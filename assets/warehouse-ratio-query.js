"use strict";

const STATUS_URL = "../data/warehouse-ratio-status.json";
const MODEL_URL = "../data/warehouse-ratio-model.enc.json";
const $ = (id) => document.getElementById(id);
const ids = [
  "unlock", "app", "unlockForm", "password", "unlockStatus", "unlockButton",
  "unlockDate", "unlockProducts", "unlockWarehouses", "unlockWarning", "lock",
  "meta", "notice", "brand", "l1", "l2", "l3", "price", "excludeLight",
  "skuList", "skuStats", "scopeReminder", "query", "reset", "download", "kpis", "rdcBody", "c62Body",
  "mappingBody", "mappingSearch",
];
const el = Object.fromEntries(ids.map((id) => [id, $(id)]));
const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const state = { status: null, model: null, result: null, worker: null };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function setStatus(message, info = false) {
  el.unlockStatus.textContent = message;
  el.unlockStatus.classList.toggle("info", info);
}

function showNotice(message) {
  el.notice.textContent = message;
  el.notice.hidden = !message;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error("数据下载失败");
  return response.json();
}

class Decryptor {
  constructor() {
    if (!window.Worker) throw new Error("当前浏览器不支持后台解密，请升级 Chrome 或 Edge");
    this.requestId = 0;
    this.pending = new Map();
    this.worker = new Worker("../assets/warehouse-ratio-decrypt-worker.js");
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      if (data.type === "progress") {
        request.progress(data.stage);
        return;
      }
      this.pending.delete(data.id);
      if (data.type === "result") request.resolve(data.result);
      else request.reject(Object.assign(new Error(data.message), { name: data.name }));
    };
  }

  decrypt(payloadText, password, progress) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject, progress });
      this.worker.postMessage({ type: "decrypt", id, payloadText, password });
    });
  }

  close() {
    this.worker.postMessage({ type: "clear" });
    this.worker.terminate();
  }
}

async function loadPublicStatus() {
  try {
    state.status = await fetchJson(STATUS_URL);
    const counts = state.status.counts || {};
    el.unlockDate.textContent = state.status.snapshot_date || "待发布";
    el.unlockProducts.textContent = counts.products == null ? "—" : `${numberFormat.format(counts.products)} 个`;
    el.unlockWarehouses.textContent = counts.delivery_centers == null ? "—" : `${counts.delivery_centers} 个`;
    if (state.status.warning) {
      el.unlockWarning.textContent = state.status.warning;
      el.unlockWarning.hidden = false;
    }
  } catch {
    setStatus("无法读取公开状态文件，请稍后重试。");
  }
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((first, second) => first.localeCompare(second, "zh-CN"));
}

function parseSkuList(value) {
  const tokens = String(value || "").split(/[\s,，;；、]+/).map((token) => token.trim()).filter(Boolean);
  const skus = [];
  const invalid = [];
  const seen = new Set();
  const invalidSeen = new Set();
  for (const token of tokens) {
    const normalized = token.replace(/\.0$/, "");
    if (!/^\d+$/.test(normalized)) {
      if (!invalidSeen.has(token)) {
        invalidSeen.add(token);
        invalid.push(token);
      }
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      skus.push(normalized);
    }
  }
  return { skus, invalid };
}

function updateSkuStats() {
  const parsed = parseSkuList(el.skuList.value);
  if (!el.skuList.value.trim()) {
    el.skuStats.textContent = "未输入时不限制 SKU。";
    el.skuStats.classList.remove("warning");
    return parsed;
  }
  const available = state.model ? new Set(state.model.products.map((product) => product.sku)) : new Set();
  const matched = parsed.skus.filter((sku) => available.has(sku)).length;
  const missing = parsed.skus.length - matched;
  const parts = [`识别 ${parsed.skus.length} 个`, `模型命中 ${matched} 个`];
  if (missing) parts.push(`未找到 ${missing} 个`);
  if (parsed.invalid.length) parts.push(`格式无效 ${parsed.invalid.length} 个`);
  el.skuStats.textContent = parts.join(" · ");
  el.skuStats.classList.toggle("warning", missing > 0 || parsed.invalid.length > 0);
  return parsed;
}

function setOptions(select, values, label, selected = "") {
  select.innerHTML = `<option value="">${escapeHtml(label)}</option>${values.map((value) =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`
  ).join("")}`;
}

function productsFor(level) {
  return state.model.products.filter((product) => {
    if (level !== "brand" && el.brand.value && product.brand !== el.brand.value) return false;
    if (!["brand", "l1"].includes(level) && el.l1.value && product.l1 !== el.l1.value) return false;
    if (!["brand", "l1", "l2"].includes(level) && el.l2.value && product.l2 !== el.l2.value) return false;
    return true;
  });
}

function refreshCategoryOptions(changed = "") {
  if (changed === "brand") {
    el.l1.value = "";
    el.l2.value = "";
    el.l3.value = "";
  } else if (changed === "l1") {
    el.l2.value = "";
    el.l3.value = "";
  } else if (changed === "l2") {
    el.l3.value = "";
  }
  const currentL1 = el.l1.value;
  const currentL2 = el.l2.value;
  const currentL3 = el.l3.value;
  setOptions(el.l1, uniqueSorted(productsFor("l1").map((product) => product.l1)), "全部一级类目", currentL1);
  setOptions(el.l2, uniqueSorted(productsFor("l2").map((product) => product.l2)), "全部二级类目", currentL2);
  setOptions(el.l3, uniqueSorted(productsFor("l3").map((product) => product.l3)), "全部三级类目", currentL3);
}

function initializeFilters() {
  setOptions(el.brand, uniqueSorted(state.model.products.map((product) => product.brand)), "全部品牌");
  refreshCategoryOptions();
  updateSkuStats();
  resetScopes();
}

function scopeInputs() {
  return [...document.querySelectorAll('input[name="scope"]')];
}

function selectedScopes() {
  const values = scopeInputs().filter((input) => input.checked).map((input) => input.value);
  return values.length ? values : ["all"];
}

function updateScopeReminder() {
  const scopes = selectedScopes();
  const names = {
    all: "全国全仓",
    "11rdc": "仅11RDC",
    direct62: "宝洁直送62仓",
    light: "轻货仓",
    city: "城市仓",
  };
  const suffix = el.excludeLight.checked ? "，不含轻货仓" : "，包含轻货仓";
  el.scopeReminder.textContent = `当前销量口径：${scopes.map((scope) => names[scope]).join(" + ")}${suffix}`;
}

function resetScopes() {
  for (const input of scopeInputs()) input.checked = input.value === "all";
  el.excludeLight.checked = true;
  updateScopeReminder();
}

function currentSettings() {
  const parsed = updateSkuStats();
  if (el.skuList.value.trim() && parsed.skus.length === 0) {
    throw new Error("SKU列表中没有识别到有效的数字ID。");
  }
  return {
    filters: {
      skus: parsed.skus,
      brand: el.brand.value,
      l1: el.l1.value,
      l2: el.l2.value,
      l3: el.l3.value,
      price: el.price.value,
    },
    scopes: selectedScopes(),
    excludeLight: el.excludeLight.checked,
  };
}

function renderKpis(result) {
  const skuNote = result.summary.requestedSkuCount
    ? `批量输入 ${result.summary.requestedSkuCount} 个，模型命中 ${result.summary.availableRequestedSkuCount} 个`
    : "采购价空值SKU已排除";
  const cards = [
    ["纳入SKU", numberFormat.format(result.summary.selectedProductCount), skuNote],
    ["纳入90日销量", numberFormat.format(result.summary.totalSales90), "近90日收货地商品件数"],
    ["贡献销量配送中心", numberFormat.format(result.summary.contributingWarehouseCount), `口径选择 ${result.summary.selectedWarehouseCount} 个配送中心`],
    ["排除轻货仓销量", numberFormat.format(result.summary.excludedLightSales), el.excludeLight.checked ? "当前未进入仓比" : "当前已包含"],
  ];
  el.kpis.innerHTML = cards.map(([label, value, note]) =>
    `<article class="kpi"><small>${label}</small><strong>${value}</strong><span>${escapeHtml(note)}</span></article>`
  ).join("");
}

function renderRatioTable(target, rows, nameField = "warehouse") {
  target.innerHTML = rows.map((row) => {
    const zeroClass = row.sales90 === 0 ? "zero" : "";
    return `<tr class="${zeroClass}"><td><strong>${escapeHtml(row[nameField])}</strong></td><td class="numeric">${numberFormat.format(row.sales90)}</td><td class="numeric">${percentFormat.format(row.ratio)}</td></tr>`;
  }).join("");
}

function renderMappings(rows) {
  el.mappingBody.innerHTML = rows.map((row) =>
    `<tr data-search="${escapeHtml(`${row.source} ${row.city} ${row.rdc} ${row.target62}`)}">
      <td><strong>${escapeHtml(row.source)}</strong></td>
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.city)}</td>
      <td>${escapeHtml(row.rdc)}</td>
      <td>${escapeHtml(row.target62)}</td>
      <td class="numeric">${row.distance62 == null ? "—" : decimalFormat.format(row.distance62)}</td>
      <td>${escapeHtml(row.second62 || "—")}</td>
      <td class="${row.boundary ? "boundary" : ""}">${row.boundary ? "边界" : "否"}</td>
      <td class="numeric">${numberFormat.format(row.sales90)}</td>
    </tr>`
  ).join("");
  filterMappings();
}

function render(result) {
  state.result = result;
  renderKpis(result);
  renderRatioTable(el.rdcBody, result.rdcRows);
  renderRatioTable(el.c62Body, result.c62Rows);
  renderMappings(result.mappingRows);
  el.download.disabled = result.summary.totalSales90 <= 0;
  if (result.summary.totalSales90 <= 0) {
    showNotice("当前筛选条件没有可计算的近90日收货地销量。");
  } else {
    showNotice(state.status?.warning || "");
  }
}

function runQuery() {
  try {
    el.query.disabled = true;
    el.query.textContent = "正在计算…";
    render(WarehouseRatioEngine.calculate(state.model, currentSettings()));
  } catch (error) {
    showNotice(error.message || "计算失败");
  } finally {
    el.query.disabled = false;
    el.query.textContent = "计算仓比";
  }
}

function filterMappings() {
  const query = el.mappingSearch.value.trim().toLocaleLowerCase("zh-CN");
  for (const row of el.mappingBody.querySelectorAll("tr")) {
    row.hidden = query && !row.dataset.search.toLocaleLowerCase("zh-CN").includes(query);
  }
}

function resetFilters() {
  el.skuList.value = "";
  el.brand.value = "";
  el.price.value = "";
  refreshCategoryOptions("brand");
  updateSkuStats();
  resetScopes();
  runQuery();
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, true);
  return output;
}

function uint32(value) {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value >>> 0, true);
  return output;
}

function joinBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function dosDateTime(date = new Date()) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zipStore(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const local = joinBytes([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(stamp.time), uint16(stamp.date),
      uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name, data,
    ]);
    locals.push(local);
    const central = joinBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(stamp.time), uint16(stamp.date),
      uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]);
    centrals.push(central);
    offset += local.length;
  }
  const centralBytes = joinBytes(centrals);
  return joinBytes([
    ...locals,
    centralBytes,
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralBytes.length), uint32(offset), uint16(0),
  ]);
}

function xmlText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((raw, columnIndex) => {
      const value = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
      const style = raw && typeof raw === "object" && "style" in raw ? raw.style : 0;
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${reference}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;
      }
      return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const lastColumn = columnName(Math.max(0, (rows[0]?.length || 1) - 1));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData><autoFilter ref="A1:${lastColumn}${Math.max(1, rows.length)}"/></worksheet>`;
}

function workbookBlob(sheets) {
  const sheetEntries = sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml(sheet.rows) }));
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xmlText(sheet.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const relationships = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const worksheetOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const entries = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${worksheetOverrides}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...sheetEntries,
  ];
  return new Blob([zipStore(entries)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function filterDescription(settings) {
  const filters = settings.filters;
  const priceNames = { "": "全部非空采购价", zero: "采购价为0", nonzero: "采购价不为0" };
  return [
    ["SKU批量筛选数量", filters.skus?.length || 0],
    ["品牌", filters.brand || "全部"],
    ["一级类目", filters.l1 || "全部"],
    ["二级类目", filters.l2 || "全部"],
    ["三级类目", filters.l3 || "全部"],
    ["采购价", priceNames[filters.price] || "全部非空采购价"],
    ["配送中心范围", settings.scopes.join(" + ")],
    ["排除轻货仓", settings.excludeLight ? "是" : "否"],
  ];
}

async function downloadExcel() {
  if (!state.result) return;
  el.download.disabled = true;
  const original = el.download.textContent;
  el.download.textContent = "正在生成 Excel…";
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = WarehouseRatioEngine.calculate(state.model, currentSettings(), true);
    const summaryRows = [
      ["项目", "值"],
      ["库存切片", state.status?.snapshot_date || ""],
      ["最新检测切片", state.status?.latest_detected_date || ""],
      ["页面数据提示", state.status?.warning || "使用最新成功切片"],
      ["纳入SKU", { value: result.summary.selectedProductCount, style: 1 }],
      ["纳入90日销量", { value: result.summary.totalSales90, style: 1 }],
      ["贡献销量配送中心", { value: result.summary.contributingWarehouseCount, style: 1 }],
      ["排除轻货仓销量", { value: result.summary.excludedLightSales, style: 1 }],
      ...filterDescription(result.settings),
    ];
    const rdcRows = [["11RDC", "90日件数", "备货占比"], ...result.rdcRows.map((row) => [row.warehouse, { value: row.sales90, style: 1 }, { value: row.ratio, style: 2 }])];
    const c62Rows = [["普通C仓", "标准城市", "90日件数", "备货占比"], ...result.c62Rows.map((row) => [row.warehouse, row.city, { value: row.sales90, style: 1 }, { value: row.ratio, style: 2 }])];
    const mappingRows = [["原配送中心", "仓型", "标准城市", "11RDC", "目标62仓", "最近距离km", "第二候选仓", "第二候选距离km", "地理边界", "映射置信度", "90日件数"], ...result.mappingRows.map((row) => [row.source, row.type, row.city, row.rdc, row.target62, row.distance62, row.second62, row.secondDistance62, row.boundary ? "是" : "否", row.confidence, { value: row.sales90, style: 1 }])];
    const detailHeaders = ["SKU", "商品名称", "品牌", "一级类目", "二级类目", "三级类目", "全国采购价", "原配送中心", "原仓型", "标准城市", "目标11RDC", "目标62仓", "近90日收货地商品件数"];
    const detailRows = [detailHeaders, ...result.details.map((row) => detailHeaders.map((header) => {
      const value = row[header];
      return header === "近90日收货地商品件数" ? { value, style: 1 } : value;
    }))];
    const quality = state.model.quality || {};
    const exceptionRows = [
      ["项目", "数量/说明"],
      ["采购价空值SKU", quality.blank_price_skus ?? 0],
      ["采购价冲突SKU", quality.price_conflict_skus ?? 0],
      ["零销量未映射配送中心", (quality.unmapped_zero_sales_centers || []).join("、") || "无"],
      ["缓存回退", state.status?.fallback_active ? "是" : "否"],
      ["提示", state.status?.warning || "无"],
    ];
    const methodologyRows = [
      ["口径", "说明"],
      ["销量字段", "近90日收货地商品件数"],
      ["全国行", "配送中心=全国为汇总行，不参与"],
      ["重复处理", "同一SKU×配送中心取最大值"],
      ["采购价", "全国采购价空值SKU不进入计算"],
      ["11RDC方案", "所选配送中心销量收敛到所属11RDC"],
      ["62仓方案", "普通C仓归自身；同城特殊仓归同城普通C仓；其他仓按城市中心球面距离归最近普通C仓"],
      ["多选", "配送中心范围按并集去重；全国全仓已包含11RDC"],
    ];
    const modelSkuSet = new Set(state.model.products.map((product) => product.sku));
    const skuFilterRows = [
      ["SKU ID", "模型是否存在"],
      ...(result.settings.filters.skus || []).map((sku) => [sku, modelSkuSet.has(sku) ? "是" : "否（可能不存在或采购价为空）"]),
    ];
    const blob = workbookBlob([
      { name: "01_查询摘要", rows: summaryRows },
      { name: "02_11RDC备货比", rows: rdcRows },
      { name: "03_62仓备货比", rows: c62Rows },
      { name: "04_收敛关系审计", rows: mappingRows },
      { name: "05_SKU销量明细", rows: detailRows },
      { name: "06_异常与排除", rows: exceptionRows },
      { name: "07_口径说明", rows: methodologyRows },
      { name: "08_SKU筛选清单", rows: skuFilterRows },
    ]);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `JD仓比查询_${state.status?.snapshot_date || "latest"}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    showNotice(error.message || "Excel生成失败");
  } finally {
    el.download.disabled = false;
    el.download.textContent = original;
  }
}

el.unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = el.password.value;
  if (!password) return setStatus("请输入访问密码。");
  el.unlockButton.disabled = true;
  try {
    setStatus("正在下载加密模型…", true);
    const response = await fetch(MODEL_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error("仓比加密模型尚未发布");
    state.worker ||= new Decryptor();
    const payload = await state.worker.decrypt(await response.text(), password, (stage) => setStatus({
      derive: "正在验证密码（PBKDF2 600,000轮）…",
      decrypt: "正在解密模型…",
      decompress: "正在解压模型…",
      parse: "正在解析模型…",
    }[stage], true));
    state.model = WarehouseRatioEngine.decodeModel(payload.data);
    initializeFilters();
    el.meta.textContent = `切片 ${payload.metadata?.snapshot_date || state.status?.snapshot_date || "未知"} · ${numberFormat.format(state.model.products.length)}个SKU · ${state.model.warehouses.length}个配送中心`;
    el.unlock.hidden = true;
    el.app.hidden = false;
    showNotice(payload.metadata?.warning || state.status?.warning || "");
    runQuery();
    window.scrollTo(0, 0);
  } catch (error) {
    setStatus(error.name === "OperationError" ? "密码不正确，或加密数据已损坏。" : error.message || "解锁失败。");
  } finally {
    el.unlockButton.disabled = false;
  }
});

for (const [select, level] of [[el.brand, "brand"], [el.l1, "l1"], [el.l2, "l2"]]) {
  select.addEventListener("change", () => refreshCategoryOptions(level));
}

for (const input of scopeInputs()) {
  input.addEventListener("change", () => {
    if (input.checked && input.value === "all") {
      for (const other of scopeInputs()) if (other !== input) other.checked = false;
    } else if (input.checked) {
      scopeInputs().find((item) => item.value === "all").checked = false;
    }
    if (input.checked && input.value === "light") el.excludeLight.checked = false;
    if (!scopeInputs().some((item) => item.checked)) {
      scopeInputs().find((item) => item.value === "all").checked = true;
    }
    updateScopeReminder();
  });
}

el.excludeLight.addEventListener("change", () => {
  if (el.excludeLight.checked) {
    const light = scopeInputs().find((input) => input.value === "light");
    if (light.checked) light.checked = false;
    if (!scopeInputs().some((input) => input.checked)) {
      scopeInputs().find((input) => input.value === "all").checked = true;
    }
  }
  updateScopeReminder();
});
el.skuList.addEventListener("input", updateSkuStats);
el.query.addEventListener("click", runQuery);
el.reset.addEventListener("click", resetFilters);
el.mappingSearch.addEventListener("input", filterMappings);
el.download.addEventListener("click", downloadExcel);
el.lock.addEventListener("click", () => {
  state.worker?.close();
  state.worker = null;
  state.model = null;
  state.result = null;
  el.password.value = "";
  el.app.hidden = true;
  el.unlock.hidden = false;
  setStatus("");
});

loadPublicStatus();
