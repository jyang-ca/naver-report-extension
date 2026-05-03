(() => {
  'use strict';

  if (window.__NAVER_REPORT_EXTENSION_BOOTSTRAPPED__) {
    return;
  }
  window.__NAVER_REPORT_EXTENSION_BOOTSTRAPPED__ = true;

  const utils = window.NaverReportUtils;
  const ROW_ICON_SVG = `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.5a.75.75 0 0 1 .75.75v6.19l1.97-1.97a.75.75 0 1 1 1.06 1.06L8.53 10.78a.75.75 0 0 1-1.06 0L4.22 7.53a.75.75 0 1 1 1.06-1.06l1.97 1.97V2.25A.75.75 0 0 1 8 1.5Z"></path>
      <path d="M3 11.25A1.75 1.75 0 0 1 4.75 9.5h6.5A1.75 1.75 0 0 1 13 11.25v1A1.75 1.75 0 0 1 11.25 14h-6.5A1.75 1.75 0 0 1 3 12.25v-1Zm1.5 0v1a.25.25 0 0 0 .25.25h6.5a.25.25 0 0 0 .25-.25v-1a.25.25 0 0 0-.25-.25h-6.5a.25.25 0 0 0-.25.25Z"></path>
    </svg>
  `;

  if (!utils) {
    return;
  }

  const {
    SETTINGS_STORAGE_KEY,
    DEFAULT_SETTINGS,
    migrateStoredSettings,
    normalizeSettings,
    normalizeDate,
    buildFilename,
    buildSectionZipFilename,
    buildReportZipEntryPath,
    getResearchPageConfig,
    getResearchSectionConfig,
    parseReportRow,
    parseReportRowsFromDocument,
    parseReportDetailDocument,
    dedupeReports
  } = utils;

  const currentPageConfig = getResearchPageConfig(window.location.href);
  if (!currentPageConfig) {
    return;
  }

  const isListPage = currentPageConfig.pageType === 'list';
  const isHomePage = currentPageConfig.pageType === 'home';

  const APP_ID = 'naver-report-extension';
  const TOOLBAR_ID = `${APP_ID}-toolbar`;
  const STATUS_ID = `${APP_ID}-status`;
  const MODAL_ID = `${APP_ID}-modal`;
  const MODAL_BODY_ID = `${APP_ID}-modal-body`;
  const DETAIL_STATUS_ID = `${APP_ID}-detail-status`;

  const MESSAGE_TYPES = {
    START_QUEUE: 'NAVER_REPORT_START_QUEUE',
    STOP_QUEUE: 'NAVER_REPORT_STOP_QUEUE',
    QUEUE_UPDATE: 'NAVER_REPORT_QUEUE_UPDATE',
    START_DAILY_ZIP: 'NAVER_REPORT_START_DAILY_ZIP',
    STOP_DAILY_ZIP: 'NAVER_REPORT_STOP_DAILY_ZIP',
    DAILY_ZIP_UPDATE: 'NAVER_REPORT_DAILY_ZIP_UPDATE'
  };

  const state = {
    pageType: isListPage ? 'list' : isHomePage ? 'home' : 'detail',
    pageConfig: currentPageConfig,
    settings: normalizeSettings(DEFAULT_SETTINGS),
    previewItems: [],
    currentDate: '',
    queueActive: false,
    activeJobId: '',
    activeJobKind: '',
    scanToken: null,
    port: null,
    detailReport: null,
    elements: {
      toolbar: null,
      dateInput: null,
      previewButton: null,
      downloadButton: null,
      stopButton: null,
      progressText: null,
      statusText: null,
      modal: null,
      modalTitle: null,
      modalDate: null,
      modalProgressText: null,
      modalProgressBar: null,
      modalProgressPercent: null,
      modalSummary: null,
      modalCurrentFile: null,
      modalBody: null,
      modalDownloadButton: null,
      modalStopButton: null,
      detailStatus: null
    }
  };

  init().catch((error) => {
    console.error('Failed to initialize Naver Report Downloader:', error);
  });

  async function init() {
    state.settings = await loadSettings();
    connectPort();
    attachMessageListeners();

    if (state.pageType === 'list') {
      initListPage();
    } else if (state.pageType === 'home') {
      initHomePage();
    } else {
      initDetailPage();
    }
  }

  async function loadSettings() {
    const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
    const storedSettings = result && result[SETTINGS_STORAGE_KEY];
    const migratedStoredSettings = migrateStoredSettings(storedSettings);

    if (!storedSettings || JSON.stringify(storedSettings) !== JSON.stringify(migratedStoredSettings)) {
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: migratedStoredSettings
      });
    }

    return normalizeSettings(migratedStoredSettings);
  }

  function connectPort() {
    try {
      const port = chrome.runtime.connect({ name: 'naver-report' });
      state.port = port;
      port.onMessage.addListener(handleRuntimeMessage);
      port.onDisconnect.addListener(() => {
        if (state.port === port) {
          state.port = null;
        }
      });
    } catch (_error) {
      state.port = null;
    }
  }

  function attachMessageListeners() {
    chrome.runtime.onMessage.addListener((message) => {
      handleRuntimeMessage(message);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[SETTINGS_STORAGE_KEY]) {
        return;
      }

      state.settings = normalizeSettings(migrateStoredSettings(changes[SETTINGS_STORAGE_KEY].newValue));

      if (state.pageType === 'list') {
        decorateVisibleRows();
        if (!state.queueActive && state.previewItems.length) {
          state.previewItems = state.previewItems.map((item) => ({
            ...item,
            expectedFilename: buildReportZipEntryPath(item, state.settings)
          }));
          renderPreviewModal();
        }
      } else if (state.pageType === 'home') {
        decorateResearchHomeRows();
      } else {
        state.detailReport = parseReportDetailDocument(document, {
          settings: state.settings,
          baseUrl: window.location.href
        });
      }

      setStatus('설정을 다시 불러왔습니다.');
    });
  }

  function initListPage() {
    injectToolbar();
    injectModal();
    decorateVisibleRows();
    state.elements.dateInput.value = inferInitialDate();
    updateProgressText();
    syncButtons();
    setStatus('날짜를 선택한 뒤 미리보기 또는 다운로드를 눌러주세요.');
  }

  function initHomePage() {
    decorateResearchHomeRows();
  }

  function initDetailPage() {
    state.detailReport = parseReportDetailDocument(document, {
      settings: state.settings,
      baseUrl: window.location.href
    });

    if (!state.detailReport) {
      return;
    }

    injectDetailStatus();
    bindDetailDownloadLinks();
    setStatus('상세 페이지 다운로드에 확장 파일명 규칙이 적용됩니다.');
  }

  function injectToolbar() {
    if (document.getElementById(TOOLBAR_ID)) {
      hydrateListReferences();
      return;
    }

    const table = document.querySelector('.box_type_m table.type_1');
    if (!table) {
      throw new Error('Research report table was not found on the page.');
    }

    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.className = `${APP_ID}__toolbar`;
    toolbar.innerHTML = `
      <label class="${APP_ID}__field">
        <span>날짜</span>
        <input type="date" id="${APP_ID}-date" />
      </label>
      <button type="button" id="${APP_ID}-preview">미리보기</button>
      <button type="button" id="${APP_ID}-download">다운로드</button>
      <button type="button" id="${APP_ID}-stop" class="${APP_ID}__danger">중지</button>
      <span id="${APP_ID}-progress" class="${APP_ID}__progress">0 / 0개 완료</span>
    `;

    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.className = `${APP_ID}__status`;

    table.parentElement.insertBefore(toolbar, table);
    table.parentElement.insertBefore(status, table);

    hydrateListReferences();

    state.elements.previewButton.addEventListener('click', () => {
      void previewSelectedDate();
    });
    state.elements.downloadButton.addEventListener('click', () => {
      void startBulkDownload();
    });
    state.elements.stopButton.addEventListener('click', () => {
      void stopCurrentWork();
    });
  }

  function hydrateListReferences() {
    state.elements.toolbar = document.getElementById(TOOLBAR_ID);
    state.elements.dateInput = document.getElementById(`${APP_ID}-date`);
    state.elements.previewButton = document.getElementById(`${APP_ID}-preview`);
    state.elements.downloadButton = document.getElementById(`${APP_ID}-download`);
    state.elements.stopButton = document.getElementById(`${APP_ID}-stop`);
    state.elements.progressText = document.getElementById(`${APP_ID}-progress`);
    state.elements.statusText = document.getElementById(STATUS_ID);
  }

  function injectModal() {
    if (document.getElementById(MODAL_ID)) {
      hydrateModalReferences();
      return;
    }

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = `${APP_ID}__modal`;
    modal.hidden = true;
    modal.innerHTML = `
      <div class="${APP_ID}__modal-scrim" data-modal-close="true"></div>
      <div class="${APP_ID}__modal-dialog" role="dialog" aria-modal="true" aria-labelledby="${APP_ID}-modal-title">
        <div class="${APP_ID}__modal-header">
          <div>
            <h3 id="${APP_ID}-modal-title">날짜별 리포트 미리보기</h3>
            <p id="${APP_ID}-modal-date" class="${APP_ID}__modal-date"></p>
          </div>
          <button type="button" class="${APP_ID}__modal-close" data-modal-close="true" aria-label="닫기">×</button>
        </div>
        <div class="${APP_ID}__modal-toolbar">
          <div class="${APP_ID}__modal-summary">
            <strong id="${APP_ID}-modal-progress">0 / 0개 완료</strong>
            <span id="${APP_ID}-modal-summary"></span>
            <div class="${APP_ID}__modal-progress-track" aria-hidden="true">
              <span id="${APP_ID}-modal-progress-bar" class="${APP_ID}__modal-progress-bar"></span>
            </div>
            <span id="${APP_ID}-modal-progress-percent" class="${APP_ID}__modal-progress-percent">0%</span>
            <span id="${APP_ID}-modal-current-file" class="${APP_ID}__modal-current-file" hidden></span>
          </div>
          <div class="${APP_ID}__modal-actions">
            <button type="button" id="${APP_ID}-modal-download">다운로드 시작</button>
            <button type="button" id="${APP_ID}-modal-stop" class="${APP_ID}__danger">중지</button>
          </div>
        </div>
        <div id="${MODAL_BODY_ID}" class="${APP_ID}__modal-body"></div>
      </div>
    `;

    document.body.appendChild(modal);
    hydrateModalReferences();

    modal.addEventListener('click', (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.modalClose === 'true') {
        hideModal();
      }
    });

    state.elements.modalDownloadButton.addEventListener('click', () => {
      void handleModalDownloadAction();
    });
    state.elements.modalStopButton.addEventListener('click', () => {
      void stopCurrentWork();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.elements.modal && !state.elements.modal.hidden) {
        hideModal();
      }
    });
  }

  function hydrateModalReferences() {
    state.elements.modal = document.getElementById(MODAL_ID);
    state.elements.modalTitle = document.getElementById(`${APP_ID}-modal-title`);
    state.elements.modalDate = document.getElementById(`${APP_ID}-modal-date`);
    state.elements.modalProgressText = document.getElementById(`${APP_ID}-modal-progress`);
    state.elements.modalProgressBar = document.getElementById(`${APP_ID}-modal-progress-bar`);
    state.elements.modalProgressPercent = document.getElementById(`${APP_ID}-modal-progress-percent`);
    state.elements.modalSummary = document.getElementById(`${APP_ID}-modal-summary`);
    state.elements.modalCurrentFile = document.getElementById(`${APP_ID}-modal-current-file`);
    state.elements.modalBody = document.getElementById(MODAL_BODY_ID);
    state.elements.modalDownloadButton = document.getElementById(`${APP_ID}-modal-download`);
    state.elements.modalStopButton = document.getElementById(`${APP_ID}-modal-stop`);
  }

  function injectDetailStatus() {
    if (document.getElementById(DETAIL_STATUS_ID)) {
      state.elements.detailStatus = document.getElementById(DETAIL_STATUS_ID);
      return;
    }

    const anchor = document.querySelector('.box_type_m3') || document.querySelector('.sub_tlt');
    if (!anchor) {
      return;
    }

    const status = document.createElement('div');
    status.id = DETAIL_STATUS_ID;
    status.className = `${APP_ID}__detail-status`;
    anchor.insertAdjacentElement('afterend', status);
    state.elements.detailStatus = status;
  }

  function bindDetailDownloadLinks() {
    for (const anchor of getDetailDownloadAnchors()) {
      if (anchor.dataset.naverReportIntercepted === 'true') {
        continue;
      }

      anchor.dataset.naverReportIntercepted = 'true';
      anchor.title = '확장 다운로드 파일명으로 저장';

      anchor.addEventListener('click', (event) => {
        if (shouldBypassLinkIntercept(event)) {
          return;
        }

        event.preventDefault();
        void startDetailDownload();
      });
    }
  }

  function decorateVisibleRows() {
    const rows = Array.from(document.querySelectorAll('.box_type_m table.type_1 tr'));
    for (const row of rows) {
      decorateReportRow(row, state.pageConfig);
    }
  }

  function decorateResearchHomeRows() {
    const sectionBoxes = Array.from(document.querySelectorAll('.box_type_m'));
    for (const sectionBox of sectionBoxes) {
      const sectionConfig = getResearchHomeSectionConfig(sectionBox);
      if (!sectionConfig) {
        continue;
      }

      const rows = Array.from(sectionBox.querySelectorAll('table tr'));
      for (const row of rows) {
        decorateReportRow(row, sectionConfig);
      }
    }
  }

  function decorateReportRow(row, pageConfig) {
    if (row.dataset.naverReportBound === 'true') {
      return;
    }

    const report = parseReportRow(row, {
      settings: state.settings,
      baseUrl: window.location.href,
      pageConfig
    });
    if (!report) {
      return;
    }

    const fileCell = getReportFileCell(row);
    if (!fileCell) {
      return;
    }

    row.dataset.naverReportBound = 'true';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${APP_ID}__row-download`;
    button.setAttribute('aria-label', `${report.stockName} 리포트 다운로드`);
    button.title = `${report.stockName} 리포트 다운로드`;
    button.innerHTML = ROW_ICON_SVG;
    button.addEventListener('click', () => {
      void startRowDownload(report);
    });

    const wrapper = document.createElement('span');
    wrapper.className = `${APP_ID}__row-download-wrap`;
    wrapper.appendChild(button);
    const pdfAnchor = fileCell.querySelector('a[href]');
    if (pdfAnchor) {
      pdfAnchor.classList.add(`${APP_ID}__native-pdf-link`);
      fileCell.insertBefore(wrapper, pdfAnchor);
    } else {
      fileCell.appendChild(wrapper);
    }
  }

  async function previewSelectedDate() {
    const selectedDate = readSelectedDate();
    if (!selectedDate) {
      return false;
    }

    cancelPreviewScan();
    const scanToken = { cancelled: false };
    state.scanToken = scanToken;
    syncButtons();
    setStatus('선택 날짜의 리포트를 수집하는 중입니다.');

    try {
      const preview = await collectReportsForDate(selectedDate, scanToken);
      if (scanToken.cancelled) {
        setStatus('리포트 수집을 중지했습니다.');
        return false;
      }

      state.currentDate = selectedDate;
      state.previewItems = preview.items.map(createPreviewItem);
      renderPreviewModal();
      showModal();
      setStatus(preview.message);
      return true;
    } catch (error) {
      setStatus(formatError(error), true);
      return false;
    } finally {
      if (state.scanToken === scanToken) {
        state.scanToken = null;
      }
      syncButtons();
    }
  }

  async function startBulkDownload() {
    if (state.pageType !== 'list') {
      return;
    }

    if (state.queueActive) {
      setStatus('이미 다운로드 큐가 실행 중입니다.', true);
      showModal();
      return;
    }

    const selectedDate = readSelectedDate();
    if (!selectedDate) {
      return;
    }

    const previewNeedsRefresh =
      !state.previewItems.length || state.currentDate !== selectedDate;

    if (previewNeedsRefresh) {
      cancelPreviewScan();
      const scanToken = { cancelled: false };
      state.scanToken = scanToken;
      syncButtons();
      setStatus('선택 날짜의 리포트를 수집하는 중입니다.');

      try {
        const preview = await collectReportsForDate(selectedDate, scanToken);
        if (scanToken.cancelled) {
          setStatus('리포트 수집을 중지했습니다.');
          return;
        }

        state.currentDate = selectedDate;
        state.previewItems = preview.items.map(createPreviewItem);
        setStatus(preview.message);
      } catch (error) {
        setStatus(formatError(error), true);
        return;
      } finally {
        if (state.scanToken === scanToken) {
          state.scanToken = null;
        }
        syncButtons();
      }
    }

    const pendingItems = state.previewItems.filter((item) => item.status !== 'completed');
    if (!pendingItems.length) {
      setStatus('다운로드할 리포트가 없습니다.');
      return;
    }

    try {
      await requestZipStart(pendingItems, state.currentDate);
    } catch (error) {
      setStatus(formatError(error), true);
    }
  }

  async function handleModalDownloadAction() {
    if (state.queueActive) {
      return;
    }

    const snapshot = buildLocalSnapshot();
    const retryableItems = state.previewItems.filter((item) =>
      item.status === 'failed' || item.status === 'skipped'
    );
    const allCompleted = state.previewItems.length > 0 &&
      snapshot.completedCount === state.previewItems.length;

    if (retryableItems.length) {
      await requestRetryDownload(retryableItems);
      return;
    }

    if (allCompleted) {
      state.previewItems = state.previewItems.map((item) => ({
        ...item,
        status: 'pending',
        error: '',
        attemptCount: 0,
        retriesRemaining: state.settings.bulkRetryMax
      }));
      renderPreviewModal();
    }

    await startBulkDownload();
  }

  async function requestRetryDownload(items) {
    if (!items.length) {
      return;
    }

    const retryItems = items.map((item) => ({
      ...item,
      status: 'pending',
      error: '',
      attemptCount: 0,
      retriesRemaining: state.settings.bulkRetryMax
    }));
    const retryByUrl = new Map(retryItems.map((item) => [item.pdfUrl, item]));
    state.previewItems = state.previewItems.map((item) => retryByUrl.get(item.pdfUrl) || item);
    renderPreviewModal();

    try {
      await requestZipStart(retryItems, state.currentDate);
    } catch (error) {
      setStatus(formatError(error), true);
    }
  }

  async function startRowDownload(report) {
    const item = createPreviewItem(report);
    state.currentDate = item.date;
    state.previewItems = [item];
    setStatus('리포트 다운로드를 시작합니다.');

    try {
      await requestQueueStart([item], item.date);
    } catch (error) {
      setStatus(formatError(error), true);
    }
  }

  async function startDetailDownload() {
    if (state.queueActive) {
      setStatus('이미 다운로드가 진행 중입니다.', true);
      return;
    }

    const report = parseReportDetailDocument(document, {
      settings: state.settings,
      baseUrl: window.location.href
    });

    if (!report) {
      setStatus('상세 페이지 리포트 정보를 읽을 수 없습니다.', true);
      return;
    }

    state.detailReport = report;
    state.currentDate = report.date;
    setStatus('상세 페이지 리포트 다운로드를 시작합니다.');

    try {
      await requestQueueStart([createPreviewItem(report)], report.date);
    } catch (error) {
      setStatus(formatError(error), true);
    }
  }

  async function requestQueueStart(items, targetDate) {
    if (!items.length) {
      throw new Error('다운로드할 항목이 없습니다.');
    }

    const payloadItems = items.map((item) => ({
      date: item.date,
      sectionName: item.sectionName || state.pageConfig.sectionName,
      stockName: item.stockName,
      broker: item.broker,
      reportTitle: item.reportTitle,
      pdfUrl: item.pdfUrl,
      expectedFilename: buildFilename(item, state.settings)
    }));

    state.queueActive = true;
    state.activeJobKind = 'queue';
    syncButtons();
    renderPreviewModal();

    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.START_QUEUE,
        items: payloadItems,
        settings: state.settings,
        targetDate: targetDate || ''
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Failed to start the download queue.');
      }

      handleRuntimeMessage({
        type: MESSAGE_TYPES.QUEUE_UPDATE,
        snapshot: response.snapshot
      });
    } catch (error) {
      state.queueActive = false;
      state.activeJobKind = '';
      syncButtons();
      throw error;
    }
  }

  async function requestZipStart(items, targetDate) {
    if (!items.length) {
      throw new Error('다운로드할 항목이 없습니다.');
    }

    const payloadItems = items.map((item) => {
      const zipPath = buildReportZipEntryPath(item, state.settings);
      return {
        date: item.date,
        sectionName: item.sectionName || state.pageConfig.sectionName,
        stockName: item.stockName,
        broker: item.broker,
        reportTitle: item.reportTitle,
        pdfUrl: item.pdfUrl,
        zipPath,
        expectedFilename: zipPath
      };
    });

    state.queueActive = true;
    state.activeJobKind = 'zip';
    syncButtons();
    renderPreviewModal();

    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.START_DAILY_ZIP,
        source: 'content',
        items: payloadItems,
        settings: state.settings,
        targetDate: targetDate || '',
        zipFilename: buildSectionZipFilename(state.settings, state.pageConfig.sectionName)
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'ZIP 다운로드를 시작하지 못했습니다.');
      }

      handleRuntimeMessage({
        type: MESSAGE_TYPES.DAILY_ZIP_UPDATE,
        snapshot: response.snapshot
      });
    } catch (error) {
      state.queueActive = false;
      state.activeJobKind = '';
      syncButtons();
      throw error;
    }
  }

  async function stopCurrentWork() {
    if (state.scanToken) {
      cancelPreviewScan();
      setStatus('리포트 수집 중지 요청을 반영했습니다.');
      syncButtons();
      return;
    }

    if (!state.queueActive) {
      setStatus('중지할 활성 작업이 없습니다.');
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: state.activeJobKind === 'zip'
        ? MESSAGE_TYPES.STOP_DAILY_ZIP
        : MESSAGE_TYPES.STOP_QUEUE
    });

    if (!response || !response.ok) {
      setStatus((response && response.error) || '큐 중지 요청에 실패했습니다.', true);
      return;
    }

    if (response.snapshot) {
      handleRuntimeMessage({
        type: state.activeJobKind === 'zip'
          ? MESSAGE_TYPES.DAILY_ZIP_UPDATE
          : MESSAGE_TYPES.QUEUE_UPDATE,
        snapshot: response.snapshot
      });
    }
  }

  async function collectReportsForDate(targetDate, scanToken) {
    const currentPage = getPageNumberFromUrl(window.location.href) || 1;
    const collected = [];
    let scannedPages = 0;

    for (let page = 1; page <= state.settings.bulkMaxPages; page += 1) {
      if (scanToken.cancelled) {
        break;
      }

      const pageUrl = buildListPageUrl(page);
      const doc = page === currentPage
        ? document
        : await fetchResearchPage(pageUrl);

      const pageItems = parseReportRowsFromDocument(doc, {
        settings: state.settings,
        baseUrl: pageUrl
      });
      if (!pageItems.length) {
        break;
      }

      scannedPages += 1;
      collected.push(...pageItems.filter((item) => item.date === targetDate));

      const allRowsOlderThanTarget = pageItems.every((item) => item.date < targetDate);
      if (allRowsOlderThanTarget || !hasNextPage(doc, page)) {
        break;
      }
    }

    const filtered = dedupeReports(collected);
    return {
      items: filtered,
      message: `${targetDate} ${state.pageConfig.sectionName} 리포트 ${filtered.length}건을 ${scannedPages}페이지에서 찾았습니다.`
    };
  }

  async function fetchResearchPage(url) {
    const response = await fetch(url, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`페이지를 불러오지 못했습니다: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('euc-kr');
    const html = decoder.decode(buffer);
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function handleRuntimeMessage(message) {
    if (!message || !message.snapshot) {
      return;
    }

    if (message.type === MESSAGE_TYPES.DAILY_ZIP_UPDATE) {
      handleZipUpdate(message.snapshot);
      return;
    }

    if (message.type !== MESSAGE_TYPES.QUEUE_UPDATE) {
      return;
    }

    const snapshot = message.snapshot;
    state.activeJobId = snapshot.jobId || '';
    state.queueActive = snapshot.jobStatus === 'queued' ||
      snapshot.jobStatus === 'running' ||
      snapshot.jobStatus === 'stopping';
    state.activeJobKind = state.queueActive ? 'queue' : state.activeJobKind;
    if (!state.queueActive && state.activeJobKind === 'queue') {
      state.activeJobKind = '';
    }

    if (state.pageType === 'list') {
      const snapshotItems = snapshot.items.map((item) => ({
        date: item.date,
        stockName: item.stockName,
        broker: item.broker,
        reportTitle: item.reportTitle,
        pdfUrl: item.pdfUrl,
        expectedFilename: item.expectedFilename,
        status: item.status,
        error: item.error,
        attemptCount: item.attemptCount,
        retriesRemaining: item.retriesRemaining
      }));

      if (state.previewItems.length && snapshotItems.length < state.previewItems.length) {
        const updatesByUrl = new Map(snapshotItems.map((item) => [item.pdfUrl, item]));
        state.previewItems = state.previewItems.map((item) => updatesByUrl.get(item.pdfUrl) || item);
      } else {
        state.previewItems = snapshotItems;
      }

      if (snapshot.targetDate) {
        state.currentDate = snapshot.targetDate;
      if (state.elements.dateInput) {
          state.elements.dateInput.value = snapshot.targetDate;
        }
      }

      if (state.elements.modal && !state.elements.modal.hidden) {
        renderPreviewModal();
      }
    }

    updateProgressText(snapshot);
    syncButtons();
    applyStatusFromSnapshot(snapshot);
  }

  function handleZipUpdate(snapshot) {
    state.activeJobId = snapshot.jobId || '';
    state.queueActive = isActiveSnapshot(snapshot);
    state.activeJobKind = state.queueActive ? 'zip' : '';

    if (state.pageType === 'list') {
      const snapshotItems = Array.isArray(snapshot.items)
        ? snapshot.items.map((item) => ({
            date: item.date,
            sectionName: item.sectionName || state.pageConfig.sectionName,
            stockName: item.stockName,
            broker: item.broker,
            reportTitle: item.reportTitle,
            pdfUrl: item.pdfUrl,
            expectedFilename: item.expectedFilename || item.zipPath || '',
            status: item.status,
            error: item.error,
            attemptCount: item.attemptCount,
            retriesRemaining: item.retriesRemaining
          }))
        : [];

      if (state.previewItems.length && snapshotItems.length < state.previewItems.length) {
        const updatesByUrl = new Map(snapshotItems.map((item) => [item.pdfUrl, item]));
        state.previewItems = state.previewItems.map((item) => updatesByUrl.get(item.pdfUrl) || item);
      } else {
        state.previewItems = snapshotItems;
      }

      if (snapshot.targetDate) {
        state.currentDate = snapshot.targetDate;
        if (state.elements.dateInput) {
          state.elements.dateInput.value = snapshot.targetDate;
        }
      }

      if (state.elements.modal && !state.elements.modal.hidden) {
        renderPreviewModal();
      }
    }

    updateProgressText(snapshot);
    syncButtons();
    applyStatusFromSnapshot(snapshot);
  }

  function renderPreviewModal() {
    if (state.pageType !== 'list' || !state.elements.modalBody) {
      return;
    }

    const snapshot = buildLocalSnapshot();
    const hasStarted = hasDownloadStarted();
    const showStatusColumn = hasStarted || state.queueActive;
    const title = getModalTitle(snapshot, hasStarted);
    if (state.elements.modalTitle) {
      state.elements.modalTitle.textContent = title;
    }
    if (state.elements.modalDate) {
      state.elements.modalDate.textContent = getModalSubtitle(snapshot, hasStarted);
    }

    if (!state.previewItems.length) {
      state.elements.modalBody.innerHTML = `
        <div class="${APP_ID}__empty">
          선택한 날짜의 리포트를 찾으면 이 모달에서 저장될 파일명을 확인할 수 있습니다.
        </div>
      `;
      updateProgressText();
      syncModalActions(snapshot);
      return;
    }

    const rows = state.previewItems.map((item) => {
      const shouldShowError = item.error && item.status !== 'skipped';
      const errorHtml = shouldShowError
        ? `<div class="${APP_ID}__error">${escapeHtml(item.error)}</div>`
        : '';
      const statusCell = showStatusColumn
        ? `<td class="${APP_ID}__cell-status ${APP_ID}__sticky-col"><span class="${APP_ID}__status-pill ${APP_ID}__status-pill--${item.status}">${escapeHtml(getStatusLabel(item.status))}</span>${errorHtml}</td>`
        : '';
      const stockName = escapeHtml(item.stockName);
      const broker = escapeHtml(item.broker);
      const reportTitle = escapeHtml(item.reportTitle);
      const expectedFilename = escapeHtml(item.expectedFilename);

      return `
        <tr class="${APP_ID}__row ${APP_ID}__row--${item.status}">
          ${statusCell}
          <td class="${APP_ID}__cell-stock ${APP_ID}__sticky-stock" style="left: ${showStatusColumn ? '96px' : '0'}" title="${escapeAttribute(item.stockName)}">${stockName}</td>
          <td title="${escapeAttribute(item.broker)}">${broker}</td>
          <td class="${APP_ID}__cell-title" title="${escapeAttribute(item.reportTitle)}">${reportTitle}</td>
          <td class="${APP_ID}__cell-filename">
            <code title="${escapeAttribute(item.expectedFilename)}">${expectedFilename}</code>
          </td>
        </tr>
      `;
    }).join('');

    const statusCol = showStatusColumn ? '<col style="width: 96px" />' : '';
    const statusHeader = showStatusColumn ? `<th class="${APP_ID}__sticky-col">상태</th>` : '';

    state.elements.modalBody.innerHTML = `
      <div class="${APP_ID}__table-wrap">
        <table class="${APP_ID}__table">
          <colgroup>
            ${statusCol}
            <col style="width: 130px" />
            <col style="width: 120px" />
            <col style="width: 360px" />
            <col style="width: 380px" />
          </colgroup>
          <thead>
            <tr>
              ${statusHeader}
              <th class="${APP_ID}__sticky-stock" style="left: ${showStatusColumn ? '96px' : '0'}">종목명</th>
              <th>증권사</th>
              <th>리포트 제목</th>
              <th>ZIP 내부 파일명</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    updateProgressText();
    syncModalActions(snapshot);
  }

  function applyStatusFromSnapshot(snapshot) {
    const suffix = snapshot.failedCount ? ` · 실패 ${snapshot.failedCount}` : '';
    if (snapshot.jobStatus === 'completed') {
      if (snapshot.zipFilename) {
        setStatus(`ZIP 다운로드 완료: Downloads/${snapshot.zipFilename}${suffix}`);
        return;
      }

      if (state.pageType === 'detail') {
        const firstItem = snapshot.items && snapshot.items[0];
        setStatus(
          firstItem
            ? `다운로드 완료: ${firstItem.expectedFilename}`
            : '다운로드를 완료했습니다.'
        );
      } else {
        setStatus(`다운로드 완료${suffix}`);
      }
      return;
    }

    if (snapshot.jobStatus === 'stopped') {
      setStatus(`다운로드를 중지했습니다${suffix}`);
      return;
    }

    if (snapshot.jobStatus === 'stopping') {
      setStatus('다운로드를 중지하는 중입니다.');
      return;
    }

    setStatus(`${snapshot.completedCount} / ${snapshot.totalCount}개 완료${suffix}`);
  }

  function createPreviewItem(report) {
    return {
      date: report.date,
      sectionName: report.sectionName || state.pageConfig.sectionName,
      stockName: report.stockName,
      broker: report.broker,
      reportTitle: report.reportTitle,
      pdfUrl: report.pdfUrl,
      expectedFilename: buildReportZipEntryPath(report, state.settings),
      status: 'pending',
      error: '',
      attemptCount: 0,
      retriesRemaining: state.settings.bulkRetryMax
    };
  }

  function updateProgressText(snapshot) {
    const source = snapshot || buildLocalSnapshot();
    const extras = [];
    if (source.failedCount) {
      extras.push(`실패 ${source.failedCount}`);
    }
    if (source.skippedCount) {
      extras.push(`중지됨 ${source.skippedCount}`);
    }

    const message = `${source.completedCount} / ${source.totalCount}개 완료${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    if (state.elements.progressText) {
      state.elements.progressText.textContent = message;
    }
    if (state.elements.modalProgressText) {
      state.elements.modalProgressText.textContent = message;
    }
    if (state.elements.modalProgressBar) {
      const percent = source.totalCount > 0
        ? Math.min(100, Math.round((source.completedCount / source.totalCount) * 100))
        : 0;
      state.elements.modalProgressBar.style.width = `${percent}%`;
      if (state.elements.modalProgressPercent) {
        state.elements.modalProgressPercent.textContent = `${percent}%`;
      }
    }
    if (state.elements.modalSummary) {
      const pendingText = source.pendingCount ? `대기 ${source.pendingCount}` : '';
      const downloadingText = source.downloadingCount ? `진행 중 ${source.downloadingCount}` : '';
      const completedText = `완료 ${source.completedCount}`;
      const failedText = source.failedCount ? `실패 ${source.failedCount}` : '';
      state.elements.modalSummary.textContent = [
        completedText,
        downloadingText,
        pendingText,
        failedText
      ].filter(Boolean).join(' · ');
    }
    if (state.elements.modalCurrentFile) {
      const currentItem = getCurrentItem();
      if (currentItem && state.queueActive) {
        state.elements.modalCurrentFile.hidden = false;
        state.elements.modalCurrentFile.textContent =
          `현재 파일: ${getFilenameOnly(currentItem.expectedFilename)}`;
      } else {
        state.elements.modalCurrentFile.hidden = true;
        state.elements.modalCurrentFile.textContent = '';
      }
    }
  }

  function buildLocalSnapshot() {
    const counts = {
      totalCount: state.previewItems.length,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      pendingCount: 0,
      downloadingCount: 0
    };

    for (const item of state.previewItems) {
      if (item.status === 'completed') {
        counts.completedCount += 1;
      } else if (item.status === 'failed') {
        counts.failedCount += 1;
      } else if (item.status === 'skipped') {
        counts.skippedCount += 1;
      } else if (item.status === 'downloading') {
        counts.downloadingCount += 1;
      } else {
        counts.pendingCount += 1;
      }
    }

    return counts;
  }

  function hasDownloadStarted() {
    return state.previewItems.some((item) => item.status !== 'pending');
  }

  function getModalTitle(snapshot, hasStarted) {
    if (state.queueActive) {
      return `${state.pageConfig.sectionName} 리포트 다운로드 중`;
    }

    if (hasStarted && snapshot.failedCount) {
      return `${state.pageConfig.sectionName} 리포트 일부 실패`;
    }

    if (hasStarted && snapshot.totalCount && snapshot.completedCount === snapshot.totalCount) {
      return `${state.pageConfig.sectionName} 리포트 다운로드 완료`;
    }

    return `${state.pageConfig.sectionName} 리포트 미리보기`;
  }

  function getModalSubtitle(snapshot, hasStarted) {
    if (!state.currentDate) {
      return '';
    }

    const zipText = `ZIP: ${getFilenameOnly(buildSectionZipFilename(state.settings, state.pageConfig.sectionName))}`;

    if (!snapshot.totalCount) {
      return `${state.currentDate} · 리포트 없음`;
    }

    if (state.queueActive || hasStarted) {
      const suffix = snapshot.failedCount ? ` · 실패 ${snapshot.failedCount}개` : '';
      return `${state.currentDate} · ${snapshot.completedCount} / ${snapshot.totalCount}개 완료${suffix} · ${zipText}`;
    }

    return `${state.currentDate} · ${snapshot.totalCount}개 리포트 발견 · ${zipText}`;
  }

  function isActiveSnapshot(snapshot) {
    if (!snapshot) {
      return false;
    }

    return snapshot.jobStatus === 'queued' ||
      snapshot.jobStatus === 'running' ||
      snapshot.jobStatus === 'stopping' ||
      snapshot.phase === 'queued' ||
      snapshot.phase === 'downloading' ||
      snapshot.phase === 'zipping' ||
      snapshot.phase === 'ready' ||
      snapshot.phase === 'saving' ||
      snapshot.phase === 'stopping';
  }

  function syncModalActions(snapshot) {
    if (!state.elements.modalDownloadButton || !state.elements.modalStopButton) {
      return;
    }

    const total = snapshot.totalCount || 0;
    const retryableCount = snapshot.failedCount + snapshot.skippedCount;
    const allCompleted = total > 0 && snapshot.completedCount === total;

    if (state.queueActive) {
      state.elements.modalDownloadButton.textContent = '다운로드 중...';
      state.elements.modalDownloadButton.disabled = true;
      state.elements.modalStopButton.hidden = false;
      state.elements.modalStopButton.disabled = false;
      return;
    }

    state.elements.modalStopButton.hidden = true;
    state.elements.modalStopButton.disabled = true;

    if (retryableCount) {
      state.elements.modalDownloadButton.textContent = `실패한 항목 다시 시도 (${retryableCount})`;
      state.elements.modalDownloadButton.disabled = false;
      return;
    }

    if (allCompleted) {
      state.elements.modalDownloadButton.textContent = '다시 다운로드';
      state.elements.modalDownloadButton.disabled = false;
      return;
    }

    state.elements.modalDownloadButton.textContent = total
      ? `${total}개 리포트 다운로드`
      : '다운로드 시작';
    state.elements.modalDownloadButton.disabled = !total || Boolean(state.scanToken);
  }

  function getStatusLabel(status) {
    const labels = {
      pending: '대기',
      downloading: '진행 중',
      completed: '완료',
      failed: '실패',
      skipped: '중지됨'
    };
    return labels[status] || status || '대기';
  }

  function getCurrentItem() {
    return state.previewItems.find((item) => item.status === 'downloading') ||
      state.previewItems.find((item) => item.status === 'pending');
  }

  function getFilenameOnly(path) {
    const parts = String(path || '').split('/');
    return parts[parts.length - 1] || String(path || '');
  }

  function syncButtons() {
    const scanning = Boolean(state.scanToken);
    const hasPreviewItems = state.previewItems.length > 0;

    if (state.elements.previewButton) {
      state.elements.previewButton.disabled = state.queueActive || scanning;
    }
    if (state.elements.downloadButton) {
      state.elements.downloadButton.disabled = state.queueActive || scanning;
    }
    if (state.elements.stopButton) {
      state.elements.stopButton.disabled = !state.queueActive && !scanning;
    }
    if (state.elements.modalDownloadButton) {
      const localSnapshot = buildLocalSnapshot();
      const retryableCount = localSnapshot.failedCount + localSnapshot.skippedCount;
      const allCompleted = hasPreviewItems &&
        localSnapshot.completedCount === localSnapshot.totalCount;
      state.elements.modalDownloadButton.disabled =
        state.queueActive || scanning || (!hasPreviewItems && !retryableCount && !allCompleted);
    }
    if (state.elements.modalStopButton) {
      state.elements.modalStopButton.disabled = !state.queueActive && !scanning;
      state.elements.modalStopButton.hidden = !state.queueActive && !scanning;
    }
  }

  function readSelectedDate() {
    if (!state.elements.dateInput) {
      setStatus('날짜 입력 필드를 찾을 수 없습니다.', true);
      return '';
    }

    try {
      const selectedDate = normalizeDate(state.elements.dateInput.value);
      state.elements.dateInput.value = selectedDate;
      return selectedDate;
    } catch (error) {
      setStatus(formatError(error), true);
      return '';
    }
  }

  function inferInitialDate() {
    const rows = parseReportRowsFromDocument(document, {
      settings: state.settings,
      baseUrl: window.location.href
    });

    if (rows.length) {
      return rows[0].date;
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function buildListPageUrl(page) {
    const url = new URL(state.pageConfig.listPath, window.location.origin);
    url.searchParams.set('page', String(page));
    return url.href;
  }

  function hasNextPage(doc, currentPage) {
    const links = Array.from(doc.querySelectorAll('.Nnavi a[href*="page="]'));
    return links.some((link) => getPageNumberFromUrl(link.href) > currentPage);
  }

  function getPageNumberFromUrl(url) {
    try {
      const page = new URL(url, window.location.origin).searchParams.get('page');
      const parsed = Number.parseInt(page || '1', 10);
      return Number.isFinite(parsed) ? parsed : 1;
    } catch (_error) {
      return 1;
    }
  }

  function getResearchHomeSectionConfig(sectionBox) {
    const sectionNameNode =
      sectionBox.querySelector('h4.top_tlt em') ||
      sectionBox.querySelector('caption');
    const sectionName = String(sectionNameNode && sectionNameNode.textContent || '')
      .replace(/\s*리포트\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return getResearchSectionConfig(sectionName);
  }

  function getReportFileCell(row) {
    return row.querySelector('td.file') ||
      Array.from(row.querySelectorAll('td.tc'))
        .find((cell) => cell.querySelector('a[href]')) ||
      null;
  }

  function getDetailDownloadAnchors() {
    const anchors = Array.from(
      document.querySelectorAll('th.view_report a[href$=".pdf"], .view_cnt a[href$=".pdf"]')
    );
    return Array.from(new Set(anchors));
  }

  function shouldBypassLinkIntercept(event) {
    return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }

  function cancelPreviewScan() {
    if (state.scanToken) {
      state.scanToken.cancelled = true;
      state.scanToken = null;
    }
  }

  function showModal() {
    if (!state.elements.modal) {
      return;
    }
    state.elements.modal.hidden = false;
    document.body.classList.add(`${APP_ID}__modal-open`);
  }

  function hideModal() {
    if (!state.elements.modal) {
      return;
    }
    if ((state.queueActive || state.scanToken) && !window.confirm('다운로드를 중지하고 닫을까요?')) {
      return;
    }
    if (state.queueActive || state.scanToken) {
      void stopCurrentWork();
    }
    state.elements.modal.hidden = true;
    document.body.classList.remove(`${APP_ID}__modal-open`);
  }

  function setStatus(message, isError) {
    if (state.pageType === 'detail' && state.elements.detailStatus) {
      state.elements.detailStatus.textContent = message;
      state.elements.detailStatus.dataset.error = isError ? 'true' : 'false';
      return;
    }

    if (state.elements.statusText) {
      state.elements.statusText.textContent = message;
      state.elements.statusText.dataset.error = isError ? 'true' : 'false';
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
    return escapeHtml(value).replace(/"/g, '&quot;');
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
