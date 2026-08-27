"use strict";
const STATUS_URL = "../data/bbcc-status.json";
const MODEL_URL = "../data/bbcc-model.enc.json";
const STORE = "jd.bbcc.scenario.v1";
const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(["unlock","app","unlockForm","password","unlockStatus","unlockButton","unlockDate","unlockCities","unlockWarehouses","lock","meta","notice","frequency","giftValue","insuranceRate","rates","warehouseBody","routeBody","routeCount","citySearch","run","download","results","kpis","fees","mappings","details","capacity","exceptions","sourceInfo"].map((id) => [id, $(id)]));
const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const money = (value) => `¥${fmt.format(Number(value) || 0)}`;
const text = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const state = { status: null, model: null, password: "", worker: null, result: null };

class Decryptor {
  constructor() {
    if (!window.Worker) throw new Error("当前浏览器不支持后台解密，请升级Chrome或Edge");
    this.id = 0; this.pending = new Map(); this.worker = new Worker("../assets/bbcc-decrypt-worker.js");
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id); if (!request) return;
      if (data.type === "progress") { request.progress(data.stage); return; }
      this.pending.delete(data.id); data.type === "result" ? request.resolve(data.result) : request.reject(Object.assign(new Error(data.message), { name: data.name || "Error" }));
    };
  }
  decrypt(payloadText, password, progress) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject, progress }); this.worker.postMessage({ type: "decrypt", id, payloadText, password }); }); }
  close() { this.worker.postMessage({ type: "clear" }); this.worker.terminate(); }
}
function status(message, info = false) { el.unlockStatus.textContent = message; el.unlockStatus.classList.toggle("info", info); }
function notice(message) { el.notice.textContent = message; el.notice.hidden = !message; }
async function json(url) { const response = await fetch(url, { cache: "no-cache" }); if (!response.ok) throw new Error("数据下载失败"); return response.json(); }
async function loadStatus() {
  try {
    state.status = await json(STATUS_URL); const counts = state.status.counts || {};
    el.unlockDate.textContent = state.status.date_range ? `${state.status.date_range.start} — ${state.status.date_range.end}` : "待发布";
    el.unlockCities.textContent = counts.cities ?? "—"; el.unlockWarehouses.textContent = counts.warehouses ?? "—";
  } catch { status("无法读取公开状态文件；请稍后重试。"); }
}
function savedSettings() { try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch { return null; } }
function scenario() {
  const settings = {
    frequency: el.frequency.value, gift_value_per_unit: Number(el.giftValue.value), insurance_rate: Number(el.insuranceRate.value),
    payable_rates: Object.fromEntries([...el.rates.querySelectorAll("[data-rate]")].map((input) => [input.dataset.rate, Number(input.value)])),
    warehouses: [...el.warehouseBody.querySelectorAll("tr")].map((row) => ({ name: row.dataset.name, enabled: row.querySelector("[data-enabled]").checked, pg_to_b_trips_per_month: Number(row.querySelector("[data-trips]").value), pg_to_b_cost_per_trip: Number(row.querySelector("[data-cost]").value) })),
    routes: [...el.routeBody.querySelectorAll("tr")].map((row) => ({ c_city: row.dataset.city, mode: row.querySelector("[data-mode]").value, assignment: row.querySelector("[data-assignment]").value, b_warehouse: row.querySelector("[data-warehouse]").value || null, direct_lead_days: row.querySelector("[data-direct-lead]").value === "" ? null : Number(row.querySelector("[data-direct-lead]").value) })),
  };
  return settings;
}
function persist() { try { localStorage.setItem(STORE, JSON.stringify(scenario())); } catch { /* Browser storage may be unavailable. */ } }
function updateRoute(row) {
  const direct = row.querySelector("[data-mode]").value === "direct";
  const assignment = row.querySelector("[data-assignment]"); const warehouse = row.querySelector("[data-warehouse]"); const directLead = row.querySelector("[data-direct-lead]");
  assignment.disabled = direct; warehouse.disabled = direct || assignment.value !== "manual"; directLead.disabled = !direct;
}
function fillSettings(settings) {
  const defaults = BbccEngine.defaultSettings(state.model); const value = settings || defaults;
  el.frequency.value = value.frequency || defaults.frequency; el.giftValue.value = value.gift_value_per_unit ?? defaults.gift_value_per_unit; el.insuranceRate.value = value.insurance_rate ?? defaults.insurance_rate;
  const rateNames = { pg_to_b_transport: "PG→B运输", bc_transport: "B-C运输", whole_case_outbound: "整箱出库", loose_first_outbound: "散支首件", loose_continuation_outbound: "散支续件", storage: "存储", insurance: "保费" };
  el.rates.innerHTML = Object.entries(defaults.payable_rates).map(([name, fallback]) => `<label class="field">${rateNames[name]} 折扣比例<input data-rate="${name}" type="number" min="0" max="1" step=".01" value="${value.payable_rates?.[name] ?? fallback}"></label>`).join("");
  const savedWarehouses = new Map((value.warehouses || []).map((row) => [row.name, row]));
  el.warehouseBody.innerHTML = defaults.warehouses.map((warehouse) => {
    const current = savedWarehouses.get(warehouse.name) || warehouse;
    return `<tr data-name="${text(warehouse.name)}"><td><input data-enabled type="checkbox" ${current.enabled ? "checked" : ""}></td><td>${text(warehouse.name)}</td><td>${text(state.model.warehouses.find((item) => item.name === warehouse.name).routeKey)}</td><td>${state.model.warehouses.find((item) => item.name === warehouse.name).pgLead}</td><td><input data-trips type="number" min=".01" step=".1" value="${current.pg_to_b_trips_per_month}"></td><td><input data-cost type="number" min="0" step=".01" value="${current.pg_to_b_cost_per_trip}"></td></tr>`;
  }).join("");
  const savedRoutes = new Map((value.routes || []).map((row) => [row.c_city, row])); const options = defaults.warehouses.map((warehouse) => `<option value="${text(warehouse.name)}">${text(warehouse.name)}</option>`).join("");
  el.routeBody.innerHTML = state.model.cities.map((city) => {
    const current = savedRoutes.get(city) || { mode: state.model.directCities.has(city) ? "direct" : "bc", assignment: "auto", b_warehouse: "", direct_lead_days: "" };
    const rdc = state.model.cityTo11r.get(city) || "未映射";
    return `<tr data-city="${text(city)}"><td><strong>${text(city)}</strong></td><td><select data-mode><option value="direct" ${current.mode === "direct" ? "selected" : ""}>PG直送</option><option value="bc" ${current.mode === "bc" ? "selected" : ""}>B-C调运</option></select></td><td><select data-assignment><option value="auto" ${current.assignment === "auto" ? "selected" : ""}>自动最低成本</option><option value="manual" ${current.assignment === "manual" ? "selected" : ""}>手工指定</option></select></td><td><select data-warehouse><option value="">请选择</option>${options}</select></td><td><input data-direct-lead type="number" min=".1" step=".1" value="${current.direct_lead_days ?? ""}"></td><td>${text(rdc)}</td></tr>`;
  }).join("");
  for (const row of el.routeBody.querySelectorAll("tr")) { const saved = savedRoutes.get(row.dataset.city); if (saved?.b_warehouse) row.querySelector("[data-warehouse]").value = saved.b_warehouse; updateRoute(row); }
  el.routeCount.textContent = `${state.model.cities.length} 个C仓`;
}
function render(result) {
  const summary = result.summaries[0]; const cards = [
    ["标准 / 折后总成本", `${money(summary.standard_total)} / ${money(summary.payable_total)}`, "仅计算BBCC增量成本；右侧按各环节折扣比例计算。"],
    ["BBCC折后单支成本", money(summary.payable_cost_per_bbcc_unit), "折后总成本 ÷ 纳入BBCC链路的赠品支数。"],
    ["BBCC / 直送 / 回退货量", `${fmt.format(summary.bbcc_quantity)} / ${fmt.format(summary.direct_quantity)} / ${fmt.format(summary.fallback_quantity)}`, "依次为B-C调运、PG直送和无线路回退11R代发的模拟支数。"],
    ["BBCC / 直送 / 回退占比", `${fmt.format(summary.bbcc_ratio * 100)}% / ${fmt.format(summary.direct_ratio * 100)}% / ${fmt.format(summary.fallback_ratio * 100)}%`, "三类路径占已成功分配模拟货量的比例。"],
    ["活跃B仓 / 调拨任务", `${summary.active_b_count} / ${summary.transfer_tasks}`, "活跃B仓实际分到货量；任务数为全年B-C发运次数。"],
    ["全国加权端到端时效", `${fmt.format(summary.nationwide_weighted_end_to_end_lead_days)} 天`, "按全国模拟货量加权，包含直送、BBCC及11R回退。"],
    ["B-C运输 / BBCC端到端时效", `${fmt.format(summary.bc_weighted_lead_days)} / ${fmt.format(summary.bc_end_to_end_weighted_lead_days)} 天`, "前者仅为报价B-C时效；后者再加对应PG→B时效。"],
    ["整箱出库支数占比", `${fmt.format(summary.whole_case_ratio * 100)}%`, "BBCC货量中按整箱出库计费的支数占比。"],
    ["历史货量建模覆盖率", `${fmt.format(summary.modeled_coverage * 100)}%`, "已映射到有效城市路径的货量 ÷ FY2526历史赠品货量。"],
  ];
  el.kpis.innerHTML = cards.map(([title, value, help]) => `<article class="kpi"><small>${title}</small><strong>${value}</strong><p>${help}</p></article>`).join("");
  const rows = (items, fields) => items.map((item) => `<tr>${fields.map((field) => `<td>${typeof field === "function" ? field(item) : text(item[field])}</td>`).join("")}</tr>`).join("");
  el.fees.innerHTML = rows(result.fee_breakdown, ["stage", (x) => money(x.standard_fee), (x) => `${fmt.format(x.payable_rate * 100)}%`, (x) => money(x.payable_fee)]);
  el.mappings.innerHTML = rows(result.route_mapping, ["c_city", "route_type", (x) => text(x.b_warehouse || x.assigned_rdc || "—"), (x) => x.bc_lead_days ?? "—", "end_to_end_lead_days", (x) => money(x.annual_transport)]);
  el.details.innerHTML = rows(result.route_details, ["month", "b_warehouse", "c_city", "task_count", (x) => fmt.format(x.task_quantity), (x) => fmt.format(x.task_chargeable_weight_kg), "bc_lead_days", "end_to_end_lead_days", (x) => money(x.monthly_transport), (x) => money(x.monthly_outbound)]);
  el.capacity.innerHTML = rows(result.capacity_checks, ["month", "b_warehouse", "pg_to_b_trips", (x) => fmt.format(x.quantity_per_trip), (x) => fmt.format(x.volume_m3_per_trip), (x) => fmt.format(x.weight_kg_per_trip)]);
  el.exceptions.innerHTML = result.exceptions.length ? result.exceptions.map((x) => `<p><strong>${text(x.type)} · ${text(x.key)}</strong> ${text(x.message)}</p>`).join("") : "<p>没有异常。</p>";
  el.results.hidden = false; el.download.disabled = false; state.result = result;
}
function csv() {
  if (!state.result) return; const sections = [["汇总", state.result.summaries], ["费用分解", state.result.fee_breakdown], ["路由时效", state.result.route_mapping], ["月度B-C任务", state.result.route_details], ["PG到B容量", state.result.capacity_checks], ["异常", state.result.exceptions]];
  const lines = [];
  for (const [name, data] of sections) { lines.push(name); const columns = [...new Set(data.flatMap((row) => Object.keys(row)))]; lines.push(columns.join(",")); lines.push(...data.map((row) => columns.map((column) => `"${String(row[column] ?? "").replace(/"/g, '""')}"`).join(","))); lines.push(""); }
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" })); link.download = "Free-Goods-BBCC-Simulation.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
el.unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault(); const password = el.password.value; if (!password) return status("请输入访问密码。");
  el.unlockButton.disabled = true;
  try {
    status("正在下载加密模型…", true); const response = await fetch(MODEL_URL, { cache: "no-cache" }); if (!response.ok) throw new Error("加密BBCC模型尚未发布");
    state.worker ||= new Decryptor(); const payload = await state.worker.decrypt(await response.text(), password, (stage) => status({ derive: "正在验证密码（PBKDF2 600,000轮）…", decrypt: "正在解密模型…", decompress: "正在解压模型…", parse: "正在解析模型…" }[stage], true));
    state.model = BbccEngine.decodeModel(payload.data); state.password = password; fillSettings(savedSettings()); el.sourceInfo.textContent = `加密模型生成于 ${payload.metadata?.generated_at || state.status?.generated_at || "未知"}；FY2526月度发货、需求分布、13个B仓、B-C报价及调拨日历均在浏览器内解密计算。`;
    el.unlock.hidden = true; el.app.hidden = false; notice(""); window.scrollTo(0, 0);
  } catch (error) { status(error.name === "OperationError" ? "密码不正确，或加密数据已损坏。" : error.message || "解锁失败。"); }
  finally { el.unlockButton.disabled = false; }
});
el.routeBody.addEventListener("change", (event) => { const row = event.target.closest("tr"); if (row) { updateRoute(row); persist(); } });
el.citySearch.addEventListener("input", () => { const query = el.citySearch.value.trim(); for (const row of el.routeBody.querySelectorAll("tr")) row.hidden = !row.dataset.city.includes(query); });
document.addEventListener("change", (event) => { if (el.app.contains(event.target) && !event.target.matches("#citySearch")) persist(); });
el.run.addEventListener("click", () => { try { el.run.disabled = true; el.run.textContent = "正在计算…"; render(BbccEngine.simulate(state.model, scenario())); notice("仿真完成，结果已更新。"); el.results.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (error) { notice(error.message || "计算失败。"); } finally { el.run.disabled = false; el.run.textContent = "重新运行当前情景"; } });
el.download.addEventListener("click", csv);
el.lock.addEventListener("click", () => { state.worker?.close(); state.worker = null; state.model = null; state.password = ""; state.result = null; el.password.value = ""; el.app.hidden = true; el.unlock.hidden = false; status(""); });
loadStatus();
