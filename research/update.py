"""GitHub Actions から実行される取得スクリプト（自動発見つき）。

  DATA_PASSWORD=... python -m research.update

1. 種ジャンル（research/seeds.py）＋自分で追加したキーワードを、メルカリで調べる
2. よく売れているジャンルの「売れた商品のタイトル」から売れ筋の言葉を拾い、
   「ジャンル＋言葉」も調べる（例：バッグチャーム → バッグチャーム パール）
3. 結果を暗号化して docs/data/results.enc.json に保存する

いつ何を調べるか:
- schedule / workflow_dispatch : 全部（＋売れ筋の自動発見）
- push（サイトで設定を保存）   : 新しく追加されたキーワードだけ
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from .analyzer import extract_terms, summarize
from .crypto import WrongPassword, decrypt, encrypt
from .fetcher import FetchError, MercariFetcher, MockFetcher
from .seeds import BLOCK_WORDS, SEARCH_EXCLUDE, SEEDS, STOP_WORDS

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR", ROOT / "docs" / "data"))
CONFIG = DATA / "config.enc.json"
RESULTS = DATA / "results.enc.json"

DEFAULT_SETTINGS = {"min_profit": 300, "intl_yen": 100, "ship_yen": 210}
WINDOW_DAYS = 30
MAX_PAGES = 2
INTERVAL = float(os.environ.get("REQUEST_INTERVAL", "2.5"))
EXPAND_FROM = 12      # 売れた数の上位いくつのジャンルから売れ筋語を探すか
EXPAND_PER_SEED = 2
EXPAND_MAX = 20
HISTORY_LIMIT = 30


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(path: Path, password: str, default):
    if not path.exists():
        return default
    return decrypt(json.loads(path.read_text(encoding="utf-8")), password)


def save(path: Path, obj, password: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(encrypt(obj, password)) + "\n", encoding="utf-8")


def migrate(config: dict) -> dict:
    """前のバージョン（候補を手入力する形）の設定を引き継ぐ。"""
    config.setdefault("settings", {})
    config.setdefault("extra_keywords", [])
    config.setdefault("hidden", [])
    for c in config.pop("candidates", []) or []:
        kw = (c.get("keyword") or "").strip()
        if kw and kw not in config["extra_keywords"]:
            config["extra_keywords"].append(kw)
    config["version"] = 2
    return config


def url_1688(cn: str) -> str:
    return "https://s.1688.com/selloffer/offer_search.htm?keywords=" + quote(cn.encode("gbk"))


def blocked(name: str) -> bool:
    low = name.lower()
    return any(b.lower() in low for b in BLOCK_WORDS)


async def fetch_rate(prev: float | None) -> tuple[float, str | None]:
    """人民元→円（欧州中央銀行のデータ）。取れなければ前回の値。"""
    try:
        import httpx

        async with httpx.AsyncClient(timeout=15) as cl:
            r = await cl.get("https://api.frankfurter.app/latest", params={"from": "CNY", "to": "JPY"})
            r.raise_for_status()
            j = r.json()
        return round(float(j["rates"]["JPY"]), 2), j.get("date")
    except Exception as e:
        print(f"為替を取得できませんでした（前回の値を使います）: {e}")
        return prev or 21.0, None


class Runner:
    def __init__(self, fetcher, items: dict):
        self.fetcher = fetcher
        self.items = items
        self.titles: dict[str, list[str]] = {}
        self.ok = 0
        self.tried = 0

    async def check(self, keyword: str, *, cn: str | None, source: str, parent: str | None = None):
        self.tried += 1
        prev = self.items.get(keyword, {})
        cand = {"keyword": keyword, "exclude": SEARCH_EXCLUDE, "new_only": True}
        print(f"- {keyword} … ", end="", flush=True)
        try:
            res = await self.fetcher.fetch(cand, window_days=WINDOW_DAYS, max_pages=MAX_PAGES)
        except FetchError as e:
            print(f"失敗: {e}")
            if prev:
                self.items[keyword] = {**prev, "error": str(e)}
            return
        sold = [x for x in res.sold if not blocked(x.name)]
        on_sale = [x for x in res.on_sale if not blocked(x.name)]
        m = summarize(sold, on_sale, res.on_sale_total, window_days=WINDOW_DAYS, sold_capped=res.sold_capped)
        m.pop("histogram", None)
        ts = now_iso()
        recent = sorted(sold, key=lambda x: x.updated, reverse=True)
        self.titles[keyword] = [x.name for x in recent[:120]]
        hist = prev.get("history", []) + [{"at": ts, "sold": m["sold_recent"], "price": m["price_median"]}]
        self.items[keyword] = {
            "keyword": keyword,
            "cn": cn,
            "url_1688": url_1688(cn) if cn else None,
            "source": source,
            "parent": parent,
            "fetched_at": ts,
            "metrics": m,
            "samples": [
                {"id": x.id, "name": x.name, "price": x.price, "thumbnail": x.thumbnail, "sold_at": x.updated.isoformat()}
                for x in recent[:8]
            ],
            "history": hist[-HISTORY_LIMIT:],
            "error": None,
        }
        self.ok += 1
        print(f"売れた{m['sold_recent']}件 / 相場{m['price_median']}円 / 出品中{m['on_sale_total']}件")
        await asyncio.sleep(self.fetcher.interval)


async def run(password: str, event: str, mock: bool) -> int:
    try:
        config = load(CONFIG, password, None)
        results = load(RESULTS, password, {"items": {}})
    except WrongPassword as e:
        print(f"::error::{e}（Secrets の DATA_PASSWORD とサイトで入れたパスワードが同じか確認してください）")
        return 1

    created = config is None
    config = migrate(config or {"settings": dict(DEFAULT_SETTINGS)})
    old_format = any("keyword" not in v for v in results.get("items", {}).values())
    if created or old_format:
        results = {"items": {}}  # 前のバージョンの結果は形が違うので作り直す
    if created:
        save(CONFIG, config, password)

    hidden = set(config["hidden"])
    extras = [k for k in config["extra_keywords"] if k not in hidden]
    seeds = [(k, cn) for k, cn in SEEDS if k not in hidden]
    old_items: dict = results.get("items", {})
    fetcher = MockFetcher(interval=0.05) if mock else MercariFetcher(interval=INTERVAL)

    if event == "push":
        # 設定の保存で動いたとき：新しく追加したキーワードだけ調べる
        items = dict(old_items)
        r = Runner(fetcher, items)
        for kw in extras:
            if kw not in items:
                await r.check(kw, cn=None, source="user")
        for kw in list(items):
            if kw in hidden or (items[kw].get("source") == "user" and kw not in extras):
                del items[kw]
        if r.tried == 0 and items.keys() == old_items.keys():
            print("調べ直すものはありません")
            return 0
        cny, fx_date = results.get("cny_jpy", 21.0), results.get("fx_date")
    else:
        cny, fx_date = await fetch_rate(results.get("cny_jpy")) if not mock else (20.5, "mock")
        r = Runner(fetcher, dict(old_items))  # 前回のデータ（履歴）を引き継ぐ
        cn_of = dict(seeds)
        print(f"■ ジャンル {len(seeds)}件 ＋ 追加キーワード {len(extras)}件")
        for kw, cn in seeds:
            await r.check(kw, cn=cn, source="seed")
        for kw in extras:
            if kw not in cn_of:
                await r.check(kw, cn=None, source="user")
        checked = {kw for kw, _ in seeds} | set(extras)

        # 売れ筋語の自動発見
        top = sorted(
            (k for k in checked if k in r.items and r.items[k].get("metrics") and not r.items[k].get("error")),
            key=lambda k: -r.items[k]["metrics"]["sold_recent"],
        )[:EXPAND_FROM]
        found: list[tuple[str, str]] = []
        for k in top:
            terms = extract_terms(r.titles.get(k, []), k, stop=STOP_WORDS, block=BLOCK_WORDS, top=EXPAND_PER_SEED)
            for t in terms:
                kw = f"{k} {t}"
                if kw not in hidden and kw not in checked and len(found) < EXPAND_MAX:
                    found.append((kw, k))
        print(f"■ 売れ筋から見つけたキーワード {len(found)}件")
        for kw, parent in found:
            await r.check(kw, cn=cn_of.get(parent), source="found", parent=parent)
        keep = checked | {kw for kw, _ in found}
        items = {k: v for k, v in r.items.items() if k in keep and k not in hidden}

    results = {"generated_at": now_iso(), "cny_jpy": cny, "fx_date": fx_date, "items": items}
    save(RESULTS, results, password)
    print(f"完了: 成功 {r.ok} / {r.tried}")
    if r.tried and r.ok == 0:
        print("::warning::すべての取得に失敗しました。メルカリ側でブロックされているか、仕様が変わった可能性があります")
    return 0


def main() -> None:
    password = os.environ.get("DATA_PASSWORD", "")
    if not password:
        print("::error::DATA_PASSWORD が設定されていません（Settings → Secrets and variables → Actions）")
        sys.exit(1)
    sys.exit(asyncio.run(run(password, os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("MOCK") == "1")))


if __name__ == "__main__":
    main()
