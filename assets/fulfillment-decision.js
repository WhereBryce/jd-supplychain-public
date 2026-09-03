"use strict";

const STATUS_URL = "../data/fulfillment-status.json";
const SNAPSHOT_BASE_URL = "../data/fulfillment-snapshots";
const DECRYPT_WORKER_URL = "../assets/fulfillment-decrypt-worker.js?v=20260730c";
const STORAGE_KEY = "jd.fulfillment.localConfig.v1";
const RULES_VERSION = 3;
const ROUTING_VERSION = 2;
const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "unlockView", "appView", "unlockForm", "password", "togglePassword", "unlockButton",
  "unlockSnapshotDate", "unlockSnapshotCount", "unlockWarehouseCount", "unlockSkuCount", "unlockStatus",
  "lockButton", "reportMeta", "notice", "noticeText", "noticeClose", "orderPaste", "orderSnapshot",
  "mechanismSnapshot", "warehouseCount", "cityCount", "skuCount", "analyzeOrders", "orderResults",
  "orderCount", "orderAverage", "orderTotal", "orderFulfilled", "orderModeBars", "orderResultBody",
  "mechanismBody", "addMechanismRow", "primarySku", "skuSuggestions", "analyzeMechanism",
  "mechanismResults", "mechanismQuantity", "mechanismAverage", "mechanismThousand",
  "mechanismModeBars", "mechanismResultBody", "cityFilter", "cityMappingList",
  "ruleOrdinaryProduction", "ruleSpecialProduction", "ruleSameRegionDelivery",
  "ruleCrossRegionDelivery", "ruleCrossNetworkDelivery", "ruleSpecialDelivery",
  "saveSettings", "resetSettings",
  "ordinaryCNationalFallback",
  "fromCountExplanation", "ordinaryCount", "lightCount", "cityWarehouseCount",
].map((id) => [id, byId(id)]));

const state = { status: null, password: "", decryptor: null, snapshot: null, snapshotEntry: null, snapshotMetadata: null, shardPromises: new Map(), lastTiming: null, cityMapping: [], rules: null, routing: null, mechanismRows: 0 };
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const CREDENTIAL_ID = "jd-fulfillment-decision";

async function rememberCredential(password) {
  if (!navigator.credentials?.store || typeof PasswordCredential === "undefined") return;
  try {
    await navigator.credentials.store(new PasswordCredential({
      id: CREDENTIAL_ID,
      name: "JD订单履约分析",
      password,
    }));
  } catch (error) {
    console.warn("浏览器未保存履约分析凭据", error);
  }
}

class DecryptWorkerClient {
  constructor() {
    if (!("Worker" in window)) throw new Error("当前浏览器不支持后台解密，请升级Chrome或Edge");
    this.nextId = 1;
    this.pending = new Map();
    this.worker = new Worker(DECRYPT_WORKER_URL);
    this.worker.addEventListener("message", (event) => this.handleMessage(event.data || {}));
    this.worker.addEventListener("error", () => this.failAll(new Error("后台解密线程异常")));
  }

  handleMessage(message) {
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.type === "progress") {
      request.onProgress?.(message.stage);
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "result") request.resolve(message);
    else if (message.type === "error") {
      const error = new Error(message.message || "解密失败");
      error.name = message.name || "Error";
      request.reject(error);
    }
  }

  failAll(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  decrypt(payloadText, password, onProgress) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: "decrypt", id, payloadText, password });
    });
  }

  dispose() {
    this.failAll(new Error("解密会话已关闭"));
    this.worker.terminate();
  }
}

async function fetchText(url, cache = "default") {
  const started = performance.now();
  const response = await fetch(url, { cache });
  if (!response.ok) throw new Error(response.status === 404 ? "加密履约数据尚未发布" : "数据下载失败");
  const text = await response.text();
  return {
    text,
    bytes: new TextEncoder().encode(text).byteLength,
    downloadMs: performance.now() - started,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error("数据下载失败");
  return response.json();
}

function setUnlockStatus(message, info = false) { elements.unlockStatus.textContent = message; elements.unlockStatus.classList.toggle("info", info); }
function setBusy(button, busy, busyLabel, idleLabel) { button.disabled = busy; button.textContent = busy ? busyLabel : idleLabel; }
function showNotice(message) { elements.noticeText.textContent = message; elements.notice.hidden = false; window.scrollTo({ top: 0, behavior: "smooth" }); }
function hideNotice() { elements.notice.hidden = true; }

async function loadStatus() {
  try {
    state.status = await fetchJson(STATUS_URL);
    const latest = state.status.snapshots[0];
    elements.unlockSnapshotDate.textContent = latest?.date || "未知";
    elements.unlockSnapshotCount.textContent = state.status.snapshots.length;
    elements.unlockWarehouseCount.textContent = latest?.warehouse_count ?? "未知";
    elements.unlockSkuCount.textContent = latest ? integer.format(latest.sku_count) : "未知";
  } catch {
    [elements.unlockSnapshotDate, elements.unlockSnapshotCount, elements.unlockWarehouseCount, elements.unlockSkuCount].forEach((node) => { node.textContent = "暂时无法读取"; });
  }
}

function snapshotUrl(path) {
  const version = encodeURIComponent(state.status?.generated_at || "current");
  return `${SNAPSHOT_BASE_URL}/${path}?v=${version}`;
}

function progressLabel(stage) {
  return {
    derive: "正在验证密码（PBKDF2 600,000轮）…",
    decrypt: "正在解密基础数据…",
    decompress: "正在解压基础数据…",
    parse: "正在解析基础数据…",
  }[stage] || "正在处理基础数据…";
}

function seconds(value) {
  return `${(Math.max(0, value) / 1000).toFixed(2)}秒`;
}

function timingSummary(timing) {
  if (!timing) return "";
  const worker = timing.worker || {};
  const verify = worker.deriveMs || 0;
  const processing = (worker.encryptedParseMs || 0) + (worker.decryptMs || 0)
    + (worker.decompressMs || 0) + (worker.dataParseMs || 0) + (timing.decodeMs || 0);
  return ` · 解锁${seconds(timing.totalMs)}（下载${seconds(timing.downloadMs)} / 验证${seconds(verify)} / 解密解压解析${seconds(processing)}）`;
}

async function loadSnapshot(entry, password = state.password) {
  if (!entry?.base) throw new Error("库存切片清单格式不受支持");
  const totalStarted = performance.now();
  setUnlockStatus("正在下载轻量基础数据…", true);
  const downloaded = await fetchText(snapshotUrl(entry.base));
  if (!state.decryptor) state.decryptor = new DecryptWorkerClient();
  let output;
  try {
    output = await state.decryptor.decrypt(
      downloaded.text,
      password,
      (stage) => setUnlockStatus(progressLabel(stage), true),
    );
  } catch (error) {
    if (error.name === "OperationError") throw new Error("密码不正确，或加密数据已损坏");
    throw error;
  }
  const decodeStarted = performance.now();
  state.snapshot = FulfillmentEngine.decodeSnapshot(output.result.data);
  const decodeMs = performance.now() - decodeStarted;
  state.snapshotEntry = entry;
  state.snapshotMetadata = output.result.metadata;
  state.shardPromises = new Map();
  state.password = password;
  state.lastTiming = {
    bytes: downloaded.bytes,
    downloadMs: downloaded.downloadMs,
    worker: output.timings,
    decodeMs,
    totalMs: performance.now() - totalStarted,
  };
  applyStoredConfig();
  renderSnapshotMeta(output.result.metadata, state.lastTiming);
  renderSkuSuggestions();
  renderCityMappings();
  return output.result;
}

function populateSnapshotSelects() {
  [elements.orderSnapshot, elements.mechanismSnapshot].forEach((select) => {
    select.replaceChildren(...state.status.snapshots.map((item) => {
      const option = document.createElement("option"); option.value = item.base; option.textContent = item.date; return option;
    }));
    select.value = state.snapshotEntry?.base || "";
  });
}

function renderSnapshotMeta(metadata, timing = state.lastTiming) {
  elements.reportMeta.textContent = `库存切片 ${metadata.snapshot_date} · ${metadata.warehouse_count} 个履约from${timingSummary(timing)}`;
  elements.warehouseCount.textContent = metadata.warehouse_count;
  elements.cityCount.textContent = metadata.city_count;
  elements.skuCount.textContent = integer.format(metadata.sku_count);
  elements.fromCountExplanation.textContent = `${metadata.warehouse_count}个履约from`;
  elements.ordinaryCount.textContent = metadata.network_counts?.["普通C仓"] ?? 0;
  elements.lightCount.textContent = metadata.network_counts?.["轻货仓"] ?? 0;
  elements.cityWarehouseCount.textContent = metadata.network_counts?.["城市仓"] ?? 0;
  populateSnapshotSelects();
}

function storedConfig() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; } }
function applyStoredConfig() {
  const saved = storedConfig();
  state.cityMapping = [...state.snapshot.defaultCityMapping];
  state.rules = { ...state.snapshot.defaultRules };
  state.routing = { ...state.snapshot.defaultRouting };
  if (saved?.cityMapping && saved.cityMapping.length === state.cityMapping.length) state.cityMapping = saved.cityMapping.map(Number);
  if (saved?.rules && saved.rulesVersion >= RULES_VERSION) {
    state.rules = { ...state.rules, ...saved.rules };
  }
  if (saved?.routing && saved.routingVersion >= ROUTING_VERSION) {
    state.routing = { ...state.routing, ...saved.routing };
  }
  elements.ruleOrdinaryProduction.value = state.rules.ordinaryProduction / 100;
  elements.ruleSpecialProduction.value = state.rules.specialProduction / 100;
  elements.ruleSameRegionDelivery.value = state.rules.sameRegionDelivery / 100;
  elements.ruleCrossRegionDelivery.value = state.rules.crossRegionDelivery / 100;
  elements.ruleCrossNetworkDelivery.value = state.rules.crossNetworkDelivery / 100;
  elements.ruleSpecialDelivery.value = state.rules.specialDelivery / 100;
  elements.ordinaryCNationalFallback.checked = Boolean(
    state.routing.ordinaryCNationalFallback,
  );
}

async function unlock(event) {
  event.preventDefault(); const password = elements.password.value;
  if (!state.status?.snapshots?.length) { setUnlockStatus("没有可用库存切片"); return; }
  state.decryptor?.dispose();
  state.decryptor = new DecryptWorkerClient();
  setBusy(elements.unlockButton, true, "正在解锁", "解锁并进入");
  try {
    await loadSnapshot(state.status.snapshots[0], password);
    void rememberCredential(password);
    elements.unlockView.hidden = true; elements.appView.hidden = false; setUnlockStatus("");
  } catch (error) { state.decryptor?.dispose(); state.decryptor = null; setUnlockStatus(error.message); elements.password.select(); }
  finally { setBusy(elements.unlockButton, false, "正在解锁", "解锁并进入"); }
}

function lock() {
  state.password = ""; state.decryptor?.dispose(); state.decryptor = null; state.snapshot = null; state.snapshotEntry = null; state.snapshotMetadata = null; state.shardPromises = new Map(); state.lastTiming = null; state.cityMapping = []; state.rules = null; state.routing = null;
  elements.password.value = ""; elements.appView.hidden = true; elements.unlockView.hidden = false;
  elements.orderResults.hidden = true; elements.mechanismResults.hidden = true; window.setTimeout(() => elements.password.focus(), 0);
}

async function switchSnapshot(basePath) {
  if (!basePath || basePath === state.snapshotEntry?.base) return;
  const entry = state.status.snapshots.find((item) => item.base === basePath);
  if (!entry) throw new Error("库存切片不存在");
  hideNotice();
  elements.orderSnapshot.disabled = true;
  elements.mechanismSnapshot.disabled = true;
  elements.reportMeta.textContent = "正在切换库存切片…";
  try { await loadSnapshot(entry); elements.orderResults.hidden = true; elements.mechanismResults.hidden = true; }
  catch (error) { showNotice(error.message); populateSnapshotSelects(); }
  finally { elements.orderSnapshot.disabled = false; elements.mechanismSnapshot.disabled = false; }
}

function parseOrderRows(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const separator = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const cells = lines.map((line) => line.split(separator).map((value) => value.trim()));
  const header = cells[0].join("").toLocaleLowerCase("zh-CN");
  const start = /订单|order|收货|城市|jd码|sku|数量/.test(header) ? 1 : 0;
  return cells.slice(start).map((row, index) => ({ orderId: row[0] || `订单${index + 1}`, city: row[1], sku: row[2], quantity: Number(row[3]) }));
}

function destinationIndex(cityName) {
  const source = state.snapshot.cities.indexOf(String(cityName || "").trim());
  if (source < 0) throw new Error(`无法识别消费者城市：${cityName}`);
  const destination = state.cityMapping[source];
  if (!Number.isInteger(destination)) throw new Error(`城市尚未配置收敛关系：${cityName}`);
  return destination;
}

async function skuShardIndex(sku, shardCount) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sku),
  );
  return new Uint8Array(digest)[0] % shardCount;
}

async function loadSkuShard(shardIndex) {
  if (state.snapshot.loadedShards.has(shardIndex)) return { bytes: 0, totalMs: 0 };
  if (state.shardPromises.has(shardIndex)) return state.shardPromises.get(shardIndex);
  const entry = state.snapshotEntry;
  const snapshot = state.snapshot;
  const promise = (async () => {
    const started = performance.now();
    const name = String(shardIndex).padStart(2, "0");
    elements.reportMeta.textContent = `正在加载SKU数据分片 ${name}…`;
    const downloaded = await fetchText(snapshotUrl(`${entry.shard_base}/${name}.enc.json`));
    const output = await state.decryptor.decrypt(
      downloaded.text,
      state.password,
      (stage) => {
        const label = stage === "decompress" || stage === "parse" ? "解压解析" : "解密";
        elements.reportMeta.textContent = `正在${label}SKU数据分片 ${name}…`;
      },
    );
    if (state.snapshot !== snapshot || state.snapshotEntry !== entry) {
      throw new Error("库存切片已切换，请重新分析");
    }
    if (
      Number(output.result.metadata?.shard_index) !== shardIndex
      || output.result.metadata?.snapshot_date !== state.snapshotMetadata?.snapshot_date
    ) {
      throw new Error("SKU数据分片校验失败");
    }
    FulfillmentEngine.mergeSkuShard(snapshot, output.result.data);
    return {
      bytes: downloaded.bytes,
      downloadMs: downloaded.downloadMs,
      worker: output.timings,
      totalMs: performance.now() - started,
    };
  })();
  state.shardPromises.set(shardIndex, promise);
  try {
    return await promise;
  } catch (error) {
    state.shardPromises.delete(shardIndex);
    throw error;
  }
}

async function ensureSkuData(rawSkus) {
  const skus = [...new Set(rawSkus.map((value) => String(value || "").trim().replace(/\.0$/, "")))];
  const shardIndexes = new Set();
  for (const sku of skus) {
    if (!state.snapshot.skuIndex.has(sku)) throw new Error(`库存切片没有SKU：${sku}`);
    shardIndexes.add(await skuShardIndex(sku, state.snapshot.shardCount));
  }
  const missing = [...shardIndexes].filter((index) => !state.snapshot.loadedShards.has(index));
  if (!missing.length) {
    renderSnapshotMeta(state.snapshotMetadata);
    return;
  }
  const started = performance.now();
  const results = await Promise.all(missing.map(loadSkuShard));
  const bytes = results.reduce((sum, item) => sum + item.bytes, 0);
  const elapsed = performance.now() - started;
  elements.reportMeta.textContent = `库存切片 ${state.snapshotMetadata.snapshot_date} · 按需加载${missing.length}个SKU分片 ${(bytes / 1024).toFixed(1)} KB / ${seconds(elapsed)}`;
}

function renderModeBars(target, distribution) {
  target.replaceChildren(...distribution.map((item) => {
    const row = document.createElement("div"); row.className = "mode-row";
    const label = document.createElement("span"); label.textContent = item.mode.replaceAll("发货", "").replaceAll(" / ", " · ");
    const value = document.createElement("strong"); value.textContent = `${(item.ratio * 100).toFixed(1)}%`;
    const rail = document.createElement("i"); const fill = document.createElement("b"); fill.style.width = `${item.ratio * 100}%`; rail.append(fill); row.append(label, value, rail); return row;
  }));
}

function deliveryValue(item) {
  const geographic = item.sameRegionDeliveryFeeCents + item.crossRegionDeliveryFeeCents;
  return {
    text: money.format(item.deliveryFeeCents / 100),
    title: `普通地理 ${money.format(geographic / 100)}；普通跨网 ${money.format(item.crossNetworkDeliveryFeeCents / 100)}（取高）；特殊仓 ${money.format(item.specialDeliveryFeeCents / 100)}`,
  };
}

async function analyzeOrders() {
  hideNotice();
  setBusy(elements.analyzeOrders, true, "正在加载SKU数据", "执行判定");
  try {
    const rows = parseOrderRows(elements.orderPaste.value); if (!rows.length) throw new Error("请先粘贴订单明细");
    const grouped = new Map();
    rows.forEach((row) => {
      if (!row.city || !row.sku || !Number.isInteger(row.quantity) || row.quantity <= 0) throw new Error(`订单 ${row.orderId} 缺少城市、SKU或有效数量`);
      const item = grouped.get(row.orderId) || { city: row.city, demand: {} };
      if (item.city !== row.city) throw new Error(`订单 ${row.orderId} 出现多个收货城市`);
      item.demand[row.sku] = (item.demand[row.sku] || 0) + row.quantity; grouped.set(row.orderId, item);
    });
    await ensureSkuData([...grouped.values()].flatMap((item) => Object.keys(item.demand)));
    const details = [...grouped].map(([orderId, item]) => {
      const destination = destinationIndex(item.city);
      const result = FulfillmentEngine.decide(state.snapshot, destination, item.demand, {
        rules: state.rules,
        ordinaryCNationalFallback: state.routing.ordinaryCNationalFallback,
      });
      return { orderId, consumerCity: item.city, destinationCity: state.snapshot.cities[destination], ...result };
    });
    const modes = new Map(); details.forEach((item) => modes.set(item.mode, (modes.get(item.mode) || 0) + 1));
    const total = details.reduce((sum, item) => sum + item.upchargeCents, 0);
    elements.orderCount.textContent = details.length; elements.orderAverage.textContent = money.format(total / 100 / details.length); elements.orderTotal.textContent = money.format(total / 100); elements.orderFulfilled.textContent = details.filter((item) => item.fulfilled).length;
    renderModeBars(elements.orderModeBars, [...modes].map(([mode, count]) => ({ mode, ratio: count / details.length })));
    elements.orderResultBody.replaceChildren(...details.map((item) => tableRow([item.orderId, item.consumerCity, item.destinationCity, item.geography.replace(/发货$/, ""), item.network, item.warehouseMode, item.additionalFromCount > 0 ? "是" : "否", item.fromCount, item.additionalFromCount, money.format(item.productionFeeCents / 100), deliveryValue(item), money.format(item.upchargeCents / 100)])));
    elements.orderResults.hidden = false;
  } catch (error) { showNotice(error.message); }
  finally { setBusy(elements.analyzeOrders, false, "正在加载SKU数据", "执行判定"); }
}

function addMechanismRow(values = {}) {
  state.mechanismRows += 1; const row = document.createElement("tr");
  row.innerHTML = `<td><input data-field="sku" list="skuSuggestions" placeholder="JD码"></td><td><input data-field="quantity" type="number" min="1" step="1" value="${values.quantity || 1}"></td><td><select data-field="role"><option>主品</option><option>赠品</option></select></td><td><button class="square-button remove" type="button" title="删除">×</button></td>`;
  row.querySelector("[data-field=sku]").value = values.sku || ""; row.querySelector("[data-field=role]").value = values.role || "赠品";
  row.querySelector(".remove").addEventListener("click", () => row.remove()); elements.mechanismBody.append(row);
}

async function analyzeMechanism() {
  hideNotice();
  setBusy(elements.analyzeMechanism, true, "正在加载SKU数据", "开始模拟");
  try {
    const items = [...elements.mechanismBody.rows].map((row) => ({
      sku: row.querySelector("[data-field=sku]").value.trim(),
      quantity: Number(row.querySelector("[data-field=quantity]").value),
      role: row.querySelector("[data-field=role]").value,
    }));
    const demand = {}; items.forEach((item) => { if (!item.sku || !Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("机制SKU不能为空，单套数量必须大于0"); demand[item.sku] = (demand[item.sku] || 0) + item.quantity; });
    const primarySku = elements.primarySku.value.trim(); if (!(primarySku in demand)) throw new Error("地域分布基准主品必须包含在机制中");
    const mechanismRouting = FulfillmentEngine.mechanismRoutingOptions(items, primarySku);
    await ensureSkuData([...Object.keys(demand), primarySku]);
    const weights = FulfillmentEngine.mechanismWeights(state.snapshot, primarySku, state.cityMapping);
    const cityResults = weights.map((item) => ({
      ...item,
      result: FulfillmentEngine.decide(state.snapshot, item.cityIndex, demand, {
        rules: state.rules,
        ordinaryCNationalFallback: state.routing.ordinaryCNationalFallback,
        ...mechanismRouting,
      }),
    }));
    const modes = new Map(); let averageCents = 0;
    cityResults.forEach((item) => { modes.set(item.result.mode, (modes.get(item.result.mode) || 0) + item.weight); averageCents += item.result.upchargeCents * item.weight; });
    elements.mechanismQuantity.textContent = integer.format(weights.reduce((sum, item) => sum + item.quantity, 0)); elements.mechanismAverage.textContent = money.format(averageCents / 100); elements.mechanismThousand.textContent = money.format(averageCents * 10);
    renderModeBars(elements.mechanismModeBars, [...modes].map(([mode, ratio]) => ({ mode, ratio })));
    elements.mechanismResultBody.replaceChildren(...cityResults.map((item) => tableRow([state.snapshot.cities[item.cityIndex], `${(item.weight * 100).toFixed(1)}%`, item.result.geography.replace(/发货$/, ""), item.result.network, item.result.warehouseMode, item.result.additionalFromCount > 0 ? "是" : "否", item.result.fromCount, item.result.additionalFromCount, money.format(item.result.productionFeeCents / 100), deliveryValue(item.result), money.format(item.result.upchargeCents / 100)])));
    elements.mechanismResults.hidden = false;
  } catch (error) { showNotice(error.message); }
  finally { setBusy(elements.analyzeMechanism, false, "正在加载SKU数据", "开始模拟"); }
}

function tableRow(values) { const row = document.createElement("tr"); values.forEach((value) => { const cell = document.createElement("td"); const item = value && typeof value === "object" ? value : { text: value, title: value }; cell.textContent = item.text; cell.title = item.title; row.append(cell); }); return row; }
function renderSkuSuggestions() { elements.skuSuggestions.replaceChildren(...state.snapshot.skus.map((item) => { const option = document.createElement("option"); option.value = item.sku; option.label = item.name; return option; })); }

function renderCityMappings() {
  const filter = elements.cityFilter.value.trim(); const fragment = document.createDocumentFragment();
  state.snapshot.cities.forEach((city, index) => {
    const target = state.snapshot.cities[state.cityMapping[index]]; if (filter && !city.includes(filter) && !target.includes(filter)) return;
    const label = document.createElement("label"); label.className = "mapping-row"; const name = document.createElement("span"); name.textContent = city;
    const select = document.createElement("select"); state.snapshot.cities.forEach((candidate, candidateIndex) => { const option = document.createElement("option"); option.value = candidateIndex; option.textContent = candidate; select.append(option); }); select.value = state.cityMapping[index]; select.addEventListener("change", () => { state.cityMapping[index] = Number(select.value); }); label.append(name, select); fragment.append(label);
  });
  elements.cityMappingList.replaceChildren(fragment);
}

function saveSettings() {
  const values = [elements.ruleOrdinaryProduction.value, elements.ruleSpecialProduction.value, elements.ruleSameRegionDelivery.value, elements.ruleCrossRegionDelivery.value, elements.ruleCrossNetworkDelivery.value, elements.ruleSpecialDelivery.value].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) { showNotice("费率必须是大于等于0的数字"); return; }
  state.rules = { ordinaryProduction: Math.round(values[0] * 100), specialProduction: Math.round(values[1] * 100), sameRegionDelivery: Math.round(values[2] * 100), crossRegionDelivery: Math.round(values[3] * 100), crossNetworkDelivery: Math.round(values[4] * 100), specialDelivery: Math.round(values[5] * 100) };
  state.routing = {
    ordinaryCNationalFallback: elements.ordinaryCNationalFallback.checked,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    rulesVersion: RULES_VERSION,
    routingVersion: ROUTING_VERSION,
    cityMapping: state.cityMapping,
    rules: state.rules,
    routing: state.routing,
  }));
  showNotice("配置已保存到当前浏览器");
}

function resetSettings() { localStorage.removeItem(STORAGE_KEY); applyStoredConfig(); renderCityMappings(); showNotice("已恢复团队默认规则"); }

document.querySelectorAll(".view-tabs button").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".view-tabs button").forEach((item) => item.classList.toggle("active", item === button)); document.querySelectorAll(".tool-view").forEach((view) => view.classList.toggle("active", view.id === `${button.dataset.view}View`)); hideNotice(); }));
elements.unlockForm.addEventListener("submit", unlock); elements.togglePassword.addEventListener("click", () => { const reveal = elements.password.type === "password"; elements.password.type = reveal ? "text" : "password"; elements.togglePassword.textContent = reveal ? "隐藏" : "显示"; }); elements.lockButton.addEventListener("click", lock); elements.noticeClose.addEventListener("click", hideNotice);
elements.orderSnapshot.addEventListener("change", () => switchSnapshot(elements.orderSnapshot.value)); elements.mechanismSnapshot.addEventListener("change", () => switchSnapshot(elements.mechanismSnapshot.value)); elements.analyzeOrders.addEventListener("click", analyzeOrders); elements.addMechanismRow.addEventListener("click", () => addMechanismRow()); elements.analyzeMechanism.addEventListener("click", analyzeMechanism); elements.cityFilter.addEventListener("input", renderCityMappings); elements.saveSettings.addEventListener("click", saveSettings); elements.resetSettings.addEventListener("click", resetSettings);
addMechanismRow({ role: "主品" }); addMechanismRow({ role: "赠品", quantity: 2 }); loadStatus();