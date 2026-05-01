(() => {
  'use strict';

  const {
    DEFAULT_SETTINGS,
    normalizeSettings,
    createZipArchive
  } = globalThis.NaverReportUtils;

  const MESSAGE_TYPES = {
    OFFSCREEN_START_DAILY_ZIP: 'NAVER_REPORT_OFFSCREEN_START_DAILY_ZIP',
    OFFSCREEN_STOP_DAILY_ZIP: 'NAVER_REPORT_OFFSCREEN_STOP_DAILY_ZIP',
    OFFSCREEN_DAILY_ZIP_PROGRESS: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_PROGRESS',
    OFFSCREEN_DAILY_ZIP_READY: 'NAVER_REPORT_OFFSCREEN_DAILY_ZIP_READY',
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
    const items = Array.isArray(message.items)
      ? message.items.map((item, index) => ({
          id: item.id || `daily-report-${index}`,
          date: item.date || '',
          sectionName: item.sectionName || '',
          stockName: item.stockName || '',
          broker: item.broker || '',
          reportTitle: item.reportTitle || '',
          pdfUrl: item.pdfUrl || '',
          zipPath: item.zipPath || '',
          expectedFilename: item.expectedFilename || item.zipPath || '',
          status: item.pdfUrl ? 'pending' : 'failed',
          error: item.pdfUrl ? '' : 'Missing PDF URL',
          attemptCount: 0,
          retriesRemaining: settings.bulkRetryMax
        }))
      : [];

    return {
      id: message.jobId,
      targetDate: message.targetDate || '',
      zipFilename: message.zipFilename || '',
      settings,
      jobStatus: 'running',
      phase: 'downloading',
      error: '',
      stopRequested: false,
      abortController: null,
      items
    };
  }

  async function runJob(job) {
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
      throw new Error('ZIP에 포함할 수 있는 리포트가 없습니다.');
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
      targetDate: job.targetDate,
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
