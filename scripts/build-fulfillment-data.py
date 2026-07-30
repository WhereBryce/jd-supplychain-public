"""Build encrypted fulfillment decision payloads for the static GitHub Pages app."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_ASSETS = Path(
    r"C:\Users\yao.q.1\repos\jd-supplychain-apps"
    r"\apps\jd_fulfillment_decision_tool\assets"
)
DEFAULT_OUTPUT_DIR = REPO_ROOT / "data" / "fulfillment-snapshots"
DEFAULT_STATUS_OUTPUT = REPO_ROOT / "data" / "fulfillment-status.json"
ITERATIONS = 600_000


class BuildError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build encrypted static fulfillment-analysis snapshots."
    )
    parser.add_argument("--app-assets", type=Path, default=DEFAULT_APP_ASSETS)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--status-output", type=Path, default=DEFAULT_STATUS_OUTPUT)
    parser.add_argument("--snapshot-count", type=int, default=3)
    parser.add_argument("--password-env", default="FULFILLMENT_PAGES_PASSWORD")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def encode64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def decode64(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def derive_key(password: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=ITERATIONS,
    ).derive(password.encode("utf-8"))


def encrypt(
    data: dict[str, Any],
    metadata: dict[str, Any],
    password: str,
    *,
    salt: bytes | None = None,
    key: bytes | None = None,
) -> dict[str, Any]:
    plaintext = json.dumps(
        {"metadata": metadata, "data": data},
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    compressed = gzip.compress(plaintext, compresslevel=9, mtime=0)
    salt = salt or os.urandom(16)
    iv = os.urandom(12)
    key = key or derive_key(password, salt)
    ciphertext = AESGCM(key).encrypt(iv, compressed, None)
    return {
        "version": 1,
        "algorithm": "AES-256-GCM",
        "compression": "gzip",
        "kdf": {
            "name": "PBKDF2",
            "hash": "SHA-256",
            "iterations": ITERATIONS,
            "salt": encode64(salt),
        },
        "iv": encode64(iv),
        "ciphertext": encode64(ciphertext),
    }


def decrypt(payload: Mapping[str, Any], password: str) -> dict[str, Any]:
    key = derive_key(password, decode64(payload["kdf"]["salt"]))
    plaintext = AESGCM(key).decrypt(
        decode64(payload["iv"]), decode64(payload["ciphertext"]), None
    )
    return json.loads(gzip.decompress(plaintext).decode("utf-8"))


def atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(path)


def load_app_modules(app_assets: Path) -> tuple[Any, Any]:
    if not (app_assets / "data.py").exists():
        raise BuildError(f"找不到履约工具数据层：{app_assets}")
    sys.path.insert(0, str(app_assets))
    import data as fulfillment_data
    import engine as fulfillment_engine

    return fulfillment_data, fulfillment_engine


def demand_by_source_city(
    bundle: Any,
    config: Mapping[str, Any],
    fulfillment_data: Any,
) -> dict[str, dict[str, int]]:
    frame = bundle.demand_distribution
    known_cities = set(bundle.city_to_region)
    aliases = config["delivery_center_aliases"]
    output: dict[str, dict[str, int]] = {}
    for sku, sku_rows in frame.groupby("SKU"):
        by_center = (
            sku_rows.groupby("配送中心", as_index=False)["近90日收货地商品件数"]
            .max()
        )
        by_city: dict[str, int] = defaultdict(int)
        for _, row in by_center.iterrows():
            quantity = max(0, int(float(row["近90日收货地商品件数"])))
            if quantity <= 0:
                continue
            source_city = fulfillment_data.normalize_delivery_center(
                row["配送中心"], aliases, known_cities
            )
            if not source_city:
                raise BuildError(
                    f"主品90日件数存在未识别配送中心：{row['配送中心']}"
                )
            by_city[source_city] += quantity
        if by_city:
            output[str(sku)] = dict(by_city)
    return output


def compact_bundle(
    bundle: Any,
    config: Mapping[str, Any],
    fulfillment_data: Any,
) -> dict[str, Any]:
    demand = demand_by_source_city(bundle, config, fulfillment_data)
    stock_skus = {
        sku
        for warehouse in bundle.warehouses
        for sku, quantity in warehouse.stock.items()
        if int(quantity) > 0
    }
    sku_values = sorted(stock_skus | set(demand))
    sku_indexes = {sku: index for index, sku in enumerate(sku_values)}
    cities = sorted(bundle.city_to_region)
    city_indexes = {city: index for index, city in enumerate(cities)}
    regions = sorted(set(bundle.city_to_region.values()))
    region_indexes = {region: index for index, region in enumerate(regions)}
    networks = sorted({warehouse.network for warehouse in bundle.warehouses})
    network_indexes = {network: index for index, network in enumerate(networks)}

    sku_rows = []
    for sku in sku_values:
        metadata = bundle.sku_metadata.get(sku, {})
        sku_rows.append(
            [
                sku,
                metadata.get("商品名称", ""),
                metadata.get("品牌", ""),
                metadata.get("宝洁品类", ""),
            ]
        )

    warehouse_rows = []
    for warehouse in bundle.warehouses:
        stock = sorted(
            [sku_indexes[sku], int(quantity)]
            for sku, quantity in warehouse.stock.items()
            if sku in sku_indexes and int(quantity) > 0
        )
        covered = (
            sorted(city_indexes[city] for city in warehouse.covered_cities)
            if warehouse.covered_cities is not None
            else None
        )
        warehouse_rows.append(
            [
                warehouse.fulfillment_from,
                warehouse.delivery_center,
                warehouse.warehouse_name,
                city_indexes[warehouse.city],
                region_indexes[warehouse.region],
                network_indexes[warehouse.network],
                covered,
                stock,
            ]
        )

    demand_rows = [
        [
            sku_indexes[sku],
            sorted([city_indexes[city], quantity] for city, quantity in by_city.items()),
        ]
        for sku, by_city in sorted(demand.items())
        if sku in sku_indexes
    ]
    rules = fulfillment_data.charge_rules(config)
    return {
        "format": "fulfillment-snapshot-v1",
        "cities": cities,
        "regions": regions,
        "networks": networks,
        "city_regions": [region_indexes[bundle.city_to_region[city]] for city in cities],
        "city_mapping": [city_indexes[bundle.city_mapping[city]] for city in cities],
        "rules": [
            rules.local_extra_same_network,
            rules.same_region_other_city_same_network,
            rules.cross_region,
            rules.cross_network,
        ],
        "skus": sku_rows,
        "warehouses": warehouse_rows,
        "demand": demand_rows,
    }


def main() -> int:
    args = parse_args()
    if not 1 <= args.snapshot_count <= 10:
        raise BuildError("snapshot-count必须在1到10之间")
    password = os.getenv(args.password_env, "")
    if len(password) < 8:
        raise BuildError(f"环境变量{args.password_env}未设置或密码少于8位")

    fulfillment_data, _ = load_app_modules(args.app_assets)
    config = fulfillment_data.load_config()
    snapshots = fulfillment_data.list_snapshots(Path(config["data_dir"]))
    selected = list(reversed(snapshots[-args.snapshot_count :]))
    if not selected:
        raise BuildError("没有可发布的库存切片")

    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    common_salt = os.urandom(16)
    common_key = derive_key(password, common_salt)
    status_rows = []
    expected_names: set[str] = set()
    for snapshot in selected:
        print(f"读取并压缩 {snapshot.name}", flush=True)
        bundle = fulfillment_data.build_bundle(config, snapshot.name)
        data = compact_bundle(bundle, config, fulfillment_data)
        metadata = {
            "snapshot_date": bundle.snapshot_date,
            "generated_at": generated_at,
            "warehouse_count": len(bundle.warehouses),
            "network_counts": dict(Counter(warehouse.network for warehouse in bundle.warehouses)),
            "city_count": len(bundle.city_to_region),
            "sku_count": len(data["skus"]),
        }
        payload = encrypt(
            data,
            metadata,
            password,
            salt=common_salt,
            key=common_key,
        )
        output_name = f"{bundle.snapshot_date}.enc.json"
        output_path = args.output_dir / output_name
        atomic_json(output_path, payload)
        expected_names.add(output_name)
        if args.self_test:
            restored = decrypt(payload, password)
            if (
                restored["data"].get("format") != "fulfillment-snapshot-v1"
                or restored["metadata"].get("snapshot_date") != bundle.snapshot_date
            ):
                raise BuildError(f"加密自检失败：{bundle.snapshot_date}")
        status_rows.append(
            {
                "date": bundle.snapshot_date,
                "file": output_name,
                "size": output_path.stat().st_size,
                "warehouse_count": len(bundle.warehouses),
                "city_count": len(bundle.city_to_region),
                "sku_count": len(data["skus"]),
            }
        )
        print(
            f"  {output_path.name}: {output_path.stat().st_size / 1024 / 1024:.2f} MB, "
            f"SKU={len(data['skus']):,}",
            flush=True,
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    for stale in args.output_dir.glob("*.enc.json"):
        if stale.name not in expected_names:
            stale.unlink()
    atomic_json(
        args.status_output,
        {
            "version": 1,
            "generated_at": generated_at,
            "snapshots": status_rows,
        },
    )
    print(f"已生成{len(status_rows)}个加密履约切片：{args.output_dir}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as exc:
        print(f"构建失败：{exc}", file=sys.stderr)
        raise SystemExit(2) from exc