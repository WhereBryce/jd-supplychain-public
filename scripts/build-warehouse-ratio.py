"""Build the encrypted warehouse-ratio query model for GitHub Pages."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import math
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from pyecharts.datasets import COORDINATES


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_DIR = Path(
    r"C:\Users\yao.q.1\Procter and Gamble\JD PS 铁军 - Documents"
    r"\17 SND\18. 代发治理\拆单或代发判断数据基础"
)
DEFAULT_INVENTORY_DIR = DEFAULT_SOURCE_DIR / "JD库存大表"
DEFAULT_DIRECT = DEFAULT_SOURCE_DIR / "宝洁直送明细.xlsx"
DEFAULT_MAPPING_DIR = (
    Path(r"C:\Users\yao.q.1\repos\jd-supplychain-apps")
    / "apps"
    / "jd_11rdc_dc_mapping"
    / "output"
)
DEFAULT_CACHE_DIR = (
    Path(os.getenv("LOCALAPPDATA", str(Path.home())))
    / "JD-SupplyChain"
    / "warehouse-ratio-cache"
)
DEFAULT_OUTPUT = ROOT / "data" / "warehouse-ratio-model.enc.json"
DEFAULT_STATUS = ROOT / "data" / "warehouse-ratio-status.json"

ITERATIONS = 600_000
RDC_ORDER = (
    "北京",
    "上海",
    "广州",
    "杭州",
    "南京",
    "郑州",
    "德州",
    "成都",
    "西安",
    "沈阳",
    "武汉",
)
REQUIRED_INVENTORY_COLUMNS = (
    "SKU",
    "商品名称",
    "品牌",
    "一级类目",
    "二级类目",
    "三级类目",
    "全国采购价",
    "RDC",
    "配送中心",
    "近90日收货地商品件数",
)
REQUIRED_DIRECT_COLUMNS = (
    "库存大表-配送中心",
    "城市",
    "仓型",
)
DIRECT_TYPES = ("普通C仓", "城市仓", "轻货仓")
BOUNDARY_MARGIN_KM = 150.0
BOUNDARY_DISTANCE_RATIO = 0.80

DELIVERY_CENTER_ALIASES = {
    "上海FDC": "上海",
    "上海零售": "上海",
    "上海定制": "上海",
    "北京北": "北京",
    "北京城市": "北京",
    "北京城市仓": "北京",
    "北京大商超": "北京",
    "北京定制": "北京",
    "广州城市": "广州",
    "广州城市仓": "广州",
    "广州大商超": "广州",
    "广州定制": "广州",
    "佛山城市": "佛山",
    "成都大商超": "成都",
    "成都服装": "成都",
    "武汉大商超": "武汉",
    "武汉服装": "武汉",
    "沈阳大商超": "沈阳",
    "西安大商超": "西安",
    "西安服装": "西安",
    "徐州FDC": "徐州",
    "徐州FDC配送中心": "徐州",
    "南通本地仓中心": "南通",
    "常州本地仓中心": "常州",
    "绵阳本地仓中心": "绵阳",
    "临沂配送中心": "临沂",
    "邢台配送中心": "邢台",
    "喀什配送中心": "喀什",
}
MANUAL_COORDINATES = {
    "佛山": [113.1227, 23.0288],
    "林芝": [94.3615, 29.6489],
}


class BuildError(RuntimeError):
    """The private source data cannot be safely converted."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build encrypted JD 11RDC/62C warehouse-ratio query data."
    )
    parser.add_argument("--inventory-dir", type=Path, default=DEFAULT_INVENTORY_DIR)
    parser.add_argument("--direct", type=Path, default=DEFAULT_DIRECT)
    parser.add_argument("--mapping-dir", type=Path, default=DEFAULT_MAPPING_DIR)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--status-output", type=Path, default=DEFAULT_STATUS)
    parser.add_argument("--password-env", default="WAREHOUSE_RATIO_PAGES_PASSWORD")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def clean_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    return (
        str(value)
        .replace("\u3000", " ")
        .replace("\xa0", " ")
        .strip()
    )


def clean_sku(value: Any) -> str:
    text = clean_text(value)
    return re.sub(r"\.0$", "", text)


def snapshot_date(path: Path) -> str:
    matched = re.search(r"(20\d{6})", path.name)
    return matched.group(1) if matched else ""


def dated_files(directory: Path, pattern: str) -> list[Path]:
    if not directory.exists():
        raise BuildError(f"目录不存在：{directory}")
    files = [
        path
        for path in directory.glob(pattern)
        if path.is_file() and not path.name.startswith("~$")
    ]
    return sorted(
        files,
        key=lambda path: (snapshot_date(path), path.stat().st_mtime_ns, path.name),
        reverse=True,
    )


def copy_with_retries(source: Path, destination: Path, attempts: int = 3) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            shutil.copy2(source, temporary)
            temporary.replace(destination)
            return
        except (OSError, PermissionError) as exc:
            last_error = exc
            temporary.unlink(missing_ok=True)
            if attempt + 1 < attempts:
                time.sleep(0.5)
    raise BuildError(f"文件暂不可读取：{source.name}") from last_error


def stage_inventory(
    inventory_dir: Path, cache_dir: Path
) -> tuple[Path, Path, bool, str]:
    candidates = dated_files(inventory_dir, "下沉用-*.xlsx")
    if not candidates:
        raise BuildError(f"未找到库存切片：{inventory_dir}")
    latest = candidates[0]
    latest_date = snapshot_date(latest)
    cached_latest = cache_dir / "inventory" / latest.name
    try:
        copy_with_retries(latest, cached_latest)
        return cached_latest, latest, False, ""
    except BuildError:
        cached = dated_files(cache_dir / "inventory", "下沉用-*.xlsx") if (
            cache_dir / "inventory"
        ).exists() else []
        if cached:
            used = cached[0]
        else:
            used = None
            for candidate in candidates[1:]:
                destination = cache_dir / "inventory" / candidate.name
                try:
                    copy_with_retries(candidate, destination)
                    used = destination
                    break
                except BuildError:
                    continue
            if used is None:
                raise BuildError("最新库存切片被占用，且没有可用历史缓存")
        used_date = snapshot_date(used)
        warning = (
            f"最新文件暂不可读取，当前使用 {format_date(used_date)} 切片"
        )
        return used, latest, True, warning


def stage_reference(
    source: Path, cache_dir: Path, cache_name: str
) -> tuple[Path, bool, str]:
    if not source.exists():
        raise BuildError(f"文件不存在：{source}")
    destination = cache_dir / "references" / cache_name
    try:
        copy_with_retries(source, destination)
        return destination, False, ""
    except BuildError:
        if destination.exists():
            return destination, True, f"{source.name}暂不可读取，当前使用成功缓存"
        raise


def find_latest_mapping(mapping_dir: Path) -> Path:
    candidates = dated_files(mapping_dir, "JD_11RDC配送中心映射_*.csv")
    if not candidates:
        raise BuildError(f"未找到11RDC映射：{mapping_dir}")
    return candidates[0]


def format_date(value: str) -> str:
    if len(value) == 8:
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value


def read_inventory(path: Path) -> pd.DataFrame:
    try:
        frame = pd.read_excel(
            path,
            engine="calamine",
            usecols=lambda column: clean_text(column) in REQUIRED_INVENTORY_COLUMNS,
        )
    except Exception as exc:
        raise BuildError(f"库存切片读取失败：{exc}") from exc
    frame.columns = [clean_text(column) for column in frame.columns]
    missing = [
        column for column in REQUIRED_INVENTORY_COLUMNS if column not in frame.columns
    ]
    if missing:
        raise BuildError("库存切片缺少字段：" + "、".join(missing))
    frame = frame[list(REQUIRED_INVENTORY_COLUMNS)].copy()
    for column in (
        "商品名称",
        "品牌",
        "一级类目",
        "二级类目",
        "三级类目",
        "RDC",
        "配送中心",
    ):
        frame[column] = frame[column].map(clean_text)
    frame["SKU"] = frame["SKU"].map(clean_sku)
    frame["全国采购价"] = pd.to_numeric(
        frame["全国采购价"], errors="coerce"
    )
    frame["近90日收货地商品件数"] = (
        pd.to_numeric(frame["近90日收货地商品件数"], errors="coerce")
        .fillna(0)
        .clip(lower=0)
    )
    frame = frame[frame["SKU"].ne("") & frame["配送中心"].ne("")].copy()
    return frame


def read_direct(path: Path) -> tuple[pd.DataFrame, dict[str, dict[str, str]]]:
    try:
        frame = pd.read_excel(
            path,
            sheet_name="直送明细",
            engine="calamine",
            dtype=str,
        )
    except Exception as exc:
        raise BuildError(f"宝洁直送明细读取失败：{exc}") from exc
    frame.columns = [clean_text(column) for column in frame.columns]
    missing = [column for column in REQUIRED_DIRECT_COLUMNS if column not in frame]
    if missing:
        raise BuildError("宝洁直送明细缺少字段：" + "、".join(missing))
    for column in REQUIRED_DIRECT_COLUMNS:
        frame[column] = frame[column].map(clean_text)
    frame = frame[
        frame["仓型"].isin(DIRECT_TYPES)
        & frame["库存大表-配送中心"].ne("")
        & frame["城市"].ne("")
    ].copy()

    direct_by_dc: dict[str, dict[str, str]] = {}
    for dc, group in frame.groupby("库存大表-配送中心", sort=True):
        types = sorted(set(group["仓型"]))
        cities = sorted(set(group["城市"]))
        if len(types) != 1 or len(cities) != 1:
            raise BuildError(f"直送配送中心仓型或城市冲突：{dc}")
        direct_by_dc[dc] = {"type": types[0], "city": cities[0]}
    ordinary = [
        dc for dc, item in direct_by_dc.items() if item["type"] == "普通C仓"
    ]
    if len(ordinary) != 62:
        raise BuildError(f"普通C仓应为62个配送中心，实际为{len(ordinary)}个")
    return frame, direct_by_dc


def read_mapping(path: Path) -> dict[str, dict[str, str]]:
    try:
        frame = pd.read_csv(path, encoding="utf-8-sig", dtype=str).fillna("")
    except Exception as exc:
        raise BuildError(f"11RDC映射读取失败：{exc}") from exc
    required = {"配送中心原名", "标准城市", "11RDC", "证据类型", "置信度"}
    missing = required - set(frame.columns)
    if missing:
        raise BuildError("11RDC映射缺少字段：" + "、".join(sorted(missing)))
    output: dict[str, dict[str, str]] = {}
    for row in frame.to_dict(orient="records"):
        dc = clean_text(row["配送中心原名"])
        if not dc:
            continue
        output[dc] = {
            "city": clean_text(row["标准城市"]),
            "rdc": clean_text(row["11RDC"]),
            "evidence": clean_text(row["证据类型"]),
            "confidence": clean_text(row["置信度"]),
        }
    return output


def coordinates(city: str) -> list[float] | None:
    for candidate in (city, city.removesuffix("市")):
        if candidate in MANUAL_COORDINATES:
            return MANUAL_COORDINATES[candidate]
        value = COORDINATES.get(candidate)
        if value:
            return list(value)
    return None


def haversine_km(first: Iterable[float], second: Iterable[float]) -> float:
    lon1, lat1 = map(math.radians, first)
    lon2, lat2 = map(math.radians, second)
    delta_lon = lon2 - lon1
    delta_lat = lat2 - lat1
    value = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    return 6371.0088 * 2 * math.asin(math.sqrt(value))


def normalize_city(dc: str) -> str:
    if dc in DELIVERY_CENTER_ALIASES:
        return DELIVERY_CENTER_ALIASES[dc]
    value = dc
    for suffix in ("FDC配送中心", "本地仓中心", "配送中心", "城市仓"):
        if value.endswith(suffix):
            value = value[: -len(suffix)]
            break
    return DELIVERY_CENTER_ALIASES.get(value, value)


def dominant_rdc(frame: pd.DataFrame) -> dict[str, str]:
    relevant = frame[
        frame["配送中心"].ne("全国") & frame["RDC"].isin(RDC_ORDER)
    ][["配送中心", "RDC", "SKU"]].drop_duplicates()
    counts = (
        relevant.groupby(["配送中心", "RDC"])["SKU"]
        .nunique()
        .reset_index(name="sku_count")
        .sort_values(
            ["配送中心", "sku_count", "RDC"],
            ascending=[True, False, True],
            kind="stable",
        )
    )
    return dict(
        counts.drop_duplicates("配送中心")[["配送中心", "RDC"]].itertuples(
            index=False, name=None
        )
    )


def choose_products(
    frame: pd.DataFrame,
) -> tuple[list[list[Any]], dict[str, int], dict[str, Any]]:
    work = frame.copy()
    work["_row"] = range(len(work))
    work["_national"] = work["配送中心"].eq("全国").astype(int)
    priced = work[work["全国采购价"].notna()].sort_values(
        ["SKU", "_national", "_row"], kind="stable"
    )
    chosen = priced.drop_duplicates("SKU", keep="last").sort_values("SKU")
    all_skus = set(work["SKU"])
    valid_skus = set(chosen["SKU"])
    conflicts = (
        priced.groupby("SKU")["全国采购价"].nunique().gt(1)
    )
    products = [
        [
            row.SKU,
            row.商品名称,
            row.品牌,
            row.一级类目,
            row.二级类目,
            row.三级类目,
            float(row.全国采购价),
        ]
        for row in chosen.itertuples(index=False)
    ]
    product_index = {row[0]: index for index, row in enumerate(products)}
    quality = {
        "source_skus": len(all_skus),
        "included_skus": len(valid_skus),
        "blank_price_skus": len(all_skus - valid_skus),
        "price_conflict_skus": int(conflicts.sum()),
    }
    return products, product_index, quality


def nearest_targets(
    city: str, ordinary_by_city: dict[str, str]
) -> list[tuple[float, str, str]]:
    origin = coordinates(city)
    if not origin:
        return []
    ranked = []
    for target_city, target_dc in ordinary_by_city.items():
        target = coordinates(target_city)
        if target:
            ranked.append((haversine_km(origin, target), target_dc, target_city))
    return sorted(ranked, key=lambda item: (item[0], item[1]))


def build_model(
    inventory_path: Path,
    detected_inventory: Path,
    direct_path: Path,
    mapping_path: Path,
    fallback_warning: str,
    reference_warnings: list[str],
) -> tuple[dict[str, Any], dict[str, Any]]:
    frame = read_inventory(inventory_path)
    _, direct_by_dc = read_direct(direct_path)
    mapping_by_dc = read_mapping(mapping_path)
    products, product_index, product_quality = choose_products(frame)
    valid_skus = set(product_index)

    sales = frame[
        frame["配送中心"].ne("全国") & frame["SKU"].isin(valid_skus)
    ][["SKU", "配送中心", "近90日收货地商品件数"]]
    sales = (
        sales.groupby(["SKU", "配送中心"], as_index=False)[
            "近90日收货地商品件数"
        ]
        .max()
    )
    sales = sales[sales["近90日收货地商品件数"].gt(0)].copy()
    source_sales = dict(
        sales.groupby("配送中心")["近90日收货地商品件数"].sum()
    )
    all_dcs = sorted(
        set(frame.loc[frame["配送中心"].ne("全国"), "配送中心"])
    )

    ordinary_by_city: dict[str, str] = {}
    for dc, item in direct_by_dc.items():
        if item["type"] != "普通C仓":
            continue
        city = item["city"]
        if city in ordinary_by_city and ordinary_by_city[city] != dc:
            raise BuildError(f"同一城市存在多个普通C仓配送中心：{city}")
        ordinary_by_city[city] = dc
    if len(ordinary_by_city) != 62:
        raise BuildError(f"普通C仓城市应为62个，实际为{len(ordinary_by_city)}个")

    fallback_rdc = dominant_rdc(frame)
    warehouses: list[list[Any]] = []
    unmapped_zero_sales: list[str] = []
    for dc in all_dcs:
        direct = direct_by_dc.get(dc)
        mapped = mapping_by_dc.get(dc, {})
        city = (
            direct["city"]
            if direct
            else mapped.get("city") or normalize_city(dc)
        )
        warehouse_type = direct["type"] if direct else "其他"
        ranked = nearest_targets(city, ordinary_by_city)
        if direct and warehouse_type == "普通C仓":
            target62 = dc
            ranked = [
                item for item in ranked if item[1] == dc
            ] + [item for item in ranked if item[1] != dc]
        if not ranked:
            if source_sales.get(dc, 0) > 0:
                raise BuildError(f"正销量配送中心缺少城市坐标或62仓映射：{dc} -> {city}")
            target62 = ""
            nearest_distance = None
            second_target = ""
            second_distance = None
            boundary = False
            unmapped_zero_sales.append(dc)
        else:
            nearest_distance, nearest_target, _ = ranked[0]
            target62 = target62 if (
                direct and warehouse_type == "普通C仓"
            ) else nearest_target
            selected = next(
                (item for item in ranked if item[1] == target62), ranked[0]
            )
            nearest_distance = selected[0]
            alternatives = [item for item in ranked if item[1] != target62]
            second_distance, second_target, _ = (
                alternatives[0] if alternatives else (None, "", "")
            )
            margin = (
                second_distance - nearest_distance
                if second_distance is not None
                else float("inf")
            )
            ratio = (
                nearest_distance / second_distance
                if second_distance not in (None, 0)
                else 0
            )
            boundary = (
                margin < BOUNDARY_MARGIN_KM
                or ratio > BOUNDARY_DISTANCE_RATIO
            )

        rdc = mapped.get("rdc") or fallback_rdc.get(dc, "")
        if not rdc and target62:
            rdc = (
                mapping_by_dc.get(target62, {}).get("rdc")
                or fallback_rdc.get(target62, "")
            )
        if source_sales.get(dc, 0) > 0 and rdc not in RDC_ORDER:
            raise BuildError(f"正销量配送中心缺少11RDC映射：{dc}")
        confidence = mapped.get("confidence") or (
            "高" if direct or dc in fallback_rdc else ""
        )
        is_11rdc = warehouse_type == "普通C仓" and city in RDC_ORDER
        warehouses.append(
            [
                dc,
                warehouse_type,
                city,
                rdc,
                target62,
                round(nearest_distance, 1)
                if nearest_distance is not None
                else None,
                second_target,
                round(second_distance, 1)
                if second_distance is not None
                else None,
                boundary,
                confidence,
                is_11rdc,
            ]
        )

    warehouse_index = {row[0]: index for index, row in enumerate(warehouses)}
    sales_rows = [
        [
            product_index[row.SKU],
            warehouse_index[row.配送中心],
            float(row.近90日收货地商品件数),
        ]
        for row in sales.itertuples(index=False)
    ]
    used_date = snapshot_date(inventory_path)
    latest_date = snapshot_date(detected_inventory)
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    warnings = [value for value in [fallback_warning, *reference_warnings] if value]
    model = {
        "format": "warehouse-ratio-model-v1",
        "rdc_order": list(RDC_ORDER),
        "products": products,
        "warehouses": warehouses,
        "sales": sales_rows,
        "quality": {
            **product_quality,
            "inventory_rows": len(frame),
            "sales_records": len(sales_rows),
            "delivery_centers": len(warehouses),
            "ordinary_c_centers": sum(row[1] == "普通C仓" for row in warehouses),
            "city_centers": sum(row[1] == "城市仓" for row in warehouses),
            "light_centers": sum(row[1] == "轻货仓" for row in warehouses),
            "other_centers": sum(row[1] == "其他" for row in warehouses),
            "unmapped_zero_sales_centers": unmapped_zero_sales,
            "included_sales90": float(sales["近90日收货地商品件数"].sum()),
        },
    }
    metadata = {
        "snapshot_date": format_date(used_date),
        "latest_detected_date": format_date(latest_date),
        "source_updated_at": datetime.fromtimestamp(
            detected_inventory.stat().st_mtime
        ).astimezone().isoformat(timespec="seconds"),
        "generated_at": generated_at,
        "fallback_active": bool(warnings),
        "warning": "；".join(warnings),
        "mapping_file": mapping_path.name,
    }
    status = {
        "version": 1,
        **metadata,
        "counts": {
            "products": len(products),
            "delivery_centers": len(warehouses),
            "ordinary_c_centers": model["quality"]["ordinary_c_centers"],
            "sales_records": len(sales_rows),
        },
    }
    return {"metadata": metadata, "data": model}, status


def derive_key(password: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=ITERATIONS,
    ).derive(password.encode("utf-8"))


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def unb64(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def encrypt(value: dict[str, Any], password: str) -> dict[str, Any]:
    plaintext = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    salt = os.urandom(16)
    iv = os.urandom(12)
    ciphertext = AESGCM(derive_key(password, salt)).encrypt(
        iv, gzip.compress(plaintext, compresslevel=9, mtime=0), None
    )
    return {
        "version": 1,
        "algorithm": "AES-256-GCM",
        "compression": "gzip",
        "kdf": {
            "name": "PBKDF2",
            "hash": "SHA-256",
            "iterations": ITERATIONS,
            "salt": b64(salt),
        },
        "iv": b64(iv),
        "ciphertext": b64(ciphertext),
    }


def decrypt(value: dict[str, Any], password: str) -> dict[str, Any]:
    compressed = AESGCM(
        derive_key(password, unb64(value["kdf"]["salt"]))
    ).decrypt(unb64(value["iv"]), unb64(value["ciphertext"]), None)
    return json.loads(gzip.decompress(compressed).decode("utf-8"))


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    temporary.replace(path)


def main() -> int:
    args = parse_args()
    password = os.getenv(args.password_env, "")
    if len(password) < 12:
        raise BuildError(f"环境变量{args.password_env}未设置或密码少于12位")

    inventory_path, detected_inventory, fallback, inventory_warning = (
        stage_inventory(args.inventory_dir, args.cache_dir)
    )
    direct_path, direct_fallback, direct_warning = stage_reference(
        args.direct, args.cache_dir, "宝洁直送明细.xlsx"
    )
    mapping_source = find_latest_mapping(args.mapping_dir)
    mapping_path, mapping_fallback, mapping_warning = stage_reference(
        mapping_source, args.cache_dir, mapping_source.name
    )
    payload, status = build_model(
        inventory_path,
        detected_inventory,
        direct_path,
        mapping_path,
        inventory_warning if fallback else "",
        [
            direct_warning if direct_fallback else "",
            mapping_warning if mapping_fallback else "",
        ],
    )
    envelope = encrypt(payload, password)
    atomic_json(args.output, envelope)
    atomic_json(args.status_output, status)

    if args.self_test:
        if decrypt(envelope, password) != payload:
            raise BuildError("加密解密往返校验失败")
        model = payload["data"]
        if len(model["rdc_order"]) != 11:
            raise BuildError("11RDC数量校验失败")
        if sum(row[1] == "普通C仓" for row in model["warehouses"]) != 62:
            raise BuildError("62仓数量校验失败")
        encrypted_text = args.output.read_text(encoding="utf-8")
        probes = [
            model["products"][0][0] if model["products"] else "",
            model["products"][0][1] if model["products"] else "",
            model["warehouses"][0][0] if model["warehouses"] else "",
        ]
        if any(probe and probe in encrypted_text for probe in probes):
            raise BuildError("加密文件疑似包含明文业务数据")

    print(
        "已生成仓比加密模型："
        f"{args.output}，切片 {status['snapshot_date']}，"
        f"SKU {status['counts']['products']:,}，"
        f"销量记录 {status['counts']['sales_records']:,}"
    )
    if status["warning"]:
        print(f"提示：{status['warning']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as exc:
        print(f"构建失败：{exc}", file=os.sys.stderr)
        raise SystemExit(2)
