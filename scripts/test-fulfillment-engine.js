"use strict";

const assert = require("node:assert/strict");
const engine = require("../assets/fulfillment-engine.js");

function snapshot(warehouseRows) {
  return engine.decodeSnapshot({
    format: "fulfillment-snapshot-v1",
    cities: ["北京", "石家庄", "唐山", "呼和浩特", "广州", "上海"],
    regions: ["北京", "广州", "上海"],
    networks: ["普通C仓", "轻货仓"],
    city_regions: [0, 0, 0, 0, 1, 2],
    city_mapping: [0, 1, 2, 3, 4, 5],
    rules: [150, 300, 450, 450],
    skus: [["A", "A", "", ""], ["B", "B", "", ""]],
    warehouses: warehouseRows,
    demand: [[0, [[0, 100]]]],
  });
}

function warehouse(id, cityIndex, regionIndex, networkIndex, stock, covered = null) {
  return [id, id, `${id}库`, cityIndex, regionIndex, networkIndex, covered, stock];
}

let data = snapshot([
  warehouse("石家庄A", 1, 0, 0, [[0, 1]]),
  warehouse("石家庄B", 1, 0, 0, [[1, 2]]),
]);
let result = engine.decide(data, 1, { A: 1, B: 2 });
assert.equal(result.mode, "本地同城发货 / 同网 / 拆单发货");
assert.equal(result.upchargeCents, 150);

data = snapshot([
  warehouse("呼和浩特", 3, 0, 0, [[0, 1]]),
  warehouse("唐山", 2, 0, 0, [[1, 1]]),
]);
result = engine.decide(data, 0, { A: 1, B: 1 });
assert.equal(result.mode, "同区跨城发货 / 同网 / 拆单发货");
assert.equal(result.upchargeCents, 600);

data = snapshot([
  warehouse("北京", 0, 0, 0, [[1, 1]]),
  warehouse("唐山", 2, 0, 0, [[0, 1], [1, 2]]),
]);
result = engine.decide(data, 0, { A: 1, B: 2 });
assert.equal(result.fromCount, 2);
assert.equal(result.upchargeCents, 300);
assert.equal(result.allocations.filter((row) => row.isLocal).reduce((sum, row) => sum + row.quantity, 0), 1);

data = snapshot([warehouse("唐山", 2, 0, 0, [[0, 1]])]);
result = engine.decide(data, 0, { A: 1 });
assert.equal(result.parcel, "整单发货");
assert.equal(result.upchargeCents, 300);

data = snapshot([
  warehouse("北京C", 0, 0, 0, [[0, 1]]),
  warehouse("北京轻", 0, 0, 1, [[1, 1]]),
]);
result = engine.decide(data, 0, { A: 1, B: 1 });
assert.equal(result.network, "跨网");
assert.equal(result.upchargeCents, 450);

data = snapshot([warehouse("北京大仓", 0, 0, 0, [[0, 1]], [0, 1, 2, 3])]);
assert.equal(engine.decide(data, 1, { A: 1 }).fulfilled, true);
assert.equal(engine.decide(data, 4, { A: 1 }).fulfilled, false);

console.log("fulfillment-engine: 6 business scenarios passed");