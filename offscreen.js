(() => {
  'use strict';

  const {
    DEFAULT_SETTINGS,
    RESEARCH_PAGE_CONFIGS,
    normalizeSettings,
    normalizeDate,
    buildFilename,
    buildEntityZipEntryPath,
    createZipArchive,
    parseReportRowsFromDocument,
    dedupeReports
  } = globalThis.NaverReportUtils;

  const MESSAGE_TYPES = {
    OFFSCREEN_START_DAILY_ZIP: 'NAVER_REPORT_OFFSCREEN_START_DAILY_ZIP',
    OFFSCREEN_STOP_DAILY_ZIP: 'NAVER_REPORT_OFFSCREEN_STOP_DAILY_ZIP',
    OFFSCREEN_DAILY_ZIP_PROGRESS: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_PROGRESS',
    OFFSCREEN_DAILY_ZIP_READY: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_READY',
    OFFSCREEN_DAILY_ZIP_EMPTY: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_EMPTY',
    OFFSCREEN_DAILY_ZIP_STOPPED: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_STOPPED',
    OFFSCREEN_DAILY_ZIP_FAILED: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_FAILED',
    OFFSCREEN_REVOKE_OBJECT_URL: 'NAVER_REPORT_OFFSCREEN_REVOKE_OBJECT_URL'
  };

  const objectUrls = new Set();
  let activeJob = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'offscreen') {
      return false;
    }

    if (message.type === MESSAGE_TYPES.OFFSCREEN_STOP_DAILY_ZIP) {
      stopJob(message.jobId);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MESSAGE_TYPES.OFFSCREEN_START_DAILY_ZIP) {
      try {
        if (activeJob) {
          throw new Error('A daily ZIP job is already running.');
        }

        activeJob = createJob(message);
        sendResponse({ ok: true });
        runJob(activeJob).catch((error) => {
          failJob(activeJob, error);
        });
      } catch (error) {
        sendResponse({ ok: false, error: formatError(error) });
      }
      return false;
    }

    if (message.type === MESSAGE_TYPES.OFFSCREEN_REVOKE_OBJECT_URL) {
      if (message.objectUrl && objectUrls.has(message.objectUrl)) {
        URL.revokeObjectURL(message.objectUrl);
        objectUrls.delete(message.objectUrl);
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function createJob(message) {
    const settings = normalizeSettings(message.settings || DEFAULT_SETTINGS);
    const collectSpec = normalizeCollectSpec(message.collectSpec);
    const items = buildJobItems(Array.isArray(message.items) ? message.items : [], settings);
    const mode = message.mode === 'entity' || (collectSpec && collectSpec.mode === 'entity')
      ? 'entity'
      : 'date';
    const targetDate = message.targetDate || (collectSpec ? collectSpec.targetDate : '') || '';
    const fromDate = message.fromDate || (collectSpec ? collectSpec.fromDate : '') || '';
    const toDate = message.toDate || (collectSpec ? collectSpec.toDate : '') || targetDate;

    return {
      id: message.jobId,
      mode,
      targetDate,
      fromDate,
      toDate,
      zipFilename: message.zipFilename || '',
      selectionSummary: message.selectionSummary || '',
      selectedCount: Number.isFinite(message.selectedCount) ? message.selectedCount : 0,
      selectedCompanyCount: Number.isFinite(message.selectedCompanyCount)
        ? message.selectedCompanyCount
        : 0,
      selectedIndustryCount: Number.isFinite(message.selectedIndustryCount)
        ? message.selectedIndustryCount
        : 0,
      settings,
      collectSpec,
      jobStatus: 'running',
      phase: collectSpec ? 'collecting' : 'downloading',
      error: '',
      stopRequested: false,
      abortController: null,
      items,
      scannedPageCount: 0,
      currentCollectionPage: 0,
      currentSectionName: '',
      collectionTotalPageCount: estimateCollectionTotalPageCount(collectSpec, settings),
      collectedReportCount: items.length
    };
  }

  async function runJob(job) {
    if (job.collectSpec) {
      emitProgress(job);
      await collectJobItems(job);
      if (job.stopRequested) {
        finishStoppedJob(job);
        return;
      }

      if (!job.items.length) {
        finishEmptyJob(job);
        return;
      }

      job.phase = 'downloading';
    }

    const zipEntries = [];
    emitProgress(job);

    for (let index = 0; index < job.items.length; index += 1) {
      if (job.stopRequested) {
        finishStoppedJob(job);
        return;
      }

      const item = job.items[index];
      if (item.status === 'failed') {
        emitProgress(job);
        continue;
      }

      await fetchReportWithRetry(job, item, zipEntries);
      if (job.stopRequested) {
        finishStoppedJob(job);
        return;
      }
      emitProgress(job);

      if (index < job.items.length - 1) {
        await delay(job.settings.bulkDelayMs);
      }
    }

    if (job.stopRequested) {
      finishStoppedJob(job);
      return;
    }

    if (!zipEntries.length) {
      finishEmptyJob(job);
      return;
    }

    job.phase = 'zipping';
    emitProgress(job);

    const zipBytes = createZipArchive(zipEntries);
    if (job.stopRequested) {
      finishStoppedJob(job);
      return;
    }

    const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
    const objectUrl = URL.createObjectURL(zipBlob);
    objectUrls.add(objectUrl);

    if (job.stopRequested) {
      URL.revokeObjectURL(objectUrl);
      objectUrls.delete(objectUrl);
      finishStoppedJob(job);
      return;
    }

    job.phase = 'ready';
    emitProgress(job);

    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_READY,
      jobId: job.id,
      objectUrl,
      entryCount: zipEntries.length,
      sizeBytes: zipBlob.size,
      snapshot: createSnapshot(job)
    });

    activeJob = null;
  }

  async function collectJobItems(job) {
    if (!job.collectSpec) {
      return;
    }

    const collectedReports = [];
    const sectionConfigs = resolveCollectionSections(job.collectSpec);

    for (const config of sectionConfigs) {
      if (job.collectSpec.mode === 'entity') {
        const matcher = buildEntityMatcher(job.collectSpec, config);
        if (!matcher) {
          continue;
        }

        const reports = await collectSectionReportsForRange(
          job,
          config,
          job.collectSpec.fromDate,
          job.collectSpec.toDate,
          matcher
        );
        collectedReports.push(...reports);
      } else {
        const reports = await collectSectionReportsForDate(
          job,
          config,
          job.collectSpec.targetDate
        );
        collectedReports.push(...reports);
      }
    }

    const uniqueReports = dedupeReports(collectedReports)
      .sort(compareReportsForZip)
      .map((report) => {
        const zipPath = job.collectSpec.mode === 'entity'
          ? buildEntityZipEntryPath(report, job.settings)
          : buildDateZipPathForReport(report, job.settings);

        return {
          ...report,
          zipPath,
          expectedFilename: zipPath
        };
      });

    job.items = buildJobItems(uniqueReports, job.settings);
    job.collectedReportCount = job.items.length;
  }

  async function collectSectionReportsForDate(job, config, targetDate) {
    const reports = [];

    for (let page = 1; page <= job.settings.bulkMaxPages; page += 1) {
      throwIfStopped(job);

      const pageUrl = buildListPageUrl(config, page);
      const doc = await fetchResearchPage(job, pageUrl);
      const pageItems = parseReportRowsFromDocument(doc, {
        settings: job.settings,
        baseUrl: pageUrl
      });
      const matched = pageItems.filter((item) => item.date === targetDate);

      reports.push(...matched);
      markCollectionProgress(job, config.sectionName, page, matched.length);

      if (!pageItems.length) {
        break;
      }

      const allRowsOlderThanTarget = pageItems.every((item) => item.date < targetDate);
      if (allRowsOlderThanTarget || !hasNextPage(doc, page)) {
        break;
      }
    }

    return reports;
  }

  async function collectSectionReportsForRange(job, config, fromDate, toDate, matcher) {
    const reports = [];

    for (let page = 1; page <= job.settings.bulkMaxPages; page += 1) {
      throwIfStopped(job);

      const pageUrl = buildDateRangePageUrl(config, page, fromDate, toDate);
      const doc = await fetchResearchPage(job, pageUrl);
      const pageItems = parseReportRowsFromDocument(doc, {
        settings: job.settings,
        baseUrl: pageUrl
      });
      const matched = pageItems.filter((item) => matcher(item));

      reports.push(...matched);
      markCollectionProgress(job, config.sectionName, page, matched.length);

      if (!pageItems.length || !hasNextPage(doc, page)) {
        break;
      }
    }

    return reports;
  }

  function markCollectionProgress(job, sectionName, page, matchedCount) {
    job.scannedPageCount += 1;
    job.currentCollectionPage = page;
    job.currentSectionName = sectionName || '';
    job.collectedReportCount += matchedCount;
    emitProgress(job);
  }

  function resolveCollectionSections(collectSpec) {
    if (!collectSpec) {
      return [];
    }

    if (collectSpec.mode === 'entity') {
      return RESEARCH_PAGE_CONFIGS.filter((config) => (
        (config.kind === 'company' && collectSpec.selectedCompanyCodes.length) ||
        (config.kind === 'industry' && collectSpec.selectedIndustryNames.length)
      ));
    }

    return RESEARCH_PAGE_CONFIGS.filter((config) => Boolean(config.listPath));
  }

  function buildEntityMatcher(collectSpec, config) {
    if (!collectSpec || !config) {
      return null;
    }

    if (config.kind === 'company') {
      const companyCodes = new Set(collectSpec.selectedCompanyCodes);
      return (report) => companyCodes.has(report.stockCode);
    }

    if (config.kind === 'industry') {
      const industryNames = new Set(collectSpec.selectedIndustryNames);
      return (report) => industryNames.has(report.stockName);
    }

    return null;
  }

  async function fetchResearchPage(job, url) {
    job.abortController = new AbortController();

    const response = await fetch(url, {
      credentials: 'include',
      signal: job.abortController.signal
    });

    if (!response.ok) {
      job.abortController = null;
      throw new Error(`페이지를 불러오지 못했습니다: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    job.abortController = null;
    const decoder = new TextDecoder('euc-kr');
    const html = decoder.decode(buffer);
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function fetchReportWithRetry(job, item, zipEntries) {
    while (true) {
      if (job.stopRequested) {
        item.status = 'skipped';
        item.error = '';
        return;
      }

      item.status = 'downloading';
      item.error = '';
      item.attemptCount += 1;
      emitProgress(job);

      try {
        job.abortController = new AbortController();
        const response = await fetch(item.pdfUrl, {
          credentials: 'include',
          signal: job.abortController.signal
        });

        if (!response.ok) {
          throw new Error(`PDF 요청 실패: ${response.status}`);
        }

        const data = await response.arrayBuffer();
        job.abortController = null;
        zipEntries.push({
          path: item.zipPath,
          data
        });
        item.status = 'completed';
        item.error = '';
        return;
      } catch (error) {
        job.abortController = null;
        if (job.stopRequested || (error && error.name === 'AbortError')) {
          item.status = 'skipped';
          item.error = '';
          return;
        }

        const message = formatError(error) || 'PDF 다운로드 실패';
        if (item.retriesRemaining > 0) {
          item.retriesRemaining -= 1;
          item.status = 'pending';
          item.error = `재시도 예정: ${message}`;
          emitProgress(job);
          await delay(job.settings.bulkDelayMs);
          continue;
        }

        item.status = 'failed';
        item.error = message;
        return;
      }
    }
  }

  function stopJob(jobId) {
    if (!activeJob || activeJob.id !== jobId) {
      return;
    }

    activeJob.stopRequested = true;
    activeJob.jobStatus = 'stopping';
    activeJob.phase = 'stopping';

    for (const item of activeJob.items) {
      if (item.status === 'pending') {
        item.status = 'skipped';
        item.error = '';
      }
    }

    if (activeJob.abortController) {
      activeJob.abortController.abort();
    }

    emitProgress(activeJob);
  }

  function finishEmptyJob(job) {
    job.jobStatus = 'completed';
    job.phase = 'empty';
    job.error = '';

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_EMPTY,
      jobId: job.id,
      snapshot: createSnapshot(job)
    }).catch(() => {
      // Ignore reporting failures when the service worker is unavailable.
    });

    activeJob = null;
  }

  function finishStoppedJob(job) {
    for (const item of job.items) {
      if (item.status === 'pending' || item.status === 'downloading') {
        item.status = 'skipped';
        item.error = '';
      }
    }

    job.jobStatus = 'stopped';
    job.phase = 'stopped';
    job.error = '';

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_STOPPED,
      jobId: job.id,
      snapshot: createSnapshot(job)
    }).catch(() => {
      // Ignore reporting failures when the service worker is unavailable.
    });

    activeJob = null;
  }

  function failJob(job, error) {
    if (!job) {
      return;
    }

    job.jobStatus = 'failed';
    job.phase = 'failed';
    job.error = formatError(error);

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_FAILED,
      jobId: job.id,
      error: job.error,
      snapshot: createSnapshot(job)
    }).catch(() => {
      // Ignore reporting failures when the service worker is unavailable.
    });

    activeJob = null;
  }

  function emitProgress(job) {
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_PROGRESS,
      jobId: job.id,
      snapshot: createSnapshot(job)
    }).catch(() => {
      // The next progress tick will try again.
    });
  }

  function createSnapshot(job) {
    const summary = countStatuses(job.items);
    return {
      jobId: job.id,
      mode: job.mode,
      targetDate: job.targetDate,
      fromDate: job.fromDate,
      toDate: job.toDate,
      selectionSummary: job.selectionSummary,
      selectedCount: job.selectedCount,
      selectedCompanyCount: job.selectedCompanyCount,
      selectedIndustryCount: job.selectedIndustryCount,
      zipFilename: job.zipFilename,
      jobStatus: job.jobStatus,
      phase: job.phase,
      totalCount: job.items.length,
      completedCount: summary.completed,
      failedCount: summary.failed,
      skippedCount: summary.skipped,
      pendingCount: summary.pending,
      downloadingCount: summary.downloading,
      processedCount: summary.completed + summary.failed + summary.skipped,
      scannedPageCount: job.scannedPageCount,
      currentCollectionPage: job.currentCollectionPage,
      currentSectionName: job.currentSectionName,
      collectionTotalPageCount: job.collectionTotalPageCount,
      collectedReportCount: job.collectedReportCount,
      error: job.error,
      items: job.items.map((item) => ({
        id: item.id,
        date: item.date,
        sectionName: item.sectionName,
        stockName: item.stockName,
        broker: item.broker,
        reportTitle: item.reportTitle,
        pdfUrl: item.pdfUrl,
        zipPath: item.zipPath,
        expectedFilename: item.expectedFilename || item.zipPath,
        status: item.status,
        error: item.error,
        attemptCount: item.attemptCount,
        retriesRemaining: item.retriesRemaining
      }))
    };
  }

  function buildJobItems(reports, settings) {
    return (Array.isArray(reports) ? reports : []).map((report, index) => ({
      id: report && report.id ? String(report.id) : `daily-report-${index}`,
      date: report && report.date ? report.date : '',
      sectionName: report && report.sectionName ? report.sectionName : '',
      stockName: report && report.stockName ? report.stockName : '',
      broker: report && report.broker ? report.broker : '',
      reportTitle: report && report.reportTitle ? report.reportTitle : '',
      pdfUrl: report && report.pdfUrl ? report.pdfUrl : '',
      zipPath: report && report.zipPath ? report.zipPath : '',
      expectedFilename: report && report.expectedFilename ? report.expectedFilename : '',
      status: report && report.pdfUrl ? 'pending' : 'failed',
      error: report && report.pdfUrl ? '' : 'Missing PDF URL',
      attemptCount: 0,
      retriesRemaining: settings.bulkRetryMax
    }));
  }

  function normalizeCollectSpec(collectSpec) {
    if (!collectSpec || typeof collectSpec !== 'object') {
      return null;
    }

    const mode = collectSpec.mode === 'entity' ? 'entity' : 'date';
    return {
      mode,
      targetDate: collectSpec.targetDate ? normalizeDate(collectSpec.targetDate) : '',
      fromDate: collectSpec.fromDate ? normalizeDate(collectSpec.fromDate) : '',
      toDate: collectSpec.toDate ? normalizeDate(collectSpec.toDate) : '',
      selectedCompanyCodes: Array.isArray(collectSpec.selectedCompanyCodes)
        ? collectSpec.selectedCompanyCodes.filter(Boolean).map((code) => String(code))
        : [],
      selectedIndustryNames: Array.isArray(collectSpec.selectedIndustryNames)
        ? collectSpec.selectedIndustryNames.filter(Boolean).map((name) => String(name))
        : []
    };
  }

  function estimateCollectionTotalPageCount(collectSpec, settings) {
    if (!collectSpec) {
      return 0;
    }

    if (collectSpec.mode === 'entity') {
      let sectionCount = 0;
      if (collectSpec.selectedCompanyCodes.length) {
        sectionCount += 1;
      }
      if (collectSpec.selectedIndustryNames.length) {
        sectionCount += 1;
      }
      return sectionCount * settings.bulkMaxPages;
    }

    return RESEARCH_PAGE_CONFIGS.length * settings.bulkMaxPages;
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

  function buildDateZipPathForReport(report, settings) {
    const sectionName = report.sectionName || report.stockName || '리포트';
    const filename = buildFilename(report, {
      ...(settings || {}),
      downloadPathPrefix: 'daily',
      createStockFolders: false
    });

    return joinPathParts(sectionName, getPathBasename(filename));
  }

  function getPathBasename(path) {
    const parts = String(path || '').split('/');
    return parts[parts.length - 1] || 'report.pdf';
  }

  function joinPathParts() {
    return Array.from(arguments)
      .map((part) => String(part || '').trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
  }

  function throwIfStopped(job) {
    if (job.stopRequested) {
      throw new DOMException('사용자가 중단했습니다.', 'AbortError');
    }
  }

  function countStatuses(items) {
    return items.reduce(
      (accumulator, item) => {
        if (accumulator[item.status] !== undefined) {
          accumulator[item.status] += 1;
        }
        return accumulator;
      },
      {
        pending: 0,
        downloading: 0,
        completed: 0,
        failed: 0,
        skipped: 0
      }
    );
  }

  function delay(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

  function formatError(error) {
    if (!error) {
      return 'Unknown error';
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
