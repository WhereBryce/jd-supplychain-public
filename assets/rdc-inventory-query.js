"use strict";

const SHARD_BASE_URL = "../data/rdc-inventory-shards";
const CATALOG_URL = "../data/rdc-product-catalog.enc.json";
const SEARCH_BASE_URL = "../data/rdc-product-search";
const SHARD_COUNT = 64;
const SEARCH_SHARD_COUNT = 256;
const MAX_PRODUCT_MATCHES = 100;
const elements = Object.fromEntries([
  "unlockView", "appView", "unlockForm", "password", "togglePassword", "unlockButton",
  "unlockStatus", "lockButton", "refreshButton", "reportMeta", "totalRecords",
  "matchedProducts", "availableInventory", "incomingInventory", "filterForm", "keywordFilter",
  "searchSuggestions", "rdcFilter", "clearButton", "productResults", "productResultsTitle", "productResultsCount", "productList",
  "inventoryBody", "emptyState", "emptyStateText",
  "loadingState", "resultRange", "pageSize", "previousPage", "nextPage", "pageIndicator",
  "notice", "noticeText", "noticeClose", "tableFrame",
].map((id) => [id, document.getElementById(id)]));

const state = {
  payload: null,
  catalog: null,
  products: [],
  searchBuckets: new Map(),
  searchBucketPromises: new Map(),
  data: null,
  metadata: null,
  columns: null,
  lowerDictionaries: null,
  password: "",
  currentShard: null,
  selectedSku: "",
  filteredRows: [],
  page: 1,
  pageCount: 1,
  suggestionRequest: 0,
};

let suggestionTimer = 0;

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const rowLabels = [
  "京东码", "商品名称", "RDC", "可用库存", "采购未到货库存", "全国采购价", "条形码",
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
      reportProgress(`正在下载加密数据… ${progress}%`);
    } else {
      reportProgress(`正在下载加密数据… ${receivedMb} MB`);
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

function decodeCatalog(decrypted) {
  if (!decrypted.data || decrypted.data.format !== "product-search-manifest-v1") {
    throw new Error("商品搜索清单格式不受支持");
  }
  state.catalog = decrypted.data;
  state.products = [];
  state.searchBuckets.clear();
  state.searchBucketPromises.clear();
  state.metadata = decrypted.metadata || {};
  populateSelectValues(elements.rdcFilter, state.catalog.rdc_values || [], "全部 RDC");
  updateReportMeta();
}

function decodeProducts(data) {
  if (!data || data.format !== "product-catalog-v1") {
    throw new Error("商品搜索分片格式不受支持");
  }
  const columns = Object.fromEntries(data.columns.map((column, index) => [column, index]));
  const value = (row, column) => data.dictionaries[column][row[columns[column]]] || "";
  return data.rows.map((row) => {
    const sku = value(row, "SKU");
    const name = value(row, "商品名称");
    const barcode = value(row, "条形码");
    return {
      sku,
      name,
      barcode,
      lowerName: name.toLocaleLowerCase("zh-CN"),
      searchText: `${sku}\n${name}\n${barcode}`.toLocaleLowerCase("zh-CN"),
    };
  });
}

function updateReportMeta() {
  const reportDate = state.metadata?.report_date || "日期未知";
  const generated = state.metadata?.generated_at
    ? new Date(state.metadata.generated_at).toLocaleString("zh-CN", { hour12: false })
    : "时间未知";
  elements.reportMeta.textContent = `报告 ${reportDate} · 加密更新 ${generated}`;
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
  state.catalog = null;
  state.products = [];
  state.searchBuckets.clear();
  state.searchBucketPromises.clear();
  state.data = null;
  state.metadata = null;
  state.columns = null;
  state.lowerDictionaries = null;
  state.password = "";
  state.currentShard = null;
  state.selectedSku = "";
  state.filteredRows = [];
  elements.inventoryBody.replaceChildren();
  elements.productList.replaceChildren();
  hideSuggestions();
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
  populateSelectValues(select, state.data.dictionaries[column] || [], emptyLabel);
}

function populateSelectValues(select, values, emptyLabel) {
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
  updateReportMeta();
}

async function handleUnlock(event) {
  event.preventDefault();
  if (!window.crypto || !window.crypto.subtle) {
    setUnlockStatus("当前环境不支持安全解密，请使用 HTTPS 打开本页");
    return;
  }
  const password = elements.password.value;
  setUnlockLoading(true);
  setUnlockStatus("正在下载轻量商品目录…", true);
  try {
    const payload = await fetchEncryptedPayload(
      CATALOG_URL,
      (message) => setUnlockStatus(message, true),
    );
    setUnlockStatus("正在本地验证密码并解密…", true);
    const decrypted = await decryptInventory(payload, password);
    state.payload = payload;
    state.password = password;
    decodeCatalog(decrypted);
    elements.password.value = "";
    showApp();
    clearSearchResults();
    elements.keywordFilter.focus();
  } catch (error) {
    const wrongPassword = error && error.name === "OperationError";
    setUnlockStatus(wrongPassword ? "密码不正确" : (error.message || "解锁失败"));
    elements.password.select();
  } finally {
    setUnlockLoading(false);
  }
}

async function searchShardIndex(character) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(character),
  );
  return new Uint8Array(digest)[0] % SEARCH_SHARD_COUNT;
}

async function loadSearchProducts(query, reportProgress = showNotice) {
  const tokens = new Set(
    query.toLocaleLowerCase("zh-CN").split("").filter((character) => !/\s/.test(character)),
  );
  const candidates = [];
  for (const token of tokens) {
    const shardIndex = await searchShardIndex(token);
    candidates.push({
      shardIndex,
      count: Number(state.catalog.bucket_counts[shardIndex]) || Number.MAX_SAFE_INTEGER,
    });
  }
  candidates.sort((left, right) => left.count - right.count);
  const shardIndex = candidates[0]?.shardIndex;
  if (!Number.isInteger(shardIndex)) return [];
  if (state.searchBuckets.has(shardIndex)) return state.searchBuckets.get(shardIndex);
  if (state.searchBucketPromises.has(shardIndex)) {
    return state.searchBucketPromises.get(shardIndex);
  }

  const loadPromise = (async () => {
    reportProgress("正在下载商品搜索索引…");
    const shardName = String(shardIndex).padStart(2, "0");
    const payload = await fetchEncryptedPayload(
      `${SEARCH_BASE_URL}/${shardName}.enc.json`,
      reportProgress,
    );
    reportProgress("正在解密商品搜索索引…");
    const decrypted = await decryptInventory(payload, state.password);
    if (Number(decrypted.metadata?.search_shard_index) !== shardIndex) {
      throw new Error("商品搜索分片校验失败");
    }
    const products = decodeProducts(decrypted.data);
    state.searchBuckets.set(shardIndex, products);
    return products;
  })();
  state.searchBucketPromises.set(shardIndex, loadPromise);
  try {
    return await loadPromise;
  } finally {
    state.searchBucketPromises.delete(shardIndex);
  }
}

function searchTerms(query) {
  return query
    .trim()
    .toLocaleLowerCase("zh-CN")
    .split(/\s+/)
    .filter(Boolean);
}

function findProducts(products, query) {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const nameOnly = terms.some((term) => /[\u3400-\u9fff]/.test(term));
  const matches = products.filter(
    (product) => terms.every(
      (term) => (nameOnly ? product.lowerName : product.searchText).includes(term),
    ),
  );
  const firstTerm = terms[0];
  return matches.sort((left, right) => {
    const leftName = left.name.toLocaleLowerCase("zh-CN");
    const rightName = right.name.toLocaleLowerCase("zh-CN");
    const leftStarts = leftName.startsWith(firstTerm) ? 0 : 1;
    const rightStarts = rightName.startsWith(firstTerm) ? 0 : 1;
    return leftStarts - rightStarts
      || leftName.indexOf(firstTerm) - rightName.indexOf(firstTerm)
      || leftName.length - rightName.length
      || left.sku.localeCompare(right.sku);
  });
}

function hideSuggestions() {
  state.suggestionRequest += 1;
  elements.searchSuggestions.hidden = true;
  elements.searchSuggestions.replaceChildren();
  elements.keywordFilter.setAttribute("aria-expanded", "false");
}

function renderSuggestionState(message) {
  const status = document.createElement("div");
  status.className = "suggestion-state";
  status.textContent = message;
  elements.searchSuggestions.replaceChildren(status);
  elements.searchSuggestions.hidden = false;
  elements.keywordFilter.setAttribute("aria-expanded", "true");
}

function renderSuggestions(products) {
  if (products.length === 0) {
    renderSuggestionState("没有匹配的商品");
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const product of products.slice(0, 5)) {
    const button = document.createElement("button");
    button.className = "suggestion-option";
    button.type = "button";
    button.setAttribute("role", "option");

    const name = document.createElement("strong");
    name.textContent = product.name || "未命名商品";
    const details = document.createElement("span");
    details.textContent = `京东码 ${product.sku}`;
    button.append(name, details);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", async () => {
      elements.keywordFilter.value = product.name;
      hideSuggestions();
      await loadProductInventory(product);
    });
    fragment.appendChild(button);
  }
  elements.searchSuggestions.replaceChildren(fragment);
  elements.searchSuggestions.hidden = false;
  elements.keywordFilter.setAttribute("aria-expanded", "true");
}

async function updateSuggestions() {
  const query = elements.keywordFilter.value.trim();
  const compactLength = query.replace(/\s/g, "").length;
  if (compactLength < 2 || /^\d{5,}$/.test(query)) {
    hideSuggestions();
    return;
  }
  const requestId = ++state.suggestionRequest;
  renderSuggestionState("正在联想商品…");
  try {
    const products = await loadSearchProducts(
      query,
      (message) => {
        if (requestId === state.suggestionRequest) renderSuggestionState(message);
      },
    );
    if (requestId !== state.suggestionRequest) return;
    renderSuggestions(findProducts(products, query));
  } catch (error) {
    if (requestId !== state.suggestionRequest) return;
    renderSuggestionState(error.message || "商品联想加载失败");
  }
}

function hideProductMatches() {
  elements.productResults.hidden = true;
  elements.productList.replaceChildren();
}

function renderProductMatches(matches) {
  const visibleMatches = matches.slice(0, MAX_PRODUCT_MATCHES);
  const fragment = document.createDocumentFragment();
  for (const product of visibleMatches) {
    const button = document.createElement("button");
    button.className = "product-option";
    button.type = "button";

    const name = document.createElement("strong");
    name.textContent = product.name || "未命名商品";
    const details = document.createElement("span");
    details.textContent = `京东码 ${product.sku}${product.barcode ? ` · 条形码 ${product.barcode}` : ""}`;
    button.append(name, details);
    button.addEventListener("click", () => loadProductInventory(product));
    fragment.appendChild(button);
  }
  elements.productList.replaceChildren(fragment);
  elements.productResultsTitle.textContent = "选择商品查看 RDC 库存";
  elements.productResultsCount.textContent = matches.length > MAX_PRODUCT_MATCHES
    ? `找到 ${numberFormatter.format(matches.length)} 个，显示前 ${MAX_PRODUCT_MATCHES} 个，请细化关键词`
    : `找到 ${numberFormatter.format(matches.length)} 个`;
  elements.productResults.hidden = false;
  elements.matchedProducts.textContent = numberFormatter.format(matches.length);
}

async function loadProductInventory(product) {
  const shardIndex = await skuShardIndex(product.sku);
  setFiltering(true);
  showNotice("正在加载商品库存…");
  try {
    if (!state.data || state.currentShard !== shardIndex) {
      const result = await downloadSkuShard(
        product.sku,
        state.password,
        (message) => showNotice(message),
      );
      state.payload = result.payload;
      state.currentShard = result.shardIndex;
      initializeData(result.decrypted);
    }
    if (!(state.data.dictionaries.SKU || []).includes(product.sku)) {
      clearSearchResults("没有匹配的商品");
      return;
    }
    state.selectedSku = product.sku;
    state.page = 1;
    hideProductMatches();
    hideNotice();
    applyFilters();
  } catch (error) {
    if (error && error.name === "OperationError") {
      lockPage("库存已更新，请重新输入密码");
      return;
    }
    showNotice(error.message || "商品库存加载失败");
  } finally {
    setFiltering(false);
  }
}

async function searchProducts() {
  const query = elements.keywordFilter.value.trim();
  if (!query) {
    showNotice("请输入京东码或商品名称");
    return;
  }
  if (/^\d{5,}$/.test(query)) {
    await loadProductInventory({ sku: query, name: "", barcode: "" });
    return;
  }
  let products;
  try {
    products = await loadSearchProducts(query);
    hideNotice();
  } catch (error) {
    if (error && error.name === "OperationError") {
      lockPage("商品目录已更新，请重新输入密码");
      return;
    }
    showNotice(error.message || "商品搜索索引加载失败");
    return;
  }
  const matches = findProducts(products, query);
  if (matches.length === 0) {
    clearSearchResults("没有匹配的商品");
    return;
  }
  const exactMatch = matches.find(
    (product) => product.sku === query || product.barcode === query,
  );
  if (exactMatch || matches.length === 1) {
    await loadProductInventory(exactMatch || matches[0]);
    return;
  }
  resetInventoryResults();
  renderProductMatches(matches);
}

function filterRows() {
  const rdcValue = elements.rdcFilter.value;
  const skuIndex = state.columns.SKU;
  const rdcIndex = state.columns.RDC;
  const matches = [];
  for (let index = 0; index < state.data.rows.length; index += 1) {
    const row = state.data.rows[index];
    if (dictionaryValue("SKU", row[skuIndex]) !== state.selectedSku) continue;
    if (rdcValue && dictionaryValue("RDC", row[rdcIndex]) !== rdcValue) continue;
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
    const row = document.createElement("tr");
    row.append(
      textCell(valueAt(rowData, "SKU"), "sku-cell"),
      textCell(valueAt(rowData, "商品名称")),
      textCell(valueAt(rowData, "RDC")),
      numberCell(valueAt(rowData, "可用库存")),
      numberCell(valueAt(rowData, "采购未到货")),
      numberCell(valueAt(rowData, "全国采购价")),
      textCell(valueAt(rowData, "条形码")),
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
  for (const dataIndex of state.filteredRows) {
    const row = state.data.rows[dataIndex];
    const available = valueAt(row, "可用库存");
    const incoming = valueAt(row, "采购未到货");
    if (available !== null && available !== undefined && !Number.isNaN(Number(available))) {
      availableTotal += Number(available);
    }
    if (incoming !== null && incoming !== undefined && !Number.isNaN(Number(incoming))) {
      incomingTotal += Number(incoming);
    }
  }
  elements.totalRecords.textContent = numberFormatter.format(state.filteredRows.length);
  elements.matchedProducts.textContent = state.selectedSku ? "1" : "0";
  elements.availableInventory.textContent = numberFormatter.format(availableTotal);
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

function resetInventoryResults(message = "输入京东码或商品名称后查询") {
  state.selectedSku = "";
  state.filteredRows = [];
  state.page = 1;
  elements.inventoryBody.replaceChildren();
  elements.emptyStateText.textContent = message;
  elements.emptyState.hidden = false;
  elements.resultRange.textContent = "等待查询";
  elements.pageIndicator.textContent = "第 1 / 1 页";
  elements.previousPage.disabled = true;
  elements.nextPage.disabled = true;
  elements.totalRecords.textContent = "0";
  elements.matchedProducts.textContent = "0";
  elements.availableInventory.textContent = "0";
  elements.incomingInventory.textContent = "0";
}

function clearSearchResults(message) {
  hideSuggestions();
  hideProductMatches();
  hideNotice();
  resetInventoryResults(message);
}

function clearFilters() {
  elements.keywordFilter.value = "";
  elements.rdcFilter.value = "";
  clearSearchResults();
  elements.keywordFilter.focus();
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
  hideSuggestions();
  hideNotice();
  await searchProducts();
});
elements.keywordFilter.addEventListener("input", () => {
  window.clearTimeout(suggestionTimer);
  hideSuggestions();
  suggestionTimer = window.setTimeout(updateSuggestions, 300);
});
elements.keywordFilter.addEventListener("focus", () => {
  if (elements.keywordFilter.value.trim().replace(/\s/g, "").length >= 2) {
    window.clearTimeout(suggestionTimer);
    suggestionTimer = window.setTimeout(updateSuggestions, 150);
  }
});
elements.keywordFilter.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSuggestions();
});
document.addEventListener("click", (event) => {
  if (!elements.searchSuggestions.contains(event.target)
      && event.target !== elements.keywordFilter) {
    hideSuggestions();
  }
});
elements.rdcFilter.addEventListener("change", () => {
  if (!state.data || !state.selectedSku) return;
  state.page = 1;
  applyFilters();
});
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