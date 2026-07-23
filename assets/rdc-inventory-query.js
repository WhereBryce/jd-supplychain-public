"use strict";

const SHARD_BASE_URL = "../data/rdc-inventory-shards";
const SHARD_COUNT = 64;
const elements = Object.fromEntries([
  "unlockView", "appView", "unlockForm", "initialSku", "password", "togglePassword", "unlockButton",
  "unlockStatus", "lockButton", "refreshButton", "reportMeta", "totalRecords",
  "availableInventory", "outOfStock", "incomingInventory", "filterForm", "keywordFilter",
  "rdcFilter", "brandFilter", "statusFilter", "clearButton", "inventoryBody", "emptyState", "emptyStateText",
  "loadingState", "resultRange", "pageSize", "previousPage", "nextPage", "pageIndicator",
  "notice", "noticeText", "noticeClose", "tableFrame",
].map((id) => [id, document.getElementById(id)]));

const state = {
  payload: null,
  data: null,
  metadata: null,
  columns: null,
  lowerDictionaries: null,
  password: "",
  currentShard: null,
  filteredRows: [],
  page: 1,
  pageCount: 1,
};

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const rowLabels = [
  "状态", "RDC", "SKU", "商品名称", "品牌", "可用库存", "可订购库存",
  "采购未到货", "28日有货天数", "近7日出库", "报告日期",
];

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function fetchEncryptedPayload(url, reportProgress) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(response.status === 404 ? "加密库存尚未发布" : "加密库存下载失败");
  }
  if (!response.body) return response.json();

  const totalBytes = Number(response.headers.get("Content-Length")) || 0;
  const hasReliableTotal = totalBytes > 0 && !response.headers.get("Content-Encoding");
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    const receivedMb = (receivedBytes / 1024 / 1024).toFixed(1);
    if (hasReliableTotal) {
      const progress = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
      reportProgress(`正在下载 SKU 数据… ${progress}%`);
    } else {
      reportProgress(`正在下载 SKU 数据… ${receivedMb} MB`);
    }
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function decompressGzip(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("当前浏览器版本过旧，不支持库存解压，请升级浏览器");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decryptInventory(payload, password) {
  if (payload.version !== 1 || payload.algorithm !== "AES-256-GCM") {
    throw new Error("加密库存格式不受支持");
  }
  const salt = bytesFromBase64(payload.kdf.salt);
  const iv = bytesFromBase64(payload.iv);
  const ciphertext = bytesFromBase64(payload.ciphertext);
  const key = await deriveKey(password, salt, Number(payload.kdf.iterations));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  let decoded = new Uint8Array(plaintext);
  if (payload.compression === "gzip") {
    decoded = await decompressGzip(decoded);
  } else if (payload.compression) {
    throw new Error("库存压缩格式不受支持");
  }
  return JSON.parse(new TextDecoder().decode(decoded));
}

function isExactSku(value) {
  return /^\d+$/.test(value.trim());
}

async function skuShardIndex(sku) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sku));
  return new Uint8Array(digest)[0] % SHARD_COUNT;
}

async function downloadSkuShard(sku, password, reportProgress) {
  const shardIndex = await skuShardIndex(sku);
  const shardName = String(shardIndex).padStart(2, "0");
  const payload = await fetchEncryptedPayload(
    `${SHARD_BASE_URL}/${shardName}.enc.json`,
    reportProgress,
  );
  reportProgress("正在本地验证密码并解密…");
  const decrypted = await decryptInventory(payload, password);
  if (Number(decrypted.metadata?.shard_index) !== shardIndex) {
    throw new Error("SKU 分片校验失败");
  }
  return { payload, decrypted, shardIndex };
}

function setUnlockStatus(message, info = false) {
  elements.unlockStatus.textContent = message;
  elements.unlockStatus.classList.toggle("info", info);
}

function setUnlockLoading(loading) {
  elements.unlockButton.disabled = loading;
  elements.unlockButton.textContent = loading ? "正在下载并解密" : "解锁库存";
}

function showUnlock(message = "") {
  elements.appView.hidden = true;
  elements.unlockView.hidden = false;
  elements.password.value = "";
  setUnlockStatus(message);
  window.setTimeout(() => elements.password.focus(), 0);
}

function showApp() {
  elements.unlockView.hidden = true;
  elements.appView.hidden = false;
}

function clearDecryptedData() {
  state.payload = null;
  state.data = null;
  state.metadata = null;
  state.columns = null;
  state.lowerDictionaries = null;
  state.password = "";
  state.currentShard = null;
  state.filteredRows = [];
  elements.inventoryBody.replaceChildren();
}

function lockPage(message = "") {
  clearDecryptedData();
  showUnlock(message);
}

function dictionaryValue(column, code) {
  const values = state.data.dictionaries[column];
  return values && Number.isInteger(code) ? (values[code] ?? "") : "";
}

function valueAt(row, column) {
  const index = state.columns[column];
  const value = row[index];
  return Object.hasOwn(state.data.dictionaries, column)
    ? dictionaryValue(column, value)
    : value;
}

function stockStatus(available) {
  if (available === null || available === undefined || Number.isNaN(Number(available))) {
    return { key: "missing", label: "数据缺失", className: "status-missing" };
  }
  if (Number(available) <= 0) {
    return { key: "out", label: "缺货", className: "status-out" };
  }
  return { key: "in", label: "有库存", className: "status-in" };
}

function populateSelect(select, column, emptyLabel) {
  const values = state.data.dictionaries[column] || [];
  const fragment = document.createDocumentFragment();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  fragment.appendChild(empty);
  values.forEach((value) => {
    if (!value) return;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    fragment.appendChild(option);
  });
  select.replaceChildren(fragment);
}

function initializeData(decrypted) {
  if (!decrypted.data || decrypted.data.format !== "dictionary-rows-v1") {
    throw new Error("库存数据格式不受支持");
  }
  state.data = decrypted.data;
  state.metadata = decrypted.metadata || {};
  state.columns = Object.fromEntries(state.data.columns.map((column, index) => [column, index]));
  state.lowerDictionaries = Object.fromEntries(
    Object.entries(state.data.dictionaries).map(([column, values]) => [
      column,
      values.map((value) => String(value).toLocaleLowerCase("zh-CN")),
    ]),
  );
  const selectedRdc = elements.rdcFilter.value;
  const selectedBrand = elements.brandFilter.value;
  populateSelect(elements.rdcFilter, "RDC", "全部 RDC");
  populateSelect(elements.brandFilter, "品牌", "全部品牌");
  if (Array.from(elements.rdcFilter.options).some((option) => option.value === selectedRdc)) {
    elements.rdcFilter.value = selectedRdc;
  }
  if (Array.from(elements.brandFilter.options).some((option) => option.value === selectedBrand)) {
    elements.brandFilter.value = selectedBrand;
  }
  const reportDate = state.metadata.report_date || "日期未知";
  const generated = state.metadata.generated_at
    ? new Date(state.metadata.generated_at).toLocaleString("zh-CN", { hour12: false })
    : "时间未知";
  elements.reportMeta.textContent = `报告 ${reportDate} · 加密更新 ${generated}`;
}

async function handleUnlock(event) {
  event.preventDefault();
  if (!window.crypto || !window.crypto.subtle) {
    setUnlockStatus("当前环境不支持安全解密，请使用 HTTPS 打开本页");
    return;
  }
  const initialSku = elements.initialSku.value.trim();
  if (!isExactSku(initialSku)) {
    setUnlockStatus("请输入完整的数字 SKU");
    elements.initialSku.focus();
    return;
  }
  const password = elements.password.value;
  setUnlockLoading(true);
  setUnlockStatus("正在定位 SKU 数据…", true);
  try {
    const { payload, decrypted, shardIndex } = await downloadSkuShard(
      initialSku,
      password,
      (message) => setUnlockStatus(message, true),
    );
    state.payload = payload;
    state.password = password;
    state.currentShard = shardIndex;
    initializeData(decrypted);
    elements.keywordFilter.value = initialSku;
    elements.password.value = "";
    showApp();
    applyFilters();
  } catch (error) {
    const wrongPassword = error && error.name === "OperationError";
    setUnlockStatus(wrongPassword ? "密码不正确" : (error.message || "解锁失败"));
    elements.password.select();
  } finally {
    setUnlockLoading(false);
  }
}

async function ensureSkuShard(sku) {
  if (!isExactSku(sku)) {
    showNotice("请输入完整的数字 SKU");
    return false;
  }
  const shardIndex = await skuShardIndex(sku);
  if (state.data && state.currentShard === shardIndex) return true;

  setFiltering(true);
  showNotice("正在定位 SKU 数据…");
  try {
    const result = await downloadSkuShard(
      sku,
      state.password,
      (message) => showNotice(message),
    );
    state.payload = result.payload;
    state.currentShard = result.shardIndex;
    elements.initialSku.value = sku;
    initializeData(result.decrypted);
    hideNotice();
    return true;
  } catch (error) {
    if (error && error.name === "OperationError") {
      lockPage("库存已更新，请重新输入密码和 SKU");
      return false;
    }
    showNotice(error.message || "SKU 数据加载失败");
    return false;
  } finally {
    setFiltering(false);
  }
}

function rowMatchesKeyword(row, keyword) {
  if (!keyword) return true;
  for (const column of ["SKU", "商品名称", "品牌", "RDC"]) {
    const code = row[state.columns[column]];
    const value = state.lowerDictionaries[column][code] || "";
    if (value.includes(keyword)) return true;
  }
  return false;
}

function filterRows() {
  const keyword = elements.keywordFilter.value.trim().toLocaleLowerCase("zh-CN");
  const rdcValue = elements.rdcFilter.value;
  const brandValue = elements.brandFilter.value;
  const status = elements.statusFilter.value;
  const rdcIndex = state.columns.RDC;
  const brandIndex = state.columns["品牌"];
  const availableIndex = state.columns["可用库存"];
  const matches = [];
  for (let index = 0; index < state.data.rows.length; index += 1) {
    const row = state.data.rows[index];
    if (rdcValue && dictionaryValue("RDC", row[rdcIndex]) !== rdcValue) continue;
    if (brandValue && dictionaryValue("品牌", row[brandIndex]) !== brandValue) continue;
    if (status && stockStatus(row[availableIndex]).key !== status) continue;
    if (!rowMatchesKeyword(row, keyword)) continue;
    matches.push(index);
  }
  return matches;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return numberFormatter.format(Number(value));
}

function textCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value === null || value === undefined || value === "" ? "--" : String(value);
  cell.title = value === null || value === undefined ? "" : String(value);
  if (className) cell.className = className;
  return cell;
}

function numberCell(value) {
  return textCell(formatNumber(value), "number-cell");
}

function renderRows() {
  const pageSize = Number(elements.pageSize.value);
  state.pageCount = Math.max(1, Math.ceil(state.filteredRows.length / pageSize));
  state.page = Math.min(Math.max(1, state.page), state.pageCount);
  const start = (state.page - 1) * pageSize;
  const end = Math.min(start + pageSize, state.filteredRows.length);
  const fragment = document.createDocumentFragment();
  for (const dataIndex of state.filteredRows.slice(start, end)) {
    const rowData = state.data.rows[dataIndex];
    const status = stockStatus(valueAt(rowData, "可用库存"));
    const row = document.createElement("tr");
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge ${status.className}`;
    badge.textContent = status.label;
    statusCell.appendChild(badge);
    row.append(
      statusCell,
      textCell(valueAt(rowData, "RDC")),
      textCell(valueAt(rowData, "SKU"), "sku-cell"),
      textCell(valueAt(rowData, "商品名称")),
      textCell(valueAt(rowData, "品牌")),
      numberCell(valueAt(rowData, "可用库存")),
      numberCell(valueAt(rowData, "可订购库存")),
      numberCell(valueAt(rowData, "采购未到货")),
      numberCell(valueAt(rowData, "28日有货天数")),
      numberCell(valueAt(rowData, "近7日出库商品件数")),
      textCell(valueAt(rowData, "时间")),
    );
    Array.from(row.cells).forEach((cell, index) => {
      cell.dataset.label = rowLabels[index];
    });
    fragment.appendChild(row);
  }
  elements.inventoryBody.replaceChildren(fragment);
  elements.emptyStateText.textContent = "没有匹配的库存记录";
  elements.emptyState.hidden = state.filteredRows.length !== 0;
  const first = state.filteredRows.length === 0 ? 0 : start + 1;
  elements.resultRange.textContent = `${first}-${end} / ${numberFormatter.format(state.filteredRows.length)}`;
  elements.pageIndicator.textContent = `第 ${state.page} / ${state.pageCount} 页`;
  elements.previousPage.disabled = state.page <= 1;
  elements.nextPage.disabled = state.page >= state.pageCount;
}

function renderSummary() {
  let availableTotal = 0;
  let incomingTotal = 0;
  let outCount = 0;
  for (const dataIndex of state.filteredRows) {
    const row = state.data.rows[dataIndex];
    const available = valueAt(row, "可用库存");
    const incoming = valueAt(row, "采购未到货");
    if (available !== null && available !== undefined && !Number.isNaN(Number(available))) {
      availableTotal += Number(available);
      if (Number(available) <= 0) outCount += 1;
    }
    if (incoming !== null && incoming !== undefined && !Number.isNaN(Number(incoming))) {
      incomingTotal += Number(incoming);
    }
  }
  elements.totalRecords.textContent = numberFormatter.format(state.filteredRows.length);
  elements.availableInventory.textContent = numberFormatter.format(availableTotal);
  elements.outOfStock.textContent = numberFormatter.format(outCount);
  elements.incomingInventory.textContent = numberFormatter.format(incomingTotal);
}

function setFiltering(loading) {
  elements.loadingState.hidden = !loading;
}

function applyFilters() {
  if (!state.data) return;
  setFiltering(true);
  window.setTimeout(() => {
    try {
      state.filteredRows = filterRows();
      renderSummary();
      renderRows();
    } catch (error) {
      showNotice(error.message || "筛选失败");
    } finally {
      setFiltering(false);
    }
  });
}

function clearFilters() {
  elements.keywordFilter.value = "";
  elements.rdcFilter.value = "";
  elements.brandFilter.value = "";
  elements.statusFilter.value = "";
  state.data = null;
  state.columns = null;
  state.lowerDictionaries = null;
  state.currentShard = null;
  state.filteredRows = [];
  state.page = 1;
  elements.inventoryBody.replaceChildren();
  elements.emptyStateText.textContent = "输入完整 SKU 后查询";
  elements.emptyState.hidden = false;
  elements.resultRange.textContent = "等待输入 SKU";
  elements.pageIndicator.textContent = "第 1 / 1 页";
  elements.previousPage.disabled = true;
  elements.nextPage.disabled = true;
  elements.totalRecords.textContent = "0";
  elements.availableInventory.textContent = "0";
  elements.outOfStock.textContent = "0";
  elements.incomingInventory.textContent = "0";
}

function showNotice(message) {
  elements.noticeText.textContent = message;
  elements.notice.hidden = false;
}

function hideNotice() {
  elements.notice.hidden = true;
  elements.noticeText.textContent = "";
}

elements.unlockForm.addEventListener("submit", handleUnlock);
elements.togglePassword.addEventListener("click", () => {
  const reveal = elements.password.type === "password";
  elements.password.type = reveal ? "text" : "password";
  elements.togglePassword.textContent = reveal ? "隐藏" : "显示";
  elements.password.focus();
});
elements.lockButton.addEventListener("click", () => lockPage());
elements.refreshButton.addEventListener("click", () => lockPage("加密库存可能已更新，请重新输入密码"));
elements.filterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.page = 1;
  hideNotice();
  const ready = await ensureSkuShard(elements.keywordFilter.value.trim());
  if (!ready) return;
  applyFilters();
});
for (const select of [elements.rdcFilter, elements.brandFilter, elements.statusFilter]) {
  select.addEventListener("change", () => {
    state.page = 1;
    applyFilters();
  });
}
elements.clearButton.addEventListener("click", clearFilters);
elements.pageSize.addEventListener("change", () => {
  if (!state.data) return;
  state.page = 1;
  renderRows();
});
elements.previousPage.addEventListener("click", () => {
  if (state.page > 1) { state.page -= 1; renderRows(); elements.tableFrame.scrollLeft = 0; }
});
elements.nextPage.addEventListener("click", () => {
  if (state.page < state.pageCount) { state.page += 1; renderRows(); elements.tableFrame.scrollLeft = 0; }
});
elements.noticeClose.addEventListener("click", hideNotice);

if (!window.isSecureContext) {
  setUnlockStatus("请通过 GitHub Pages 的 HTTPS 地址打开本页");
}