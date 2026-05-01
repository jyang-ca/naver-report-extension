(() => {
  'use strict';

  const utils = window.NaverReportUtils;
  if (!utils) {
    return;
  }

  const {
    SETTINGS_STORAGE_KEY,
    DEFAULT_SETTINGS,
    RESEARCH_PAGE_CONFIGS,
    normalizeSettings,
    normalizeDate,
    getRecentKrxTradingDate,
    buildFilename,
    parseReportRowsFromDocument,
    dedupeReports
  } = utils;

  const elements = {
    downloadToday: document.getElementById('download-today'),
    downloadTodayLabel: document.getElementById('download-today-label'),
    downloadTodayActionLabel: document.getElementById('download-today-action-label'),
    stopDailyDownload: document.getElementById('stop-daily-download'),
    downloadDate: document.getElementById('download-date'),
    datePresetButtons: Array.from(document.querySelectorAll('[data-date-preset]')),
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
  let statusTimer = null;
  let busy = false;
  let progressPort = null;
  let collectionAbortController = null;
  let collectionStopRequested = false;
  let selectedDownloadDate = '';
  let dateAnimationTimer = null;

  const DOWNLOAD_ACTION_LABEL = '리포트 모두 다운로드';
  const DEFAULT_STATUS_TEXT = '설정은 자동으로 저장됩니다.';

  init().catch((error) => {
    setStatus(error && error.message ? error.message : String(error), true);
  });

  async function init() {
    const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
    currentSettings = normalizeSettings(result && result[SETTINGS_STORAGE_KEY]);

    if (!result || !result[SETTINGS_STORAGE_KEY]) {
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: currentSettings
      });
    }

    selectedDownloadDate = getTodayIsoDate();
    syncUi();
    renderStatusPanel(null);
    attachListeners();
    connectProgressPort();
    setStatus('설정을 불러왔습니다.');
  }

  function attachListeners() {
    elements.downloadToday.addEventListener('click', () => {
      void downloadSelectedDateReports();
    });

    elements.stopDailyDownload.addEventListener('click', () => {
      void stopDailyDownload();
    });

    elements.resetFilenameTemplate.addEventListener('click', () => {
      elements.filenameTemplate.value = DEFAULT_SETTINGS.filenameTemplate;
      void saveSettings();
    });

    elements.downloadDate.addEventListener('change', () => {
      setSelectedDownloadDate(elements.downloadDate.value, {
        animate: true
      });
    });

    for (const button of elements.datePresetButtons) {
      button.addEventListener('click', () => {
        setSelectedDownloadDate(getPresetDate(button.dataset.datePreset), {
          animate: true
        });
      });
    }

    const watchedElements = [
      elements.downloadPathPrefix,
      elements.filenameTemplate,
      elements.useNativePathPicker,
      elements.createStockFolders,
      elements.bulkMaxPages,
      elements.bulkConcurrency
    ];

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

  function syncUi() {
    elements.downloadPathPrefix.value = currentSettings.downloadPathPrefix;
    elements.filenameTemplate.value = currentSettings.filenameTemplate;
    elements.useNativePathPicker.checked = currentSettings.useNativePathPicker;
    elements.createStockFolders.checked = currentSettings.createStockFolders;
    elements.bulkMaxPages.value = String(currentSettings.bulkMaxPages);
    elements.bulkConcurrency.value = String(currentSettings.bulkConcurrency);
    elements.downloadToday.disabled = busy;
    elements.stopDailyDownload.hidden = !busy;
    elements.downloadDate.value = selectedDownloadDate || getTodayIsoDate();
    elements.downloadDate.disabled = busy;
    for (const button of elements.datePresetButtons) {
      button.disabled = busy;
      button.classList.toggle(
        'is-active',
        getPresetDate(button.dataset.datePreset) === (selectedDownloadDate || getTodayIsoDate())
      );
    }
    if (!busy) {
      renderDailyZipControls(null);
    }
    updatePreviews();
  }

  async function saveSettings() {
    currentSettings = normalizeSettings({
      downloadPathPrefix: elements.downloadPathPrefix.value,
      filenameTemplate: elements.filenameTemplate.value,
      useNativePathPicker: elements.useNativePathPicker.checked,
      createStockFolders: elements.createStockFolders.checked,
      bulkMaxPages: elements.bulkMaxPages.value,
      bulkConcurrency: elements.bulkConcurrency.value,
      bulkRetryMax: currentSettings.bulkRetryMax
    });

    syncUi();

    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: currentSettings
    });

    setStatus('설정을 저장했습니다.');
  }

  async function downloadSelectedDateReports() {
    if (busy) {
      return;
    }

    busy = true;
    collectionStopRequested = false;
    collectionAbortController = new AbortController();
    syncUi();

    try {
      const targetDate = selectedDownloadDate || getTodayIsoDate();
      const dateLabel = formatKoreanDate(targetDate);
      setStatus(`${dateLabel} 리포트를 수집하는 중입니다.`, false, {
        persist: true
      });

      const collectingSnapshot = {
        jobStatus: 'running',
        phase: 'collecting',
        targetDate,
        totalCount: 0,
        processedCount: 0
      };
      renderDailyZipControls(collectingSnapshot);
      renderStatusPanel(collectingSnapshot);

      const reports = await collectReportsForDate(targetDate);
      if (!reports.length) {
        renderStatusPanel({
          jobStatus: 'completed',
          phase: 'empty',
          targetDate,
          totalCount: 0,
          processedCount: 0
        });
        setStatus(`${dateLabel}에 등록된 PDF 리포트가 없습니다.`);
        busy = false;
        renderDailyZipControls(null);
        return;
      }

      renderStatusPanel({
        jobStatus: 'running',
        phase: 'found',
        targetDate,
        totalCount: reports.length,
        processedCount: 0,
        failedCount: 0
      });

      const response = await chrome.runtime.sendMessage({
        type: 'NAVER_REPORT_START_DAILY_ZIP',
        items: reports,
        settings: currentSettings,
        targetDate
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || '선택한 날짜의 다운로드를 시작하지 못했습니다.');
      }

      handleDailyZipUpdate(response.snapshot);
      setStatus(`${dateLabel} 리포트 ${reports.length}건 ZIP 생성을 시작했습니다.`, false, {
        persist: true
      });
    } catch (error) {
      if (collectionStopRequested || (error && error.name === 'AbortError')) {
        renderStatusPanel({
          jobStatus: 'stopped',
          phase: 'stopped',
          targetDate: selectedDownloadDate || getTodayIsoDate(),
          totalCount: 0,
          processedCount: 0
        });
        setStatus('선택한 날짜의 리포트 다운로드를 중단했습니다.');
      } else {
        setStatus(error && error.message ? error.message : String(error), true);
      }
      busy = false;
      renderDailyZipControls(null);
    } finally {
      collectionAbortController = null;
      syncUi();
    }
  }

  async function stopDailyDownload() {
    if (!busy) {
      return;
    }

    collectionStopRequested = true;
    elements.stopDailyDownload.disabled = true;
    setStatus('중단하는 중입니다.', false, {
      persist: true
    });

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
      const reports = await collectSectionReports(config, targetDate);
      collected.push(...reports);
    }

    return dedupeReports(collected).map((report) => ({
      ...report,
      zipPath: buildZipPathForReport(report),
      expectedFilename: buildZipPathForReport(report)
    }));
  }

  async function collectSectionReports(config, targetDate) {
    const reports = [];

    for (let page = 1; page <= currentSettings.bulkMaxPages; page += 1) {
      if (collectionStopRequested) {
        throw new DOMException('사용자가 중단했습니다.', 'AbortError');
      }

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

  function getTodayIsoDate() {
    const now = new Date();
    return formatIsoDateFromLocalDate(now);
  }

  function getYesterdayIsoDate() {
    const date = parseIsoDateToLocalDate(getTodayIsoDate());
    date.setDate(date.getDate() - 1);
    return formatIsoDateFromLocalDate(date);
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
      elements.downloadDate.value = selectedDownloadDate || getTodayIsoDate();
      setStatus(error && error.message ? error.message : String(error), true);
      return;
    }

    selectedDownloadDate = nextDate;
    elements.downloadDate.value = nextDate;

    const shouldAnimate = options && options.animate && previousDate && previousDate !== nextDate;
    if (shouldAnimate) {
      animatePrimaryDate(nextDate > previousDate ? 'up' : 'down');
    }

    syncUi();
    updatePreviews();

    if (!busy && (!options || options.renderIdleStatus !== false)) {
      renderStatusPanel(null);
    }
  }

  function animatePrimaryDate(direction) {
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

  function buildZipPathForReport(report) {
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

    const isActive = isDailyZipActive(snapshot);
    busy = isActive;

    if (snapshot.targetDate && snapshot.targetDate !== selectedDownloadDate) {
      if (isActive) {
        setSelectedDownloadDate(snapshot.targetDate, {
          animate: false,
          renderIdleStatus: false
        });
      } else {
        renderDailyZipControls(null);
        renderStatusPanel(null);
        return;
      }
    }

    if (!isActive && snapshot.targetDate && snapshot.targetDate !== selectedDownloadDate) {
      renderDailyZipControls(null);
      renderStatusPanel(null);
      return;
    }

    renderDailyZipControls(snapshot);
    renderStatusPanel(snapshot);

    if (snapshot.phase === 'completed') {
      setStatus(`${formatKoreanDate(snapshot.targetDate)} 리포트 다운로드가 완료되었습니다.`, false, {
        persist: true
      });
    } else if (snapshot.phase === 'failed') {
      setStatus(snapshot.error || '선택한 날짜의 ZIP 다운로드에 실패했습니다.', true);
    } else if (snapshot.phase === 'stopped') {
      setStatus('선택한 날짜의 리포트 다운로드를 중단했습니다.');
    } else if (isActive) {
      setStatus(getDailyZipStatusText(snapshot), false, {
        persist: true
      });
    }

    syncUi();
  }

  function renderDailyZipControls(snapshot) {
    const isActive = snapshot && isDailyZipActive(snapshot);
    const targetDate = snapshot && snapshot.targetDate
      ? snapshot.targetDate
      : selectedDownloadDate || getTodayIsoDate();

    elements.downloadToday.classList.toggle('is-running', Boolean(isActive));
    elements.downloadToday.disabled = Boolean(isActive);
    elements.stopDailyDownload.hidden = !isActive;
    elements.stopDailyDownload.disabled = snapshot && snapshot.phase === 'stopping';
    elements.downloadTodayLabel.textContent = formatKoreanDate(targetDate);
    elements.downloadTodayActionLabel.textContent = isActive
      ? getDailyZipButtonLabel(snapshot)
      : DOWNLOAD_ACTION_LABEL;
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

  function renderStatusPanel(snapshot) {
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
    const saveLocation = `Downloads/${zipFilename || `${currentSettings.downloadPathPrefix}/${targetDate}.zip`}`;

    elements.statusPanel.classList.toggle('is-running', isDailyZipActive(snapshot || {}));
    elements.statusPanel.classList.toggle('is-complete', phase === 'completed');
    elements.statusPanel.classList.toggle('is-error', phase === 'failed');

    if (phase === 'collecting') {
      setStatusPanelText(
        `${dateLabel} 리포트를 수집 중입니다`,
        '네이버 증권 리서치 목록 확인 중',
        `최대 ${currentSettings.bulkMaxPages}페이지 탐색`,
        {
          progress: true,
          percent: 18,
          countText: '목록 확인 중'
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

  function getDailyZipStatusText(snapshot) {
    const dateLabel = formatKoreanDate(snapshot.targetDate);

    if (snapshot.phase === 'zipping') {
      return 'PDF를 하나의 ZIP 파일로 묶는 중입니다.';
    }

    if (snapshot.phase === 'saving' || snapshot.phase === 'ready') {
      return `${snapshot.zipFilename} 저장을 준비하는 중입니다.`;
    }

    return `${dateLabel} 리포트 ${snapshot.processedCount || 0} / ${snapshot.totalCount || 0}건을 가져오는 중입니다.`;
  }

  function isDailyZipActive(snapshot) {
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

  function updatePreviews() {
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
      `저장 예시: Downloads/${currentSettings.downloadPathPrefix}/${targetDate}.zip`;
    elements.zipPreview.textContent =
      `ZIP 내부 예시: 종목분석/${sampleFilename}`;
    elements.filenamePreview.textContent = sampleFilename;
  }

  function setStatus(message, isError, options) {
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
})();
