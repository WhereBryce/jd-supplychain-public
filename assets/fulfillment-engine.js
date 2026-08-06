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
      firstCategory: row[4] || "",
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
      defaultRules: payload.rules.length >= 6 ? {
        ordinaryProduction: payload.rules[0],
        specialProduction: payload.rules[1],
        sameRegionDelivery: payload.rules[2],
        crossRegionDelivery: payload.rules[3],
        crossNetworkDelivery: payload.rules[4],
        specialDelivery: payload.rules[5],
      } : {
        ordinaryProduction: 150,
        specialProduction: 100,
        sameRegionDelivery: 80,
        crossRegionDelivery: 300,
        crossNetworkDelivery: 300,
        specialDelivery: 200,
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

  function isSpecial(snapshot, warehouse) {
    return new Set(["轻货仓", "城市仓"]).has(snapshot.networks[warehouse.networkIndex]);
  }

  function chargeBreakdown(snapshot, base, additional, destinationCityIndex, destinationRegionIndex, rules) {
    const special = additional.filter((warehouse) => isSpecial(snapshot, warehouse));
    const ordinaryAdditional = additional.filter((warehouse) => !isSpecial(snapshot, warehouse));
    const ordinaryRoutes = [...(isSpecial(snapshot, base) ? [] : [base]), ...ordinaryAdditional];
    const productionCents = special.length * rules.specialProduction
      + ordinaryAdditional.length * rules.ordinaryProduction;
    const specialDeliveryCents = special.length * rules.specialDelivery;
    const sameRegionDeliveryCents = ordinaryRoutes.some((warehouse) => (
      warehouse.regionIndex === destinationRegionIndex
      && warehouse.cityIndex !== destinationCityIndex
    )) ? rules.sameRegionDelivery : 0;
    const crossRegions = new Set(ordinaryRoutes
      .filter((warehouse) => warehouse.regionIndex !== destinationRegionIndex)
      .map((warehouse) => warehouse.regionIndex));
    const crossRegionDeliveryCents = crossRegions.size * rules.crossRegionDelivery;
    const crossNetworkDeliveryCents = ordinaryAdditional.some(
      (warehouse) => warehouse.networkIndex !== base.networkIndex,
    ) ? rules.crossNetworkDelivery : 0;
    const ordinaryDelivery = Math.max(
      sameRegionDeliveryCents + crossRegionDeliveryCents,
      crossNetworkDeliveryCents,
    );
    const deliveryCents = ordinaryDelivery + specialDeliveryCents;
    return {
      productionCents,
      deliveryCents,
      sameRegionDeliveryCents,
      crossRegionDeliveryCents,
      crossNetworkDeliveryCents,
      specialDeliveryCents,
      totalCents: productionCents + deliveryCents,
    };
  }

  function basePriority(snapshot, warehouse, isLocal, coverage) {
    const ordinary = snapshot.networks[warehouse.networkIndex] === "普通C仓";
    if (isLocal) return [ordinary ? 0 : 1, coverage, warehouse.id];
    let level;
    if (ordinary && coverage === 0) level = 0;
    else if (coverage === 0) level = 1;
    else if (ordinary) level = 2;
    else level = 3;
    return [level, coverage, warehouse.id];
  }

  function coverTasks(snapshot, tasks, warehouses, priorities, base, destinationCityIndex, destinationRegionIndex, rules) {
    const active = tasks.filter((task) => task.quantity > 0)
      .sort((left, right) => left.group.localeCompare(right.group) || left.skuIndex - right.skuIndex);
    if (!active.length) return [];
    const initialNeeds = active.map((task) => task.quantity);
    const candidates = warehouses.filter((warehouse) => active.some((task) => {
      const groupMatches = task.group === "all"
        || (task.group === "local" && warehouse.cityIndex === destinationCityIndex)
        || (task.group === "external" && warehouse.cityIndex !== destinationCityIndex);
      return groupMatches && stockQuantity(warehouse, task.skuIndex) > 0;
    }));
    const vectors = candidates.map((warehouse) => active.map((task, index) => {
      const groupMatches = task.group === "all"
        || (task.group === "local" && warehouse.cityIndex === destinationCityIndex)
        || (task.group === "external" && warehouse.cityIndex !== destinationCityIndex);
      return groupMatches ? Math.min(initialNeeds[index], stockQuantity(warehouse, task.skuIndex)) : 0;
    }));
    const byTask = active.map((_, taskPosition) => candidates.map((__, index) => index)
      .filter((index) => vectors[index][taskPosition] > 0));
    if (byTask.some((indexes) => !indexes.length)) return null;
    const memo = new Map();
    const allIndexes = new Set(candidates.map((_, index) => index));

    function solve(needs, available) {
      if (needs.every((value) => value === 0)) {
        const availableSet = new Set(available);
        return [...allIndexes].filter((index) => !availableSet.has(index)).sort((a, b) => a - b);
      }
      const key = `${needs.join(",")}|${available.join(",")}`;
      if (memo.has(key)) return memo.get(key);
      const availableSet = new Set(available);
      const activeTaskPositions = needs.map((value, index) => value > 0 ? index : -1).filter((index) => index >= 0);
      const target = activeTaskPositions.sort((a, b) => {
        const left = byTask[a].filter((index) => availableSet.has(index)).length;
        const right = byTask[b].filter((index) => availableSet.has(index)).length;
        return left - right || a - b;
      })[0];
      const options = byTask[target].filter((index) => availableSet.has(index));
      let best = null;
      let bestKey = null;
      for (const index of options) {
        const remaining = needs.map((need, position) => Math.max(0, need - vectors[index][position]));
        const tail = solve(remaining, available.filter((value) => value !== index));
        if (tail === null) continue;
        const selectedWarehouses = tail.map((value) => candidates[value]);
        const breakdown = chargeBreakdown(
          snapshot, base, selectedWarehouses, destinationCityIndex, destinationRegionIndex, rules,
        );
        const candidateKey = [
          selectedWarehouses.reduce((sum, warehouse) => sum + (priorities.get(warehouse.id) || 0), 0),
          breakdown.totalCents,
          selectedWarehouses.length,
          selectedWarehouses.map((warehouse) => warehouse.id).sort(),
        ];
        if (bestKey === null || compareTuples(candidateKey, bestKey) < 0) {
          best = tail;
          bestKey = candidateKey;
        }
      }
      memo.set(key, best);
      return best;
    }

    const result = solve(initialNeeds, candidates.map((_, index) => index));
    return result === null ? null : result.map((index) => candidates[index]);
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
      return {
        fulfilled: false, mode: "库存不足", geography: "无法履约", network: "无法判断",
        parcel: "无法判断", warehouseMode: "无法判断", fromCount: 0, additionalFromCount: 0,
        productionFeeCents: 0, deliveryFeeCents: 0, sameRegionDeliveryFeeCents: 0,
        crossRegionDeliveryFeeCents: 0, crossNetworkDeliveryFeeCents: 0,
        specialDeliveryFeeCents: 0, upchargeCents: 0, allocations: [], shortage,
      };
    }

    const local = candidates.filter((warehouse) => warehouse.cityIndex === destinationCityIndex);
    const nonlocal = candidates.filter((warehouse) => warehouse.cityIndex !== destinationCityIndex);
    const firstCategories = new Set(
      [...indexedDemand.keys()]
        .map((skuIndex) => String(snapshot.skus[skuIndex].firstCategory || "").trim())
        .filter(Boolean),
    );
    const categoryComplete = [...indexedDemand.keys()].every(
      (skuIndex) => String(snapshot.skus[skuIndex].firstCategory || "").trim(),
    );
    const isSingleCategory = categoryComplete && firstCategories.size === 1;
    let preferredWholePlan = null;
    if (isSingleCategory) {
      const wholeOrderCandidates = candidates.filter((warehouse) => (
        warehouse.regionIndex === destinationRegionIndex
        && [...indexedDemand].every(
          ([skuIndex, quantity]) => stockQuantity(warehouse, skuIndex) >= quantity,
        )
      ));
      const wholeOrderPlans = wholeOrderCandidates.map((base) => {
        const breakdown = chargeBreakdown(
          snapshot, base, [], destinationCityIndex, destinationRegionIndex, rules,
        );
        return {
          base,
          additional: [],
          selected: [base],
          breakdown,
          key: [candidateRanks.get(base.id), breakdown.totalCents, base.id],
        };
      });
      wholeOrderPlans.sort((left, right) => compareTuples(left.key, right.key));
      preferredWholePlan = wholeOrderPlans[0] || null;
    }
    const localTargets = new Map([...indexedDemand].map(([skuIndex, quantity]) => [
      skuIndex,
      Math.min(quantity, local.reduce((sum, warehouse) => sum + stockQuantity(warehouse, skuIndex), 0)),
    ]));
    const externalNeeds = new Map([...indexedDemand].map(([skuIndex, quantity]) => [skuIndex, quantity - localTargets.get(skuIndex)]));
    const localHasStock = [...localTargets.values()].some((quantity) => quantity > 0);
    const plans = [];

    if (!preferredWholePlan && localHasStock) {
      const bases = local.filter((warehouse) => [...indexedDemand.keys()].some((skuIndex) => stockQuantity(warehouse, skuIndex) > 0));
      for (const base of bases) {
        const tasks = [
          ...[...localTargets].map(([skuIndex, quantity]) => ({
            group: "local", skuIndex, quantity: Math.max(0, quantity - stockQuantity(base, skuIndex)),
          })),
          ...[...externalNeeds].map(([skuIndex, quantity]) => ({ group: "external", skuIndex, quantity })),
        ];
        const remainingCandidates = candidates.filter((warehouse) => warehouse.id !== base.id);
        const priorities = new Map(remainingCandidates.map(
          (warehouse) => [warehouse.id, candidateRanks.get(warehouse.id)],
        ));
        const additional = coverTasks(
          snapshot, tasks, remainingCandidates, priorities, base,
          destinationCityIndex, destinationRegionIndex, rules,
        );
        if (additional === null) continue;
        const selected = [base, ...additional];
        const breakdown = chargeBreakdown(
          snapshot, base, additional, destinationCityIndex, destinationRegionIndex, rules,
        );
        const routePriority = selected.reduce((sum, warehouse) => sum + candidateRanks.get(warehouse.id), 0);
        plans.push({
          base, additional, selected, breakdown,
          key: [
            basePriority(snapshot, base, true, candidateRanks.get(base.id)),
            routePriority, breakdown.totalCents, selected.length,
            selected.map((item) => item.id).sort(),
          ],
        });
      }
    } else if (!preferredWholePlan) {
      const bases = nonlocal.filter((warehouse) => [...indexedDemand.keys()].some(
        (skuIndex) => stockQuantity(warehouse, skuIndex) > 0,
      ));
      for (const base of bases) {
        const tasks = [...indexedDemand].map(([skuIndex, quantity]) => ({
          group: "all", skuIndex, quantity: Math.max(0, quantity - stockQuantity(base, skuIndex)),
        }));
        const remainingCandidates = nonlocal.filter((warehouse) => warehouse.id !== base.id);
        const priorities = new Map(remainingCandidates.map(
          (warehouse) => [warehouse.id, candidateRanks.get(warehouse.id)],
        ));
        const additional = coverTasks(
          snapshot, tasks, remainingCandidates, priorities, base,
          destinationCityIndex, destinationRegionIndex, rules,
        );
        if (additional === null) continue;
        const selected = [base, ...additional];
        const breakdown = chargeBreakdown(
          snapshot, base, additional, destinationCityIndex, destinationRegionIndex, rules,
        );
        const routePriority = selected.reduce((sum, warehouse) => sum + candidateRanks.get(warehouse.id), 0);
        plans.push({
          base, additional, selected, breakdown,
          key: [
            basePriority(snapshot, base, false, candidateRanks.get(base.id)),
            routePriority, breakdown.totalCents, selected.length,
            selected.map((item) => item.id).sort(),
          ],
        });
      }
    }
    if (!preferredWholePlan && !plans.length) {
      throw new Error("库存合计可满足，但未找到有效分仓方案");
    }
    plans.sort((a, b) => compareTuples(a.key, b.key));
    const plan = preferredWholePlan || plans[0];
    let allocationRows;
    if (preferredWholePlan) {
      const [wholeRows, wholeShortage] = allocate(indexedDemand, plan.selected);
      if (wholeShortage.size) throw new Error("同区整单分配失败");
      allocationRows = wholeRows;
    } else {
      const localSelected = plan.selected.filter((warehouse) => warehouse.cityIndex === destinationCityIndex);
      const externalSelected = plan.selected.filter((warehouse) => warehouse.cityIndex !== destinationCityIndex);
      const [localRows, localShortage] = allocate(localTargets, localSelected);
      const [externalRows, externalShortage] = allocate(externalNeeds, externalSelected);
      if (localShortage.size || externalShortage.size) throw new Error("分仓分配失败");
      allocationRows = [...localRows, ...externalRows];
    }
    const nodeFees = new Map(plan.selected.map((warehouse) => {
      if (warehouse.id === plan.base.id) return [warehouse.id, [0, 0]];
      if (isSpecial(snapshot, warehouse)) {
        return [warehouse.id, [rules.specialProduction, rules.specialDelivery]];
      }
      return [warehouse.id, [rules.ordinaryProduction, 0]];
    }));
    const allocations = allocationRows.map(([warehouse, skuIndex, quantity]) => ({
      fulfillmentFrom: warehouse.id,
      deliveryCenter: warehouse.deliveryCenter,
      warehouseName: warehouse.warehouseName,
      city: snapshot.cities[warehouse.cityIndex],
      region: snapshot.regions[warehouse.regionIndex],
      network: snapshot.networks[warehouse.networkIndex],
      sku: snapshot.skus[skuIndex].sku,
      quantity,
      isLocal: warehouse.cityIndex === destinationCityIndex,
      isBase: warehouse.id === plan.base.id,
      productionFeeCents: nodeFees.get(warehouse.id)[0],
      deliveryFeeCents: nodeFees.get(warehouse.id)[1],
      upchargeCents: nodeFees.get(warehouse.id)[0] + nodeFees.get(warehouse.id)[1],
    }));
    const geography = plan.selected.every((warehouse) => warehouse.cityIndex === destinationCityIndex)
      ? "本地同城发货"
      : plan.selected.every((warehouse) => warehouse.regionIndex === destinationRegionIndex)
        ? "同区跨城发货" : "跨区发货";
    const network = new Set(plan.selected.map((warehouse) => warehouse.networkIndex)).size === 1 ? "同网" : "跨网";
    const parcel = plan.selected.length === 1 ? "整单发货" : "拆单发货";
    const warehouseMode = plan.selected.length === 1 ? "同仓" : "跨仓";
    return {
      fulfilled: true, geography, network, parcel, warehouseMode,
      mode: `${geography} / ${network} / ${warehouseMode}`,
      fromCount: plan.selected.length,
      additionalFromCount: plan.additional.length,
      productionFeeCents: plan.breakdown.productionCents,
      deliveryFeeCents: plan.breakdown.deliveryCents,
      sameRegionDeliveryFeeCents: plan.breakdown.sameRegionDeliveryCents,
      crossRegionDeliveryFeeCents: plan.breakdown.crossRegionDeliveryCents,
      crossNetworkDeliveryFeeCents: plan.breakdown.crossNetworkDeliveryCents,
      specialDeliveryFeeCents: plan.breakdown.specialDeliveryCents,
      upchargeCents: plan.breakdown.totalCents,
      allocations,
      shortage: {},
    };
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