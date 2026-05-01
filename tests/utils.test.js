const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDate,
  normalizeSettings,
  sanitizeFilename,
  isKrxTradingDate,
  getRecentKrxTradingDate,
  buildFilename,
  buildDailyZipFilename,
  buildSectionZipFilename,
  buildReportZipEntryPath,
  createZipArchive,
  getResearchPageConfig,
  getResearchSectionConfig,
  parseReportRow,
  parseReportRowsFromResearchHomeDocument,
  parseReportDetailDocument,
  dedupeReports
} = require('../utils.js');

test('normalizeDate converts YY.MM.DD into ISO format', () => {
  assert.equal(normalizeDate('26.04.24'), '2026-04-24');
});

test('normalizeDate preserves YYYY.MM.DD values', () => {
  assert.equal(normalizeDate('2026.04.24'), '2026-04-24');
});

test('normalizeDate accepts YYYY-MM-DD input', () => {
  assert.equal(normalizeDate('2026-04-24'), '2026-04-24');
});

test('normalizeDate rejects invalid dates', () => {
  assert.throws(() => normalizeDate('2026-13-40'), /Invalid date/i);
});

test('isKrxTradingDate excludes KRX holidays and weekends', () => {
  assert.equal(isKrxTradingDate('2026-04-30'), true);
  assert.equal(isKrxTradingDate('2026-05-01'), false);
  assert.equal(isKrxTradingDate('2026-05-02'), false);
  assert.equal(isKrxTradingDate('2026-03-02'), false);
});

test('getRecentKrxTradingDate skips KRX holidays before selecting a date', () => {
  assert.equal(getRecentKrxTradingDate('2026-05-01'), '2026-04-30');
  assert.equal(getRecentKrxTradingDate('2026-05-02'), '2026-04-30');
  assert.equal(getRecentKrxTradingDate('2026-03-02'), '2026-02-27');
});

test('sanitizeFilename removes path-invalid characters and preserves Korean text', () => {
  assert.equal(
    sanitizeFilename('삼성전자:/Q1? "리뷰"*'),
    '삼성전자 Q1 리뷰'
  );
});

test('buildFilename uses stock folders and deterministic naming', () => {
  const filename = buildFilename(
    {
      date: '26.04.24',
      stockName: '삼성전자',
      broker: '한화투자증권',
      reportTitle: '1Q26 Review: 기대/위험'
    },
    {
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  );

  assert.equal(
    filename,
    'naver-reports/삼성전자/2026-04-24_삼성전자_한화투자증권_1Q26 Review 기대 위험.pdf'
  );
});

test('normalizeSettings keeps a relative download path prefix', () => {
  const settings = normalizeSettings({
    downloadPathPrefix: 'custom-folder/reports'
  });

  assert.equal(settings.downloadPathPrefix, 'custom-folder/reports');
  assert.equal(settings.bulkDelayMs, 500);
});

test('buildDailyZipFilename stores the date zip under the configured download path', () => {
  const filename = buildDailyZipFilename(
    {
      downloadPathPrefix: 'naver-reports'
    },
    '2026-04-30'
  );

  assert.equal(filename, 'naver-reports/2026-04-30.zip');
});

test('buildSectionZipFilename stores section zips under the configured download path', () => {
  const filename = buildSectionZipFilename(
    {
      downloadPathPrefix: 'naver-reports'
    },
    '산업분석'
  );

  assert.equal(filename, 'naver-reports/산업분석.zip');
});

test('buildReportZipEntryPath removes the Downloads folder prefix for ZIP contents', () => {
  const filename = buildReportZipEntryPath(
    {
      date: '2026-04-30',
      stockName: '삼성전자',
      broker: '하나증권',
      reportTitle: '반도체 업황 점검'
    },
    {
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  );

  assert.equal(filename, '삼성전자/2026-04-30_삼성전자_하나증권_반도체 업황 점검.pdf');
});

test('createZipArchive creates a UTF-8 stored zip with sanitized entry paths', () => {
  const archive = createZipArchive([
    {
      path: '시황정보/report?.pdf',
      data: new TextEncoder().encode('hello')
    }
  ]);
  const bytes = Buffer.from(archive);

  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(6), 0x0800);
  assert.equal(bytes.readUInt16LE(8), 0);
  assert.match(bytes.toString('utf8'), /시황정보\/report \.pdf/);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
});

test('getResearchPageConfig identifies supported list pages', () => {
  const config = getResearchPageConfig('https://finance.naver.com/research/economy_list.naver?page=1');

  assert.equal(config.kind, 'economy');
  assert.equal(config.pageType, 'list');
  assert.equal(config.sectionName, '경제분석');
});

test('getResearchPageConfig identifies the research home page', () => {
  const config = getResearchPageConfig('https://finance.naver.com/research/');

  assert.equal(config.kind, 'research_home');
  assert.equal(config.pageType, 'home');
});

test('parseReportRow extracts normalized report metadata from a table row', () => {
  const stockLink = {
    textContent: '삼성전자',
    getAttribute(name) {
      return name === 'href' ? '/item/main.naver?code=005930' : null;
    }
  };

  const titleLink = {
    textContent: '1Q26 Review: 기대/위험',
    getAttribute(name) {
      return name === 'href' ? 'company_read.naver?nid=123&page=1' : null;
    }
  };

  const fileLink = {
    getAttribute(name) {
      return name === 'href'
        ? 'https://stock.pstatic.net/stock-research/company/18/20260424_company_662793000.pdf'
        : null;
    }
  };

  const dateCell = { textContent: '26.04.24' };
  const cells = [
    {},
    { querySelector: (selector) => (selector === 'a' ? titleLink : null) },
    { textContent: '한화투자증권' },
    {},
    {},
    {}
  ];

  const row = {
    ownerDocument: {
      location: {
        href: 'https://finance.naver.com/research/company_list.naver?page=1'
      }
    },
    querySelector(selector) {
      if (selector === 'a.stock_item') {
        return stockLink;
      }
      if (selector === 'td.file a[href]') {
        return fileLink;
      }
      if (selector === 'td.date') {
        return dateCell;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'td' ? cells : [];
    }
  };

  const report = parseReportRow(row, {
    settings: {
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  });

  assert.deepEqual(
    {
      stockName: report.stockName,
      stockCode: report.stockCode,
      broker: report.broker,
      date: report.date,
      pdfUrl: report.pdfUrl,
      expectedFilename: report.expectedFilename
    },
    {
      stockName: '삼성전자',
      stockCode: '005930',
      broker: '한화투자증권',
      date: '2026-04-24',
      pdfUrl: 'https://stock.pstatic.net/stock-research/company/18/20260424_company_662793000.pdf',
      expectedFilename:
        'naver-reports/삼성전자/2026-04-24_삼성전자_한화투자증권_1Q26 Review 기대 위험.pdf'
    }
  );
});

test('dedupeReports keeps the first item per PDF URL', () => {
  const unique = dedupeReports([
    { pdfUrl: 'https://example.com/a.pdf', title: 'A' },
    { pdfUrl: 'https://example.com/a.pdf', title: 'A duplicate' },
    { pdfUrl: 'https://example.com/b.pdf', title: 'B' }
  ]);

  assert.deepEqual(unique, [
    { pdfUrl: 'https://example.com/a.pdf', title: 'A' },
    { pdfUrl: 'https://example.com/b.pdf', title: 'B' }
  ]);
});

test('parseReportRow extracts market report metadata without stock column', () => {
  const titleLink = {
    textContent: '마켓레이더(4월 28일, 오전)',
    getAttribute(name) {
      return name === 'href' ? 'market_info_read.naver?nid=35881&page=1' : null;
    }
  };

  const fileLink = {
    getAttribute(name) {
      return name === 'href'
        ? 'https://stock.pstatic.net/stock-research/market/66/20260428_market_8516000.pdf'
        : null;
    }
  };

  const dateCell = { textContent: '26.04.28' };
  const cells = [
    { querySelector: (selector) => (selector === 'a' ? titleLink : null) },
    { textContent: 'DS투자증권' },
    {},
    {},
    {}
  ];

  const row = {
    ownerDocument: {
      location: {
        href: 'https://finance.naver.com/research/market_info_list.naver?page=1'
      }
    },
    querySelector(selector) {
      if (selector === 'td.file a[href]') {
        return fileLink;
      }
      if (selector === 'td.date') {
        return dateCell;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'td' ? cells : [];
    }
  };

  const report = parseReportRow(row, {
    settings: {
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  });

  assert.deepEqual(
    {
      stockName: report.stockName,
      broker: report.broker,
      date: report.date,
      reportType: report.reportType,
      expectedFilename: report.expectedFilename
    },
    {
      stockName: '시황정보',
      broker: 'DS투자증권',
      date: '2026-04-28',
      reportType: 'market_info',
      expectedFilename:
        'naver-reports/시황정보/2026-04-28_시황정보_DS투자증권_마켓레이더(4월 28일, 오전).pdf'
    }
  );
});

test('parseReportRow extracts industry category as folder name', () => {
  const titleLink = {
    textContent: '2026년 4월 넷째 주 자동차/이차전지 Weekly',
    getAttribute(name) {
      return name === 'href' ? 'industry_read.naver?nid=44364&page=1' : null;
    }
  };

  const fileLink = {
    getAttribute(name) {
      return name === 'href'
        ? 'https://stock.pstatic.net/stock-research/industry/62/20260428_industry_889335000.pdf'
        : null;
    }
  };

  const dateCell = { textContent: '26.04.28' };
  const cells = [
    { textContent: '자동차' },
    { querySelector: (selector) => (selector === 'a' ? titleLink : null) },
    { textContent: '교보증권' },
    {},
    {},
    {}
  ];

  const row = {
    ownerDocument: {
      location: {
        href: 'https://finance.naver.com/research/industry_list.naver?page=1'
      }
    },
    querySelector(selector) {
      if (selector === 'td.file a[href]') {
        return fileLink;
      }
      if (selector === 'td.date') {
        return dateCell;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'td' ? cells : [];
    }
  };

  const report = parseReportRow(row, {
    settings: {
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  });

  assert.equal(report.stockName, '자동차');
  assert.equal(report.reportType, 'industry');
});

test('parseReportRowsFromResearchHomeDocument extracts reports from mixed home sections', () => {
  const stockLink = {
    textContent: 'LG씨엔에스',
    getAttribute(name) {
      return name === 'href' ? '/item/main.naver?code=064400' : null;
    }
  };

  const titleLink = {
    textContent: '대외 사업 성장으로 호실적',
    getAttribute(name) {
      return name === 'href' ? 'company_read.naver?nid=92285' : null;
    }
  };

  const fileLink = {
    getAttribute(name) {
      return name === 'href'
        ? 'https://stock.pstatic.net/stock-research/company/16/20260430_company_410118000.pdf'
        : null;
    }
  };

  const dateCell = { textContent: '26.04.30' };
  const cells = [
    { textContent: 'LG씨엔에스' },
    { querySelector: (selector) => (selector === 'a' ? titleLink : null) },
    { textContent: '한화투자증권' },
    {},
    {}
  ];

  const row = {
    querySelector(selector) {
      if (selector === 'a.stock_item') {
        return null;
      }
      if (selector === 'a[href*="/item/main.naver"][href*="code="]') {
        return stockLink;
      }
      if (selector === 'td.file a[href]') {
        return null;
      }
      if (selector === 'td.tc a[href]') {
        return fileLink;
      }
      if (selector === 'td.date') {
        return dateCell;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'td' ? cells : [];
    }
  };

  const sectionBox = {
    querySelector(selector) {
      if (selector === 'h4.top_tlt em') {
        return { textContent: '종목분석' };
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'table tr' ? [row] : [];
    }
  };

  const doc = {
    location: {
      href: 'https://finance.naver.com/research/'
    },
    querySelectorAll(selector) {
      return selector === '.box_type_m' ? [sectionBox] : [];
    }
  };

  const [report] = parseReportRowsFromResearchHomeDocument(doc, {
    settings: {
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  });

  assert.deepEqual(
    {
      stockName: report.stockName,
      stockCode: report.stockCode,
      broker: report.broker,
      date: report.date,
      reportType: report.reportType,
      expectedFilename: report.expectedFilename
    },
    {
      stockName: 'LG씨엔에스',
      stockCode: '064400',
      broker: '한화투자증권',
      date: '2026-04-30',
      reportType: 'company',
      expectedFilename:
        'naver-reports/LG씨엔에스/2026-04-30_LG씨엔에스_한화투자증권_대외 사업 성장으로 호실적.pdf'
    }
  );

  assert.equal(getResearchSectionConfig('종목분석').kind, 'company');
});

test('parseReportDetailDocument extracts metadata from company_read view', () => {
  const sourceNode = {
    innerText: '한화투자증권|2026.04.24|조회 7802',
    textContent: '한화투자증권|2026.04.24|조회 7802'
  };
  const stockNode = { textContent: '삼성에스디에스' };
  const cloneSource = { remove() {} };
  const cloneStock = { remove() {} };
  const subjectNode = {
    textContent: '삼성에스디에스 낮은 주가 레벨, 기대해볼 만한 투자 성과 한화투자증권|2026.04.24|조회 7802',
    querySelector(selector) {
      if (selector === 'p.source') {
        return sourceNode;
      }
      if (selector === 'span em') {
        return stockNode;
      }
      return null;
    },
    cloneNode() {
      return {
        textContent: ' 낮은 주가 레벨, 기대해볼 만한 투자 성과 ',
        querySelector(selector) {
          if (selector === 'span') {
            return cloneStock;
          }
          if (selector === 'p.source') {
            return cloneSource;
          }
          return null;
        }
      };
    }
  };
  const pdfNode = {
    getAttribute(name) {
      return name === 'href'
        ? 'https://stock.pstatic.net/stock-research/company/16/20260424_company_717332000.pdf'
        : null;
    }
  };

  const doc = {
    location: {
      href: 'https://finance.naver.com/research/company_read.naver?nid=91924&page=1'
    },
    querySelector(selector) {
      if (selector === 'th.view_sbj') {
        return subjectNode;
      }
      if (selector === 'th.view_report a[href$=".pdf"]') {
        return pdfNode;
      }
      if (selector === '.view_cnt a[href$=".pdf"]') {
        return null;
      }
      return null;
    }
  };

  const report = parseReportDetailDocument(doc, {
    settings: {
      downloadPathPrefix: 'naver-reports',
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  });

  assert.deepEqual(
    {
      stockName: report.stockName,
      broker: report.broker,
      date: report.date,
      reportTitle: report.reportTitle,
      expectedFilename: report.expectedFilename
    },
    {
      stockName: '삼성에스디에스',
      broker: '한화투자증권',
      date: '2026-04-24',
      reportTitle: '낮은 주가 레벨, 기대해볼 만한 투자 성과',
      expectedFilename:
        'naver-reports/삼성에스디에스/2026-04-24_삼성에스디에스_한화투자증권_낮은 주가 레벨, 기대해볼 만한 투자 성과.pdf'
    }
  );
});

test('parseReportDetailDocument falls back to section name for non-company detail pages', () => {
  const sourceNode = {
    innerText: 'DS투자증권|2026.04.28|조회 274',
    textContent: 'DS투자증권|2026.04.28|조회 274'
  };
  const subjectNode = {
    textContent: '[DS Defense Daily] 2026-04-28 DS투자증권|2026.04.28|조회 274',
    querySelector(selector) {
      if (selector === 'p.source') {
        return sourceNode;
      }
      if (selector === 'span em') {
        return null;
      }
      return null;
    },
    cloneNode() {
      return {
        textContent: ' [DS Defense Daily] 2026-04-28 ',
        querySelector() {
          return null;
        }
      };
    }
  };
  const pdfNode = {
    getAttribute(name) {
      return name === 'href'
        ? 'https://stock.pstatic.net/stock-research/market/66/20260428_market_8516000.pdf'
        : null;
    }
  };

  const doc = {
    location: {
      href: 'https://finance.naver.com/research/market_info_read.naver?nid=35880&page=1'
    },
    querySelector(selector) {
      if (selector === 'th.view_sbj') {
        return subjectNode;
      }
      if (selector === 'th.view_report a[href$=".pdf"]') {
        return pdfNode;
      }
      if (selector === '.view_cnt a[href$=".pdf"]') {
        return null;
      }
      return null;
    }
  };

  const report = parseReportDetailDocument(doc, {
    settings: {
      downloadPathPrefix: 'naver-reports',
      filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
      createStockFolders: true
    }
  });

  assert.equal(report.stockName, '시황정보');
  assert.equal(report.reportType, 'market_info');
});
