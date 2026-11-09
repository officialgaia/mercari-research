"""GitHub Actions から毎日／手動で実行される取得スクリプト。

  DATA_PASSWORD=... python -m research.update

- docs/data/config.enc.json   … 候補と設定（サイトから編集される）
- docs/data/results.enc.json  … 取得結果と履歴（このスクリプトが書く）

どの候補を取り直すか:
- schedule（毎日）       : 全部
- push（サイトで編集）   : 新しく追加された候補と、検索条件が変わった候補だけ
- workflow_dispatch      : 入力 ids で指定したもの（空なら全部）
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .analyzer import summarize
from .crypto import WrongPassword, decrypt, encrypt
from .fetcher import FetchError, MercariFetcher, MockFetcher

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR", ROOT / "docs" / "data"))
CONFIG = DATA / "config.enc.json"
RESULTS = DATA / "results.enc.json"

DEFAULT_SETTINGS = {
    "fee_rate": 0.10,
    "default_ship": 210,
    "cny_jpy": 21.0,
    "price_basis": "median",
    "min_profit": 300,
    "min_sold": 10,
    "min_sell_through": 0.3,
    "window_days": 30,
    "max_pages": 3,
    "request_interval": 2.5,
}
SEARCH_KEYS = ("keyword", "exclude", "new_only", "price_min", "price_max")
HISTORY_LIMIT = 60


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def params_hash(c: dict, settings: dict) -> str:
    key = {k: c.get(k) or None for k in SEARCH_KEYS}
    key["window_days"] = settings.get("window_days")
    key["max_pages"] = settings.get("max_pages")
    return hashlib.sha1(json.dumps(key, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


def load(path: Path, password: str, default):
    if not path.exists():
        return default
    return decrypt(json.loads(path.read_text(encoding="utf-8")), password)


def save(path: Path, obj, password: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(encrypt(obj, password)) + "\n", encoding="utf-8")


def pick_targets(cands: list[dict], items: dict, settings: dict, event: str, ids_input: str) -> list[dict]:
    if event == "push":
        return [c for c in cands
                if c["id"] not in items or items[c["id"]].get("params_hash") != params_hash(c, settings)]
    if event == "workflow_dispatch" and ids_input.strip() and ids_input.strip() != "all":
        wanted = {x.strip() for x in ids_input.split(",") if x.strip()}
        return [c for c in cands if c["id"] in wanted]
    return list(cands)


async def run(password: str, event: str, ids_input: str, mock: bool) -> int:
    try:
        config = load(CONFIG, password, None)
        results = load(RESULTS, password, {"items": {}})
    except WrongPassword as e:
        print(f"::error::{e}（Secrets の DATA_PASSWORD とサイトで入れたパスワードが同じか確認してください）")
        return 1

    if config is None:
        config = {"version": 1, "settings": dict(DEFAULT_SETTINGS), "candidates": []}
        save(CONFIG, config, password)
        print("設定ファイルがなかったので、空の設定を作りました")

    settings = {**DEFAULT_SETTINGS, **config.get("settings", {})}
    cands = config.get("candidates", [])
    items: dict = results.get("items", {})

    # 削除された候補の結果は消す
    alive = {c["id"] for c in cands}
    removed = [cid for cid in items if cid not in alive]
    for cid in removed:
        del items[cid]

    targets = pick_targets(cands, items, settings, event, ids_input)
    print(f"イベント: {event or 'local'} / 対象 {len(targets)}件 / 全 {len(cands)}件")

    fetcher = MockFetcher() if mock else MercariFetcher(interval=float(settings["request_interval"]))
    ok = 0
    for n, c in enumerate(targets, 1):
        print(f"[{n}/{len(targets)}] {c['keyword']} … ", end="", flush=True)
        prev = items.get(c["id"], {})
        try:
            res = await fetcher.fetch(c, window_days=int(settings["window_days"]), max_pages=int(settings["max_pages"]))
            m = summarize(res.sold, res.on_sale, res.on_sale_total,
                          window_days=int(settings["window_days"]), sold_capped=res.sold_capped)
            recent_sold = sorted(res.sold, key=lambda x: x.updated, reverse=True)[:40]
            cheapest = sorted(res.on_sale, key=lambda x: x.price)[:10]
            ts = now_iso()
            history = prev.get("history", []) + [{
                "fetched_at": ts,
                "sold_recent": m["sold_recent"],
                "price_median": m["price_median"],
                "on_sale_total": m["on_sale_total"],
            }]
            items[c["id"]] = {
                "fetched_at": ts,
                "params_hash": params_hash(c, settings),
                "metrics": m,
                "samples": [x.to_dict() for x in recent_sold + cheapest],
                "history": history[-HISTORY_LIMIT:],
                "error": None,
            }
            ok += 1
            print(f"売れた{m['sold_recent']}件 / 中央値{m['price_median']}円 / 出品中{m['on_sale_total']}件")
        except FetchError as e:
            items[c["id"]] = {**prev, "error": str(e), "error_at": now_iso()}
            print(f"失敗: {e}")
        if n < len(targets):
            await asyncio.sleep(0.2 if mock else float(settings["request_interval"]))

    if not targets and not removed:
        print("取り直す候補はありません")
        return 0
    results = {"generated_at": now_iso(), "items": items}
    save(RESULTS, results, password)
    print(f"完了: 成功 {ok} / 対象 {len(targets)}")
    if targets and ok == 0:
        print("::warning::すべての取得に失敗しました。メルカリ側でブロックされているか、仕様が変わった可能性があります")
    return 0


def main() -> None:
    password = os.environ.get("DATA_PASSWORD", "")
    if not password:
        print("::error::DATA_PASSWORD が設定されていません（Settings → Secrets and variables → Actions）")
        sys.exit(1)
    code = asyncio.run(run(
        password,
        os.environ.get("GITHUB_EVENT_NAME", ""),
        os.environ.get("IDS", ""),
        os.environ.get("MOCK") == "1",
    ))
    sys.exit(code)


if __name__ == "__main__":
    main()
