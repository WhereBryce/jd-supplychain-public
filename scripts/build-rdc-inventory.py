"""Build an AES-GCM encrypted RDC inventory payload for GitHub Pages."""

from __future__ import annotations

import argparse
import base64
import getpass
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
ITERATIONS = 600_000
REQUIRED_COLUMNS = (
    "时间",
    "RDC",
    "SKU",
    "商品名称",
    "品牌",
    "可用库存",
    "可订购库存",
    "采购未到货",
    "28日有货天数",
    "近7日出库商品件数",
)
TEXT_COLUMNS = ("RDC", "SKU", "商品名称", "品牌")
NUMERIC_COLUMNS = (
    "可用库存",
    "可订购库存",
    "采购未到货",
    "28日有货天数",
    "近7日出库商品件数",
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
            dtype={"SKU": "string"},
            usecols=lambda column: str(column).strip() in REQUIRED_COLUMNS,
        )
    except Exception as exc:
        raise BuildError(f"库存报告读取失败：{exc}") from exc

    frame.columns = [str(column).strip() for column in frame.columns]
    missing = [column for column in REQUIRED_COLUMNS if column not in frame.columns]
    if missing:
        raise BuildError("库存报告缺少字段：" + "、".join(missing))

    frame = frame[list(REQUIRED_COLUMNS)].copy()
    parsed_time = pd.to_datetime(frame["时间"], errors="coerce")
    original_time = frame["时间"].astype("string").fillna("").str.strip()
    frame["时间"] = parsed_time.dt.strftime("%Y-%m-%d").where(
        parsed_time.notna(), original_time
    )
    for column in TEXT_COLUMNS:
        frame[column] = frame[column].astype("string").fillna("").str.strip()
    frame["SKU"] = frame["SKU"].str.replace(r"\.0$", "", regex=True)
    for column in NUMERIC_COLUMNS:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    frame = frame.where(pd.notna(frame), None)
    dictionary_columns = ("时间", *TEXT_COLUMNS)
    dictionaries: dict[str, list[str]] = {}
    encoded_columns: list[list[int | float | None]] = []
    for column in REQUIRED_COLUMNS:
        if column in dictionary_columns:
            values = frame[column].fillna("").astype(str)
            codes, unique_values = pd.factorize(values, sort=True)
            dictionaries[column] = unique_values.tolist()
            encoded_columns.append(codes.tolist())
        else:
            encoded_columns.append(frame[column].tolist())
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


def encrypt_payload(data: dict[str, Any], metadata: dict[str, str], password: str) -> dict[str, Any]:
    plaintext = json.dumps(
        {"metadata": metadata, "data": data},
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = derive_key(password, salt)
    ciphertext = AESGCM(key).encrypt(iv, plaintext, None)
    return {
        "version": 1,
        "algorithm": "AES-256-GCM",
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
    return json.loads(plaintext.decode("utf-8"))


def write_payload(output: Path, payload: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temporary.replace(output)


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
    print(
        f"加密完成，耗时 {time.perf_counter() - encryption_started_at:.1f} 秒",
        flush=True,
    )
    if args.self_test:
        restored = decrypt_payload(payload, password)
        if restored["data"] != data or restored["metadata"] != metadata:
            raise BuildError("加密自检失败：解密内容与源数据不一致")
    print(f"正在写入：{args.output}", flush=True)
    write_payload(args.output, payload)
    print(f"已生成加密库存：{args.output}")
    print(f"记录数：{len(data['rows']):,}；报告日期：{metadata['report_date'] or '未知'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as exc:
        print(f"生成失败：{exc}")
        raise SystemExit(2) from exc