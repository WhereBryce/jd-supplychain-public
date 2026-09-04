(function (root, factory) {
  const engine = factory();
  if (typeof module === "object" && module.exports) module.exports = engine;
  else root.WarehouseRatioEngine = engine;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRODUCT_FIELDS = ["sku", "name", "brand", "l1", "l2", "l3", "price"];
  const WAREHOUSE_FIELDS = [
    "dc",
    "type",
    "city",
    "rdc",
    "target62",
    "distance62",
    "second62",
    "secondDistance62",
    "boundary",
    "confidence",
    "is11",
  ];

  function decodeModel(raw) {
    if (!raw || raw.format !== "warehouse-ratio-model-v1") {
      throw new Error("仓比模型格式不受支持");
    }
    const products = raw.products.map((row, index) =>
      Object.fromEntries(PRODUCT_FIELDS.map((field, fieldIndex) => [field, row[fieldIndex]]).concat([["index", index]]))
    );
    const warehouses = raw.warehouses.map((row, index) =>
      Object.fromEntries(WAREHOUSE_FIELDS.map((field, fieldIndex) => [field, row[fieldIndex]]).concat([["index", index]]))
    );
    return {
      ...raw,
      products,
      warehouses,
      sales: raw.sales.map((row) => ({ product: row[0], warehouse: row[1], quantity: Number(row[2]) || 0 })),
    };
  }

  function productMatches(product, filters, skuSet = null) {
    if (skuSet?.size && !skuSet.has(product.sku)) return false;
    if (filters.brand && product.brand !== filters.brand) return false;
    if (filters.l1 && product.l1 !== filters.l1) return false;
    if (filters.l2 && product.l2 !== filters.l2) return false;
    if (filters.l3 && product.l3 !== filters.l3) return false;
    if (filters.price === "zero" && Number(product.price) !== 0) return false;
    if (filters.price === "nonzero" && Number(product.price) === 0) return false;
    return true;
  }

  function warehouseInScopes(warehouse, scopes) {
    if (scopes.has("all")) return true;
    return (
      (scopes.has("11rdc") && warehouse.is11) ||
      (scopes.has("direct62") && warehouse.type === "普通C仓") ||
      (scopes.has("light") && warehouse.type === "轻货仓") ||
      (scopes.has("city") && warehouse.type === "城市仓")
    );
  }

  function calculate(model, settings = {}, includeDetails = false) {
    const filters = settings.filters || {};
    const scopes = new Set(settings.scopes?.length ? settings.scopes : ["all"]);
    const excludeLight = settings.excludeLight !== false;
    const skuSet = new Set(Array.isArray(filters.skus) ? filters.skus : []);
    const modelSkuSet = new Set(model.products.map((product) => product.sku));
    const productMask = model.products.map((product) => productMatches(product, filters, skuSet));
    const sourceMask = model.warehouses.map((warehouse) => warehouseInScopes(warehouse, scopes));
    const selectedProductCount = productMask.filter(Boolean).length;
    const selectedWarehouseCount = model.warehouses.filter(
      (warehouse) => sourceMask[warehouse.index] && (!excludeLight || warehouse.type !== "轻货仓")
    ).length;

    const rdcTotals = new Map(model.rdc_order.map((rdc) => [rdc, 0]));
    const ordinary = model.warehouses.filter((warehouse) => warehouse.type === "普通C仓");
    const targetByName = new Map(ordinary.map((warehouse) => [warehouse.dc, warehouse]));
    const targetTotals = new Map(ordinary.map((warehouse) => [warehouse.dc, 0]));
    const sourceTotals = new Map();
    const details = [];
    let total = 0;
    let excludedLightSales = 0;

    for (const sale of model.sales) {
      if (!productMask[sale.product] || !sourceMask[sale.warehouse]) continue;
      const product = model.products[sale.product];
      const warehouse = model.warehouses[sale.warehouse];
      if (excludeLight && warehouse.type === "轻货仓") {
        excludedLightSales += sale.quantity;
        continue;
      }
      if (!warehouse.rdc || !warehouse.target62) {
        throw new Error(`配送中心缺少收敛关系：${warehouse.dc}`);
      }
      total += sale.quantity;
      rdcTotals.set(warehouse.rdc, (rdcTotals.get(warehouse.rdc) || 0) + sale.quantity);
      targetTotals.set(warehouse.target62, (targetTotals.get(warehouse.target62) || 0) + sale.quantity);
      sourceTotals.set(warehouse.dc, (sourceTotals.get(warehouse.dc) || 0) + sale.quantity);
      if (includeDetails) {
        details.push({
          SKU: product.sku,
          商品名称: product.name,
          品牌: product.brand,
          一级类目: product.l1,
          二级类目: product.l2,
          三级类目: product.l3,
          全国采购价: product.price,
          原配送中心: warehouse.dc,
          原仓型: warehouse.type,
          标准城市: warehouse.city,
          目标11RDC: warehouse.rdc,
          目标62仓: warehouse.target62,
          近90日收货地商品件数: sale.quantity,
        });
      }
    }

    const ratio = (value) => (total > 0 ? value / total : 0);
    const rdcRows = model.rdc_order.map((rdc) => ({
      warehouse: rdc,
      sales90: rdcTotals.get(rdc) || 0,
      ratio: ratio(rdcTotals.get(rdc) || 0),
    }));
    const c62BaseRows = [...targetTotals].map(([warehouse, sales90]) => {
      const target = targetByName.get(warehouse);
      return {
        warehouse,
        city: target?.city || warehouse,
        is11: Boolean(target?.is11),
        sales90,
        ratio: ratio(sales90),
      };
    });
    const only11Sales90 = c62BaseRows.reduce(
      (sum, row) => sum + (row.is11 ? row.sales90 : 0),
      0
    );
    const c62Rows = c62BaseRows.map((row) => ({
      ...row,
      only11Ratio: row.is11 && only11Sales90 > 0 ? row.sales90 / only11Sales90 : 0,
    })).sort((first, second) => second.ratio - first.ratio || first.warehouse.localeCompare(second.warehouse, "zh-CN"));
    const mappingRows = model.warehouses
      .filter((warehouse) => sourceMask[warehouse.index] && (!excludeLight || warehouse.type !== "轻货仓"))
      .map((warehouse) => ({
        source: warehouse.dc,
        type: warehouse.type,
        city: warehouse.city,
        rdc: warehouse.rdc,
        target62: warehouse.target62,
        distance62: warehouse.distance62,
        second62: warehouse.second62,
        secondDistance62: warehouse.secondDistance62,
        boundary: warehouse.boundary,
        confidence: warehouse.confidence,
        sales90: sourceTotals.get(warehouse.dc) || 0,
      })).sort((first, second) => second.sales90 - first.sales90 || first.source.localeCompare(second.source, "zh-CN"));

    return {
      settings: {
        filters: { ...filters },
        scopes: [...scopes],
        excludeLight,
      },
      summary: {
        selectedProductCount,
        requestedSkuCount: skuSet.size,
        availableRequestedSkuCount: [...skuSet].filter((sku) => modelSkuSet.has(sku)).length,
        missingRequestedSkus: [...skuSet].filter((sku) => !modelSkuSet.has(sku)),
        selectedWarehouseCount,
        contributingWarehouseCount: [...sourceTotals.values()].filter((value) => value > 0).length,
        totalSales90: total,
        excludedLightSales,
        only11Sales90,
        only11CoverageRatio: ratio(only11Sales90),
      },
      rdcRows,
      c62Rows,
      mappingRows,
      details,
    };
  }

  return { decodeModel, calculate, productMatches };
});
