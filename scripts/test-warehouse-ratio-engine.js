"use strict";

const assert = require("node:assert/strict");
const engine = require("../assets/warehouse-ratio-engine.js");

const model = engine.decodeModel({
  format: "warehouse-ratio-model-v1",
  rdc_order: ["北京", "上海"],
  products: [
    ["A", "零价商品", "品牌甲", "个护", "身体", "沐浴", 0],
    ["B", "正价商品", "品牌甲", "个护", "口腔", "牙膏", 10],
    ["C", "其他品牌", "品牌乙", "家清", "清洁", "洗衣", 20],
  ],
  warehouses: [
    ["北京", "普通C仓", "北京", "北京", "北京", 0, "上海", 1068, false, "高", true],
    ["上海", "普通C仓", "上海", "上海", "上海", 0, "北京", 1068, false, "高", true],
    ["北京大商超", "轻货仓", "北京", "北京", "北京", 0, "上海", 1068, false, "高", false],
    ["北京城市", "城市仓", "北京", "北京", "北京", 0, "上海", 1068, false, "高", false],
    ["苏州本地仓", "其他", "苏州", "上海", "上海", 84, "北京", 1000, false, "高", false],
  ],
  sales: [
    [0, 0, 100],
    [0, 2, 50],
    [0, 3, 20],
    [0, 4, 30],
    [1, 1, 200],
    [2, 0, 300],
  ],
  quality: {},
});

const defaultResult = engine.calculate(model, {
  filters: {},
  scopes: ["all"],
  excludeLight: true,
});
assert.equal(defaultResult.summary.totalSales90, 650);
assert.equal(defaultResult.summary.excludedLightSales, 50);
assert.equal(defaultResult.rdcRows.find((row) => row.warehouse === "北京").sales90, 420);
assert.equal(defaultResult.rdcRows.find((row) => row.warehouse === "上海").sales90, 230);
assert.equal(defaultResult.c62Rows.find((row) => row.warehouse === "北京").sales90, 420);
assert.equal(defaultResult.c62Rows.find((row) => row.warehouse === "上海").sales90, 230);

const overlapResult = engine.calculate(model, {
  filters: { brand: "品牌甲" },
  scopes: ["11rdc", "direct62"],
  excludeLight: false,
});
assert.equal(overlapResult.summary.totalSales90, 300, "11RDC和62仓重叠时不得重复累计");

const zeroResult = engine.calculate(model, {
  filters: { price: "zero" },
  scopes: ["all"],
  excludeLight: false,
});
assert.equal(zeroResult.summary.totalSales90, 200);
assert.equal(zeroResult.c62Rows.find((row) => row.warehouse === "上海").sales90, 30);

const cityResult = engine.calculate(model, {
  filters: {},
  scopes: ["city"],
  excludeLight: false,
});
assert.equal(cityResult.summary.totalSales90, 20);
assert.equal(cityResult.rdcRows[0].ratio, 1);

console.log("warehouse-ratio-engine: all tests passed");
