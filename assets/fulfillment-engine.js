"use strict";

(function exposeFulfillmentEngine(root) {
  function compareTuples(first, second) {
    const length = Math.max(first.length, second.length);
    for (let index = 0; index < length; index += 1) {
      const left = first[index];
      const right = second[index];
      if (Array.isArray(left) && Array.isArray(right)) {
        const nested = compareTuples(left, right);
        if (nested !== 0) return nested;
      } else if (left < right) return -1;
      else if (left > right) return 1;
    }
    return 0;
  }

  function cleanDemand(demand) {
    const cleaned = new Map();
    for (const [rawSku, rawQuantity] of Object.entries(demand || {})) {
      const sku = String(rawSku || "").trim().replace(/\.0$/, "");
      const quantity = Number(rawQuantity);
      if (!sku || !Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("SKU不能为空，数量必须是大于0的整数");
      }
      cleaned.set(sku, (cleaned.get(sku) || 0) + quantity);
    }
    if (!cleaned.size) throw new Error("订单至少需要一个SKU");
    return cleaned;
  }

  function decodeSnapshot(payload) {
    const supported = new Set([
      "fulfillment-snapshot-v1",
      "fulfillment-snapshot-v2-base",
    ]);
    if (!payload || !supported.has(payload.format)) {
      throw new Error("履约数据格式不受支持");
    }
    const skus = payload.skus.map((row, index) => ({
      index,
      sku: String(row[0]),
      name: row[1] || "",
      brand: row[2] || "",
      category: row[3] || "",
      searchText: `${row[0]} ${row[1] || ""} ${row[2] || ""}`.toLocaleLowerCase("zh-CN"),
    }));
    const skuIndex = new Map(skus.map((item) => [item.sku, item.index]));
    const warehouses = payload.warehouses.map((row) => ({
      id: row[0],
      deliveryCenter: row[1],
      warehouseName: row[2],
      cityIndex: row[3],
      regionIndex: row[4],
      networkIndex: row[5],
      coveredCities: row[6] === null ? null : new Set(row[6]),
      stock: new Map(row[7] || []),
    }));
    const demand = new Map((payload.demand || []).map((row) => [row[0], new Map(row[1])]));
    return {
      format: payload.format,
      shardCount: Number(payload.shard_count || 0),
      loadedShards: new Set(),
      cities: payload.cities,
      regions: payload.regions,
      networks: payload.networks,
      cityRegions: payload.city_regions,
      defaultCityMapping: payload.city_mapping,
      defaultRules: {
        localExtra: payload.rules[0],
        sameRegion: payload.rules[1],
        crossRegion: payload.rules[2],
        crossNetwork: payload.rules[3],
      },
      defaultRouting: {
        ordinaryCNationalFallback: payload.routing?.[0] !== false,
      },
      skus,
      skuIndex,
      warehouses,
      demand,
    };
  }

  function mergeSkuShard(snapshot, payload) {
    if (!payload || payload.format !== "fulfillment-sku-shard-v1") {
      throw new Error("SKU分片格式不受支持");
    }
    const shardIndex = Number(payload.shard_index);
    if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= snapshot.shardCount) {
      throw new Error("SKU分片编号无效");
    }
    if (snapshot.loadedShards.has(shardIndex)) return;
    for (const row of payload.rows || []) {
      const skuIndex = Number(row[0]);
      if (!Number.isInteger(skuIndex) || !snapshot.skus[skuIndex]) {
        throw new Error("SKU分片包含无效SKU索引");
      }
      for (const stockRow of row[1] || []) {
        const warehouseIndex = Number(stockRow[0]);
        const quantity = Number(stockRow[1]);
        const warehouse = snapshot.warehouses[warehouseIndex];
        if (!warehouse || !Number.isFinite(quantity) || quantity < 0) {
          throw new Error("SKU分片包含无效库存记录");
        }
        warehouse.stock.set(skuIndex, quantity);
      }
      snapshot.demand.set(skuIndex, new Map(row[2] || []));
    }
    snapshot.loadedShards.add(shardIndex);
  }

  function canServe(warehouse, destinationCityIndex) {
    return warehouse.coveredCities === null || warehouse.coveredCities.has(destinationCityIndex);
  }

  function coverageRank(snapshot, warehouse, destinationCityIndex, ordinaryCNationalFallback) {
    if (canServe(warehouse, destinationCityIndex)) return 0;
    const network = snapshot.networks[warehouse.networkIndex];
    if (network === "轻货仓") return 1;
    if (network === "普通C仓" && ordinaryCNationalFallback) return 2;
    return null;
  }

  function stockQuantity(warehouse, skuIndex) {
    return Math.max(0, Number(warehouse.stock.get(skuIndex) || 0));
  }

  function nodeCharge(snapshot, warehouse, destinationCityIndex, destinationRegionIndex, referenceNetwork, rules) {
    if (warehouse.networkIndex !== referenceNetwork) return rules.crossNetwork;
    if (snapshot.networks[warehouse.networkIndex] === "轻货仓") return 0;
    if (warehouse.cityIndex === destinationCityIndex) return rules.localExtra;
    if (warehouse.regionIndex === destinationRegionIndex) return rules.sameRegion;
    return rules.crossRegion;
  }

  function cover(needsMap, warehouses, costs, priorities) {
    const active = [...needsMap.entries()].filter(([, quantity]) => quantity > 0).sort((a, b) => a[0] - b[0]);
    if (!active.length) return [];
    const skuIndexes = active.map(([sku]) => sku);
    const initialNeeds = active.map(([, quantity]) => quantity);
    const candidates = warehouses.filter((warehouse) => skuIndexes.some((sku) => stockQuantity(warehouse, sku) > 0));
    const vectors = candidates.map((warehouse) => skuIndexes.map((sku, index) => Math.min(initialNeeds[index], stockQuantity(warehouse, sku))));
    const bySku = skuIndexes.map((_, skuPosition) => candidates.map((__, index) => index).filter((index) => vectors[index][skuPosition] > 0));
    if (bySku.some((indexes) => !indexes.length)) return null;
    const memo = new Map();

    function solve(needs, available) {
      if (needs.every((value) => value === 0)) return [0, 0, 0, []];
      const key = `${needs.join(",")}|${available.join(",")}`;
      if (memo.has(key)) return memo.get(key);
      const availableSet = new Set(available);
      const activeSkuPositions = needs.map((value, index) => value > 0 ? index : -1).filter((index) => index >= 0);
      const target = activeSkuPositions.sort((a, b) => {
        const left = bySku[a].filter((index) => availableSet.has(index)).length;
        const right = bySku[b].filter((index) => availableSet.has(index)).length;
        return left - right || a - b;
      })[0];
      const options = bySku[target].filter((index) => availableSet.has(index));
      let best = null;
      for (const index of options) {
        const remaining = needs.map((need, position) => Math.max(0, need - vectors[index][position]));
        const tail = solve(remaining, available.filter((value) => value !== index));
        if (tail === null) continue;
        const selected = [index, ...tail[3]].sort((a, b) => a - b);
        const candidate = [
          (priorities.get(candidates[index].id) || 0) + tail[0],
          (costs.get(candidates[index].id) || 0) + tail[1],
          1 + tail[2],
          selected,
        ];
        if (best === null || compareTuples(candidate, best) < 0) best = candidate;
      }
      memo.set(key, best);
      return best;
    }

    const result = solve(initialNeeds, candidates.map((_, index) => index));
    return result === null ? null : result[3].map((index) => candidates[index]);
  }

  function allocate(needsMap, warehouses) {
    const remaining = new Map(needsMap);
    const rows = [];
    [...warehouses].sort((a, b) => a.id.localeCompare(b.id, "zh-CN")).forEach((warehouse) => {
      [...remaining.keys()].sort((a, b) => a - b).forEach((skuIndex) => {
        const quantity = Math.min(remaining.get(skuIndex), stockQuantity(warehouse, skuIndex));
        if (quantity > 0) {
          rows.push([warehouse, skuIndex, quantity]);
          remaining.set(skuIndex, remaining.get(skuIndex) - quantity);
        }
      });
    });
    return [rows, new Map([...remaining].filter(([, quantity]) => quantity > 0))];
  }

  function decide(snapshot, destinationCityIndex, demandObject, options = {}) {
    const rules = options.rules || snapshot.defaultRules;
    const ordinaryCNationalFallback = options.ordinaryCNationalFallback
      ?? snapshot.defaultRouting.ordinaryCNationalFallback;
    const cleaned = cleanDemand(demandObject);
    const indexedDemand = new Map();
    for (const [sku, quantity] of cleaned) {
      if (!snapshot.skuIndex.has(sku)) throw new Error(`库存切片没有SKU：${sku}`);
      indexedDemand.set(snapshot.skuIndex.get(sku), quantity);
    }
    const destinationRegionIndex = snapshot.cityRegions[destinationCityIndex];
    const candidateRanks = new Map();
    const candidates = snapshot.warehouses.filter((warehouse) => {
      const rank = coverageRank(
        snapshot,
        warehouse,
        destinationCityIndex,
        ordinaryCNationalFallback,
      );
      if (rank === null) return false;
      candidateRanks.set(warehouse.id, rank);
      return true;
    });
    const shortage = {};
    for (const [skuIndex, quantity] of indexedDemand) {
      const total = candidates.reduce((sum, warehouse) => sum + stockQuantity(warehouse, skuIndex), 0);
      if (total < quantity) shortage[snapshot.skus[skuIndex].sku] = quantity - total;
    }
    if (Object.keys(shortage).length) {
      return { fulfilled: false, mode: "库存不足", geography: "无法履约", network: "无法判断", parcel: "无法判断", warehouseMode: "无法判断", fromCount: 0, upchargeCents: 0, allocations: [], shortage };
    }

    const local = candidates.filter((warehouse) => warehouse.cityIndex === destinationCityIndex);
    const nonlocal = candidates.filter((warehouse) => warehouse.cityIndex !== destinationCityIndex);
    const localTargets = new Map([...indexedDemand].map(([skuIndex, quantity]) => [
      skuIndex,
      Math.min(quantity, local.reduce((sum, warehouse) => sum + stockQuantity(warehouse, skuIndex), 0)),
    ]));
    const externalNeeds = new Map([...indexedDemand].map(([skuIndex, quantity]) => [skuIndex, quantity - localTargets.get(skuIndex)]));
    const localHasStock = [...localTargets.values()].some((quantity) => quantity > 0);
    const plans = [];

    if (localHasStock) {
      const bases = local.filter((warehouse) => [...indexedDemand.keys()].some((skuIndex) => stockQuantity(warehouse, skuIndex) > 0));
      for (const base of bases) {
        const afterBase = new Map([...localTargets].map(([skuIndex, quantity]) => [skuIndex, Math.max(0, quantity - stockQuantity(base, skuIndex))]));
        const otherLocal = local.filter((warehouse) => warehouse.id !== base.id);
        const localCosts = new Map(otherLocal.map((warehouse) => [warehouse.id, nodeCharge(snapshot, warehouse, destinationCityIndex, destinationRegionIndex, base.networkIndex, rules)]));
        const localPriorities = new Map(otherLocal.map((warehouse) => [warehouse.id, candidateRanks.get(warehouse.id)]));
        const selectedLocal = cover(afterBase, otherLocal, localCosts, localPriorities);
        if (selectedLocal === null) continue;
        const externalCosts = new Map(nonlocal.map((warehouse) => [warehouse.id, nodeCharge(snapshot, warehouse, destinationCityIndex, destinationRegionIndex, base.networkIndex, rules)]));
        const externalPriorities = new Map(nonlocal.map((warehouse) => [warehouse.id, candidateRanks.get(warehouse.id)]));
        const selectedExternal = cover(externalNeeds, nonlocal, externalCosts, externalPriorities);
        if (selectedExternal === null) continue;
        const selected = [base, ...selectedLocal, ...selectedExternal];
        const cost = selectedLocal.reduce((sum, warehouse) => sum + localCosts.get(warehouse.id), 0)
          + selectedExternal.reduce((sum, warehouse) => sum + externalCosts.get(warehouse.id), 0);
        const routePriority = selected.reduce((sum, warehouse) => sum + candidateRanks.get(warehouse.id), 0);
        plans.push({ cost, base, selected, key: [routePriority, cost, selected.length, selected.map((item) => item.id).sort(), base.id] });
      }
    } else {
      const networks = [...new Set(nonlocal.map((warehouse) => warehouse.networkIndex))].sort((a, b) => a - b);
      for (const referenceNetwork of networks) {
        const costs = new Map(nonlocal.map((warehouse) => [warehouse.id, nodeCharge(snapshot, warehouse, destinationCityIndex, destinationRegionIndex, referenceNetwork, rules)]));
        const priorities = new Map(nonlocal.map((warehouse) => [warehouse.id, candidateRanks.get(warehouse.id)]));
        const selected = cover(indexedDemand, nonlocal, costs, priorities);
        if (selected === null || !selected.some((warehouse) => warehouse.networkIndex === referenceNetwork)) continue;
        const cost = selected.reduce((sum, warehouse) => sum + costs.get(warehouse.id), 0);
        const routePriority = selected.reduce((sum, warehouse) => sum + candidateRanks.get(warehouse.id), 0);
        plans.push({ cost, base: null, referenceNetwork, selected, key: [routePriority, cost, selected.length, selected.map((item) => item.id).sort(), ""] });
      }
    }
    if (!plans.length) throw new Error("库存合计可满足，但未找到有效分仓方案");
    plans.sort((a, b) => compareTuples(a.key, b.key));
    const plan = plans[0];
    const localSelected = plan.selected.filter((warehouse) => warehouse.cityIndex === destinationCityIndex);
    const externalSelected = plan.selected.filter((warehouse) => warehouse.cityIndex !== destinationCityIndex);
    const [localRows, localShortage] = allocate(localTargets, localSelected);
    const [externalRows, externalShortage] = allocate(externalNeeds, externalSelected);
    if (localShortage.size || externalShortage.size) throw new Error("分仓分配失败");
    const referenceNetwork = plan.base ? plan.base.networkIndex : plan.referenceNetwork;
    const charges = new Map(plan.selected.map((warehouse) => [
      warehouse.id,
      plan.base && warehouse.id === plan.base.id ? 0 : nodeCharge(snapshot, warehouse, destinationCityIndex, destinationRegionIndex, referenceNetwork, rules),
    ]));
    const allocations = [...localRows, ...externalRows].map(([warehouse, skuIndex, quantity]) => ({
      fulfillmentFrom: warehouse.id,
      deliveryCenter: warehouse.deliveryCenter,
      warehouseName: warehouse.warehouseName,
      city: snapshot.cities[warehouse.cityIndex],
      region: snapshot.regions[warehouse.regionIndex],
      network: snapshot.networks[warehouse.networkIndex],
      sku: snapshot.skus[skuIndex].sku,
      quantity,
      isLocal: warehouse.cityIndex === destinationCityIndex,
      isBase: Boolean(plan.base && warehouse.id === plan.base.id),
      upchargeCents: charges.get(warehouse.id),
    }));
    const geography = plan.selected.every((warehouse) => warehouse.cityIndex === destinationCityIndex)
      ? "本地同城发货"
      : plan.selected.every((warehouse) => warehouse.regionIndex === destinationRegionIndex)
        ? "同区跨城发货" : "跨区发货";
    const network = new Set(plan.selected.map((warehouse) => warehouse.networkIndex)).size === 1 ? "同网" : "跨网";
    const parcel = plan.selected.length === 1 ? "整单发货" : "拆单发货";
    const warehouseMode = plan.selected.length === 1 ? "同仓" : "跨仓";
    return { fulfilled: true, geography, network, parcel, warehouseMode, mode: `${geography} / ${network} / ${warehouseMode}`, fromCount: plan.selected.length, upchargeCents: plan.cost, allocations, shortage: {} };
  }

  function mechanismWeights(snapshot, primarySku, cityMapping) {
    const sku = String(primarySku || "").trim().replace(/\.0$/, "");
    const skuIndex = snapshot.skuIndex.get(sku);
    if (skuIndex === undefined) throw new Error(`库存切片没有主品SKU：${sku}`);
    const source = snapshot.demand.get(skuIndex);
    if (!source || !source.size) throw new Error(`主品SKU ${sku} 的近90日收货地商品件数为0`);
    const byDestination = new Map();
    for (const [sourceCity, quantity] of source) {
      const destination = cityMapping[sourceCity];
      if (!Number.isInteger(destination)) throw new Error(`城市尚未配置收敛关系：${snapshot.cities[sourceCity]}`);
      byDestination.set(destination, (byDestination.get(destination) || 0) + quantity);
    }
    const total = [...byDestination.values()].reduce((sum, quantity) => sum + quantity, 0);
    return [...byDestination].sort((a, b) => a[0] - b[0]).map(([cityIndex, quantity]) => ({ cityIndex, quantity, weight: quantity / total }));
  }

  const api = { decodeSnapshot, mergeSkuShard, decide, mechanismWeights };
  root.FulfillmentEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);