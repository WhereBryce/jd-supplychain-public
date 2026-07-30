"use strict";

const STATUS_URL = "../data/fulfillment-status.json";
const SNAPSHOT_BASE_URL = "../data/fulfillment-snapshots";
const STORAGE_KEY = "jd.fulfillment.localConfig.v1";
const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "unlockView", "appView", "unlockForm", "password", "togglePassword", "unlockButton",
  "unlockSnapshotDate", "unlockSnapshotCount", "unlockWarehouseCount", "unlockSkuCount", "unlockStatus",
  "lockButton", "reportMeta", "notice", "noticeText", "noticeClose", "orderPaste", "orderSnapshot",
  "mechanismSnapshot", "warehouseCount", "cityCount", "skuCount", "analyzeOrders", "orderResults",
  "orderCount", "orderAverage", "orderTotal", "orderFulfilled", "orderModeBars", "orderResultBody",
  "mechanismBody", "addMechanismRow", "primarySku", "skuSuggestions", "analyzeMechanism",
  "mechanismResults", "mechanismQuantity", "mechanismAverage", "mechanismThousand",
  "mechanismModeBars", "mechanismResultBody", "cityFilter", "cityMappingList", "ruleLocal",
  "ruleRegion", "ruleCrossRegion", "ruleCrossNetwork", "saveSettings", "resetSettings",
  "fromCountExplanation", "ordinaryCount", "lightCount", "cityWarehouseCount",
].map((id) => [id, byId(id)]));

const state = { status: null, password: "", keyCache: new Map(), snapshot: null, snapshotFile: "", cityMapping: [], rules: null, mechanismRows: 0 };
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function bytesFromBase64(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

async function decryptPayload(payload, password) {
  if (payload.version !== 1 || payload.algorithm !== "AES-256-GCM") throw new Error("加密数据格式不受支持");
  const keyId = payload.kdf.salt;
  let key = state.keyCache.get(keyId);
  if (!key) {
    key = await deriveKey(password, bytesFromBase64(keyId), Number(payload.kdf.iterations));
    state.keyCache.set(keyId, key);
  }
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesFromBase64(payload.iv) }, key, bytesFromBase64(payload.ciphertext));
  if (!("DecompressionStream" in window)) throw new Error("浏览器版本过旧，请升级Chrome或Edge");
  const stream = new Blob([plaintext]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()));
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(response.status === 404 ? "加密履约数据尚未发布" : "数据下载失败");
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

async function loadSnapshot(file, password = state.password) {
  setUnlockStatus("正在下载加密履约数据…", true);
  const payload = await fetchJson(`${SNAPSHOT_BASE_URL}/${file}`);
  setUnlockStatus("正在本地验证密码并解密…", true);
  let decrypted;
  try { decrypted = await decryptPayload(payload, password); }
  catch (error) { if (error.name === "OperationError") throw new Error("密码不正确，或加密数据已损坏"); throw error; }
  state.snapshot = FulfillmentEngine.decodeSnapshot(decrypted.data);
  state.snapshotFile = file;
  state.password = password;
  applyStoredConfig();
  renderSnapshotMeta(decrypted.metadata);
  renderSkuSuggestions();
  renderCityMappings();
  return decrypted;
}

function populateSnapshotSelects() {
  [elements.orderSnapshot, elements.mechanismSnapshot].forEach((select) => {
    select.replaceChildren(...state.status.snapshots.map((item) => {
      const option = document.createElement("option"); option.value = item.file; option.textContent = item.date; return option;
    }));
    select.value = state.snapshotFile;
  });
}

function renderSnapshotMeta(metadata) {
  elements.reportMeta.textContent = `库存切片 ${metadata.snapshot_date} · ${metadata.warehouse_count} 个履约from`;
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
  if (saved?.cityMapping && saved.cityMapping.length === state.cityMapping.length) state.cityMapping = saved.cityMapping.map(Number);
  if (saved?.rules) state.rules = { ...state.rules, ...saved.rules };
  elements.ruleLocal.value = state.rules.localExtra / 100;
  elements.ruleRegion.value = state.rules.sameRegion / 100;
  elements.ruleCrossRegion.value = state.rules.crossRegion / 100;
  elements.ruleCrossNetwork.value = state.rules.crossNetwork / 100;
}

async function unlock(event) {
  event.preventDefault(); const password = elements.password.value;
  if (!state.status?.snapshots?.length) { setUnlockStatus("没有可用库存切片"); return; }
  state.keyCache.clear();
  setBusy(elements.unlockButton, true, "正在解锁", "解锁并进入");
  try {
    await loadSnapshot(state.status.snapshots[0].file, password);
    elements.unlockView.hidden = true; elements.appView.hidden = false; setUnlockStatus("");
  } catch (error) { state.keyCache.clear(); setUnlockStatus(error.message); elements.password.select(); }
  finally { setBusy(elements.unlockButton, false, "正在解锁", "解锁并进入"); }
}

function lock() {
  state.password = ""; state.keyCache.clear(); state.snapshot = null; state.snapshotFile = ""; state.cityMapping = []; state.rules = null;
  elements.password.value = ""; elements.appView.hidden = true; elements.unlockView.hidden = false;
  elements.orderResults.hidden = true; elements.mechanismResults.hidden = true; window.setTimeout(() => elements.password.focus(), 0);
}

async function switchSnapshot(file) {
  if (!file || file === state.snapshotFile) return;
  hideNotice();
  elements.orderSnapshot.disabled = true;
  elements.mechanismSnapshot.disabled = true;
  elements.reportMeta.textContent = "正在切换库存切片…";
  try { const decrypted = await loadSnapshot(file); renderSnapshotMeta(decrypted.metadata); elements.orderResults.hidden = true; elements.mechanismResults.hidden = true; }
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

function renderModeBars(target, distribution) {
  target.replaceChildren(...distribution.map((item) => {
    const row = document.createElement("div"); row.className = "mode-row";
    const label = document.createElement("span"); label.textContent = item.mode;
    const value = document.createElement("strong"); value.textContent = `${(item.ratio * 100).toFixed(1)}%`;
    const rail = document.createElement("i"); const fill = document.createElement("b"); fill.style.width = `${item.ratio * 100}%`; rail.append(fill); row.append(label, value, rail); return row;
  }));
}

function analyzeOrders() {
  hideNotice();
  try {
    const rows = parseOrderRows(elements.orderPaste.value); if (!rows.length) throw new Error("请先粘贴订单明细");
    const grouped = new Map();
    rows.forEach((row) => {
      if (!row.city || !row.sku || !Number.isInteger(row.quantity) || row.quantity <= 0) throw new Error(`订单 ${row.orderId} 缺少城市、SKU或有效数量`);
      const item = grouped.get(row.orderId) || { city: row.city, demand: {} };
      if (item.city !== row.city) throw new Error(`订单 ${row.orderId} 出现多个收货城市`);
      item.demand[row.sku] = (item.demand[row.sku] || 0) + row.quantity; grouped.set(row.orderId, item);
    });
    const details = [...grouped].map(([orderId, item]) => {
      const destination = destinationIndex(item.city);
      const result = FulfillmentEngine.decide(state.snapshot, destination, item.demand, { rules: state.rules });
      return { orderId, consumerCity: item.city, destinationCity: state.snapshot.cities[destination], ...result };
    });
    const modes = new Map(); details.forEach((item) => modes.set(item.mode, (modes.get(item.mode) || 0) + 1));
    const total = details.reduce((sum, item) => sum + item.upchargeCents, 0);
    elements.orderCount.textContent = details.length; elements.orderAverage.textContent = money.format(total / 100 / details.length); elements.orderTotal.textContent = money.format(total / 100); elements.orderFulfilled.textContent = details.filter((item) => item.fulfilled).length;
    renderModeBars(elements.orderModeBars, [...modes].map(([mode, count]) => ({ mode, ratio: count / details.length })));
    elements.orderResultBody.replaceChildren(...details.map((item) => tableRow([item.orderId, item.consumerCity, item.destinationCity, item.mode, item.warehouseMode, item.fromCount, money.format(item.upchargeCents / 100)])));
    elements.orderResults.hidden = false;
  } catch (error) { showNotice(error.message); }
}

function addMechanismRow(values = {}) {
  state.mechanismRows += 1; const row = document.createElement("tr");
  row.innerHTML = `<td><input data-field="sku" list="skuSuggestions" placeholder="JD码"></td><td><input data-field="quantity" type="number" min="1" step="1" value="${values.quantity || 1}"></td><td><select data-field="role"><option>主品</option><option>赠品</option></select></td><td><button class="square-button remove" type="button" title="删除">×</button></td>`;
  row.querySelector("[data-field=sku]").value = values.sku || ""; row.querySelector("[data-field=role]").value = values.role || "赠品";
  row.querySelector(".remove").addEventListener("click", () => row.remove()); elements.mechanismBody.append(row);
}

function analyzeMechanism() {
  hideNotice();
  try {
    const items = [...elements.mechanismBody.rows].map((row) => ({ sku: row.querySelector("[data-field=sku]").value.trim(), quantity: Number(row.querySelector("[data-field=quantity]").value) }));
    const demand = {}; items.forEach((item) => { if (!item.sku || !Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("机制SKU不能为空，单套数量必须大于0"); demand[item.sku] = (demand[item.sku] || 0) + item.quantity; });
    const primarySku = elements.primarySku.value.trim(); if (!(primarySku in demand)) throw new Error("地域分布基准主品必须包含在机制中");
    const weights = FulfillmentEngine.mechanismWeights(state.snapshot, primarySku, state.cityMapping);
    const cityResults = weights.map((item) => ({ ...item, result: FulfillmentEngine.decide(state.snapshot, item.cityIndex, demand, { rules: state.rules }) }));
    const modes = new Map(); let averageCents = 0;
    cityResults.forEach((item) => { modes.set(item.result.mode, (modes.get(item.result.mode) || 0) + item.weight); averageCents += item.result.upchargeCents * item.weight; });
    elements.mechanismQuantity.textContent = integer.format(weights.reduce((sum, item) => sum + item.quantity, 0)); elements.mechanismAverage.textContent = money.format(averageCents / 100); elements.mechanismThousand.textContent = money.format(averageCents * 10);
    renderModeBars(elements.mechanismModeBars, [...modes].map(([mode, ratio]) => ({ mode, ratio })));
    elements.mechanismResultBody.replaceChildren(...cityResults.map((item) => tableRow([state.snapshot.cities[item.cityIndex], `${(item.weight * 100).toFixed(1)}%`, item.result.mode, item.result.warehouseMode, item.result.fromCount, money.format(item.result.upchargeCents / 100)])));
    elements.mechanismResults.hidden = false;
  } catch (error) { showNotice(error.message); }
}

function tableRow(values) { const row = document.createElement("tr"); values.forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; cell.title = value; row.append(cell); }); return row; }
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
  const values = [elements.ruleLocal.value, elements.ruleRegion.value, elements.ruleCrossRegion.value, elements.ruleCrossNetwork.value].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) { showNotice("费率必须是大于等于0的数字"); return; }
  state.rules = { localExtra: Math.round(values[0] * 100), sameRegion: Math.round(values[1] * 100), crossRegion: Math.round(values[2] * 100), crossNetwork: Math.round(values[3] * 100) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ cityMapping: state.cityMapping, rules: state.rules })); showNotice("配置已保存到当前浏览器");
}

function resetSettings() { localStorage.removeItem(STORAGE_KEY); applyStoredConfig(); renderCityMappings(); showNotice("已恢复团队默认规则"); }

document.querySelectorAll(".view-tabs button").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".view-tabs button").forEach((item) => item.classList.toggle("active", item === button)); document.querySelectorAll(".tool-view").forEach((view) => view.classList.toggle("active", view.id === `${button.dataset.view}View`)); hideNotice(); }));
elements.unlockForm.addEventListener("submit", unlock); elements.togglePassword.addEventListener("click", () => { const reveal = elements.password.type === "password"; elements.password.type = reveal ? "text" : "password"; elements.togglePassword.textContent = reveal ? "隐藏" : "显示"; }); elements.lockButton.addEventListener("click", lock); elements.noticeClose.addEventListener("click", hideNotice);
elements.orderSnapshot.addEventListener("change", () => switchSnapshot(elements.orderSnapshot.value)); elements.mechanismSnapshot.addEventListener("change", () => switchSnapshot(elements.mechanismSnapshot.value)); elements.analyzeOrders.addEventListener("click", analyzeOrders); elements.addMechanismRow.addEventListener("click", () => addMechanismRow()); elements.analyzeMechanism.addEventListener("click", analyzeMechanism); elements.cityFilter.addEventListener("input", renderCityMappings); elements.saveSettings.addEventListener("click", saveSettings); elements.resetSettings.addEventListener("click", resetSettings);
addMechanismRow({ role: "主品" }); addMechanismRow({ role: "赠品", quantity: 2 }); loadStatus();