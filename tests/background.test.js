const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const utils = require('../utils.js');

function loadBackgroundScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'background.js'),
    'utf8'
  );

  let runtimeMessageListener = null;
  const offscreenMessages = [];

  const chrome = {
    runtime: {
      onInstalled: {
        addListener() {}
      },
      onConnect: {
        addListener() {}
      },
      onMessage: {
        addListener(listener) {
          runtimeMessageListener = listener;
        }
      },
      async sendMessage(message) {
        offscreenMessages.push(message);
        return { ok: true };
      },
      getURL(pathname) {
        return `chrome-extension://test/${pathname}`;
      },
      async getContexts() {
        return [];
      }
    },
    downloads: {
      onChanged: {
        addListener() {}
      },
      async cancel() {},
      async download() {
        return 1;
      }
    },
    offscreen: {
      async createDocument() {}
    },
    tabs: {
      async sendMessage() {}
    }
  };

  const context = {
    chrome,
    console,
    Map,
    Set,
    Date,
    URL,
    Promise,
    Number,
    String,
    Boolean,
    Array,
    Math,
    JSON,
    RegExp,
    Error,
    TypeError,
    setTimeout,
    clearTimeout,
    importScripts() {
      context.NaverReportUtils = utils;
    }
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, {
    filename: 'background.js'
  });

  assert.equal(typeof runtimeMessageListener, 'function');

  return {
    offscreenMessages,
    async dispatchRuntimeMessage(message, sender) {
      return await new Promise((resolve, reject) => {
        const handled = runtimeMessageListener(
          message,
          sender || {},
          (response) => resolve(response)
        );
        if (!handled) {
          reject(new Error('Background message listener did not handle the message.'));
        }
      });
    }
  };
}

test('entity zip jobs forward entity mode metadata to the offscreen worker', async () => {
  const harness = loadBackgroundScript();

  const response = await harness.dispatchRuntimeMessage({
    type: 'NAVER_REPORT_START_DAILY_ZIP',
    source: 'popup',
    mode: 'entity',
    targetDate: '2026-05-03',
    fromDate: '2026-05-01',
    toDate: '2026-05-03',
    selectionSummary: '산업 1개',
    selectedCount: 1,
    selectedCompanyCount: 0,
    selectedIndustryCount: 1,
    zipFilename: 'naver-reports/entity.zip',
    settings: utils.DEFAULT_SETTINGS,
    collectSpec: {
      mode: 'entity',
      fromDate: '2026-05-01',
      toDate: '2026-05-03',
      selectedCompanyCodes: [],
      selectedIndustryNames: ['유통']
    }
  });

  assert.equal(response.ok, true);
  assert.equal(harness.offscreenMessages.length, 1);
  const actualOffscreenMessage = JSON.parse(
    JSON.stringify(harness.offscreenMessages[0])
  );

  assert.deepEqual(actualOffscreenMessage, {
    target: 'offscreen',
    type: 'NAVER_REPORT_OFFSCREEN_START_DAILY_ZIP',
    jobId: response.snapshot.jobId,
    mode: 'entity',
    targetDate: '2026-05-03',
    fromDate: '2026-05-01',
    toDate: '2026-05-03',
    selectionSummary: '산업 1개',
    selectedCount: 1,
    selectedCompanyCount: 0,
    selectedIndustryCount: 1,
    zipFilename: 'naver-reports/entity.zip',
    settings: utils.normalizeSettings(utils.DEFAULT_SETTINGS),
    items: [],
    collectSpec: {
      mode: 'entity',
      targetDate: '2026-05-03',
      fromDate: '2026-05-01',
      toDate: '2026-05-03',
      selectedCompanyCodes: [],
      selectedIndustryNames: ['유통'],
      bulkMaxPages: utils.DEFAULT_SETTINGS.bulkMaxPages
    }
  });
});
