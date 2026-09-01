"use strict";

const scenarios = {
  "local-whole": {
    consumer: "甲城",
    destination: "甲城",
    type: "同品类订单",
    skus: [
      { name: "SKU-A", quantity: 1, role: "商品" },
      { name: "SKU-B", quantity: 1, role: "商品" },
    ],
    warehouses: [
      { name: "甲城常规仓", meta: "甲城 · 常规仓网 · 原覆盖", stock: ["A × 8", "B × 5"], selected: true },
      { name: "乙城常规仓", meta: "同区乙城 · 常规仓网", stock: ["A × 12", "B × 9"], selected: false },
    ],
    kicker: "LOCAL COMPLETE",
    title: "本地一个节点完整满足",
    modes: ["本地同城", "同网", "同仓", "整单"],
    reasons: [
      "候选库存可以完整满足全部 SKU。",
      "甲城常规仓一个履约 from 即可整单发出。",
      "不需要启用同区或跨区候选。",
    ],
    costs: { "新增节点": 0, "特殊网络": 0, "地理异常": 0 },
  },
  "local-split": {
    consumer: "甲城",
    destination: "甲城",
    type: "跨品类订单",
    skus: [
      { name: "SKU-A", quantity: 1, role: "商品" },
      { name: "SKU-C", quantity: 1, role: "商品" },
    ],
    warehouses: [
      { name: "甲城常规仓", meta: "甲城 · 常规仓网", stock: ["A × 8", "C × 0"], selected: true },
      { name: "甲城特殊仓", meta: "甲城 · 特殊仓网", stock: ["A × 0", "C × 4"], selected: true },
      { name: "乙城常规仓", meta: "同区乙城 · 常规仓网", stock: ["A × 5", "C × 5"], selected: false },
    ],
    kicker: "LOCAL CAPACITY FIRST",
    title: "本地库存优先，形成两个子单",
    modes: ["本地同城", "跨网", "跨仓", "拆单"],
    reasons: [
      "跨品类订单不强制迁移到外地单仓整单。",
      "两个本地节点合计可以完整满足订单。",
      "结果保留本地库存，但增加一个履约 from。",
    ],
    costs: { "新增节点": 2, "特殊网络": 3, "地理异常": 0 },
  },
  "regional-whole": {
    consumer: "甲城",
    destination: "甲城",
    type: "同品类订单",
    skus: [
      { name: "SKU-A", quantity: 1, role: "商品" },
      { name: "SKU-B", quantity: 2, role: "商品" },
    ],
    warehouses: [
      { name: "甲城常规仓", meta: "甲城 · 常规仓网", stock: ["A × 0", "B × 1"], selected: false },
      { name: "乙城常规仓", meta: "同区乙城 · 常规仓网 · 原覆盖", stock: ["A × 6", "B × 8"], selected: true },
      { name: "丙城常规仓", meta: "跨区丙城 · 常规仓网", stock: ["A × 8", "B × 9"], selected: false },
    ],
    kicker: "SAME-REGION WHOLE ORDER",
    title: "同区外地仓整单承担",
    modes: ["同区跨城", "同网", "同仓", "整单"],
    reasons: [
      "本地无法完整满足全部数量。",
      "同品类订单优先寻找同区单节点整单方案。",
      "乙城原覆盖节点可以完整满足，无需跨区。",
    ],
    costs: { "新增节点": 0, "特殊网络": 0, "地理异常": 1 },
  },
  "cross-region": {
    consumer: "甲城",
    destination: "甲城",
    type: "跨品类订单",
    skus: [
      { name: "SKU-A", quantity: 1, role: "商品" },
      { name: "SKU-D", quantity: 1, role: "商品" },
    ],
    warehouses: [
      { name: "甲城常规仓", meta: "甲城 · 常规仓网", stock: ["A × 4", "D × 0"], selected: true },
      { name: "乙城常规仓", meta: "同区乙城 · 常规仓网", stock: ["A × 3", "D × 0"], selected: false },
      { name: "丙城常规仓", meta: "跨区丙城 · 常规仓网", stock: ["A × 9", "D × 6"], selected: true },
    ],
    kicker: "CROSS-REGION FALLBACK",
    title: "本地承担一部分，跨区补足缺口",
    modes: ["跨区", "同网", "跨仓", "拆单"],
    reasons: [
      "候选网络合计可以满足订单，但本区没有 SKU-D。",
      "先使用甲城已有的 SKU-A 库存。",
      "SKU-D 从跨区兜底节点补足，因此形成拆单和地理异常。",
    ],
    costs: { "新增节点": 2, "特殊网络": 0, "地理异常": 5 },
  },
  bundle: {
    consumer: "甲城",
    destination: "甲城",
    type: "主品 + 赠品",
    skus: [
      { name: "SKU-A", quantity: 1, role: "主品" },
      { name: "GIFT-B", quantity: 1, role: "赠品" },
    ],
    warehouses: [
      { name: "甲城常规仓", meta: "甲城 · 常规仓网", stock: ["A × 10", "赠品 × 0"], selected: false },
      { name: "乙城常规仓", meta: "同区乙城 · 常规仓网 · 原覆盖", stock: ["A × 7", "赠品 × 5"], selected: true },
      { name: "甲城特殊仓", meta: "甲城 · 特殊仓网", stock: ["A × 0", "赠品 × 2"], selected: false },
    ],
    kicker: "BUNDLE INTEGRITY",
    title: "为保护主赠整单，选择同区单仓",
    modes: ["同区跨城", "同网", "同仓", "整单"],
    reasons: [
      "订单同时包含主品和赠品，先保护机制完整性。",
      "乙城一个节点可以完整满足主赠组合。",
      "因此不使用甲城两个节点拆单，即使本地主品有货。",
    ],
    costs: { "新增节点": 0, "特殊网络": 0, "地理异常": 1 },
  },
};

function renderScenario(key) {
  const scenario = scenarios[key];
  if (!scenario) return;

  document.getElementById("scenarioConsumer").textContent = scenario.consumer;
  document.getElementById("scenarioDestination").textContent = scenario.destination;
  document.getElementById("scenarioType").textContent = scenario.type;
  document.getElementById("scenarioKicker").textContent = scenario.kicker;
  document.getElementById("scenarioTitle").textContent = scenario.title;

  document.getElementById("scenarioSkus").replaceChildren(...scenario.skus.map((sku) => {
    const row = document.createElement("div");
    row.className = "sku-chip";
    const label = document.createElement("span");
    label.textContent = `${sku.name} × ${sku.quantity}`;
    const role = document.createElement("small");
    role.textContent = sku.role;
    row.append(label, role);
    return row;
  }));

  document.getElementById("scenarioWarehouses").replaceChildren(...scenario.warehouses.map((warehouse) => {
    const row = document.createElement("article");
    row.className = `warehouse${warehouse.selected ? " selected" : ""}`;
    const title = document.createElement("h3");
    title.textContent = warehouse.name;
    const state = document.createElement("span");
    state.textContent = warehouse.selected ? "已选择" : "未选择";
    const meta = document.createElement("span");
    meta.textContent = warehouse.meta;
    meta.className = "warehouse-meta";
    const stock = document.createElement("div");
    stock.className = "warehouse-stock";
    warehouse.stock.forEach((item) => {
      const chip = document.createElement("span");
      chip.textContent = item;
      stock.append(chip);
    });
    row.append(title, state, meta, stock);
    return row;
  }));

  document.getElementById("scenarioModes").replaceChildren(...scenario.modes.map((mode) => {
    const tag = document.createElement("span");
    tag.textContent = mode;
    return tag;
  }));

  document.getElementById("scenarioReasons").replaceChildren(...scenario.reasons.map((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    return item;
  }));

  const total = Object.values(scenario.costs).reduce((sum, value) => sum + value, 0);
  document.getElementById("scenarioCostTotal").textContent = String(total);
  document.getElementById("scenarioCostBars").replaceChildren(...Object.entries(scenario.costs).map(([label, value]) => {
    const row = document.createElement("div");
    row.className = "cost-bar";
    const name = document.createElement("span");
    name.textContent = label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.dataset.value = String(value);
    track.append(fill);
    const number = document.createElement("span");
    number.textContent = String(value);
    row.append(name, track, number);
    return row;
  }));
}

document.querySelectorAll("[data-scenario]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-scenario]").forEach((item) => {
      item.setAttribute("aria-selected", String(item === button));
    });
    renderScenario(button.dataset.scenario);
  });
});

renderScenario("local-whole");
