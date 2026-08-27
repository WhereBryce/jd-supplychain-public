"""Build an encrypted, browser-ready BBCC simulator model from the private source app."""
from __future__ import annotations
import argparse, base64, gzip, json, os, sys
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ROOT = Path(__file__).resolve().parents[1]
APP_ASSETS = Path(r"C:\Users\yao.q.1\repos\jd-supplychain-apps\apps\jd_free_goods_bbcc_cost_simulation\assets")
ITERATIONS = 600_000
DIRECT_LEADS = {"北京": 2, "上海": 2, "广州": 2, "武汉": 2, "西安": 2, "成都": 2, "沈阳": 2, "德州": 3, "杭州": 2, "南京": 2, "郑州": 4}
class BuildError(RuntimeError): pass
def b64(value: bytes) -> str: return base64.b64encode(value).decode("ascii")
def unb64(value: str) -> bytes: return base64.b64decode(value.encode("ascii"), validate=True)
def key(password: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS).derive(password.encode())
def encrypt(data: Mapping[str, Any], password: str) -> dict[str, Any]:
    plain = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    salt, iv = os.urandom(16), os.urandom(12)
    return {"version": 1, "algorithm": "AES-256-GCM", "compression": "gzip", "kdf": {"name": "PBKDF2", "hash": "SHA-256", "iterations": ITERATIONS, "salt": b64(salt)}, "iv": b64(iv), "ciphertext": b64(AESGCM(key(password, salt)).encrypt(iv, gzip.compress(plain, compresslevel=9, mtime=0), None))}
def decrypt(payload: Mapping[str, Any], password: str) -> dict[str, Any]:
    return json.loads(gzip.decompress(AESGCM(key(password, unb64(payload["kdf"]["salt"]))).decrypt(unb64(payload["iv"]), unb64(payload["ciphertext"]), None)).decode())
def atomic(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True); temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8"); temporary.replace(path)
def compact(bundle: Any) -> dict[str, Any]:
    gifts = bundle.gifts.sort_values("sku").reset_index(drop=True); sku_index = {sku: i for i, sku in enumerate(gifts.sku)}
    cities = sorted(set(bundle.demand_shares.c_city)); city_index = {city: i for i, city in enumerate(cities)}
    months = sorted(set(bundle.monthly_shipments.month)); month_index = {month: i for i, month in enumerate(months)}
    warehouses = list(bundle.warehouses); route_index = {item["route_key"]: index for index, item in enumerate(warehouses)}
    if len(warehouses) != 13: raise BuildError(f"权威B仓应为13个，实际为{len(warehouses)}")
    if len(route_index) != len(warehouses): raise BuildError("B仓始发城市重复，无法发布")
    sys.path.insert(0, str(APP_ASSETS))
    from simulation import _calendar_counts
    calendar = {name: [_calendar_counts(name)[month] for month in months] for name in ("daily", "weekly_1", "weekly_2", "weekly_3", "weekly_4", "weekly_5")}
    calendar["weekly"], calendar["twice_weekly"] = calendar["weekly_1"], calendar["weekly_2"]
    payload = {
        "format": "bbcc-model-v1", "months": months, "cities": cities,
        "gifts": [[row.sku, row.product_name, float(row.case_pack), float(row.first_item_fee), float(row.continuation_fee), float(row.whole_case_fee)] for row in gifts.itertuples(index=False)],
        "shares": [[sku_index[row.sku], city_index[row.c_city], float(row.share)] for row in bundle.demand_shares.itertuples(index=False) if row.sku in sku_index and row.c_city in city_index],
        "shipments": [[month_index[row.month], sku_index[row.sku], float(row.quantity), float(row.volume_m3), float(row.weight_kg)] for row in bundle.monthly_shipments.itertuples(index=False) if row.sku in sku_index and row.month in month_index],
        "warehouses": [[item["name"], item["route_key"], float(item["pg_to_b_lead_days"])] for item in warehouses],
        "rates": [[row.b_city, city_index[row.c_city], float(row.rate_up_to_1000), float(row.rate_over_1000), float(row.bc_lead_days)] for row in bundle.rates.itertuples(index=False) if row.b_city in route_index and row.c_city in city_index],
        # Only the authoritative 11R nodes default to PG direct; the remaining
        # HC C warehouses default to B-C even though they are valid direct cities.
        "direct_cities": [city_index[city] for city in DIRECT_LEADS if city in city_index],
        "city_to_11r": [[city_index[city], rdc] for city, rdc in (bundle.city_to_region or {}).items() if city in city_index],
        "calendar": calendar, "quality": {"gift_skus": len(gifts), "direct_cities": len(bundle.direct_cities), "rate_routes": int(len(bundle.rates)), "shipment_cache_hit": bool(bundle.data_quality.get("shipment_cache_hit"))},
    }
    return payload
def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--password-env", default="BBCC_PAGES_PASSWORD"); parser.add_argument("--self-test", action="store_true"); args = parser.parse_args()
    password = os.getenv(args.password_env, "")
    if len(password) < 8: raise BuildError(f"环境变量{args.password_env}未设置或密码少于8位")
    if not APP_ASSETS.exists(): raise BuildError(f"找不到私有BBCC数据层：{APP_ASSETS}")
    sys.path.insert(0, str(APP_ASSETS)); from data import build_bundle, DEFAULT_WAREHOUSES
    bundle = build_bundle(); data = compact(bundle); data["default_warehouses"] = [item["name"] for item in DEFAULT_WAREHOUSES]; generated = datetime.now().astimezone().isoformat(timespec="seconds")
    envelope = encrypt({"metadata": {"generated_at": generated, "format": data["format"]}, "data": data}, password)
    model_path = ROOT / "data" / "bbcc-model.enc.json"; atomic(model_path, envelope)
    status = {"version": 1, "generated_at": generated, "date_range": {"start": data["months"][0], "end": data["months"][-1]}, "counts": {"gift_skus": len(data["gifts"]), "cities": len(data["cities"]), "warehouses": len(data["warehouses"]), "rate_routes": len(data["rates"]), "months": len(data["months"])}}
    atomic(ROOT / "data" / "bbcc-status.json", status)
    if args.self_test:
        if decrypt(envelope, password) != {"metadata": {"generated_at": generated, "format": data["format"]}, "data": data}: raise BuildError("加密解密往返校验失败")
        encrypted_text = model_path.read_text(encoding="utf-8")
        probes = [str(row[0]) for row in data["gifts"]] + [str(row[1]) for row in data["gifts"]] + [str(row[0]) for row in data["warehouses"]] + list(data["cities"])
        if any(probe and probe in encrypted_text for probe in probes): raise BuildError("加密文件疑似包含明文业务数据")
    print(f"已生成加密BBCC模型：{model_path}")
    return 0
if __name__ == "__main__":
    try: raise SystemExit(main())
    except BuildError as exc: print(f"构建失败：{exc}", file=sys.stderr); raise SystemExit(2)
