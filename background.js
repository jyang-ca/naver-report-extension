importScripts('utils.js');

(() => {
  'use strict';

  const {
    SETTINGS_STORAGE_KEY,
    DEFAULT_SETTINGS,
    normalizeSettings,
    buildFilename,
    buildDailyZipFilename
  } = globalThis.NaverReportUtils;

  const MESSAGE_TYPES = {
    START_QUEUE: 'NAVER_REPORT_START_QUEUE',
    STOP_QUEUE: 'NAVER_REPORT_STOP_QUEUE',
    QUEUE_UPDATE: 'NAVER_REPORT_QUEUE_UPDATE',
    START_DAILY_ZIP: 'NAVER_REPORT_START_DAILY_ZIP',
    STOP_DAILY_ZIP: 'NAVER_REPORT_STOP_DAILY_ZIP',
    DAILY_ZIP_UPDATE: 'NAVER_REPORT_DAILY_ZIP_UPDATE',
    OFFSCREEN_START_DAILY_ZIP: 'NAVER_REPORT_OFFSCREEN_START_DAILY_ZIP',
    OFFSCREEN_STOP_DAILY_ZIP: 'NAVER_REPORT_OFFSCREEN_STOP_DAILY_ZIP',
    OFFSCREEN_DAILY_ZIP_PROGRESS: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_PROGRESS',
    OFFSCREEN_DAILY_ZIP_READY: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_READY',
    OFFSCREEN_DAILY_ZIP_STOPPED: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_STOPPED',
    OFFSCREEN_DAILY_ZIP_FAILED: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_FAILED',
    OFFSCREEN_REVOKE_OBJECT_URL: 'NAVER_REPORT_OFFSCREEN_REVOKE_OBJECT_URL'
  };

  const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

  const portsByTabId = new Map();
  const lastSnapshotByTabId = new Map();
  const popupPorts = new Set();
  const dailyZipDownloadsById = new Map();
  const lastDailyZipSnapshotByTabId = new Map();

  let activeJob = null;
  let activeDailyZipJob = null;
  let lastDailyZipSnapshot = null;
  let creatingOffscreenDocument = null;

  chrome.runtime.onInstalled.addListener(() => {
    ensureDefaultSettings().catch(() => {
      // Ignore storage bootstrapping issues and fall back to in-memory defaults.
    });
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'naver-report-popup') {
      popupPorts.add(port);
      if (lastDailyZipSnapshot && lastDailyZipSnapshot.source === 'popup') {
        safePostPortMessage(port, {
          type: MESSAGE_TYPES.DAILY_ZIP_UPDATE,
          snapshot: lastDailyZipSnapshot
        });
      }
      port.onDisconnect.addListener(() => {
        popupPorts.delete(port);
      });
      return;
    }

    if (port.name !== 'naver-report') {
      return;
    }

    const tabId = port.sender && port.sender.tab && port.sender.tab.id;
    if (typeof tabId !== 'number') {
      return;
    }

    if (!portsByTabId.has(tabId)) {
      portsByTabId.set(tabId, new Set());
    }
    portsByTabId.get(tabId).add(port);

    const snapshot = lastSnapshotByTabId.get(tabId);
    if (snapshot) {
      safePostPortMessage(port, {
        type: MESSAGE_TYPES.QUEUE_UPDATE,
        snapshot
      });
    }
    const zipSnapshot = lastDailyZipSnapshotByTabId.get(tabId);
    if (zipSnapshot) {
      safePostPortMessage(port, {
        type: MESSAGE_TYPES.DAILY_ZIP_UPDATE,
        snapshot: zipSnapshot
      });
    }

    port.onDisconnect.addListener(() => {
      const bucket = portsByTabId.get(tabId);
      if (!bucket) {
        return;
      }
      bucket.delete(port);
      if (!bucket.size) {
        portsByTabId.delete(tabId);
      }
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return false;
    }

    if (message.type === MESSAGE_TYPES.START_QUEUE) {
      handleStartQueue(message, sender)
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.STOP_QUEUE) {
      handleStopQueue(sender && sender.tab && sender.tab.id)
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.START_DAILY_ZIP) {
      handleStartDailyZip(message, sender)
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.STOP_DAILY_ZIP) {
      handleStopDailyZip()
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_PROGRESS) {
      handleOffscreenDailyZipProgress(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_READY) {
      handleOffscreenDailyZipReady(message)
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((error) => sendResponse({ ok: false, error: formatError(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_STOPPED) {
      handleOffscreenDailyZipStopped(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MESSAGE_TYPES.OFFSCREEN_DAILY_ZIP_FAILED) {
      handleOffscreenDailyZipFailed(message);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (handleDailyZipDownloadChanged(delta)) {
      return;
    }

    const job = activeJob;
    if (!job || typeof delta.id !== 'number') {
      return;
    }

    const item = job.downloadsById.get(delta.id);
    if (!item) {
      return;
    }

    if (delta.state && delta.state.current === 'complete') {
      job.downloadsById.delete(delta.id);
      item.downloadId = null;
      item.status = 'completed';
      item.error = '';
      job.runningCount = Math.max(0, job.runningCount - 1);
      emitUpdate(job);
      schedulePump(job);
      return;
    }

    if (delta.state && delta.state.current === 'interrupted') {
      job.downloadsById.delete(delta.id);
      item.downloadId = null;
      job.runningCount = Math.max(0, job.runningCount - 1);

      if (job.stopRequested) {
        item.status = 'skipped';
        item.error = '';
      } else {
        applyFailure(job, item, delta.error && delta.error.current);
      }

      emitUpdate(job);
      schedulePump(job);
    }
  });

  async function handleStartQueue(message, sender) {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number'
      ? sender.tab.id
      : null;

    if (activeJob || activeDailyZipJob) {
      throw new Error('A download job is already running. Stop it before starting a new one.');
    }

    const settings = normalizeSettings(message.settings);
    const reports = Array.isArray(message.items) ? message.items : [];
    if (!reports.length) {
      throw new Error('No reports to download.');
    }

    const preparedItems = buildQueueItems(reports, settings);
    const job = {
      id: `job-${Date.now()}`,
      tabId,
      targetDate: message.targetDate || '',
      settings,
      jobStatus: 'queued',
      stopRequested: false,
      runningCount: 0,
      items: preparedItems,
      downloadsById: new Map(),
      pumpTimer: null
    };

    activeJob = job;
    emitUpdate(job);
    schedulePump(job, 0);
    return createSnapshot(job);
  }

  async function handleStartDailyZip(message, sender) {
    if (activeJob || activeDailyZipJob) {
      throw new Error('A download job is already running. Stop it before starting a new one.');
    }

    const tabId = sender && sender.tab && typeof sender.tab.id === 'number'
      ? sender.tab.id
      : null;
    const source = message.source || (typeof tabId === 'number' ? 'content' : 'popup');
    const settings = normalizeSettings(message.settings);
    const targetDate = message.targetDate || '';
    const reports = Array.isArray(message.items) ? message.items : [];
    if (!reports.length) {
      throw new Error('No reports to download.');
    }

    const items = reports.map((report, index) => ({
      id: `daily-report-${index}`,
      date: report && report.date ? report.date : '',
      sectionName: report && report.sectionName ? report.sectionName : '',
      stockName: report && report.stockName ? report.stockName : '',
      broker: report && report.broker ? report.broker : '',
      reportTitle: report && report.reportTitle ? report.reportTitle : '',
      pdfUrl: report && report.pdfUrl ? String(report.pdfUrl) : '',
      zipPath: report && report.zipPath ? String(report.zipPath) : '',
      expectedFilename: report && report.expectedFilename ? String(report.expectedFilename) : '',
      status: report && report.pdfUrl ? 'pending' : 'failed',
      error: report && report.pdfUrl ? '' : 'Missing PDF URL',
      attemptCount: 0,
      retriesRemaining: settings.bulkRetryMax
    }));

    const jobId = `daily-zip-${Date.now()}`;
    const zipFilename = message.zipFilename
      ? String(message.zipFilename)
      : buildDailyZipFilename(settings, targetDate);
    const job = {
      id: jobId,
      source,
      tabId,
      settings,
      targetDate,
      zipFilename,
      objectUrl: '',
      zipDownloadId: null,
      stopRequested: false,
      snapshot: createDailyZipSnapshot({
        id: jobId,
        source,
        tabId,
        targetDate,
        zipFilename,
        jobStatus: 'queued',
        phase: 'queued',
        items,
        error: ''
      })
    };

    activeDailyZipJob = job;
    lastDailyZipSnapshot = job.snapshot;
    emitDailyZipUpdate(job.snapshot);

    try {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: MESSAGE_TYPES.OFFSCREEN_START_DAILY_ZIP,
        jobId: job.id,
        targetDate,
        zipFilename: job.zipFilename,
        settings,
        items
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'ZIP 작업을 시작하지 못했습니다.');
      }
    } catch (error) {
      activeDailyZipJob = null;
      job.snapshot = {
        ...job.snapshot,
        jobStatus: 'failed',
        phase: 'failed',
        error: formatError(error)
      };
      emitDailyZipUpdate(job.snapshot);
      throw error;
    }

    return job.snapshot;
  }

  async function handleStopDailyZip() {
    const job = activeDailyZipJob;
    if (!job) {
      return lastDailyZipSnapshot;
    }

    job.stopRequested = true;
    job.snapshot = {
      ...job.snapshot,
      jobStatus: 'stopping',
      phase: 'stopping',
      error: ''
    };
    emitDailyZipUpdate(job.snapshot);

    if (typeof job.zipDownloadId === 'number') {
      await chrome.downloads.cancel(job.zipDownloadId).catch(() => {
        // Ignore cancel races when the ZIP download has already finished.
      });
      return job.snapshot;
    }

    if (job.objectUrl) {
      await revokeOffscreenObjectUrl(job.objectUrl).catch(() => {
        // Ignore cleanup races if the offscreen document has already closed.
      });
      markDailyZipStopped(job);
      return job.snapshot;
    }

    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_STOP_DAILY_ZIP,
      jobId: job.id
    }).catch(() => {
      markDailyZipStopped(job);
    });

    return job.snapshot;
  }

  function handleOffscreenDailyZipProgress(message) {
    const job = activeDailyZipJob;
    if (!job || message.jobId !== job.id || !message.snapshot) {
      return;
    }

    job.snapshot = {
      ...message.snapshot,
      jobId: job.id,
      source: job.source,
      tabId: job.tabId,
      targetDate: job.targetDate,
      zipFilename: job.zipFilename
    };
    emitDailyZipUpdate(job.snapshot);
  }

  async function handleOffscreenDailyZipReady(message) {
    const job = activeDailyZipJob;
    if (!job || message.jobId !== job.id) {
      return lastDailyZipSnapshot;
    }

    if (message.snapshot) {
      job.snapshot = {
        ...message.snapshot,
        jobId: job.id,
        source: job.source,
        tabId: job.tabId,
        targetDate: job.targetDate,
        zipFilename: job.zipFilename
      };
    }

    job.objectUrl = message.objectUrl || '';
    if (!job.objectUrl) {
      throw new Error('ZIP Blob URL was not created.');
    }

    if (job.stopRequested) {
      await revokeOffscreenObjectUrl(job.objectUrl);
      markDailyZipStopped(job);
      return job.snapshot;
    }

    job.snapshot = {
      ...job.snapshot,
      jobStatus: 'running',
      phase: 'saving',
      zipSizeBytes: message.sizeBytes || 0,
      zipEntryCount: message.entryCount || job.snapshot.completedCount || 0,
      error: ''
    };
    emitDailyZipUpdate(job.snapshot);

    try {
      const downloadId = await chrome.downloads.download({
        url: job.objectUrl,
        filename: job.zipFilename,
        conflictAction: 'uniquify',
        saveAs: Boolean(job.settings.useNativePathPicker)
      });

      if (typeof downloadId !== 'number') {
        throw new Error('chrome.downloads.download() did not return a download id.');
      }

      job.zipDownloadId = downloadId;
      dailyZipDownloadsById.set(downloadId, {
        jobId: job.id,
        objectUrl: job.objectUrl
      });
      job.snapshot = {
        ...job.snapshot,
        zipDownloadId: downloadId
      };
      emitDailyZipUpdate(job.snapshot);

      if (job.stopRequested) {
        await chrome.downloads.cancel(downloadId).catch(() => {
          // Ignore cancel races when the ZIP download has already finished.
        });
      }

      return job.snapshot;
    } catch (error) {
      await revokeOffscreenObjectUrl(job.objectUrl);
      job.snapshot = {
        ...job.snapshot,
        jobStatus: 'failed',
        phase: 'failed',
        error: formatError(error)
      };
      emitDailyZipUpdate(job.snapshot);
      activeDailyZipJob = null;
      throw error;
    }
  }

  function handleOffscreenDailyZipFailed(message) {
    const job = activeDailyZipJob;
    if (!job || message.jobId !== job.id) {
      return;
    }

    job.snapshot = {
      ...(message.snapshot || job.snapshot),
      jobId: job.id,
      source: job.source,
      tabId: job.tabId,
      targetDate: job.targetDate,
      zipFilename: job.zipFilename,
      jobStatus: 'failed',
      phase: 'failed',
      error: message.error || 'ZIP 작업에 실패했습니다.'
    };
    emitDailyZipUpdate(job.snapshot);
    activeDailyZipJob = null;
  }

  function handleOffscreenDailyZipStopped(message) {
    const job = activeDailyZipJob;
    if (!job || message.jobId !== job.id) {
      return;
    }

    job.snapshot = {
      ...(message.snapshot || job.snapshot),
      jobId: job.id,
      source: job.source,
      tabId: job.tabId,
      targetDate: job.targetDate,
      zipFilename: job.zipFilename,
      jobStatus: 'stopped',
      phase: 'stopped',
      error: ''
    };
    emitDailyZipUpdate(job.snapshot);
    activeDailyZipJob = null;
  }

  function markDailyZipStopped(job) {
    if (!job) {
      return;
    }

    job.snapshot = {
      ...job.snapshot,
      jobStatus: 'stopped',
      phase: 'stopped',
      error: ''
    };
    emitDailyZipUpdate(job.snapshot);
    if (activeDailyZipJob === job) {
      activeDailyZipJob = null;
    }
  }

  function handleDailyZipDownloadChanged(delta) {
    if (!delta || typeof delta.id !== 'number') {
      return false;
    }

    const tracked = dailyZipDownloadsById.get(delta.id);
    if (!tracked) {
      return false;
    }

    const job = activeDailyZipJob;
    if (!job || tracked.jobId !== job.id) {
      return true;
    }

    if (delta.state && delta.state.current === 'complete') {
      dailyZipDownloadsById.delete(delta.id);
      job.snapshot = {
        ...job.snapshot,
        jobStatus: 'completed',
        phase: 'completed',
        error: ''
      };
      emitDailyZipUpdate(job.snapshot);
      activeDailyZipJob = null;
      revokeOffscreenObjectUrl(tracked.objectUrl).catch(() => {
        // Ignore cleanup races if the offscreen document has already closed.
      });
      return true;
    }

    if (delta.state && delta.state.current === 'interrupted') {
      dailyZipDownloadsById.delete(delta.id);
      if (job.stopRequested) {
        job.snapshot = {
          ...job.snapshot,
          jobStatus: 'stopped',
          phase: 'stopped',
          error: ''
        };
        emitDailyZipUpdate(job.snapshot);
        activeDailyZipJob = null;
      } else {
        job.snapshot = {
          ...job.snapshot,
          jobStatus: 'failed',
          phase: 'failed',
          error: delta.error && delta.error.current ? delta.error.current : 'ZIP download interrupted'
        };
        emitDailyZipUpdate(job.snapshot);
        activeDailyZipJob = null;
      }
      revokeOffscreenObjectUrl(tracked.objectUrl).catch(() => {
        // Ignore cleanup races if the offscreen document has already closed.
      });
      return true;
    }

    return true;
  }

  async function handleStopQueue(tabId) {
    const job = activeJob;
    if (!job) {
      return null;
    }

    if (typeof tabId === 'number' && job.tabId !== tabId) {
      throw new Error('No active queue for this tab.');
    }

    job.stopRequested = true;
    job.jobStatus = 'stopping';

    for (const item of job.items) {
      if (item.status === 'pending') {
        item.status = 'skipped';
        item.error = '';
      }
    }

    emitUpdate(job);

    const cancels = [];
    for (const item of job.items) {
      if (item.status === 'downloading' && typeof item.downloadId === 'number') {
        cancels.push(
          chrome.downloads.cancel(item.downloadId).catch(() => {
            // Ignore cancel races when a download has already finished.
          })
        );
      }
    }

    await Promise.all(cancels);

    if (job.runningCount === 0) {
      finalizeJob(job);
    } else {
      emitUpdate(job);
    }

    return createSnapshot(job);
  }

  function buildQueueItems(reports, settings) {
    const seen = new Set();

    return reports.map((report, index) => {
      const pdfUrl = report && report.pdfUrl ? String(report.pdfUrl) : '';
      const filename = report && report.expectedFilename
        ? String(report.expectedFilename)
        : buildFilename(report || {}, settings);

      if (!pdfUrl) {
        return {
          id: `report-${index}`,
          date: report && report.date ? report.date : '',
          stockName: report && report.stockName ? report.stockName : '',
          broker: report && report.broker ? report.broker : '',
          reportTitle: report && report.reportTitle ? report.reportTitle : '',
          pdfUrl: '',
          filename,
          expectedFilename: filename,
          status: 'failed',
          error: 'Missing PDF URL',
          downloadId: null,
          retriesRemaining: settings.bulkRetryMax,
          attemptCount: 0
        };
      }

      if (seen.has(pdfUrl)) {
        return {
          id: `report-${index}`,
          date: report.date,
          stockName: report.stockName,
          broker: report.broker,
          reportTitle: report.reportTitle,
          pdfUrl,
          filename,
          expectedFilename: filename,
          status: 'skipped',
          error: 'Duplicate PDF URL',
          downloadId: null,
          retriesRemaining: settings.bulkRetryMax,
          attemptCount: 0
        };
      }

      seen.add(pdfUrl);

      return {
        id: `report-${index}`,
        date: report.date,
        stockName: report.stockName,
        broker: report.broker,
        reportTitle: report.reportTitle,
        pdfUrl,
        filename,
        expectedFilename: filename,
        status: 'pending',
        error: '',
        downloadId: null,
        retriesRemaining: settings.bulkRetryMax,
        attemptCount: 0
      };
    });
  }

  async function pumpQueue(job) {
    if (activeJob !== job) {
      return;
    }

    if (job.stopRequested) {
      if (job.runningCount === 0) {
        finalizeJob(job);
      }
      return;
    }

    if (!job.items.some((item) => item.status === 'pending' || item.status === 'downloading')) {
      finalizeJob(job);
      return;
    }

    job.jobStatus = 'running';

    while (job.runningCount < job.settings.bulkConcurrency) {
      const nextItem = job.items.find((item) => item.status === 'pending');
      if (!nextItem) {
        break;
      }
      startDownload(job, nextItem);
    }

    emitUpdate(job);
  }

  async function startDownload(job, item) {
    if (activeJob !== job || item.status !== 'pending') {
      return;
    }

    item.status = 'downloading';
    item.error = '';
    item.attemptCount += 1;
    job.runningCount += 1;
    emitUpdate(job);

    try {
      const downloadId = await chrome.downloads.download({
        url: item.pdfUrl,
        filename: item.filename,
        conflictAction: 'uniquify',
        saveAs: Boolean(job.settings.useNativePathPicker)
      });

      if (typeof downloadId !== 'number') {
        throw new Error('chrome.downloads.download() did not return a download id.');
      }

      item.downloadId = downloadId;
      job.downloadsById.set(downloadId, item);
      emitUpdate(job);
    } catch (error) {
      job.runningCount = Math.max(0, job.runningCount - 1);
      item.downloadId = null;
      applyFailure(job, item, error);
      emitUpdate(job);
      schedulePump(job);
    }
  }

  function applyFailure(job, item, error) {
    const message = formatError(error) || 'Download failed';

    if (item.retriesRemaining > 0 && !job.stopRequested) {
      item.retriesRemaining -= 1;
      item.status = 'pending';
      item.error = `Retrying after failure: ${message}`;
      return;
    }

    item.status = 'failed';
    item.error = message;
  }

  function schedulePump(job, delay) {
    if (activeJob !== job) {
      return;
    }

    if (job.pumpTimer) {
      clearTimeout(job.pumpTimer);
    }

    const timeout = typeof delay === 'number' ? delay : job.settings.bulkDelayMs;
    job.pumpTimer = setTimeout(() => {
      job.pumpTimer = null;
      pumpQueue(job);
    }, timeout);
  }

  function finalizeJob(job) {
    if (job.pumpTimer) {
      clearTimeout(job.pumpTimer);
      job.pumpTimer = null;
    }

    job.jobStatus = job.stopRequested ? 'stopped' : 'completed';
    emitUpdate(job);

    if (activeJob === job) {
      activeJob = null;
    }
  }

  function emitUpdate(job) {
    const snapshot = createSnapshot(job);
    if (typeof job.tabId === 'number') {
      lastSnapshotByTabId.set(job.tabId, snapshot);
    }

    if (typeof job.tabId === 'number') {
      const bucket = portsByTabId.get(job.tabId);
      if (bucket) {
        for (const port of bucket) {
          try {
            port.postMessage({
              type: MESSAGE_TYPES.QUEUE_UPDATE,
              snapshot
            });
          } catch (_error) {
            // Ignore stale ports.
          }
        }
      }

      chrome.tabs.sendMessage(job.tabId, {
        type: MESSAGE_TYPES.QUEUE_UPDATE,
        snapshot
      }).catch(() => {
        // Ignore tabs that no longer host the content script.
      });
    }
  }

  function createSnapshot(job) {
    const summary = countStatuses(job.items);
    return {
      jobId: job.id,
      targetDate: job.targetDate,
      jobStatus: job.jobStatus,
      stopRequested: job.stopRequested,
      totalCount: job.items.length,
      completedCount: summary.completed,
      failedCount: summary.failed,
      skippedCount: summary.skipped,
      pendingCount: summary.pending,
      downloadingCount: summary.downloading,
      items: job.items.map((item) => ({
        id: item.id,
        date: item.date,
        stockName: item.stockName,
        broker: item.broker,
        reportTitle: item.reportTitle,
        pdfUrl: item.pdfUrl,
        expectedFilename: item.expectedFilename,
        filename: item.filename,
        status: item.status,
        error: item.error,
        attemptCount: item.attemptCount,
        retriesRemaining: item.retriesRemaining
      }))
    };
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

  function createDailyZipSnapshot(job) {
    const items = Array.isArray(job.items) ? job.items : [];
    const summary = countStatuses(items);

    return {
      jobId: job.id,
      source: job.source || 'popup',
      tabId: typeof job.tabId === 'number' ? job.tabId : null,
      targetDate: job.targetDate,
      zipFilename: job.zipFilename,
      jobStatus: job.jobStatus,
      phase: job.phase,
      totalCount: items.length,
      completedCount: summary.completed,
      failedCount: summary.failed,
      skippedCount: summary.skipped,
      pendingCount: summary.pending,
      downloadingCount: summary.downloading,
      processedCount: summary.completed + summary.failed + summary.skipped,
      error: job.error || '',
      items: items.map((item) => ({
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

  function emitDailyZipUpdate(snapshot) {
    lastDailyZipSnapshot = snapshot;

    if (typeof snapshot.tabId === 'number') {
      lastDailyZipSnapshotByTabId.set(snapshot.tabId, snapshot);

      const bucket = portsByTabId.get(snapshot.tabId);
      if (bucket) {
        for (const port of bucket) {
          safePostPortMessage(port, {
            type: MESSAGE_TYPES.DAILY_ZIP_UPDATE,
            snapshot
          });
        }
      }

      chrome.tabs.sendMessage(snapshot.tabId, {
        type: MESSAGE_TYPES.DAILY_ZIP_UPDATE,
        snapshot
      }).catch(() => {
        // Ignore tabs that no longer host the content script.
      });
    }

    if (snapshot.source === 'popup') {
      for (const port of popupPorts) {
        safePostPortMessage(port, {
          type: MESSAGE_TYPES.DAILY_ZIP_UPDATE,
          snapshot
        });
      }
    }
  }

  function safePostPortMessage(port, message) {
    try {
      port.postMessage(message);
    } catch (_error) {
      // Ignore stale ports.
    }
  }

  async function ensureOffscreenDocument() {
    if (!chrome.offscreen || !chrome.offscreen.createDocument) {
      throw new Error('Chrome offscreen API is not available.');
    }

    if (creatingOffscreenDocument) {
      await creatingOffscreenDocument;
      return;
    }

    creatingOffscreenDocument = (async () => {
      const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

      if (chrome.runtime.getContexts) {
        const existingContexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [offscreenUrl]
        });
        if (existingContexts.length > 0) {
          return;
        }
      }

      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: ['BLOBS'],
          justification: 'Create Blob URLs for generated Naver report ZIP downloads.'
        });
      } catch (error) {
        if (!/single offscreen document/i.test(formatError(error))) {
          throw error;
        }
      }
    })();

    try {
      await creatingOffscreenDocument;
    } finally {
      creatingOffscreenDocument = null;
    }
  }

  async function revokeOffscreenObjectUrl(objectUrl) {
    if (!objectUrl) {
      return;
    }

    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_REVOKE_OBJECT_URL,
      objectUrl
    });
  }

  async function ensureDefaultSettings() {
    const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
    if (result && result[SETTINGS_STORAGE_KEY]) {
      return;
    }

    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: normalizeSettings(DEFAULT_SETTINGS)
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
