"use strict";

(function exposeBbccEngine(root) {
  const EPSILON = 1e-9;
  const DEFAULT_RATES = {
    pg_to_b_transport: 1, bc_transport: .6, whole_case_outbound: .5,
    loose_first_outbound: .5, loose_continuation_outbound: .5, storage: .5, insurance: 1,
  };
  const LABELS = {
    daily: "每工作日", twice_weekly: "每周2次", weekly: "每周1次",
    weekly_1: "每周1次", weekly_2: "每周2次", weekly_3: "每周3次",
    weekly_4: "每周4次", weekly_5: "每周5次",
  };
  const number = (value, label) => {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error(`${label}必须为有限数字`);
    return result;
  };
  const sum = (rows, key) => rows.reduce((total, row) => total + number(row[key] || 0, key), 0);
  const key = (...parts) => parts.join("\u0001");
  const rateKey = (origin, city) => key(origin, city);

  function chargeableWeight(actualWeightKg, volumeM3) {
    actualWeightKg = number(actualWeightKg, "实际重量");
    volumeM3 = number(volumeM3, "体积");
    if (actualWeightKg < 0 || volumeM3 < 0) throw new Error("重量和体积不能小于0");
    return Math.max(actualWeightKg, volumeM3 * 200);
  }

  function transportFee(actualWeightKg, volumeM3, rate) {
    const chargeable = chargeableWeight(actualWeightKg, volumeM3);
    const unitRate = chargeable <= 1000 ? number(rate.low, "小公斤段报价") : number(rate.high, "大公斤段报价");
    if (unitRate < 0) throw new Error("运输报价不能小于0");
    return { fee: chargeable * unitRate, chargeable, unitRate };
  }

  function outboundFeeBreakdown(transfers) {
    const loose = [];
    let wholeCases = 0; let wholeCaseQuantity = 0; let wholeCaseFee = 0;
    for (const item of transfers || []) {
      const quantity = number(item.quantity, "SKU调拨数量");
      if (quantity <= 0) continue;
      const casePack = number(item.casePack, "箱规");
      const first = number(item.first, "首件出库费");
      const continuation = number(item.continuation, "续件出库费");
      const whole = number(item.whole, "整箱出库费");
      if (casePack <= 0 || first < 0 || continuation < 0 || whole < 0) throw new Error("箱规必须大于0，出库费不能小于0");
      const cases = Math.floor((quantity + EPSILON) / casePack);
      let looseQuantity = quantity - cases * casePack;
      if (Math.abs(looseQuantity) <= EPSILON) looseQuantity = 0;
      if (looseQuantity < 0) throw new Error("整箱拆分结果小于0");
      wholeCases += cases; wholeCaseQuantity += cases * casePack; wholeCaseFee += cases * whole;
      if (looseQuantity > 0) loose.push({ ...item, quantity: looseQuantity, first, continuation });
    }
    if (!loose.length) return { wholeCases, wholeCaseQuantity, looseQuantity: 0, wholeCaseFee, looseFirstFee: 0, looseContinuationFee: 0, total: wholeCaseFee };
    const firstItem = loose.reduce((selected, item) => (!selected || item.first > selected.first || (item.first === selected.first && String(item.sku) > String(selected.sku)) ? item : selected), null);
    const looseContinuationFee = loose.reduce((total, item) => total + (item === firstItem ? Math.max(item.quantity - 1, 0) : item.quantity) * item.continuation, 0);
    const looseFirstFee = firstItem.first;
    return {
      wholeCases, wholeCaseQuantity, looseQuantity: sum(loose, "quantity"), wholeCaseFee,
      looseFirstFee, looseContinuationFee, total: wholeCaseFee + looseFirstFee + looseContinuationFee,
    };
  }

  function chooseLowestCost(costs) {
    const choices = Object.entries(costs).filter(([, cost]) => Number.isFinite(cost) && cost >= 0);
    if (!choices.length) throw new Error("没有可用的B-C线路报价");
    choices.sort((left, right) => left[1] - right[1] || (String(left[0]) < String(right[0]) ? -1 : String(left[0]) > String(right[0]) ? 1 : 0));
    return choices[0][0];
  }

  function decodeModel(raw) {
    if (!raw || raw.format !== "bbcc-model-v1") throw new Error("BBCC加密数据格式不受支持");
    const months = raw.months || [];
    const cities = raw.cities || [];
    const gifts = (raw.gifts || []).map((row, index) => ({ index, sku: String(row[0]), name: String(row[1] || ""), casePack: number(row[2], "箱规"), first: number(row[3], "首件费"), continuation: number(row[4], "续件费"), whole: number(row[5], "整箱费") }));
    const warehouses = (raw.warehouses || []).map((row, index) => ({ index, name: String(row[0]), routeKey: String(row[1]), pgLead: number(row[2], "PG→B时效") }));
    const cityTo11r = new Map((raw.city_to_11r || []).map((row) => [cities[row[0]], String(row[1])]));
    const directCities = new Set((raw.direct_cities || []).map((index) => cities[index]));
    const shares = (raw.shares || []).map((row) => ({ sku: Number(row[0]), city: cities[row[1]], share: number(row[2], "需求占比") }));
    const shipments = (raw.shipments || []).map((row) => ({ month: months[row[0]], sku: Number(row[1]), quantity: number(row[2], "发货数量"), volume: number(row[3], "发货体积"), weight: number(row[4], "发货重量") }));
    const rates = new Map((raw.rates || []).map((row) => [rateKey(String(row[0]), cities[row[1]]), { low: number(row[2], "小公斤段报价"), high: number(row[3], "大公斤段报价"), lead: number(row[4], "B-C时效") }]));
    if (!months.length || !cities.length || !gifts.length || !warehouses.length || !shares.length || !shipments.length) throw new Error("BBCC模型缺少必要数据");
    const defaultWarehouses = (raw.default_warehouses || []).map(String);
    if (defaultWarehouses.some((name) => !warehouses.some((warehouse) => warehouse.name === name))) throw new Error("模型包含未知默认B仓");
    return { months, cities, gifts, warehouses, defaultWarehouses, cityTo11r, directCities, shares, shipments, rates, calendar: raw.calendar || {}, quality: raw.quality || {} };
  }

  function defaultSettings(model) {
    const defaults = new Set(model.defaultWarehouses || []);
    return {
      frequency: "daily", gift_value_per_unit: 3, insurance_rate: .0005,
      payable_rates: { ...DEFAULT_RATES },
      warehouses: model.warehouses.map((warehouse) => ({ name: warehouse.name, enabled: defaults.has(warehouse.name), pg_to_b_trips_per_month: 2, pg_to_b_cost_per_trip: 1000 })),
      routes: [],
    };
  }

  function validateSettings(model, supplied) {
    if (supplied !== undefined && (supplied === null || typeof supplied !== "object" || Array.isArray(supplied))) throw new Error("情景设置必须为对象");
    const input = supplied || {}; const result = defaultSettings(model);
    for (const field of ["frequency", "gift_value_per_unit", "insurance_rate"]) if (field in input) result[field] = input[field];
    if (!Object.hasOwn(LABELS, result.frequency)) throw new Error("调拨频次必须为每工作日或每周1至5次");
    result.gift_value_per_unit = number(result.gift_value_per_unit, "货值");
    result.insurance_rate = number(result.insurance_rate, "保费率");
    if (result.gift_value_per_unit < 0 || result.insurance_rate < 0 || result.insurance_rate > 1) throw new Error("货值不能小于0，保费率必须在0至100%之间");
    const submittedRates = input.payable_rates || {};
    if (typeof submittedRates !== "object" || Array.isArray(submittedRates)) throw new Error("折扣比例必须为对象");
    for (const [name, value] of Object.entries(submittedRates)) {
      if (!Object.hasOwn(DEFAULT_RATES, name)) throw new Error(`未知费用折扣比例：${name}`);
      const rate = number(value, `${name}折扣比例`);
      if (rate < 0 || rate > 1) throw new Error("折扣比例必须在0至100%之间");
      result.payable_rates[name] = rate;
    }
    const knownWarehouses = new Set(model.warehouses.map((warehouse) => warehouse.name));
    const byName = new Map(result.warehouses.map((warehouse) => [warehouse.name, warehouse]));
    if (input.warehouses !== undefined && !Array.isArray(input.warehouses)) throw new Error("B仓设置必须为数组");
    for (const item of input.warehouses || []) {
      if (!item || typeof item !== "object" || !knownWarehouses.has(item.name)) throw new Error("B仓设置包含非授权B仓");
      const target = byName.get(item.name);
      for (const field of ["enabled", "pg_to_b_trips_per_month", "pg_to_b_cost_per_trip"]) if (field in item) target[field] = item[field];
    }
    for (const warehouse of result.warehouses) {
      warehouse.enabled = Boolean(warehouse.enabled);
      warehouse.pg_to_b_trips_per_month = number(warehouse.pg_to_b_trips_per_month, `${warehouse.name}月趟数`);
      warehouse.pg_to_b_cost_per_trip = number(warehouse.pg_to_b_cost_per_trip, `${warehouse.name}单趟费用`);
      if (warehouse.pg_to_b_trips_per_month <= 0 || warehouse.pg_to_b_cost_per_trip < 0) throw new Error("宝洁→B月趟数必须大于0，单趟费用不能小于0");
    }
    if (input.routes !== undefined && !Array.isArray(input.routes)) throw new Error("C仓线路设置必须为数组");
    const cities = new Set(model.cities); result.routeSettings = new Map();
    for (const item of input.routes || []) {
      const city = String(item?.c_city || "").trim();
      if (!city || result.routeSettings.has(city)) throw new Error("C仓线路城市为空或重复");
      if (!cities.has(city)) throw new Error(`${city}不是HC直送C仓`);
      const mode = item.mode;
      if (!["direct", "bc"].includes(mode)) throw new Error(`${city}的模式必须为direct或bc`);
      const assignment = item.assignment || "auto";
      if (!["auto", "manual"].includes(assignment)) throw new Error(`${city}的B仓分配必须为auto或manual`);
      if (assignment === "manual" && !knownWarehouses.has(item.b_warehouse)) throw new Error(`${city}手工B仓不是授权B仓`);
      let directLead = item.direct_lead_days;
      if (directLead !== null && directLead !== undefined && directLead !== "") {
        directLead = number(directLead, `${city}直送时效`); if (directLead <= 0) throw new Error(`${city}直送时效必须大于0`);
      } else directLead = null;
      result.routeSettings.set(city, { mode, assignment, b_warehouse: item.b_warehouse || null, direct_lead_days: directLead });
    }
    return result;
  }

  function transferCounts(model, frequency) {
    const values = model.calendar[frequency];
    if (!Array.isArray(values) || values.length !== model.months.length || values.some((item) => !Number.isInteger(item) || item <= 0)) throw new Error("模型缺少有效调拨任务日历");
    return new Map(model.months.map((month, index) => [month, values[index]]));
  }
  function weighted(rows, value) {
    const quantity = sum(rows, "quantity");
    return quantity ? rows.reduce((total, row) => total + row.quantity * number(row[value], value), 0) / quantity : 0;
  }
  function fallback(model, city) {
    const rdc = model.cityTo11r.get(city);
    const leadDays = { "北京": 2, "上海": 2, "广州": 2, "武汉": 2, "西安": 2, "成都": 2, "沈阳": 2, "德州": 3, "杭州": 2, "南京": 2, "郑州": 4 }[rdc];
    if (!Number.isFinite(leadDays)) throw new Error(`${city}无可用B-C报价且无法收敛到具备直送时效的11R`);
    return { rdc, lead: leadDays };
  }

  function simulate(model, supplied) {
    const settings = validateSettings(model, supplied); const counts = transferCounts(model, settings.frequency);
    const giftByIndex = new Map(model.gifts.map((gift) => [gift.index, gift]));
    const shares = new Map();
    for (const row of model.shares) {
      if (!giftByIndex.has(row.sku) || !row.city || row.share < 0 || row.share > 1) throw new Error("模型包含无效需求分配");
      shares.set(row.sku, [...(shares.get(row.sku) || []), row]);
    }
    const allocations = []; const exceptions = [];
    const shipmentTotals = new Map();
    for (const shipment of model.shipments) {
      if (!giftByIndex.has(shipment.sku) || !shipment.month || shipment.quantity < 0 || shipment.volume < 0 || shipment.weight < 0) throw new Error("模型包含无效发货记录");
      shipmentTotals.set(shipment.sku, (shipmentTotals.get(shipment.sku) || 0) + shipment.quantity);
      for (const share of shares.get(shipment.sku) || []) allocations.push({ ...shipment, city: share.city, quantity: shipment.quantity * share.share, volume: shipment.volume * share.share, weight: shipment.weight * share.share });
    }
    for (const [sku, total] of shipmentTotals) {
      const allocatedShare = (shares.get(sku) || []).reduce((value, row) => value + row.share, 0);
      if (allocatedShare === 0) exceptions.push({ type: "SKU无正销量城市", key: giftByIndex.get(sku).sku, message: `未建模历史货量${total.toFixed(2)}支` });
      else if (allocatedShare < 1 - EPSILON) exceptions.push({ type: "SKU存在未映射销量", key: giftByIndex.get(sku).sku, message: `${(1 - allocatedShare).toFixed(2)}正销量未映射` });
    }
    const enabled = new Map(settings.warehouses.filter((warehouse) => warehouse.enabled).map((warehouse) => [warehouse.name, warehouse]));
    const warehouseByName = new Map(model.warehouses.map((warehouse) => [warehouse.name, warehouse]));
    const cityMonthly = new Map();
    for (const row of allocations) {
      const groupKey = key(row.city, row.month); const current = cityMonthly.get(groupKey) || { quantity: 0, volume: 0, weight: 0 };
      current.quantity += row.quantity; current.volume += row.volume; current.weight += row.weight; cityMonthly.set(groupKey, current);
    }
    const activeCities = [...new Set(allocations.map((row) => row.city))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const mappings = []; const candidates = [];
    for (const city of activeCities) {
      const override = settings.routeSettings.get(city) || {};
      const mode = override.mode || (model.directCities.has(city) ? "direct" : "bc");
      if (mode === "direct") {
        const direct = override.direct_lead_days === null || override.direct_lead_days === undefined ? fallback(model, city) : { rdc: model.cityTo11r.get(city) || null, lead: override.direct_lead_days };
        mappings.push({ c_city: city, mode, route_type: "直送", b_warehouse: null, b_city: null, assigned_rdc: direct.rdc, bc_lead_days: null, direct_lead_days: direct.lead, end_to_end_lead_days: direct.lead, lead_basis: override.direct_lead_days == null ? "11R直送时效（默认）" : "手工直送时效", annual_transport: 0 });
        continue;
      }
      const costs = {};
      for (const [warehouseName] of enabled) {
        const warehouse = warehouseByName.get(warehouseName); const rate = model.rates.get(rateKey(warehouse.routeKey, city));
        if (!rate) continue;
        let annual = 0;
        for (const month of model.months) {
          const total = cityMonthly.get(key(city, month)); if (!total) continue;
          const taskCount = counts.get(month); annual += transportFee(total.weight / taskCount, total.volume / taskCount, rate).fee * taskCount;
        }
        costs[warehouseName] = annual; candidates.push({ c_city: city, b_warehouse: warehouseName, b_city: warehouse.routeKey, annual_transport: annual, frequency: settings.frequency });
      }
      let selected = null; let reason = "";
      if (override.assignment === "manual") {
        if (!enabled.has(override.b_warehouse)) reason = "手工指定B仓未启用";
        else if (!Object.hasOwn(costs, override.b_warehouse)) reason = "手工指定B仓无B-C报价";
        else selected = override.b_warehouse;
      } else if (Object.keys(costs).length) selected = chooseLowestCost(costs); else reason = "所有启用B仓均无B-C报价";
      if (!selected) {
        const direct = fallback(model, city); exceptions.push({ type: "B-C线路回退11R代发", key: city, message: `${reason}；回退${direct.rdc}直送，不计BBCC费用。` });
        mappings.push({ c_city: city, mode, route_type: "11R回退/代发", b_warehouse: null, b_city: null, assigned_rdc: direct.rdc, bc_lead_days: null, direct_lead_days: direct.lead, end_to_end_lead_days: direct.lead, lead_basis: "11R回退直送时效", annual_transport: 0 });
      } else {
        const warehouse = warehouseByName.get(selected); const rate = model.rates.get(rateKey(warehouse.routeKey, city));
        if (!(rate.lead > 0)) throw new Error(`${warehouse.routeKey}→${city}缺少有效端到端时效`);
        mappings.push({ c_city: city, mode, route_type: "BBCC", b_warehouse: selected, b_city: warehouse.routeKey, assigned_rdc: null, bc_lead_days: rate.lead, direct_lead_days: null, end_to_end_lead_days: warehouse.pgLead + rate.lead, lead_basis: "PG→B+B-C报价时效", annual_transport: costs[selected] });
      }
    }
    const mappingByCity = new Map(mappings.map((mapping) => [mapping.c_city, mapping]));
    const routed = allocations.map((row) => ({ ...row, ...mappingByCity.get(row.city) }));
    const bbcc = routed.filter((row) => row.route_type === "BBCC"); const direct = routed.filter((row) => row.route_type === "直送"); const fallbackRows = routed.filter((row) => row.route_type === "11R回退/代发");
    const detailGroups = new Map();
    for (const row of bbcc) {
      const groupKey = key(row.month, row.b_warehouse, row.b_city, row.city); const group = detailGroups.get(groupKey) || { month: row.month, b_warehouse: row.b_warehouse, b_city: row.b_city, c_city: row.city, rows: [] };
      group.rows.push(row); detailGroups.set(groupKey, group);
    }
    const details = [];
    for (const group of detailGroups.values()) {
      const taskCount = counts.get(group.month); const quantity = sum(group.rows, "quantity"); const volume = sum(group.rows, "volume"); const weight = sum(group.rows, "weight");
      const transfers = group.rows.filter((row) => row.quantity > 0).map((row) => ({ ...giftByIndex.get(row.sku), quantity: row.quantity / taskCount }));
      const outbound = outboundFeeBreakdown(transfers); const rate = model.rates.get(rateKey(group.b_city, group.c_city)); const transport = transportFee(weight / taskCount, volume / taskCount, rate); const mapping = mappingByCity.get(group.c_city);
      details.push({ scenario: settings.frequency, scenario_label: LABELS[settings.frequency], month: group.month, b_warehouse: group.b_warehouse, b_city: group.b_city, c_city: group.c_city, task_count: taskCount, monthly_quantity: quantity, task_quantity: quantity / taskCount, task_volume_m3: volume / taskCount, task_actual_weight_kg: weight / taskCount, task_chargeable_weight_kg: transport.chargeable, weight_basis: volume / taskCount * 200 > weight / taskCount ? "体积重" : "实重", rate_band: transport.chargeable <= 1000 ? "≤1000kg" : ">1000kg", unit_rate: transport.unitRate, monthly_transport: transport.fee * taskCount, monthly_outbound: outbound.total * taskCount, task_whole_cases: outbound.wholeCases, task_whole_case_quantity: outbound.wholeCaseQuantity, task_loose_quantity: outbound.looseQuantity, task_whole_case_fee: outbound.wholeCaseFee, task_loose_first_fee: outbound.looseFirstFee, task_loose_continuation_fee: outbound.looseContinuationFee, monthly_whole_cases: outbound.wholeCases * taskCount, monthly_whole_case_quantity: outbound.wholeCaseQuantity * taskCount, monthly_loose_quantity: outbound.looseQuantity * taskCount, monthly_whole_case_fee: outbound.wholeCaseFee * taskCount, monthly_loose_first_fee: outbound.looseFirstFee * taskCount, monthly_loose_continuation_fee: outbound.looseContinuationFee * taskCount, monthly_insurance: quantity * settings.gift_value_per_unit * settings.insurance_rate, bc_lead_days: mapping.bc_lead_days, end_to_end_lead_days: mapping.end_to_end_lead_days, average_task_below_one_unit: quantity / taskCount < 1, has_fractional_sku_task: transfers.some((item) => Math.abs(item.quantity - Math.round(item.quantity)) > EPSILON) });
    }
    details.sort((left, right) => key(left.month, left.b_warehouse, left.c_city).localeCompare(key(right.month, right.b_warehouse, right.c_city), "zh-CN"));
    const capacityGroups = new Map();
    for (const row of bbcc) {
      const groupKey = key(row.month, row.b_warehouse, row.b_city); const group = capacityGroups.get(groupKey) || { month: row.month, b_warehouse: row.b_warehouse, b_city: row.b_city, quantity: 0, volume_m3: 0, weight_kg: 0 };
      group.quantity += row.quantity; group.volume_m3 += row.volume; group.weight_kg += row.weight; capacityGroups.set(groupKey, group);
    }
    const capacity_checks = [...capacityGroups.values()].map((row) => { const trips = settings.warehouses.find((warehouse) => warehouse.name === row.b_warehouse).pg_to_b_trips_per_month; return { ...row, pg_to_b_trips: trips, quantity_per_trip: row.quantity / trips, volume_m3_per_trip: row.volume_m3 / trips, weight_kg_per_trip: row.weight_kg / trips }; });
    const pg_to_b_transport = [...new Set(bbcc.map((row) => row.b_warehouse))].reduce((total, name) => total + new Set(bbcc.filter((row) => row.b_warehouse === name).map((row) => row.month)).size * settings.warehouses.find((warehouse) => warehouse.name === name).pg_to_b_trips_per_month * settings.warehouses.find((warehouse) => warehouse.name === name).pg_to_b_cost_per_trip, 0);
    const bc_transport = sum(details, "monthly_transport"); const outbound_whole_case = sum(details, "monthly_whole_case_fee"); const outbound_loose_first = sum(details, "monthly_loose_first_fee"); const outbound_loose_continuation = sum(details, "monthly_loose_continuation_fee"); const outbound = outbound_whole_case + outbound_loose_first + outbound_loose_continuation;
    const bbcc_quantity = sum(bbcc, "quantity"); const insurance = bbcc_quantity * settings.gift_value_per_unit * settings.insurance_rate; const paid = settings.payable_rates;
    const fee_breakdown = [["宝洁→B仓运输", pg_to_b_transport, paid.pg_to_b_transport], ["B仓→C仓运输", bc_transport, paid.bc_transport], ["B仓整箱出库", outbound_whole_case, paid.whole_case_outbound], ["B仓散支首件", outbound_loose_first, paid.loose_first_outbound], ["B仓散支续件", outbound_loose_continuation, paid.loose_continuation_outbound], ["B仓存储", 0, paid.storage], ["保费", insurance, paid.insurance]].map(([stage, standard_fee, payable_rate]) => ({ scenario: settings.frequency, scenario_label: LABELS[settings.frequency], stage, standard_fee, payable_rate, payable_fee: standard_fee * payable_rate }));
    const historical_quantity = sum(model.shipments, "quantity"); const modeled_quantity = sum(routed, "quantity"); const direct_quantity = sum(direct, "quantity"); const fallback_quantity = sum(fallbackRows, "quantity"); const payable_total = sum(fee_breakdown, "payable_fee");
    const summaries = [{ scenario: settings.frequency, scenario_label: LABELS[settings.frequency], pg_to_b_transport, bc_transport, outbound, storage: 0, insurance, standard_total: pg_to_b_transport + bc_transport + outbound + insurance, discounted_transport: pg_to_b_transport * paid.pg_to_b_transport + bc_transport * paid.bc_transport, discounted_outbound: outbound_whole_case * paid.whole_case_outbound + outbound_loose_first * paid.loose_first_outbound + outbound_loose_continuation * paid.loose_continuation_outbound, discounted_storage: 0, payable_total, discounted_total: payable_total, payable_cost_per_bbcc_unit: bbcc_quantity ? payable_total / bbcc_quantity : 0, discounted_cost_per_unit: bbcc_quantity ? payable_total / bbcc_quantity : 0, outbound_whole_case, outbound_loose_first, outbound_loose_continuation, historical_quantity, modeled_quantity, excluded_quantity: historical_quantity - modeled_quantity, modeled_coverage: historical_quantity ? modeled_quantity / historical_quantity : 0, bbcc_quantity, direct_quantity, fallback_quantity, bbcc_ratio: modeled_quantity ? bbcc_quantity / modeled_quantity : 0, direct_ratio: modeled_quantity ? direct_quantity / modeled_quantity : 0, fallback_ratio: modeled_quantity ? fallback_quantity / modeled_quantity : 0, active_b_count: new Set(bbcc.map((row) => row.b_warehouse)).size, transfer_tasks: sum(details, "task_count"), whole_case_ratio: bbcc_quantity ? sum(details, "monthly_whole_case_quantity") / bbcc_quantity : 0, nationwide_weighted_end_to_end_lead_days: weighted(routed, "end_to_end_lead_days"), bc_weighted_lead_days: weighted(bbcc, "bc_lead_days"), bc_end_to_end_weighted_lead_days: weighted(bbcc, "end_to_end_lead_days") }];
    const result = { summaries, fee_breakdown, route_mapping: mappings, route_candidates: candidates, route_details: details, capacity_checks, exceptions, data_quality: { ...model.quality, calendar_transfer_counts: Object.fromEntries(counts), settings } };
    assertFinite(result); return result;
  }

  function assertFinite(value) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("计算结果包含非有限数字");
    if (Array.isArray(value)) value.forEach(assertFinite);
    else if (value && typeof value === "object") Object.values(value).forEach(assertFinite);
    return value;
  }

  const api = { chargeableWeight, transportFee, outboundFeeBreakdown, chooseLowestCost, decodeModel, defaultSettings, validateSettings, simulate, assertFinite, DEFAULT_RATES };
  root.BbccEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis === "undefined" ? this : globalThis));
