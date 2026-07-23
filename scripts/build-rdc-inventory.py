"""Build an AES-GCM encrypted RDC inventory payload for GitHub Pages."""

from __future__ import annotations

import argparse
import base64
import getpass
import gzip
import hashlib
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(
    r"C:\Users\yao.q.1\Procter and Gamble\JD CSC Slay - Documents"
    r"\7. AI Order\Low Inventory Alert\RDC库存报告.xlsx"
)
DEFAULT_OUTPUT = REPO_ROOT / "data" / "rdc-inventory.enc.json"
DEFAULT_CATALOG_OUTPUT = REPO_ROOT / "data" / "rdc-product-catalog.enc.json"
DEFAULT_SHARD_DIRECTORY = REPO_ROOT / "data" / "rdc-inventory-shards"
DEFAULT_SEARCH_DIRECTORY = REPO_ROOT / "data" / "rdc-product-search"
ITERATIONS = 600_000
SHARD_COUNT = 64
SEARCH_SHARD_COUNT = 64
REPORT_DATE_COLUMN = "时间"
REQUIRED_COLUMNS = (
    "SKU",
    "商品名称",
    "RDC",
    "可用库存",
    "采购未到货",
    "全国采购价",
    "条形码",
)
SOURCE_COLUMNS = (REPORT_DATE_COLUMN, *REQUIRED_COLUMNS)
TEXT_COLUMNS = ("SKU", "商品名称", "RDC", "条形码")
NUMERIC_COLUMNS = (
    "可用库存",
    "采购未到货",
    "全国采购价",
)


class BuildError(RuntimeError):
    """Expected source validation or encryption error."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Encrypt the RDC inventory report for the static Pages query."
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--catalog-output",
        type=Path,
        default=DEFAULT_CATALOG_OUTPUT,
    )
    parser.add_argument(
        "--shard-directory",
        type=Path,
        default=DEFAULT_SHARD_DIRECTORY,
    )
    parser.add_argument(
        "--search-directory",
        type=Path,
        default=DEFAULT_SEARCH_DIRECTORY,
    )
    parser.add_argument(
        "--password-env",
        default="",
        help="Read the password from this environment variable (CI only).",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Decrypt the generated payload in memory and verify its content.",
    )
    return parser.parse_args()


def prompt_password(environment_name: str = "") -> str:
    if environment_name:
        password = os.getenv(environment_name, "")
        if not password:
            raise BuildError(f"环境变量 {environment_name} 未设置")
        return password

    password = getpass.getpass("设置库存查询页密码（至少 12 位）：")
    if len(password) < 12:
        raise BuildError("密码至少需要 12 位")
    confirmation = getpass.getpass("再次输入密码：")
    if password != confirmation:
        raise BuildError("两次输入的密码不一致")
    return password


def load_inventory(source: Path) -> tuple[dict[str, Any], dict[str, str]]:
    if not source.exists():
        raise BuildError(f"库存报告不存在：{source}")
    try:
        frame = pd.read_excel(
            source,
            dtype={"SKU": "string", "条形码": "string"},
            usecols=lambda column: str(column).strip() in SOURCE_COLUMNS,
        )
    except Exception as exc:
        raise BuildError(f"库存报告读取失败：{exc}") from exc

    frame.columns = [str(column).strip() for column in frame.columns]
    missing = [column for column in SOURCE_COLUMNS if column not in frame.columns]
    if missing:
        raise BuildError("库存报告缺少字段：" + "、".join(missing))

    frame = frame[list(SOURCE_COLUMNS)].copy()
    parsed_time = pd.to_datetime(frame[REPORT_DATE_COLUMN], errors="coerce")
    for column in TEXT_COLUMNS:
        frame[column] = frame[column].astype("string").fillna("").str.strip()
    frame["SKU"] = frame["SKU"].str.replace(r"\.0$", "", regex=True)
    frame["条形码"] = frame["条形码"].str.replace(r"\.0$", "", regex=True)
    for column in NUMERIC_COLUMNS:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    frame = frame[list(REQUIRED_COLUMNS)].where(pd.notna(frame), None)
    dictionary_columns = TEXT_COLUMNS
    dictionaries: dict[str, list[str]] = {}
    encoded_columns: list[list[int | float | None]] = []
    for column in REQUIRED_COLUMNS:
        if column in dictionary_columns:
            values = frame[column].fillna("").astype(str)
            codes, unique_values = pd.factorize(values, sort=True)
            dictionaries[column] = unique_values.tolist()
            encoded_columns.append(codes.tolist())
        else:
            encoded_columns.append(
                [None if pd.isna(value) else value for value in frame[column].tolist()]
            )
    rows = [list(row) for row in zip(*encoded_columns)]
    packed_data = {
        "format": "dictionary-rows-v1",
        "columns": list(REQUIRED_COLUMNS),
        "dictionaries": dictionaries,
        "rows": rows,
    }
    report_dates = parsed_time.dropna()
    metadata = {
        "report_date": (
            report_dates.max().strftime("%Y-%m-%d")
            if not report_dates.empty
            else ""
        ),
        "source_updated_at": datetime.fromtimestamp(
            source.stat().st_mtime
        ).strftime("%Y-%m-%d %H:%M"),
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    return packed_data, metadata


def derive_key(password: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(password.encode("utf-8"))


def encode_base64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def decode_base64(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def encrypt_payload(
    data: dict[str, Any],
    metadata: dict[str, str],
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
            "salt": encode_base64(salt),
        },
        "iv": encode_base64(iv),
        "ciphertext": encode_base64(ciphertext),
    }


def decrypt_payload(payload: dict[str, Any], password: str) -> dict[str, Any]:
    salt = decode_base64(payload["kdf"]["salt"])
    iv = decode_base64(payload["iv"])
    ciphertext = decode_base64(payload["ciphertext"])
    key = derive_key(password, salt, int(payload["kdf"]["iterations"]))
    plaintext = AESGCM(key).decrypt(iv, ciphertext, None)
    if payload.get("compression") == "gzip":
        plaintext = gzip.decompress(plaintext)
    return json.loads(plaintext.decode("utf-8"))


def sku_shard_index(sku: str) -> int:
    return hashlib.sha256(sku.encode("utf-8")).digest()[0] % SHARD_COUNT


def compact_shard_data(
    data: dict[str, Any], rows: list[list[int | float | None]]
) -> dict[str, Any]:
    columns = data["columns"]
    dictionaries: dict[str, list[str]] = {}
    code_maps: dict[str, dict[int, int]] = {}
    dictionary_indexes: list[tuple[int, str]] = []
    for column_index, column in enumerate(columns):
        if column not in data["dictionaries"]:
            continue
        used_codes = sorted({int(row[column_index]) for row in rows})
        code_maps[column] = {
            old_code: new_code for new_code, old_code in enumerate(used_codes)
        }
        dictionaries[column] = [
            data["dictionaries"][column][old_code] for old_code in used_codes
        ]
        dictionary_indexes.append((column_index, column))

    compact_rows = []
    for source_row in rows:
        row = list(source_row)
        for column_index, column in dictionary_indexes:
            row[column_index] = code_maps[column][int(row[column_index])]
        compact_rows.append(row)
    return {
        "format": "dictionary-rows-v1",
        "columns": list(columns),
        "dictionaries": dictionaries,
        "rows": compact_rows,
    }


def build_shard_data(data: dict[str, Any]) -> list[dict[str, Any]]:
    sku_index = data["columns"].index("SKU")
    sku_dictionary = data["dictionaries"]["SKU"]
    shard_rows: list[list[list[int | float | None]]] = [
        [] for _ in range(SHARD_COUNT)
    ]
    for row in data["rows"]:
        sku = sku_dictionary[int(row[sku_index])]
        shard_rows[sku_shard_index(sku)].append(row)
    return [compact_shard_data(data, rows) for rows in shard_rows]


def build_catalog_data(data: dict[str, Any]) -> dict[str, Any]:
    catalog_columns = ("SKU", "商品名称", "条形码")
    column_indexes = {
        column: data["columns"].index(column) for column in catalog_columns
    }
    products_by_sku: dict[str, tuple[str, str, str]] = {}
    for row in data["rows"]:
        product = tuple(
            data["dictionaries"][column][int(row[column_indexes[column]])]
            for column in catalog_columns
        )
        sku, name, barcode = product
        current = products_by_sku.get(sku)
        if current is None:
            products_by_sku[sku] = (sku, name, barcode)
        else:
            products_by_sku[sku] = (
                sku,
                current[1] or name,
                current[2] or barcode,
            )
    products = sorted(products_by_sku.values())
    dictionaries: dict[str, list[str]] = {}
    code_maps: dict[str, dict[str, int]] = {}
    for column_index, column in enumerate(catalog_columns):
        values = sorted({product[column_index] for product in products})
        dictionaries[column] = values
        code_maps[column] = {value: code for code, value in enumerate(values)}
    rows = [
        [
            code_maps[column][product[column_index]]
            for column_index, column in enumerate(catalog_columns)
        ]
        for product in products
    ]
    return {
        "format": "product-catalog-v1",
        "columns": list(catalog_columns),
        "dictionaries": dictionaries,
        "rows": rows,
    }


def search_shard_index(character: str) -> int:
    return hashlib.sha256(character.encode("utf-8")).digest()[0] % SEARCH_SHARD_COUNT


def build_search_shard_data(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    columns = catalog["columns"]
    column_indexes = {column: columns.index(column) for column in columns}
    shard_rows: list[list[list[int]]] = [[] for _ in range(SEARCH_SHARD_COUNT)]
    for row in catalog["rows"]:
        search_text = "\n".join(
            catalog["dictionaries"][column][int(row[column_indexes[column]])]
            for column in columns
        ).lower()
        shard_indexes = {
            search_shard_index(character)
            for character in search_text
            if not character.isspace()
        }
        for shard_index in shard_indexes:
            shard_rows[shard_index].append(row)
    shards = [compact_shard_data(catalog, rows) for rows in shard_rows]
    for shard in shards:
        shard["format"] = "product-catalog-v1"
    return shards


def encrypt_search_catalog(
    catalog: dict[str, Any],
    rdc_values: list[str],
    metadata: dict[str, str],
    password: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    search_shards = build_search_shard_data(catalog)
    salt = os.urandom(16)
    key = derive_key(password, salt)
    search_payloads = [
        encrypt_payload(
            shard,
            {
                **metadata,
                "search_shard_index": shard_index,
                "search_shard_count": SEARCH_SHARD_COUNT,
            },
            password,
            salt=salt,
            key=key,
        )
        for shard_index, shard in enumerate(search_shards)
    ]
    manifest = {
        "format": "product-search-manifest-v1",
        "product_count": len(catalog["rows"]),
        "search_shard_count": SEARCH_SHARD_COUNT,
        "bucket_counts": [len(shard["rows"]) for shard in search_shards],
        "rdc_values": sorted(value for value in rdc_values if value),
    }
    return encrypt_payload(manifest, metadata, password), search_payloads


def encrypt_shards(
    data: dict[str, Any], metadata: dict[str, str], password: str
) -> list[dict[str, Any]]:
    shard_data = build_shard_data(data)
    if sum(len(shard["rows"]) for shard in shard_data) != len(data["rows"]):
        raise BuildError("SKU 分片校验失败：记录数不一致")
    salt = os.urandom(16)
    key = derive_key(password, salt)
    return [
        encrypt_payload(
            shard,
            {
                **metadata,
                "shard_index": shard_index,
                "shard_count": SHARD_COUNT,
            },
            password,
            salt=salt,
            key=key,
        )
        for shard_index, shard in enumerate(shard_data)
    ]


def write_payload(output: Path, payload: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temporary.replace(output)


def write_shards(directory: Path, payloads: list[dict[str, Any]]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for shard_index, payload in enumerate(payloads):
        write_payload(directory / f"{shard_index:02d}.enc.json", payload)


def main() -> int:
    args = parse_args()
    password = prompt_password(args.password_env)
    started_at = time.perf_counter()
    print(f"正在读取并压缩库存报告：{args.source}", flush=True)
    data, metadata = load_inventory(args.source)
    print(
        f"报告处理完成：{len(data['rows']):,} 条，耗时 "
        f"{time.perf_counter() - started_at:.1f} 秒",
        flush=True,
    )
    encryption_started_at = time.perf_counter()
    print("正在加密库存数据...", flush=True)
    payload = encrypt_payload(data, metadata, password)
    catalog = build_catalog_data(data)
    catalog_payload, search_payloads = encrypt_search_catalog(
        catalog,
        data["dictionaries"]["RDC"],
        metadata,
        password,
    )
    shard_payloads = encrypt_shards(data, metadata, password)
    print(
        f"加密完成，耗时 {time.perf_counter() - encryption_started_at:.1f} 秒",
        flush=True,
    )
    if args.self_test:
        restored = decrypt_payload(payload, password)
        if restored["data"] != data or restored["metadata"] != metadata:
            raise BuildError("加密自检失败：解密内容与源数据不一致")
        restored_shard = decrypt_payload(shard_payloads[0], password)
        if restored_shard["metadata"].get("shard_count") != SHARD_COUNT:
            raise BuildError("加密自检失败：SKU 分片无法解密")
        restored_catalog = decrypt_payload(catalog_payload, password)
        if restored_catalog["data"].get("product_count") != len(catalog["rows"]):
            raise BuildError("加密自检失败：商品搜索清单无法解密")
        restored_search = decrypt_payload(search_payloads[0], password)
        if restored_search["data"].get("format") != "product-catalog-v1":
            raise BuildError("加密自检失败：商品搜索分片无法解密")
    print(f"正在写入：{args.output}", flush=True)
    write_shards(args.shard_directory, shard_payloads)
    write_shards(args.search_directory, search_payloads)
    write_payload(args.catalog_output, catalog_payload)
    write_payload(args.output, payload)
    print(f"已生成加密库存：{args.output}")
    print(f"SKU 分片：{SHARD_COUNT} 个，目录：{args.shard_directory}")
    print(f"商品搜索清单：{len(catalog['rows']):,} 个，文件：{args.catalog_output}")
    print(f"商品搜索分片：{SEARCH_SHARD_COUNT} 个，目录：{args.search_directory}")
    print(f"记录数：{len(data['rows']):,}；报告日期：{metadata['report_date'] or '未知'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as exc:
        print(f"生成失败：{exc}")
        raise SystemExit(2) from exc