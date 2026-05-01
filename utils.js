(function attachUtils(root) {
  'use strict';

  const ROOT_FOLDER = 'naver-reports';
  const SETTINGS_STORAGE_KEY = 'naverReportSettings';
  const RESEARCH_PAGE_CONFIGS = [
    {
      kind: 'company',
      sectionName: '종목분석',
      listPath: '/research/company_list.naver',
      detailPath: '/research/company_read.naver',
      titleCellIndex: 1,
      brokerCellIndex: 2,
      entityResolver: 'stock'
    },
    {
      kind: 'market_info',
      sectionName: '시황정보',
      listPath: '/research/market_info_list.naver',
      detailPath: '/research/market_info_read.naver',
      titleCellIndex: 0,
      brokerCellIndex: 1,
      entityResolver: 'section'
    },
    {
      kind: 'invest',
      sectionName: '투자정보',
      listPath: '/research/invest_list.naver',
      detailPath: '/research/invest_read.naver',
      titleCellIndex: 0,
      brokerCellIndex: 1,
      entityResolver: 'section'
    },
    {
      kind: 'industry',
      sectionName: '산업분석',
      listPath: '/research/industry_list.naver',
      detailPath: '/research/industry_read.naver',
      titleCellIndex: 1,
      brokerCellIndex: 2,
      entityResolver: 'category'
    },
    {
      kind: 'economy',
      sectionName: '경제분석',
      listPath: '/research/economy_list.naver',
      detailPath: '/research/economy_read.naver',
      titleCellIndex: 0,
      brokerCellIndex: 1,
      entityResolver: 'section'
    },
    {
      kind: 'debenture',
      sectionName: '채권분석',
      listPath: '/research/debenture_list.naver',
      detailPath: '/research/debenture_read.naver',
      titleCellIndex: 0,
      brokerCellIndex: 1,
      entityResolver: 'section'
    }
  ];

  const DEFAULT_SETTINGS = {
    downloadPathPrefix: ROOT_FOLDER,
    filenameTemplate: '{date}_{stockName}_{broker}_{reportTitle}.pdf',
    useNativePathPicker: false,
    createStockFolders: true,
    bulkMaxPages: 10,
    bulkConcurrency: 1,
    bulkDelayMs: 500,
    bulkRetryMax: 1
  };

  const KRX_FIXED_MARKET_HOLIDAY_MONTH_DAYS = new Set([
    '01-01',
    '03-01',
    '05-01',
    '05-05',
    '06-06',
    '08-15',
    '10-03',
    '10-09',
    '12-25'
  ]);

  const KRX_MARKET_HOLIDAYS_BY_YEAR = {
    2026: new Set([
      '2026-01-01',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-03-02',
      '2026-05-01',
      '2026-05-05',
      '2026-05-25',
      '2026-08-17',
      '2026-09-24',
      '2026-09-25',
      '2026-10-05',
      '2026-10-09',
      '2026-12-25',
      '2026-12-31'
    ])
  };

  function normalizeSettings(input) {
    const source = input || {};
    return {
      downloadPathPrefix: normalizePathPrefix(
        typeof source.downloadPathPrefix === 'string'
          ? source.downloadPathPrefix
          : DEFAULT_SETTINGS.downloadPathPrefix
      ),
      filenameTemplate:
        typeof source.filenameTemplate === 'string' && source.filenameTemplate.trim()
          ? source.filenameTemplate.trim()
          : DEFAULT_SETTINGS.filenameTemplate,
      useNativePathPicker: Boolean(source.useNativePathPicker),
      createStockFolders: source.createStockFolders !== false,
      bulkMaxPages: clampInteger(source.bulkMaxPages, 1, 100, DEFAULT_SETTINGS.bulkMaxPages),
      bulkConcurrency: clampInteger(
        source.bulkConcurrency,
        1,
        5,
        DEFAULT_SETTINGS.bulkConcurrency
      ),
      bulkDelayMs: DEFAULT_SETTINGS.bulkDelayMs,
      bulkRetryMax: clampInteger(source.bulkRetryMax, 0, 3, DEFAULT_SETTINGS.bulkRetryMax)
    };
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
  }

  function normalizeDate(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      throw new Error('Invalid date: empty');
    }

    let year;
    let month;
    let day;

    if (/^\d{2}\.\d{2}\.\d{2}$/.test(raw)) {
      const parts = raw.split('.');
      year = Number.parseInt(`20${parts[0]}`, 10);
      month = Number.parseInt(parts[1], 10);
      day = Number.parseInt(parts[2], 10);
    } else if (/^\d{4}\.\d{2}\.\d{2}$/.test(raw)) {
      const parts = raw.split('.');
      year = Number.parseInt(parts[0], 10);
      month = Number.parseInt(parts[1], 10);
      day = Number.parseInt(parts[2], 10);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const parts = raw.split('-');
      year = Number.parseInt(parts[0], 10);
      month = Number.parseInt(parts[1], 10);
      day = Number.parseInt(parts[2], 10);
    } else {
      throw new Error(`Invalid date format: ${raw}`);
    }

    const normalized = validateDateParts(year, month, day);
    return normalized;
  }

  function validateDateParts(year, month, day) {
    const candidate = new Date(Date.UTC(year, month - 1, day));

    if (
      candidate.getUTCFullYear() !== year ||
      candidate.getUTCMonth() !== month - 1 ||
      candidate.getUTCDate() !== day
    ) {
      throw new Error(`Invalid date: ${year}-${month}-${day}`);
    }

    return [
      String(year).padStart(4, '0'),
      String(month).padStart(2, '0'),
      String(day).padStart(2, '0')
    ].join('-');
  }

  function isKrxTradingDate(value) {
    const normalized = normalizeDate(value);
    return !isWeekend(normalized) && !isKrxMarketHoliday(normalized);
  }

  function getRecentKrxTradingDate(value) {
    let candidate = parseIsoDateToUtcDate(normalizeDate(value));

    for (let checkedDays = 0; checkedDays < 370; checkedDays += 1) {
      const normalized = formatUtcDate(candidate);
      if (isKrxTradingDate(normalized)) {
        return normalized;
      }
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }

    throw new Error('Unable to find a recent KRX trading date.');
  }

  function isKrxMarketHoliday(value) {
    const normalized = normalizeDate(value);
    const year = normalized.slice(0, 4);
    const monthDay = normalized.slice(5);
    const knownHolidays = KRX_MARKET_HOLIDAYS_BY_YEAR[year];

    return (
      KRX_FIXED_MARKET_HOLIDAY_MONTH_DAYS.has(monthDay) ||
      Boolean(knownHolidays && knownHolidays.has(normalized)) ||
      normalized === getKrxYearEndClosingDate(Number.parseInt(year, 10))
    );
  }

  function getKrxYearEndClosingDate(year) {
    let candidate = new Date(Date.UTC(year, 11, 31));

    while (isWeekend(formatUtcDate(candidate))) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }

    return formatUtcDate(candidate);
  }

  function isWeekend(value) {
    const date = parseIsoDateToUtcDate(normalizeDate(value));
    const day = date.getUTCDay();
    return day === 0 || day === 6;
  }

  function parseIsoDateToUtcDate(value) {
    const [year, month, day] = normalizeDate(value)
      .split('-')
      .map((part) => Number.parseInt(part, 10));
    return new Date(Date.UTC(year, month - 1, day));
  }

  function formatUtcDate(date) {
    return [
      String(date.getUTCFullYear()).padStart(4, '0'),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0')
    ].join('-');
  }

  function sanitizeFilename(value) {
    const normalized =
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';

    const canonical = typeof normalized.normalize === 'function'
      ? normalized.normalize('NFC')
      : normalized;

    const cleaned = canonical
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\.+|\.+$/g, '')
      .trim();

    return cleaned || 'untitled';
  }

  function normalizePathPrefix(value) {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    const segments = raw
      .split('/')
      .map((segment) => sanitizeFilename(segment))
      .filter(Boolean);

    if (!segments.length) {
      return ROOT_FOLDER;
    }

    return segments.join('/');
  }

  function buildFilename(report, settings) {
    const config = normalizeSettings(settings);
    const date = normalizeDate(report.date || report.rawDate || '');
    const stockName = sanitizeFilename(resolveEntityName(report));
    const broker = sanitizeFilename(report.broker || '');
    const reportTitle = sanitizeFilename(report.reportTitle || '');

    let basename = config.filenameTemplate
      .replace(/\{date\}/g, date)
      .replace(/\{stockName\}/g, stockName)
      .replace(/\{broker\}/g, broker)
      .replace(/\{reportTitle\}/g, reportTitle);

    basename = sanitizeFilename(basename);
    if (!/\.pdf$/i.test(basename)) {
      basename = `${basename}.pdf`;
    }

    const parts = [config.downloadPathPrefix || ROOT_FOLDER];
    if (config.createStockFolders) {
      parts.push(stockName || 'untitled');
    }
    parts.push(basename);

    return parts.join('/');
  }

  function buildDailyZipFilename(settings, targetDate) {
    const config = normalizeSettings(settings);
    const date = normalizeDate(targetDate);
    return [config.downloadPathPrefix || ROOT_FOLDER, `${date}.zip`].join('/');
  }

  function buildSectionZipFilename(settings, sectionName) {
    const config = normalizeSettings(settings);
    const zipName = sanitizeFilename(sectionName || '리포트');
    return [config.downloadPathPrefix || ROOT_FOLDER, `${zipName}.zip`].join('/');
  }

  function buildReportZipEntryPath(report, settings) {
    const zipRoot = '__zip-root__';
    const filename = buildFilename(report, {
      ...(settings || {}),
      downloadPathPrefix: zipRoot
    });
    const prefix = `${zipRoot}/`;
    return filename.startsWith(prefix) ? filename.slice(prefix.length) : filename;
  }

  function createZipArchive(entries) {
    const sourceEntries = Array.isArray(entries) ? entries : [];
    const encoder = new TextEncoder();
    const usedPaths = new Set();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const sourceEntry of sourceEntries) {
      const data = toUint8Array(sourceEntry && sourceEntry.data);
      const entryPath = uniquifyZipPath(
        normalizeZipEntryPath(sourceEntry && sourceEntry.path),
        usedPaths
      );
      const nameBytes = encoder.encode(entryPath);
      const crc32 = calculateCrc32(data);

      assertZip32Size(nameBytes.length, 'ZIP entry name is too long.');
      assertZip32Size(data.length, 'ZIP entry data is too large.');
      assertZip32Size(offset, 'ZIP archive is too large.');

      const localHeader = createZipLocalHeader(nameBytes.length, crc32, data.length);
      localParts.push(localHeader, nameBytes, data);

      const centralHeader = createZipCentralHeader(
        nameBytes.length,
        crc32,
        data.length,
        offset
      );
      centralParts.push(centralHeader, nameBytes);

      offset += localHeader.length + nameBytes.length + data.length;
    }

    const centralDirectoryOffset = offset;
    const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
    assertZip32Size(centralDirectoryOffset, 'ZIP archive is too large.');
    assertZip32Size(centralDirectorySize, 'ZIP central directory is too large.');
    assertZipEntryCount(sourceEntries.length);

    const endRecord = createZipEndRecord(
      sourceEntries.length,
      centralDirectorySize,
      centralDirectoryOffset
    );

    return concatUint8Arrays([...localParts, ...centralParts, endRecord]);
  }

  function parseReportRow(row, options) {
    if (!row || typeof row.querySelector !== 'function') {
      return null;
    }

    const baseUrl = (options && options.baseUrl) || getDocumentBaseUrl(row);
    const pageConfig = (options && options.pageConfig) || getResearchPageConfig(baseUrl);
    if (!pageConfig) {
      return null;
    }

    const cells = Array.from(row.querySelectorAll('td'));
    const titleLink =
      cells[pageConfig.titleCellIndex] &&
      cells[pageConfig.titleCellIndex].querySelector('a');
    const fileLink =
      row.querySelector('td.file a[href]') ||
      row.querySelector('td.tc a[href]');
    const dateCell = row.querySelector('td.date');

    if (!titleLink || !fileLink || !dateCell || cells.length <= pageConfig.brokerCellIndex) {
      return null;
    }

    const pdfUrl = toAbsoluteUrl(fileLink.getAttribute('href'), baseUrl);
    if (!pdfUrl || !/\.pdf(?:$|[?#])/i.test(pdfUrl)) {
      return null;
    }

    const report = {
      stockName: resolveRowEntityName(pageConfig, row, cells),
      stockCode: resolveRowStockCode(pageConfig, row),
      sectionName: pageConfig.sectionName,
      reportType: pageConfig.kind,
      reportTitle: sanitizeText(titleLink.textContent),
      reportUrl: toAbsoluteUrl(titleLink.getAttribute('href'), baseUrl),
      broker: sanitizeText(cells[pageConfig.brokerCellIndex] ? cells[pageConfig.brokerCellIndex].textContent : ''),
      pdfUrl,
      rawDate: sanitizeText(dateCell.textContent)
    };

    report.date = normalizeDate(report.rawDate);
    report.expectedFilename = buildFilename(report, options && options.settings);

    return report;
  }

  function parseReportRowsFromDocument(doc, options) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return [];
    }

    const reportTable =
      doc.querySelector('.box_type_m table.type_1') ||
      doc.querySelector('table.type_1');
    if (!reportTable) {
      return [];
    }

    const rows = Array.from(reportTable.querySelectorAll('tr'));
    return rows
      .map((row) => parseReportRow(row, options))
      .filter(Boolean);
  }

  function parseReportRowsFromResearchHomeDocument(doc, options) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return [];
    }

    const baseUrl = (options && options.baseUrl) || getDocumentBaseUrl(doc);
    const reports = [];
    const sectionBoxes = Array.from(doc.querySelectorAll('.box_type_m'));

    for (const sectionBox of sectionBoxes) {
      const sectionNameNode =
        sectionBox.querySelector('h4.top_tlt em') ||
        sectionBox.querySelector('caption');
      const sectionName = sanitizeText(sectionNameNode && sectionNameNode.textContent)
        .replace(/\s*리포트\s*$/, '');
      const sectionConfig = getResearchSectionConfig(sectionName);
      if (!sectionConfig) {
        continue;
      }

      const rows = Array.from(sectionBox.querySelectorAll('table tr'));
      for (const row of rows) {
        const report = parseReportRow(row, {
          ...(options || {}),
          baseUrl,
          pageConfig: sectionConfig
        });
        if (report) {
          reports.push(report);
        }
      }
    }

    return reports;
  }

  function parseReportDetailDocument(doc, options) {
    if (!doc || typeof doc.querySelector !== 'function') {
      return null;
    }

    const baseUrl = (options && options.baseUrl) || getDocumentBaseUrl(doc);
    const pageConfig = getResearchPageConfig(baseUrl);
    if (!pageConfig) {
      return null;
    }

    const subjectNode = doc.querySelector('th.view_sbj');
    const sourceNode = subjectNode && subjectNode.querySelector('p.source');
    const stockNode = subjectNode && subjectNode.querySelector('span em');
    const pdfLink =
      doc.querySelector('th.view_report a[href$=".pdf"]') ||
      doc.querySelector('.view_cnt a[href$=".pdf"]');

    if (!subjectNode || !sourceNode || !pdfLink) {
      return null;
    }

    const sourceText = sanitizeText(
      typeof sourceNode.innerText === 'string' && sourceNode.innerText.trim()
        ? sourceNode.innerText
        : sourceNode.textContent
    );
    const sourceParts = sourceText.split('|').map((part) => sanitizeText(part));
    const broker = sourceParts[0] || '';
    const rawDate = sourceParts[1] || '';

    const clonedSubjectText = cloneSubjectText(subjectNode, stockNode, sourceNode);
    const report = {
      stockName: stockNode ? sanitizeText(stockNode.textContent) : pageConfig.sectionName,
      stockCode: '',
      sectionName: pageConfig.sectionName,
      reportType: pageConfig.kind,
      reportTitle: sanitizeText(clonedSubjectText),
      reportUrl: baseUrl,
      broker,
      pdfUrl: toAbsoluteUrl(pdfLink.getAttribute('href'), baseUrl),
      rawDate
    };

    report.date = normalizeDate(report.rawDate);
    report.expectedFilename = buildFilename(report, options && options.settings);

    return report;
  }

  function dedupeReports(reports) {
    const seen = new Set();
    const unique = [];

    for (const report of reports || []) {
      if (!report || !report.pdfUrl || seen.has(report.pdfUrl)) {
        continue;
      }
      seen.add(report.pdfUrl);
      unique.push(report);
    }

    return unique;
  }

  function normalizeZipEntryPath(value) {
    const segments = String(value || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((segment) => sanitizeFilename(segment))
      .filter((segment) => segment && segment !== '.' && segment !== '..');

    return segments.length ? segments.join('/') : 'untitled.pdf';
  }

  function uniquifyZipPath(path, usedPaths) {
    if (!usedPaths.has(path)) {
      usedPaths.add(path);
      return path;
    }

    const slashIndex = path.lastIndexOf('/');
    const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : '';
    const basename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
    const dotIndex = basename.lastIndexOf('.');
    const stem = dotIndex > 0 ? basename.slice(0, dotIndex) : basename;
    const extension = dotIndex > 0 ? basename.slice(dotIndex) : '';

    let count = 2;
    let candidate = '';
    do {
      candidate = `${directory}${stem} (${count})${extension}`;
      count += 1;
    } while (usedPaths.has(candidate));

    usedPaths.add(candidate);
    return candidate;
  }

  function toUint8Array(value) {
    if (!value) {
      return new Uint8Array(0);
    }

    if (value instanceof Uint8Array) {
      return value;
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (typeof value === 'string') {
      return new TextEncoder().encode(value);
    }

    throw new Error('Unsupported ZIP entry data.');
  }

  function createZipLocalHeader(nameLength, crc32, dataLength) {
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc32, true);
    view.setUint32(18, dataLength, true);
    view.setUint32(22, dataLength, true);
    view.setUint16(26, nameLength, true);
    view.setUint16(28, 0, true);
    return header;
  }

  function createZipCentralHeader(nameLength, crc32, dataLength, localHeaderOffset) {
    const header = new Uint8Array(46);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, crc32, true);
    view.setUint32(20, dataLength, true);
    view.setUint32(24, dataLength, true);
    view.setUint16(28, nameLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, localHeaderOffset, true);
    return header;
  }

  function createZipEndRecord(entryCount, centralDirectorySize, centralDirectoryOffset) {
    const record = new Uint8Array(22);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralDirectorySize, true);
    view.setUint32(16, centralDirectoryOffset, true);
    view.setUint16(20, 0, true);
    return record;
  }

  function concatUint8Arrays(parts) {
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    assertZip32Size(totalLength, 'ZIP archive is too large.');

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  function calculateCrc32(data) {
    const table = getCrc32Table();
    let crc = 0xffffffff;

    for (let index = 0; index < data.length; index += 1) {
      crc = (crc >>> 8) ^ table[(crc ^ data[index]) & 0xff];
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  let crc32Table = null;
  function getCrc32Table() {
    if (crc32Table) {
      return crc32Table;
    }

    crc32Table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crc32Table[index] = value >>> 0;
    }

    return crc32Table;
  }

  function assertZip32Size(value, message) {
    if (value > 0xffffffff) {
      throw new Error(message);
    }
  }

  function assertZipEntryCount(value) {
    if (value > 0xffff) {
      throw new Error('ZIP archive has too many entries.');
    }
  }

  function sanitizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function resolveEntityName(report) {
    return (
      report.stockName ||
      report.category ||
      report.sectionName ||
      report.reportType ||
      'untitled'
    );
  }

  function getResearchPageConfig(source) {
    const pathname = extractPathname(source);
    if (!pathname) {
      return null;
    }

    if (pathname === '/research/' || pathname === '/research/index.naver') {
      return {
        kind: 'research_home',
        sectionName: '리서치',
        listPath: '/research/',
        detailPath: '',
        pageType: 'home'
      };
    }

    for (const config of RESEARCH_PAGE_CONFIGS) {
      if (pathname === config.listPath) {
        return { ...config, pageType: 'list' };
      }
      if (pathname === config.detailPath) {
        return { ...config, pageType: 'detail' };
      }
    }

    return null;
  }

  function getResearchSectionConfig(sectionName) {
    const normalized = sanitizeText(sectionName);
    const config = RESEARCH_PAGE_CONFIGS.find((item) => item.sectionName === normalized);
    return config ? { ...config, pageType: 'list' } : null;
  }

  function toAbsoluteUrl(value, baseUrl) {
    if (!value) {
      return '';
    }

    try {
      return new URL(value, baseUrl || 'https://finance.naver.com/').href;
    } catch (_error) {
      return '';
    }
  }

  function getDocumentBaseUrl(node) {
    const ownerDocument =
      node && node.ownerDocument
        ? node.ownerDocument
        : node && node.location
          ? node
          : null;
    return (ownerDocument && ownerDocument.location && ownerDocument.location.href) ||
      'https://finance.naver.com/research/company_list.naver';
  }

  function extractPathname(source) {
    if (!source) {
      return '';
    }

    if (typeof source === 'string') {
      try {
        return new URL(source, 'https://finance.naver.com/').pathname;
      } catch (_error) {
        return '';
      }
    }

    if (source.location && typeof source.location.pathname === 'string') {
      return source.location.pathname;
    }

    if (source.ownerDocument && source.ownerDocument.location) {
      return source.ownerDocument.location.pathname || '';
    }

    return '';
  }

  function cloneSubjectText(subjectNode, stockNode, sourceNode) {
    const clone =
      typeof subjectNode.cloneNode === 'function'
        ? subjectNode.cloneNode(true)
        : null;

    if (clone && typeof clone.querySelector === 'function') {
      const cloneStock = clone.querySelector('span');
      const cloneSource = clone.querySelector('p.source');
      if (cloneStock && typeof cloneStock.remove === 'function') {
        cloneStock.remove();
      }
      if (cloneSource && typeof cloneSource.remove === 'function') {
        cloneSource.remove();
      }
      return clone.textContent || '';
    }

    const combined = String(subjectNode.textContent || '');
    const stockText = stockNode ? String(stockNode.textContent || '') : '';
    const sourceText = sourceNode ? String(sourceNode.textContent || '') : '';
    return combined
      .replace(stockText, '')
      .replace(sourceText, '')
      .trim();
  }

  function getStockCodeFromHref(href) {
    if (!href) {
      return '';
    }

    try {
      return new URL(href, 'https://finance.naver.com/').searchParams.get('code') || '';
    } catch (_error) {
      return '';
    }
  }

  function resolveRowEntityName(pageConfig, row, cells) {
    if (pageConfig.entityResolver === 'stock') {
      const stockLink = getRowStockLink(row);
      return sanitizeText(stockLink ? stockLink.textContent : cells[0] && cells[0].textContent);
    }

    if (pageConfig.entityResolver === 'category') {
      return sanitizeText(cells[0] && cells[0].textContent);
    }

    return pageConfig.sectionName;
  }

  function resolveRowStockCode(pageConfig, row) {
    if (pageConfig.entityResolver !== 'stock') {
      return '';
    }

    const stockLink = getRowStockLink(row);
    return getStockCodeFromHref(stockLink && stockLink.getAttribute('href'));
  }

  function getRowStockLink(row) {
    return row.querySelector('a.stock_item') ||
      row.querySelector('a[href*="/item/main.naver"][href*="code="]') ||
      row.querySelector('a[href*="code="]');
  }

  const exported = {
    ROOT_FOLDER,
    SETTINGS_STORAGE_KEY,
    RESEARCH_PAGE_CONFIGS,
    DEFAULT_SETTINGS,
    normalizeSettings,
    normalizeDate,
    isKrxTradingDate,
    getRecentKrxTradingDate,
    sanitizeFilename,
    buildFilename,
    buildDailyZipFilename,
    buildSectionZipFilename,
    buildReportZipEntryPath,
    createZipArchive,
    getResearchPageConfig,
    getResearchSectionConfig,
    parseReportRow,
    parseReportRowsFromDocument,
    parseReportRowsFromResearchHomeDocument,
    parseReportDetailDocument,
    dedupeReports
  };

  root.NaverReportUtils = exported;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
