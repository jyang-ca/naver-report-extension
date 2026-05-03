(() => {
  'use strict';

  const utils = window.NaverReportUtils;
  if (!utils) {
    return;
  }

  const {
    SETTINGS_STORAGE_KEY,
    SETTINGS_SCHEMA_VERSION,
    DEFAULT_SETTINGS,
    RESEARCH_PAGE_CONFIGS,
    migrateStoredSettings,
    normalizeSettings,
    normalizeDate,
    getRecentKrxTradingDate,
    buildFilename,
    buildDailyZipFilename,
    buildEntityZipFilename,
    buildEntityZipEntryPath,
    parseReportRowsFromDocument,
    parseCompanySearchOptionsDocument,
    parseIndustrySearchOptionsDocument,
    dedupeReports,
    searchResearchEntities
  } = utils;

  const ENTITY_CATALOG_STORAGE_KEY = 'naverReportEntityCatalog';
  const ENTITY_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const ENTITY_RESULT_LIMIT = 12;
  const DEFAULT_ENTITY_LOOKBACK_DAYS = 30;

  const elements = {
    modeDate: document.getElementById('download-mode-date'),
    modeEntity: document.getElementById('download-mode-entity'),
    dateModePanel: document.getElementById('date-mode-panel'),
    entityModePanel: document.getElementById('entity-mode-panel'),
    downloadToday: document.getElementById('download-today'),
    downloadTodayLabel: document.getElementById('download-today-label'),
    downloadTodayActionLabel: document.getElementById('download-today-action-label'),
    stopDailyDownload: document.getElementById('stop-daily-download'),
    downloadDate: document.getElementById('download-date'),
    datePresetButtons: Array.from(document.querySelectorAll('[data-date-preset]')),
    entitySearchInput: document.getElementById('entity-search-input'),
    entitySearchHint: document.getElementById('entity-search-hint'),
    entitySearchResults: document.getElementById('entity-search-results'),
    industryCategoryTrigger: document.getElementById('industry-category-trigger'),
    industryCategoryTooltip: document.getElementById('industry-category-tooltip'),
    entitySelectedList: document.getElementById('entity-selected-list'),
    entitySelectedEmpty: document.getElementById('entity-selected-empty'),
    entitySelectionSummary: document.getElementById('entity-selection-summary'),
    entityStartDate: document.getElementById('entity-start-date'),
    entityEndDate: document.getElementById('entity-end-date'),
    findEntityReports: document.getElementById('find-entity-reports'),
    stopEntityDownload: document.getElementById('stop-entity-download'),
    statusPanel: document.getElementById('status-panel'),
    statusTitle: document.getElementById('status-title'),
    statusDetail: document.getElementById('status-detail'),
    statusProgress: document.getElementById('status-progress'),
    statusProgressCount: document.getElementById('status-progress-count'),
    statusProgressPercent: document.getElementById('status-progress-percent'),
    statusProgressBar: document.getElementById('status-progress-bar'),
    statusCurrentFile: document.getElementById('status-current-file'),
    statusExtra: document.getElementById('status-extra'),
    pathPreview: document.getElementById('path-preview'),
    zipPreview: document.getElementById('zip-preview'),
    filenamePreview: document.getElementById('filename-preview'),
    downloadPathPrefix: document.getElementById('download-path-prefix'),
    filenameTemplate: document.getElementById('filename-template'),
    resetFilenameTemplate: document.getElementById('reset-filename-template'),
    useNativePathPicker: document.getElementById('use-native-path-picker'),
    createStockFolders: document.getElementById('create-stock-folders'),
    bulkMaxPages: document.getElementById('bulk-max-pages'),
    bulkConcurrency: document.getElementById('bulk-concurrency'),
    statusText: document.getElementById('status-text')
  };

  let currentSettings = normalizeSettings(DEFAULT_SETTINGS);
  let activeMode = 'date';
  let busyMode = '';
  let activeSnapshot = null;
  let statusTimer = null;
  let progressPort = null;
  let collectionAbortController = null;
  let collectionStopRequested = false;
  let selectedDownloadDate = '';
  let entityStartDate = '';
  let entityEndDate = '';
  let entitySearchQuery = '';
  let selectedEntities = [];
  let entityResults = [];
  let dateAnimationTimer = null;
  let entityCatalogPromise = null;
  let isIndustryCategoryOpen = false;
  let entityCatalog = {
    status: 'idle',
    fetchedAt: '',
    entities: [],
    error: ''
  };

  const DOWNLOAD_ACTION_LABEL = '리포트 모두 다운로드';
  const ENTITY_ACTION_LABEL = '리포트 찾기';
  const DEFAULT_STATUS_TEXT = '설정은 자동으로 저장됩니다.';

  init().catch((error) => {
    setStatus(formatError(error), true);
  });

  async function init() {
    const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY, ENTITY_CATALOG_STORAGE_KEY]);
    const storedSettings = result && result[SETTINGS_STORAGE_KEY];
    const migratedStoredSettings = migrateStoredSettings(storedSettings);
    currentSettings = normalizeSettings(migratedStoredSettings);

    if (!storedSettings || JSON.stringify(storedSettings) !== JSON.stringify(migratedStoredSettings)) {
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: migratedStoredSettings
      });
    }

    selectedDownloadDate = getTodayIsoDate();
    entityEndDate = getTodayIsoDate();
    entityStartDate = shiftIsoDate(entityEndDate, -DEFAULT_ENTITY_LOOKBACK_DAYS);
    restoreEntityCatalog(result && result[ENTITY_CATALOG_STORAGE_KEY]);

    attachListeners();
    connectProgressPort();
    syncUi();
    renderStatusPanel(null);
    setStatus('설정을 불러왔습니다.');

    if (!entityCatalog.entities.length) {
      void ensureEntityCatalogLoaded().catch(() => {});
    }
  }

  function attachListeners() {
    if (elements.modeDate) {
      elements.modeDate.addEventListener('click', () => {
        switchMode('date');
      });
    }

    if (elements.modeEntity) {
      elements.modeEntity.addEventListener('click', () => {
        switchMode('entity');
      });
    }

    if (elements.downloadToday) {
      elements.downloadToday.addEventListener('click', () => {
        void downloadSelectedDateReports();
      });
    }

    if (elements.stopDailyDownload) {
      elements.stopDailyDownload.addEventListener('click', () => {
        void stopCurrentDownload();
      });
    }

    if (elements.stopEntityDownload) {
      elements.stopEntityDownload.addEventListener('click', () => {
        void stopCurrentDownload();
      });
    }

    if (elements.resetFilenameTemplate) {
      elements.resetFilenameTemplate.addEventListener('click', () => {
        if (elements.filenameTemplate) {
          elements.filenameTemplate.value = DEFAULT_SETTINGS.filenameTemplate;
        }
        if (elements.bulkMaxPages) {
          elements.bulkMaxPages.value = String(DEFAULT_SETTINGS.bulkMaxPages);
        }
        if (elements.bulkConcurrency) {
          elements.bulkConcurrency.value = String(DEFAULT_SETTINGS.bulkConcurrency);
        }
        void saveSettings();
      });
    }

    if (elements.industryCategoryTrigger) {
      elements.industryCategoryTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        setIndustryCategoryOpen(!isIndustryCategoryOpen);
      });
    }

    if (elements.industryCategoryTooltip) {
      elements.industryCategoryTooltip.addEventListener('click', (event) => {
        const button = event.target.closest('[data-industry-entity-key]');
        if (!button) {
          return;
        }

        const entity = entityCatalog.entities.find((item) => item.key === button.dataset.industryEntityKey);
        if (!entity) {
          return;
        }

        addSelectedEntity(entity);
        setIndustryCategoryOpen(false);
      });
    }

    document.addEventListener('click', (event) => {
      if (!isIndustryCategoryOpen) {
        return;
      }

      const trigger = elements.industryCategoryTrigger;
      const tooltip = elements.industryCategoryTooltip;
      const target = event.target;
      if (
        trigger && trigger.contains(target)
      ) {
        return;
      }

      if (
        tooltip && tooltip.contains(target)
      ) {
        return;
      }

      setIndustryCategoryOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isIndustryCategoryOpen) {
        setIndustryCategoryOpen(false);
      }
    });

    if (elements.downloadDate) {
      elements.downloadDate.addEventListener('change', () => {
        setSelectedDownloadDate(elements.downloadDate.value, {
          animate: true
        });
      });
    }

    for (const button of elements.datePresetButtons) {
      button.addEventListener('click', () => {
        setSelectedDownloadDate(getPresetDate(button.dataset.datePreset), {
          animate: true
        });
      });
    }

    if (elements.entitySearchInput) {
      elements.entitySearchInput.addEventListener('input', () => {
        entitySearchQuery = elements.entitySearchInput.value || '';
        updateEntitySearchResults();
        renderEntitySearchState();
      });
    }

    if (elements.entitySearchResults) {
      elements.entitySearchResults.addEventListener('click', (event) => {
        const button = event.target.closest('[data-entity-key]');
        if (!button) {
          return;
        }

        const entity = entityResults.find((item) => item.key === button.dataset.entityKey);
        if (!entity) {
          return;
        }

        addSelectedEntity(entity);
      });
    }

    if (elements.entitySelectedList) {
      elements.entitySelectedList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-remove-entity-key]');
        if (!button) {
          return;
        }

        removeSelectedEntity(button.dataset.removeEntityKey);
      });
    }

    if (elements.entityStartDate) {
      elements.entityStartDate.addEventListener('change', () => {
        entityStartDate = elements.entityStartDate.value || entityStartDate;
        syncUi();
        renderStatusPanel(null);
      });
    }

    if (elements.entityEndDate) {
      elements.entityEndDate.addEventListener('change', () => {
        entityEndDate = elements.entityEndDate.value || entityEndDate;
        syncUi();
        renderStatusPanel(null);
      });
    }

    if (elements.findEntityReports) {
      elements.findEntityReports.addEventListener('click', () => {
        void downloadSelectedEntityReports();
      });
    }

    const watchedElements = [
      elements.downloadPathPrefix,
      elements.filenameTemplate,
      elements.useNativePathPicker,
      elements.createStockFolders,
      elements.bulkMaxPages,
      elements.bulkConcurrency
    ].filter(Boolean);

    for (const element of watchedElements) {
      element.addEventListener('change', () => {
        void saveSettings();
      });
      element.addEventListener('input', () => {
        if (element.type === 'text' || element.type === 'number') {
          void saveSettings();
        }
      });
    }
  }

  function switchMode(nextMode, options) {
    if (busyMode && !(options && options.force)) {
      return;
    }

    activeMode = nextMode === 'entity' ? 'entity' : 'date';
    if (activeMode === 'entity') {
      void ensureEntityCatalogLoaded().catch(() => {});
    }

    syncUi();
    if (!(options && options.preserveStatus)) {
      renderStatusPanel(null);
    }
  }

  function syncUi() {
    const isBusy = Boolean(busyMode);

    if (elements.modeDate) {
      elements.modeDate.disabled = isBusy;
      elements.modeDate.classList.toggle('is-active', activeMode === 'date');
      elements.modeDate.setAttribute('aria-selected', String(activeMode === 'date'));
      elements.modeDate.tabIndex = activeMode === 'date' ? 0 : -1;
    }

    if (elements.modeEntity) {
      elements.modeEntity.disabled = isBusy;
      elements.modeEntity.classList.toggle('is-active', activeMode === 'entity');
      elements.modeEntity.setAttribute('aria-selected', String(activeMode === 'entity'));
      elements.modeEntity.tabIndex = activeMode === 'entity' ? 0 : -1;
    }

    if (elements.dateModePanel) {
      elements.dateModePanel.hidden = activeMode !== 'date';
    }

    if (elements.entityModePanel) {
      elements.entityModePanel.hidden = activeMode !== 'entity';
    }

    if (elements.downloadPathPrefix) {
      elements.downloadPathPrefix.value = currentSettings.downloadPathPrefix;
    }
    if (elements.filenameTemplate) {
      elements.filenameTemplate.value = currentSettings.filenameTemplate;
    }
    if (elements.useNativePathPicker) {
      elements.useNativePathPicker.checked = currentSettings.useNativePathPicker;
    }
    if (elements.createStockFolders) {
      elements.createStockFolders.checked = currentSettings.createStockFolders;
    }
    if (elements.bulkMaxPages) {
      elements.bulkMaxPages.value = String(currentSettings.bulkMaxPages);
    }
    if (elements.bulkConcurrency) {
      elements.bulkConcurrency.value = String(currentSettings.bulkConcurrency);
    }

    if (elements.downloadDate) {
      elements.downloadDate.value = selectedDownloadDate || getTodayIsoDate();
      elements.downloadDate.disabled = isBusy;
    }

    for (const button of elements.datePresetButtons) {
      button.disabled = isBusy;
      button.classList.toggle(
        'is-active',
        getPresetDate(button.dataset.datePreset) === (selectedDownloadDate || getTodayIsoDate())
      );
    }

    renderDailyZipControls(
      activeSnapshot && activeSnapshot.mode === 'date' && activeMode === 'date' && isPopupZipActive(activeSnapshot)
        ? activeSnapshot
        : null
    );

    if (elements.entityStartDate) {
      elements.entityStartDate.value = entityStartDate;
      elements.entityStartDate.disabled = isBusy;
    }

    if (elements.entityEndDate) {
      elements.entityEndDate.value = entityEndDate;
      elements.entityEndDate.disabled = isBusy;
    }

    if (elements.entitySearchInput) {
      elements.entitySearchInput.disabled = isBusy || entityCatalog.status === 'loading';
      elements.entitySearchInput.value = entitySearchQuery;
    }

    renderEntityActionControls(
      activeSnapshot && activeSnapshot.mode === 'entity' && activeMode === 'entity' && isPopupZipActive(activeSnapshot)
        ? activeSnapshot
        : null
    );
    renderEntitySearchState();
    updatePreviews();
  }

  function setIndustryCategoryOpen(isOpen) {
    isIndustryCategoryOpen = Boolean(isOpen);
    if (elements.industryCategoryTrigger) {
      elements.industryCategoryTrigger.setAttribute('aria-expanded', String(isIndustryCategoryOpen));
    }
    if (elements.industryCategoryTooltip) {
      elements.industryCategoryTooltip.hidden = !isIndustryCategoryOpen;
    }
  }

  async function saveSettings() {
    const nextStoredSettings = migrateStoredSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      downloadPathPrefix: elements.downloadPathPrefix ? elements.downloadPathPrefix.value : '',
      filenameTemplate: elements.filenameTemplate ? elements.filenameTemplate.value : '',
      useNativePathPicker: elements.useNativePathPicker ? elements.useNativePathPicker.checked : false,
      createStockFolders: elements.createStockFolders ? elements.createStockFolders.checked : false,
      bulkMaxPages: elements.bulkMaxPages ? elements.bulkMaxPages.value : DEFAULT_SETTINGS.bulkMaxPages,
      bulkConcurrency: elements.bulkConcurrency ? elements.bulkConcurrency.value : DEFAULT_SETTINGS.bulkConcurrency,
      bulkRetryMax: currentSettings.bulkRetryMax
    });
    currentSettings = normalizeSettings(nextStoredSettings);

    syncUi();

    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: nextStoredSettings
    });

    setStatus('설정을 저장했습니다.');
  }

  async function downloadSelectedDateReports() {
    if (busyMode) {
      return;
    }

    const targetDate = selectedDownloadDate || getTodayIsoDate();
    const dateLabel = formatKoreanDate(targetDate);
    beginLocalCollection('date');

    try {
      setStatus(`${dateLabel} 리포트를 수집하는 중입니다.`, false, {
        persist: true
      });

      activeSnapshot = {
        mode: 'date',
        jobStatus: 'running',
        phase: 'collecting',
        targetDate,
        collectionTotalPageCount: RESEARCH_PAGE_CONFIGS.length * currentSettings.bulkMaxPages,
        scannedPageCount: 0,
        collectedReportCount: 0,
        totalCount: 0,
        processedCount: 0
      };
      renderDailyZipControls(activeSnapshot);
      renderStatusPanel(activeSnapshot);

      const response = await chrome.runtime.sendMessage({
        type: 'NAVER_REPORT_START_DAILY_ZIP',
        source: 'popup',
        mode: 'date',
        settings: currentSettings,
        targetDate,
        collectSpec: {
          mode: 'date',
          targetDate
        }
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || '선택한 날짜의 다운로드를 시작하지 못했습니다.');
      }

      handleDailyZipUpdate(response.snapshot);
      setStatus(`${dateLabel} 리포트 수집 및 ZIP 생성을 시작했습니다.`, false, {
        persist: true
      });
    } catch (error) {
      handleLocalCollectionError(error, 'date', {
        targetDate
      });
    } finally {
      finishLocalCollection();
    }
  }

  async function downloadSelectedEntityReports() {
    if (busyMode) {
      return;
    }

    if (!selectedEntities.length) {
      setStatus('기업 또는 산업을 하나 이상 선택해 주세요.', true);
      return;
    }

    const range = readEntityDateRange();
    if (!range) {
      return;
    }

    const metadata = buildEntitySnapshotMetadata(range.fromDate, range.toDate);
    beginLocalCollection('entity');

    try {
      setStatus('선택한 기업/산업 리포트를 찾는 중입니다.', false, {
        persist: true
      });

      activeSnapshot = {
        ...metadata,
        jobStatus: 'running',
        phase: 'collecting',
        collectionTotalPageCount:
          ((metadata.selectedCompanyCount ? 1 : 0) + (metadata.selectedIndustryCount ? 1 : 0)) *
          currentSettings.bulkMaxPages,
        scannedPageCount: 0,
        collectedReportCount: 0,
        totalCount: 0,
        processedCount: 0
      };
      renderEntityActionControls(activeSnapshot);
      renderStatusPanel(activeSnapshot);

      const response = await chrome.runtime.sendMessage({
        type: 'NAVER_REPORT_START_DAILY_ZIP',
        source: 'popup',
        mode: 'entity',
        targetDate: range.toDate,
        fromDate: range.fromDate,
        toDate: range.toDate,
        selectionSummary: metadata.selectionSummary,
        selectedCount: metadata.selectedCount,
        selectedCompanyCount: metadata.selectedCompanyCount,
        selectedIndustryCount: metadata.selectedIndustryCount,
        zipFilename: buildEntityZipFilename(currentSettings, range.fromDate, range.toDate),
        settings: currentSettings,
        collectSpec: {
          mode: 'entity',
          fromDate: range.fromDate,
          toDate: range.toDate,
          selectedCompanyCodes: selectedEntities
            .filter((entity) => entity.type === 'company' && entity.code)
            .map((entity) => entity.code),
          selectedIndustryNames: selectedEntities
            .filter((entity) => entity.type === 'industry' && entity.name)
            .map((entity) => entity.name)
        }
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || '기업/산업별 다운로드를 시작하지 못했습니다.');
      }

      handleDailyZipUpdate(response.snapshot);
      setStatus('조건에 맞는 리포트 수집 및 ZIP 생성을 시작했습니다.', false, {
        persist: true
      });
    } catch (error) {
      handleLocalCollectionError(error, 'entity', metadata);
    } finally {
      finishLocalCollection();
    }
  }

  function beginLocalCollection(mode) {
    busyMode = mode;
    collectionStopRequested = false;
    collectionAbortController = null;
    syncUi();
  }

  function finishLocalCollection() {
    collectionAbortController = null;
    syncUi();
  }

  function handleLocalCollectionError(error, mode, metadata) {
    if (collectionStopRequested || (error && error.name === 'AbortError')) {
      activeSnapshot = {
        ...(metadata || {}),
        mode,
        jobStatus: 'stopped',
        phase: 'stopped',
        totalCount: 0,
        processedCount: 0
      };
      renderStatusPanel(activeSnapshot);
      setStatus(mode === 'entity'
        ? '기업/산업별 리포트 다운로드를 중단했습니다.'
        : '선택한 날짜의 리포트 다운로드를 중단했습니다.');
    } else {
      setStatus(formatError(error), true);
    }

    busyMode = '';
    if (mode === 'date') {
      renderDailyZipControls(null);
    } else {
      renderEntityActionControls(null);
    }
  }

  async function stopCurrentDownload() {
    if (!busyMode) {
      return;
    }

    collectionStopRequested = true;
    setStatus('중단하는 중입니다.', false, {
      persist: true
    });

    if (busyMode === 'date' && elements.stopDailyDownload) {
      elements.stopDailyDownload.disabled = true;
    }
    if (busyMode === 'entity' && elements.stopEntityDownload) {
      elements.stopEntityDownload.disabled = true;
    }

    const wasCollectingLocally = Boolean(collectionAbortController);
    if (collectionAbortController) {
      collectionAbortController.abort();
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'NAVER_REPORT_STOP_DAILY_ZIP'
      });

      if (!wasCollectingLocally && response && response.ok && response.snapshot) {
        handleDailyZipUpdate(response.snapshot);
      }
    } catch (_error) {
      // A stop during local list collection may happen before the background job exists.
    }
  }

  async function collectReportsForDate(targetDate) {
    const listConfigs = RESEARCH_PAGE_CONFIGS.filter((config) => Boolean(config.listPath));
    const collected = [];

    for (const config of listConfigs) {
      const reports = await collectSectionReportsForDate(config, targetDate);
      collected.push(...reports);
    }

    return dedupeReports(collected)
      .sort(compareReportsForZip)
      .map((report) => ({
        ...report,
        zipPath: buildDateZipPathForReport(report),
        expectedFilename: buildDateZipPathForReport(report)
      }));
  }

  async function collectSectionReportsForDate(config, targetDate) {
    const reports = [];

    for (let page = 1; page <= currentSettings.bulkMaxPages; page += 1) {
      throwIfCollectionStopped();

      const pageUrl = buildListPageUrl(config, page);
      const doc = await fetchResearchPage(pageUrl);
      const pageItems = parseReportRowsFromDocument(doc, {
        settings: currentSettings,
        baseUrl: pageUrl
      });

      if (!pageItems.length) {
        break;
      }

      reports.push(...pageItems.filter((item) => item.date === targetDate));

      const allRowsOlderThanTarget = pageItems.every((item) => item.date < targetDate);
      if (allRowsOlderThanTarget || !hasNextPage(doc, page)) {
        break;
      }
    }

    return reports;
  }

  async function collectReportsForEntities(fromDate, toDate) {
    const companyConfig = RESEARCH_PAGE_CONFIGS.find((config) => config.kind === 'company');
    const industryConfig = RESEARCH_PAGE_CONFIGS.find((config) => config.kind === 'industry');
    const selectedCompanyCodes = new Set(
      selectedEntities
        .filter((entity) => entity.type === 'company' && entity.code)
        .map((entity) => entity.code)
    );
    const selectedIndustries = new Set(
      selectedEntities
        .filter((entity) => entity.type === 'industry' && entity.name)
        .map((entity) => entity.name)
    );
    const collected = [];

    if (companyConfig && selectedCompanyCodes.size) {
      const companyReports = await collectSectionReportsForRange(
        companyConfig,
        fromDate,
        toDate,
        (report) => selectedCompanyCodes.has(report.stockCode)
      );
      collected.push(...companyReports);
    }

    if (industryConfig && selectedIndustries.size) {
      const industryReports = await collectSectionReportsForRange(
        industryConfig,
        fromDate,
        toDate,
        (report) => selectedIndustries.has(report.stockName)
      );
      collected.push(...industryReports);
    }

    return dedupeReports(collected)
      .sort(compareReportsForZip)
      .map((report) => ({
        ...report,
        zipPath: buildEntityZipEntryPath(report, currentSettings),
        expectedFilename: buildEntityZipEntryPath(report, currentSettings)
      }));
  }

  async function collectSectionReportsForRange(config, fromDate, toDate, matcher) {
    const reports = [];

    for (let page = 1; page <= currentSettings.bulkMaxPages; page += 1) {
      throwIfCollectionStopped();

      const pageUrl = buildDateRangePageUrl(config, page, fromDate, toDate);
      const doc = await fetchResearchPage(pageUrl);
      const pageItems = parseReportRowsFromDocument(doc, {
        settings: currentSettings,
        baseUrl: pageUrl
      });

      if (!pageItems.length) {
        break;
      }

      reports.push(...pageItems.filter((item) => matcher(item)));

      if (!hasNextPage(doc, page)) {
        break;
      }
    }

    return reports;
  }

  function throwIfCollectionStopped() {
    if (collectionStopRequested) {
      throw new DOMException('사용자가 중단했습니다.', 'AbortError');
    }
  }

  async function fetchResearchPage(url) {
    const response = await fetch(url, {
      credentials: 'include',
      signal: collectionAbortController ? collectionAbortController.signal : undefined
    });

    if (!response.ok) {
      throw new Error(`페이지를 불러오지 못했습니다: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('euc-kr');
    const html = decoder.decode(buffer);
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function buildListPageUrl(config, page) {
    const url = new URL(config.listPath, 'https://finance.naver.com');
    url.searchParams.set('page', String(page));
    return url.href;
  }

  function buildDateRangePageUrl(config, page, fromDate, toDate) {
    const url = new URL(config.listPath, 'https://finance.naver.com');
    url.searchParams.set('page', String(page));
    url.searchParams.set('searchType', 'writeDate');
    url.searchParams.set('writeFromDate', normalizeDate(fromDate));
    url.searchParams.set('writeToDate', normalizeDate(toDate));
    return url.href;
  }

  function hasNextPage(doc, currentPage) {
    const links = Array.from(doc.querySelectorAll('.Nnavi a[href*="page="]'));
    return links.some((link) => getPageNumberFromUrl(link.href) > currentPage);
  }

  function getPageNumberFromUrl(url) {
    try {
      const page = new URL(url, 'https://finance.naver.com').searchParams.get('page');
      const parsed = Number.parseInt(page || '1', 10);
      return Number.isFinite(parsed) ? parsed : 1;
    } catch (_error) {
      return 1;
    }
  }

  async function ensureEntityCatalogLoaded(options) {
    if (entityCatalogPromise) {
      return entityCatalogPromise;
    }

    if (entityCatalog.status === 'ready' && entityCatalog.entities.length && !(options && options.force)) {
      return entityCatalog.entities;
    }

    entityCatalog.status = 'loading';
    entityCatalog.error = '';
    renderEntitySearchState();

    entityCatalogPromise = (async () => {
      try {
        const stored = await chrome.storage.local.get([ENTITY_CATALOG_STORAGE_KEY]);
        const cachedCatalog = stored && stored[ENTITY_CATALOG_STORAGE_KEY];
        if (!(options && options.force) && isEntityCatalogFresh(cachedCatalog)) {
          restoreEntityCatalog(cachedCatalog);
          updateEntitySearchResults();
          renderEntitySearchState();
          return entityCatalog.entities;
        }

        const [companyDoc, industryDoc] = await Promise.all([
          fetchResearchPage('https://finance.naver.com/research/company_item_search.naver'),
          fetchResearchPage('https://finance.naver.com/research/industry_list.naver?page=1')
        ]);

        const companies = parseCompanySearchOptionsDocument(companyDoc);
        const industries = parseIndustrySearchOptionsDocument(industryDoc);
        const nextCatalog = {
          fetchedAt: new Date().toISOString(),
          entities: [...companies, ...industries]
        };

        restoreEntityCatalog(nextCatalog);
        await chrome.storage.local.set({
          [ENTITY_CATALOG_STORAGE_KEY]: nextCatalog
        });
        updateEntitySearchResults();
        renderEntitySearchState();
        return entityCatalog.entities;
      } catch (error) {
        if (entityCatalog.entities.length) {
          entityCatalog.status = 'ready';
        } else {
          entityCatalog.status = 'failed';
          entityCatalog.error = formatError(error);
        }
        renderEntitySearchState();
        throw error;
      } finally {
        entityCatalogPromise = null;
      }
    })();

    return entityCatalogPromise;
  }

  function restoreEntityCatalog(catalog) {
    const source = catalog && Array.isArray(catalog.entities)
      ? catalog.entities
      : [];
    entityCatalog = {
      status: source.length ? 'ready' : 'idle',
      fetchedAt: catalog && catalog.fetchedAt ? String(catalog.fetchedAt) : '',
      entities: source.map((entity) => ({
        key: entity.key,
        type: entity.type,
        name: entity.name,
        code: entity.code || '',
        displayName: entity.displayName || entity.name
      })),
      error: ''
    };
    updateEntitySearchResults();
    renderIndustryCategoryTooltip();
  }

  function isEntityCatalogFresh(catalog) {
    if (!catalog || !Array.isArray(catalog.entities) || !catalog.entities.length || !catalog.fetchedAt) {
      return false;
    }

    const fetchedAt = Date.parse(catalog.fetchedAt);
    if (!Number.isFinite(fetchedAt)) {
      return false;
    }

    return Date.now() - fetchedAt < ENTITY_CATALOG_CACHE_TTL_MS;
  }

  function updateEntitySearchResults() {
    entityResults = searchResearchEntities(entityCatalog.entities, entitySearchQuery, {
      limit: ENTITY_RESULT_LIMIT
    }).filter((entity) => !selectedEntities.some((selected) => selected.key === entity.key));
  }

  function addSelectedEntity(entity) {
    if (!entity || selectedEntities.some((item) => item.key === entity.key)) {
      return;
    }

    selectedEntities = [...selectedEntities, entity];
    updateEntitySearchResults();
    syncUi();
  }

  function removeSelectedEntity(entityKey) {
    selectedEntities = selectedEntities.filter((entity) => entity.key !== entityKey);
    updateEntitySearchResults();
    syncUi();
  }

  function readEntityDateRange() {
    let fromDate;
    let toDate;

    try {
      fromDate = normalizeDate(elements.entityStartDate ? elements.entityStartDate.value : entityStartDate);
      toDate = normalizeDate(elements.entityEndDate ? elements.entityEndDate.value : entityEndDate);
    } catch (error) {
      setStatus(formatError(error), true);
      return null;
    }

    if (fromDate > toDate) {
      setStatus('시작일은 종료일보다 늦을 수 없습니다.', true);
      return null;
    }

    entityStartDate = fromDate;
    entityEndDate = toDate;
    return {
      fromDate,
      toDate
    };
  }

  function buildEntitySnapshotMetadata(fromDate, toDate) {
    const companyCount = selectedEntities.filter((entity) => entity.type === 'company').length;
    const industryCount = selectedEntities.filter((entity) => entity.type === 'industry').length;
    return {
      mode: 'entity',
      targetDate: toDate,
      fromDate,
      toDate,
      selectedCount: selectedEntities.length,
      selectedCompanyCount: companyCount,
      selectedIndustryCount: industryCount,
      selectionSummary: buildSelectionSummary(companyCount, industryCount)
    };
  }

  function buildSelectionSummary(companyCount, industryCount) {
    const parts = [];
    if (companyCount) {
      parts.push(`기업 ${companyCount}개`);
    }
    if (industryCount) {
      parts.push(`산업 ${industryCount}개`);
    }
    return parts.join(' · ') || '선택 항목 없음';
  }

  function getTodayIsoDate() {
    return formatIsoDateFromLocalDate(new Date());
  }

  function getYesterdayIsoDate() {
    return shiftIsoDate(getTodayIsoDate(), -1);
  }

  function getRecentBusinessDate() {
    return getRecentKrxTradingDate(getTodayIsoDate());
  }

  function getPresetDate(preset) {
    if (preset === 'yesterday') {
      return getYesterdayIsoDate();
    }

    if (preset === 'business-day') {
      return getRecentBusinessDate();
    }

    return getTodayIsoDate();
  }

  function setSelectedDownloadDate(value, options) {
    const previousDate = selectedDownloadDate;
    let nextDate;

    try {
      nextDate = normalizeDate(value || getTodayIsoDate());
    } catch (error) {
      if (elements.downloadDate) {
        elements.downloadDate.value = selectedDownloadDate || getTodayIsoDate();
      }
      setStatus(formatError(error), true);
      return;
    }

    selectedDownloadDate = nextDate;

    const shouldAnimate = options && options.animate && previousDate && previousDate !== nextDate;
    if (shouldAnimate) {
      animatePrimaryDate(nextDate > previousDate ? 'up' : 'down');
    }

    syncUi();
    if (!busyMode && (!options || options.renderIdleStatus !== false)) {
      renderStatusPanel(null);
    }
  }

  function animatePrimaryDate(direction) {
    if (!elements.downloadToday) {
      return;
    }

    if (dateAnimationTimer) {
      clearTimeout(dateAnimationTimer);
    }

    const className = direction === 'up' ? 'is-date-flip-up' : 'is-date-flip-down';
    elements.downloadToday.classList.remove('is-date-flip-up', 'is-date-flip-down');
    void elements.downloadToday.offsetWidth;
    elements.downloadToday.classList.add(className);
    dateAnimationTimer = setTimeout(() => {
      elements.downloadToday.classList.remove(className);
    }, 260);
  }

  function shiftIsoDate(value, dayOffset) {
    const date = parseIsoDateToLocalDate(value);
    date.setDate(date.getDate() + dayOffset);
    return formatIsoDateFromLocalDate(date);
  }

  function parseIsoDateToLocalDate(value) {
    const normalized = normalizeDate(value);
    const [year, month, day] = normalized.split('-').map((part) => Number.parseInt(part, 10));
    return new Date(year, month - 1, day);
  }

  function formatIsoDateFromLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return normalizeDate(`${year}-${month}-${day}`);
  }

  function formatKoreanDate(value) {
    const normalized = normalizeDate(value || getTodayIsoDate());
    const [year, month, day] = normalized.split('-');
    return `${year}년 ${Number.parseInt(month, 10)}월 ${Number.parseInt(day, 10)}일`;
  }

  function formatDateRangeLabel(fromDate, toDate) {
    return `${formatKoreanDate(fromDate)} ~ ${formatKoreanDate(toDate)}`;
  }

  function buildDateZipPathForReport(report) {
    const sectionName = report.sectionName || report.stockName || '리포트';
    const filename = buildFilename(report, {
      ...currentSettings,
      downloadPathPrefix: 'daily',
      createStockFolders: false
    });

    return joinPathParts(sectionName, getPathBasename(filename));
  }

  function getPathBasename(path) {
    const parts = String(path || '').split('/');
    return parts[parts.length - 1] || 'report.pdf';
  }

  function joinPathParts(...parts) {
    return parts
      .map((part) => String(part || '').trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
  }

  function connectProgressPort() {
    progressPort = chrome.runtime.connect({
      name: 'naver-report-popup'
    });

    progressPort.onMessage.addListener((message) => {
      if (!message || message.type !== 'NAVER_REPORT_DAILY_ZIP_UPDATE') {
        return;
      }

      handleDailyZipUpdate(message.snapshot);
    });

    progressPort.onDisconnect.addListener(() => {
      progressPort = null;
    });
  }

  function handleDailyZipUpdate(snapshot) {
    if (!snapshot) {
      return;
    }

    activeSnapshot = snapshot;
    const snapshotMode = snapshot.mode === 'entity' ? 'entity' : 'date';
    const isActive = isPopupZipActive(snapshot);
    busyMode = isActive ? snapshotMode : '';

    if (isActive && snapshotMode !== activeMode) {
      switchMode(snapshotMode, {
        force: true,
        preserveStatus: true
      });
    }

    if (snapshotMode === 'date') {
      renderDailyZipControls(isActive ? snapshot : null);
    } else {
      renderEntityActionControls(isActive ? snapshot : null);
    }

    renderStatusPanel(snapshot);

    if (snapshot.phase === 'completed') {
      setStatus(
        snapshotMode === 'entity'
          ? '기업/산업별 리포트 다운로드가 완료되었습니다.'
          : `${formatKoreanDate(snapshot.targetDate)} 리포트 다운로드가 완료되었습니다.`,
        false,
        {
          persist: true
        }
      );
    } else if (snapshot.phase === 'failed') {
      setStatus(snapshot.error || 'ZIP 다운로드에 실패했습니다.', true);
    } else if (snapshot.phase === 'stopped') {
      setStatus(
        snapshotMode === 'entity'
          ? '기업/산업별 리포트 다운로드를 중단했습니다.'
          : '선택한 날짜의 리포트 다운로드를 중단했습니다.'
      );
    } else if (isActive) {
      setStatus(getPopupZipStatusText(snapshot), false, {
        persist: true
      });
    }

    syncUi();
  }

  function renderDailyZipControls(snapshot) {
    if (!elements.downloadToday || !elements.stopDailyDownload) {
      return;
    }

    const isActive = Boolean(snapshot && isPopupZipActive(snapshot));
    const targetDate = snapshot && snapshot.targetDate
      ? snapshot.targetDate
      : selectedDownloadDate || getTodayIsoDate();

    elements.downloadToday.classList.toggle('is-running', isActive);
    elements.downloadToday.disabled = isActive;
    elements.stopDailyDownload.hidden = !isActive;
    elements.stopDailyDownload.disabled = snapshot && snapshot.phase === 'stopping';
    if (elements.downloadTodayLabel) {
      elements.downloadTodayLabel.textContent = formatKoreanDate(targetDate);
    }
    if (elements.downloadTodayActionLabel) {
      elements.downloadTodayActionLabel.textContent = isActive
        ? getDailyZipButtonLabel(snapshot)
        : DOWNLOAD_ACTION_LABEL;
    }
  }

  function renderEntityActionControls(snapshot) {
    if (!elements.findEntityReports || !elements.stopEntityDownload) {
      return;
    }

    const isActive = Boolean(snapshot && isPopupZipActive(snapshot));
    elements.findEntityReports.classList.toggle('is-running', isActive);
    elements.findEntityReports.disabled = isActive || !selectedEntities.length;
    elements.stopEntityDownload.hidden = !isActive;
    elements.stopEntityDownload.disabled = snapshot && snapshot.phase === 'stopping';
    elements.findEntityReports.textContent = isActive
      ? getEntityZipButtonLabel(snapshot)
      : ENTITY_ACTION_LABEL;
  }

  function getDailyZipButtonLabel(snapshot) {
    if (snapshot.phase === 'stopping') {
      return '중단 중...';
    }
    if (snapshot.phase === 'collecting') {
      return '수집 중...';
    }
    if (snapshot.phase === 'zipping') {
      return 'ZIP 생성 중...';
    }
    if (snapshot.phase === 'saving' || snapshot.phase === 'ready') {
      return 'ZIP 저장 중...';
    }
    return '다운로드 중...';
  }

  function getEntityZipButtonLabel(snapshot) {
    if (snapshot.phase === 'stopping') {
      return '중단 중...';
    }
    if (snapshot.phase === 'collecting') {
      return '리포트 찾는 중...';
    }
    if (snapshot.phase === 'zipping') {
      return 'ZIP 생성 중...';
    }
    if (snapshot.phase === 'saving' || snapshot.phase === 'ready') {
      return 'ZIP 저장 중...';
    }
    return '다운로드 중...';
  }

  function renderStatusPanel(snapshot) {
    if (!elements.statusPanel) {
      return;
    }

    const mode = snapshot && snapshot.mode ? snapshot.mode : activeMode;
    if (mode === 'entity') {
      renderEntityStatusPanel(snapshot);
      return;
    }

    renderDateStatusPanel(snapshot);
  }

  function renderDateStatusPanel(snapshot) {
    const phase = snapshot && snapshot.phase ? snapshot.phase : 'idle';
    const total = snapshot && snapshot.totalCount ? snapshot.totalCount : 0;
    const processed = snapshot && snapshot.processedCount ? snapshot.processedCount : 0;
    const completed = snapshot && snapshot.completedCount ? snapshot.completedCount : 0;
    const failed = snapshot && snapshot.failedCount ? snapshot.failedCount : 0;
    const zipFilename = snapshot && snapshot.zipFilename ? snapshot.zipFilename : '';
    const targetDate = snapshot && snapshot.targetDate
      ? snapshot.targetDate
      : selectedDownloadDate || getTodayIsoDate();
    const dateLabel = formatKoreanDate(targetDate);
    const saveLocation = `Downloads/${zipFilename || buildDailyZipFilename(currentSettings, targetDate)}`;
    const scannedPages = snapshot && snapshot.scannedPageCount ? snapshot.scannedPageCount : 0;
    const totalPages = snapshot && snapshot.collectionTotalPageCount
      ? snapshot.collectionTotalPageCount
      : RESEARCH_PAGE_CONFIGS.length * currentSettings.bulkMaxPages;
    const collectedReportCount = snapshot && snapshot.collectedReportCount ? snapshot.collectedReportCount : 0;
    const currentSectionName = snapshot && snapshot.currentSectionName ? snapshot.currentSectionName : '';

    applyStatusPanelState(snapshot, phase);

    if (phase === 'collecting') {
      setStatusPanelText(
        `${dateLabel} 리포트를 수집 중입니다`,
        currentSectionName
          ? `${currentSectionName} 목록을 확인하고 있습니다.`
          : '네이버 증권 리서치 목록을 확인하고 있습니다.',
        `현재까지 ${collectedReportCount}건 발견`,
        {
          progress: true,
          total: totalPages,
          processed: scannedPages,
          countText: `${scannedPages} / ${totalPages}페이지 확인`
        }
      );
      return;
    }

    if (phase === 'found') {
      setStatusPanelText(
        `${dateLabel} 리포트 ${total}개 발견`,
        'PDF 다운로드를 준비 중입니다.',
        `예상 저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed: 0
        }
      );
      return;
    }

    if (phase === 'downloading' || phase === 'queued') {
      setStatusPanelText(
        `${dateLabel} 리포트 다운로드 중`,
        failed > 0
          ? `성공 ${completed}개, 실패 ${failed}개`
          : 'PDF 리포트를 가져와 ZIP 안에 넣고 있습니다.',
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed,
          currentFile: getCurrentFileLabel(snapshot)
        }
      );
      return;
    }

    if (phase === 'zipping') {
      setStatusPanelText(
        'ZIP 생성 중',
        failed > 0
          ? `${completed}개 저장 준비, 실패 ${failed}개`
          : `${total}개 리포트를 ZIP 파일로 묶는 중`,
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'ready' || phase === 'saving') {
      setStatusPanelText(
        'ZIP 저장 중',
        `총 ${total}개 중 ${completed}개 리포트를 담았습니다.`,
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed: total
        }
      );
      return;
    }

    if (phase === 'completed') {
      setStatusPanelText(
        `${dateLabel} 리포트 다운로드 완료`,
        `총 ${total}개 중 ${completed}개 저장됨${failed ? `, 실패 ${failed}개` : ''}`,
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed: total
        }
      );
      return;
    }

    if (phase === 'failed') {
      setStatusPanelText(
        '다운로드 실패',
        snapshot.error || 'ZIP 다운로드를 완료하지 못했습니다.',
        failed ? `실패한 리포트 ${failed}개가 있습니다.` : '잠시 후 다시 시도해 주세요.',
        {
          progress: total > 0,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'stopping') {
      setStatusPanelText(
        '중단 중',
        '현재 작업을 정리하고 있습니다.',
        '완료 전까지 잠시만 기다려 주세요.',
        {
          progress: total > 0,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'stopped') {
      setStatusPanelText(
        '중단됨',
        processed > 0 ? `${processed} / ${total}개 처리 후 중단했습니다.` : '작업을 시작하기 전에 중단했습니다.',
        `다시 실행하면 ${dateLabel} 리포트를 처음부터 확인합니다.`,
        {
          progress: total > 0,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'empty') {
      setStatusPanelText(
        '다운로드할 리포트 없음',
        `${dateLabel}에 등록된 PDF 리포트가 없습니다.`,
        '목록 페이지에 PDF 아이콘이 있는 리포트만 저장합니다.'
      );
      return;
    }

    setStatusPanelText(
      '대기 중',
      `버튼을 누르면 ${dateLabel}에 올라온 PDF 리포트를 하나의 ZIP 파일로 저장합니다.`,
      'PDF 리포트만 다운로드합니다.'
    );
  }

  function renderEntityStatusPanel(snapshot) {
    const phase = snapshot && snapshot.phase ? snapshot.phase : 'idle';
    const total = snapshot && snapshot.totalCount ? snapshot.totalCount : 0;
    const processed = snapshot && snapshot.processedCount ? snapshot.processedCount : 0;
    const completed = snapshot && snapshot.completedCount ? snapshot.completedCount : 0;
    const failed = snapshot && snapshot.failedCount ? snapshot.failedCount : 0;
    const fromDate = snapshot && snapshot.fromDate ? snapshot.fromDate : entityStartDate;
    const toDate = snapshot && snapshot.toDate ? snapshot.toDate : entityEndDate;
    const saveLocation = `Downloads/${
      snapshot && snapshot.zipFilename
        ? snapshot.zipFilename
        : buildEntityZipFilename(currentSettings, fromDate, toDate)
    }`;
    const rangeLabel = formatDateRangeLabel(fromDate, toDate);
    const scannedPages = snapshot && snapshot.scannedPageCount ? snapshot.scannedPageCount : 0;
    const totalPages = snapshot && snapshot.collectionTotalPageCount
      ? snapshot.collectionTotalPageCount
      : (((snapshot && snapshot.selectedCompanyCount) || 0 ? 1 : 0) +
        (((snapshot && snapshot.selectedIndustryCount) || 0) ? 1 : 0)) *
        currentSettings.bulkMaxPages;
    const collectedReportCount = snapshot && snapshot.collectedReportCount ? snapshot.collectedReportCount : 0;
    const currentSectionName = snapshot && snapshot.currentSectionName ? snapshot.currentSectionName : '';
    const selectionSummary = snapshot && snapshot.selectionSummary
      ? snapshot.selectionSummary
      : buildSelectionSummary(
          selectedEntities.filter((entity) => entity.type === 'company').length,
          selectedEntities.filter((entity) => entity.type === 'industry').length
        );

    applyStatusPanelState(snapshot, phase);

    if (phase === 'collecting') {
      setStatusPanelText(
        '선택한 기업/산업 리포트를 수집 중입니다',
        currentSectionName
          ? `${currentSectionName} 목록을 확인하고 있습니다.`
          : `${rangeLabel} 범위에서 목록 페이지를 확인하고 있습니다.`,
        `${selectionSummary} · 현재까지 ${collectedReportCount}건 발견`,
        {
          progress: true,
          total: totalPages,
          processed: scannedPages,
          countText: `${scannedPages} / ${totalPages}페이지 확인`
        }
      );
      return;
    }

    if (phase === 'found') {
      setStatusPanelText(
        `조건에 맞는 리포트 ${total}개 발견`,
        `${selectionSummary} · ${rangeLabel}`,
        `예상 저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed: 0
        }
      );
      return;
    }

    if (phase === 'downloading' || phase === 'queued') {
      setStatusPanelText(
        '기업/산업별 ZIP 다운로드 중',
        failed > 0
          ? `성공 ${completed}개, 실패 ${failed}개`
          : `${selectionSummary} 조건의 PDF를 ZIP 안에 넣고 있습니다.`,
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed,
          currentFile: getCurrentFileLabel(snapshot)
        }
      );
      return;
    }

    if (phase === 'zipping') {
      setStatusPanelText(
        'ZIP 생성 중',
        failed > 0
          ? `${completed}개 저장 준비, 실패 ${failed}개`
          : `${total}개 리포트를 ZIP 파일로 묶는 중`,
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'ready' || phase === 'saving') {
      setStatusPanelText(
        'ZIP 저장 중',
        `총 ${total}개 중 ${completed}개 리포트를 담았습니다.`,
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed: total
        }
      );
      return;
    }

    if (phase === 'completed') {
      setStatusPanelText(
        '기업/산업별 리포트 다운로드 완료',
        `${selectionSummary} · 총 ${total}개 중 ${completed}개 저장됨${failed ? `, 실패 ${failed}개` : ''}`,
        `저장 위치: ${saveLocation}`,
        {
          progress: true,
          total,
          processed: total
        }
      );
      return;
    }

    if (phase === 'failed') {
      setStatusPanelText(
        '다운로드 실패',
        snapshot.error || '기업/산업별 ZIP 다운로드를 완료하지 못했습니다.',
        `${selectionSummary} 조건을 다시 확인해 주세요.`,
        {
          progress: total > 0,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'stopping') {
      setStatusPanelText(
        '중단 중',
        '현재 작업을 정리하고 있습니다.',
        '완료 전까지 잠시만 기다려 주세요.',
        {
          progress: total > 0,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'stopped') {
      setStatusPanelText(
        '중단됨',
        processed > 0 ? `${processed} / ${total}개 처리 후 중단했습니다.` : '작업을 시작하기 전에 중단했습니다.',
        `${selectionSummary} 조건은 그대로 유지됩니다.`,
        {
          progress: total > 0,
          total,
          processed
        }
      );
      return;
    }

    if (phase === 'empty') {
      setStatusPanelText(
        '다운로드할 리포트 없음',
        `${rangeLabel} 범위에 조건과 일치하는 PDF 리포트가 없습니다.`,
        '선택한 기업과 산업에 연결된 PDF 리포트만 저장합니다.'
      );
      return;
    }

    setStatusPanelText(
      '대기 중',
      '기업명, 종목 코드, 산업명을 검색해 선택한 뒤 기간을 지정하면 ZIP으로 저장합니다.',
      '종료일은 기본으로 오늘이 선택됩니다.'
    );
  }

  function applyStatusPanelState(snapshot, phase) {
    elements.statusPanel.classList.toggle('is-running', isPopupZipActive(snapshot || {}));
    elements.statusPanel.classList.toggle('is-complete', phase === 'completed');
    elements.statusPanel.classList.toggle('is-error', phase === 'failed');
  }

  function setStatusPanelText(title, detail, extra, progressOptions) {
    elements.statusTitle.textContent = title;
    elements.statusDetail.textContent = detail;
    elements.statusExtra.textContent = extra;
    renderPanelProgress(progressOptions);
  }

  function renderPanelProgress(options) {
    const showProgress = Boolean(options && options.progress);
    elements.statusProgress.hidden = !showProgress;
    elements.statusCurrentFile.hidden = !options || !options.currentFile;

    if (!showProgress) {
      elements.statusProgressBar.style.width = '0';
      elements.statusProgressCount.textContent = '0 / 0개 완료';
      elements.statusProgressPercent.textContent = '0%';
    } else {
      const total = options.total || 0;
      const processed = options.processed || 0;
      const percent = typeof options.percent === 'number'
        ? options.percent
        : total > 0
          ? Math.min(100, Math.round((processed / total) * 100))
          : 0;

      elements.statusProgressBar.style.width = `${percent}%`;
      elements.statusProgressCount.textContent =
        options.countText || `${processed} / ${total}개 완료`;
      elements.statusProgressPercent.textContent =
        total > 0 || typeof options.percent === 'number' ? `${percent}%` : '';
    }

    if (options && options.currentFile) {
      elements.statusCurrentFile.textContent = `현재 파일: ${options.currentFile}`;
    } else {
      elements.statusCurrentFile.textContent = '';
    }
  }

  function getCurrentFileLabel(snapshot) {
    const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
    const currentItem =
      items.find((item) => item.status === 'downloading') ||
      items.find((item) => item.status === 'pending');
    return currentItem ? getPathBasename(currentItem.zipPath || currentItem.reportTitle) : '';
  }

  function getPopupZipStatusText(snapshot) {
    if (snapshot.mode === 'entity') {
      if (snapshot.phase === 'zipping') {
        return '선택한 기업/산업 리포트를 ZIP 파일로 묶는 중입니다.';
      }

      if (snapshot.phase === 'saving' || snapshot.phase === 'ready') {
        return `${snapshot.zipFilename} 저장을 준비하는 중입니다.`;
      }

      return `조건에 맞는 리포트 ${snapshot.processedCount || 0} / ${snapshot.totalCount || 0}건을 가져오는 중입니다.`;
    }

    if (snapshot.phase === 'zipping') {
      return 'PDF를 하나의 ZIP 파일로 묶는 중입니다.';
    }

    if (snapshot.phase === 'saving' || snapshot.phase === 'ready') {
      return `${snapshot.zipFilename} 저장을 준비하는 중입니다.`;
    }

    return `${formatKoreanDate(snapshot.targetDate)} 리포트 ${snapshot.processedCount || 0} / ${snapshot.totalCount || 0}건을 가져오는 중입니다.`;
  }

  function isPopupZipActive(snapshot) {
    if (!snapshot) {
      return false;
    }

    return snapshot.jobStatus === 'queued' ||
      snapshot.jobStatus === 'running' ||
      snapshot.jobStatus === 'stopping' ||
      snapshot.phase === 'queued' ||
      snapshot.phase === 'collecting' ||
      snapshot.phase === 'downloading' ||
      snapshot.phase === 'zipping' ||
      snapshot.phase === 'ready' ||
      snapshot.phase === 'saving' ||
      snapshot.phase === 'stopping';
  }

  function renderEntitySearchState() {
    renderIndustryCategoryTooltip();
    renderEntitySelectionState();
    renderEntityResultState();
  }

  function renderIndustryCategoryTooltip() {
    if (!elements.industryCategoryTooltip) {
      return;
    }

    if (entityCatalog.status === 'loading') {
      elements.industryCategoryTooltip.textContent = '네이버 리서치 산업 분류를 불러오는 중입니다.';
      return;
    }

    const industries = entityCatalog.entities.filter((entity) => entity.type === 'industry');
    if (!industries.length) {
      elements.industryCategoryTooltip.textContent =
        entityCatalog.error || '산업 분류를 아직 불러오지 못했습니다.';
      return;
    }

    const isBusy = Boolean(busyMode);
    elements.industryCategoryTooltip.innerHTML = `
      <div class="popup__hover-help-tags">
        ${industries
          .map((entity) => `
            <button
              type="button"
              class="popup__hover-help-tag"
              data-industry-entity-key="${escapeAttribute(entity.key)}"
              ${isBusy || selectedEntities.some((selected) => selected.key === entity.key) ? 'disabled' : ''}
            >
              ${escapeHtml(entity.name)}
            </button>
          `)
          .join('')}
      </div>
    `;
  }

  function renderEntitySelectionState() {
    if (!elements.entitySelectedList || !elements.entitySelectedEmpty) {
      return;
    }

    if (elements.entitySelectionSummary) {
      const companyCount = selectedEntities.filter((entity) => entity.type === 'company').length;
      const industryCount = selectedEntities.filter((entity) => entity.type === 'industry').length;
      elements.entitySelectionSummary.textContent = selectedEntities.length
        ? buildSelectionSummary(companyCount, industryCount)
        : '선택한 항목 없음';
    }

    const isBusy = Boolean(busyMode);
    elements.entitySelectedEmpty.hidden = selectedEntities.length > 0;
    elements.entitySelectedList.innerHTML = selectedEntities
      .map((entity) => `
        <li class="popup__selection-item">
          <div class="popup__selection-item-main">
            <strong class="popup__selection-item-name">${escapeHtml(entity.displayName)}</strong>
            <span class="popup__selection-item-meta">${escapeHtml(getEntityTypeLabel(entity.type))}</span>
          </div>
          <button type="button" class="popup__selection-remove" data-remove-entity-key="${escapeAttribute(entity.key)}"${isBusy ? ' disabled' : ''}>
            삭제
          </button>
        </li>
      `)
      .join('');
  }

  function renderEntityResultState() {
    if (!elements.entitySearchResults || !elements.entitySearchHint) {
      return;
    }

    if (entityCatalog.status === 'loading') {
      elements.entitySearchHint.textContent = '종목/산업 목록을 불러오는 중입니다.';
      elements.entitySearchResults.innerHTML = '';
      return;
    }

    if (entityCatalog.status === 'failed') {
      elements.entitySearchHint.textContent = entityCatalog.error || '검색 목록을 불러오지 못했습니다.';
      elements.entitySearchResults.innerHTML = '';
      return;
    }

    if (!entitySearchQuery.trim()) {
      elements.entitySearchHint.textContent = '기업명, 종목 코드, 산업명을 입력해 추가하세요.';
      elements.entitySearchResults.innerHTML = '';
      return;
    }

    if (!entityResults.length) {
      elements.entitySearchHint.textContent = '검색 결과가 없습니다.';
      elements.entitySearchResults.innerHTML = '';
      return;
    }

    elements.entitySearchHint.textContent = `검색 결과 ${entityResults.length}건`;
    const isBusy = Boolean(busyMode);
    elements.entitySearchResults.innerHTML = entityResults
      .map((entity) => `
        <li class="popup__entity-result">
          <div class="popup__entity-result-main">
            <strong class="popup__entity-result-name">${escapeHtml(entity.displayName)}</strong>
            <span class="popup__entity-result-meta">${escapeHtml(getEntityTypeLabel(entity.type))}</span>
          </div>
          <button type="button" class="popup__entity-result-action" data-entity-key="${escapeAttribute(entity.key)}"${isBusy ? ' disabled' : ''}>
            추가
          </button>
        </li>
      `)
      .join('');
  }

  function updatePreviews() {
    if (!elements.pathPreview || !elements.zipPreview || !elements.filenamePreview) {
      return;
    }

    if (activeMode === 'entity') {
      const previewRange = readPreviewDateRange();
      const sampleEntity = selectedEntities[0] || {
        type: 'company',
        name: '삼성전자',
        code: '005930',
        displayName: '삼성전자 · 005930'
      };
      const sampleReport = {
        date: previewRange.toDate,
        stockName: sampleEntity.name,
        stockCode: sampleEntity.code || '',
        sectionName: sampleEntity.type === 'industry' ? '산업분석' : '종목분석',
        reportType: sampleEntity.type,
        broker: '하나증권',
        reportTitle: sampleEntity.type === 'industry' ? '업황 점검' : '실적 점검'
      };
      const sampleFilename = getPathBasename(buildFilename(sampleReport, {
        ...currentSettings,
        downloadPathPrefix: 'preview',
        createStockFolders: false
      }));

      elements.pathPreview.textContent =
        `저장 예시: Downloads/${buildEntityZipFilename(currentSettings, previewRange.fromDate, previewRange.toDate)}`;
      elements.zipPreview.textContent =
        `ZIP 내부 예시: ${buildEntityZipEntryPath(sampleReport, currentSettings)}`;
      elements.filenamePreview.textContent = sampleFilename;
      return;
    }

    const targetDate = selectedDownloadDate || getTodayIsoDate();
    const sampleReport = {
      date: targetDate,
      stockName: '삼성전자',
      broker: '하나증권',
      reportTitle: '반도체 업황 점검'
    };
    const sampleFilename = getPathBasename(buildFilename(sampleReport, {
      ...currentSettings,
      downloadPathPrefix: 'preview',
      createStockFolders: false
    }));

    elements.pathPreview.textContent =
      `저장 예시: Downloads/${buildDailyZipFilename(currentSettings, targetDate)}`;
    elements.zipPreview.textContent =
      `ZIP 내부 예시: 종목분석/${sampleFilename}`;
    elements.filenamePreview.textContent = sampleFilename;
  }

  function readPreviewDateRange() {
    try {
      return {
        fromDate: normalizeDate(entityStartDate || shiftIsoDate(getTodayIsoDate(), -DEFAULT_ENTITY_LOOKBACK_DAYS)),
        toDate: normalizeDate(entityEndDate || getTodayIsoDate())
      };
    } catch (_error) {
      return {
        fromDate: shiftIsoDate(getTodayIsoDate(), -DEFAULT_ENTITY_LOOKBACK_DAYS),
        toDate: getTodayIsoDate()
      };
    }
  }

  function getEntityTypeLabel(type) {
    return type === 'industry' ? '산업' : '기업';
  }

  function compareReportsForZip(left, right) {
    if (left.date !== right.date) {
      return left.date < right.date ? 1 : -1;
    }

    if (left.reportType !== right.reportType) {
      return left.reportType === 'industry' ? 1 : -1;
    }

    if (left.stockName !== right.stockName) {
      return String(left.stockName || '').localeCompare(String(right.stockName || ''), 'ko');
    }

    return String(left.reportTitle || '').localeCompare(String(right.reportTitle || ''), 'ko');
  }

  function setStatus(message, isError, options) {
    if (!elements.statusText) {
      return;
    }

    elements.statusText.textContent = message;
    elements.statusText.style.color = isError ? '#b42318' : '#475467';

    if (statusTimer) {
      clearTimeout(statusTimer);
    }

    if (!options || !options.persist) {
      statusTimer = setTimeout(() => {
        elements.statusText.textContent = DEFAULT_STATUS_TEXT;
        elements.statusText.style.color = '#475467';
      }, 1600);
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function formatError(error) {
    if (!error) {
      return '알 수 없는 오류가 발생했습니다.';
    }

    if (typeof error === 'string') {
      return error;
    }

    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }

    return String(error);
  }
})();
