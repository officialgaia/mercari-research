"""相場の集計と、仕入れ判定（利益計算）を行う純粋関数群。

ネットワークにもDBにも触れないので、単体テストしやすい。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Iterable


@dataclass
class Listing:
    """検索結果1件分（売り切れ・出品中どちらにも使う）。"""
    id: str
    name: str
    price: int
    created: datetime
    updated: datetime
    thumbnail: str = ""
    sold: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "price": self.price,
            "created": self.created.isoformat(),
            "updated": self.updated.isoformat(),
            "thumbnail": self.thumbnail,
            "sold": self.sold,
        }


def percentile(values: list[int], p: float) -> float | None:
    """線形補間のパーセンタイル（p は 0〜100）。"""
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    k = (len(s) - 1) * p / 100
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return float(s[int(k)])
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def histogram(values: list[int], bins: int = 10) -> list[dict]:
    """価格分布のヒストグラム。端の外れ値に引っぱられないよう 5〜95% の範囲で区切る。"""
    if not values:
        return []
    lo = percentile(values, 5)
    hi = percentile(values, 95)
    if lo is None or hi is None:
        return []
    if hi <= lo:
        return [{"from": int(lo), "to": int(hi), "count": len(values)}]
    # 見やすい刻み幅（10, 20, 50, 100, 200, 500...）に丸める
    raw = (hi - lo) / bins
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    start = math.floor(lo / step) * step
    edges = []
    x = start
    while x < hi or not edges:
        edges.append(x)
        x += step
    out = [{"from": round(e), "to": round(e + step), "count": 0} for e in edges]
    for v in values:
        idx = int((v - start) // step)
        idx = max(0, min(idx, len(out) - 1))
        out[idx]["count"] += 1
    return out


def summarize(
    sold: Iterable[Listing],
    on_sale: Iterable[Listing],
    on_sale_total: int,
    *,
    window_days: int = 30,
    sold_capped: bool = False,
    now: datetime | None = None,
) -> dict:
    """取得した売り切れ／出品中の一覧から、相場の指標を作る。

    - 売れた日時は Mercari が返す `updated`（最終更新＝取引成立時刻とほぼ同じ）で近似する
    - sold_capped=True のときは取得ページ上限に達しているので「○件以上」と表示する
    """
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=window_days)
    sold = list(sold)
    on_sale = list(on_sale)

    recent = [x for x in sold if _aware(x.updated) >= since]
    # 直近の売れ数が少なすぎると相場がぶれるので、3件未満なら取得した売り切れ全体を使う
    price_base = recent if len(recent) >= 3 else sold
    prices = [x.price for x in price_base if x.price > 0]

    days_to_sell = [
        max((_aware(x.updated) - _aware(x.created)).total_seconds() / 86400, 0)
        for x in recent
    ]
    on_sale_prices = [x.price for x in on_sale if x.price > 0]

    sold_30d = len(recent)
    sell_through = (sold_30d / on_sale_total) if on_sale_total > 0 else (None if sold_30d == 0 else float("inf"))

    return {
        "window_days": window_days,
        "sold_recent": sold_30d,
        "sold_capped": sold_capped,
        "sold_fetched": len(sold),
        "price_basis": "recent" if price_base is recent else "all_sold",
        "price_median": _round(median(prices)) if prices else None,
        "price_p25": _round(percentile(prices, 25)),
        "price_p75": _round(percentile(prices, 75)),
        "price_min": min(prices) if prices else None,
        "price_max": max(prices) if prices else None,
        "on_sale_total": on_sale_total,
        "on_sale_min": min(on_sale_prices) if on_sale_prices else None,
        "on_sale_median": _round(median(on_sale_prices)) if on_sale_prices else None,
        "sell_through": None if sell_through is None else (round(sell_through, 3) if math.isfinite(sell_through) else 99.0),
        "days_to_sell_median": round(median(days_to_sell), 1) if days_to_sell else None,
        "histogram": histogram(prices),
    }


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _round(x: float | None) -> int | None:
    return None if x is None else int(round(x))


# ---------------------------------------------------------------- 自動発見用

import re
import unicodedata

_SPLIT = re.compile(r"[\s\u3000【】\[\]()（）{}「」『』<>＜＞/／・|｜,，、。.!！?？#＃★☆♪♡❤✨◆◇■□●○*＊~〜～:：;；\-_=+＋&＆'\"“”]+")


def extract_terms(titles: list[str], seed: str, *, stop: set[str], block: list[str],
                  top: int = 2, min_ratio: float = 0.12, min_count: int = 3) -> list[str]:
    """売れた商品のタイトルから、よく出てくる言葉（＝売れ筋の特徴）を拾う。

    例：「バッグチャーム」の売れた商品に「パール」が多ければ「パール」を返す。
    1つのタイトルで同じ言葉は1回と数える。
    """
    seed_parts = {unicodedata.normalize("NFKC", w).lower() for w in seed.split()}
    block_l = [b.lower() for b in block]
    stop_l = {w.lower() for w in stop}
    counts: dict[str, int] = {}
    shown: dict[str, str] = {}
    for t in titles:
        seen = set()
        for raw in _SPLIT.split(unicodedata.normalize("NFKC", t)):
            w = raw.strip()
            key = w.lower()
            if not (2 <= len(w) <= 12) or key in seen:
                continue
            if key in stop_l or key.isdigit() or re.fullmatch(r"[0-9a-z]{1,2}", key):
                continue
            if any(sp in key or key in sp for sp in seed_parts):
                continue
            if any(b in key for b in block_l):
                continue
            if re.fullmatch(r"[0-9.]+(cm|mm|m|g|個|枚|本|色|点|セット)?", key):
                continue
            seen.add(key)
            counts[key] = counts.get(key, 0) + 1
            shown.setdefault(key, w)
    need = max(min_count, int(len(titles) * min_ratio))
    ranked = sorted((k for k, c in counts.items() if c >= need), key=lambda k: (-counts[k], k))
    return [shown[k] for k in ranked[:top]]


def judge(metrics: dict, settings: dict, cny_jpy: float) -> dict:
    """相場から「いくら以下で仕入れれば目標の利益が出るか」と判定を出す。

    ブラウザ側（docs/evaluate.js）と同じ計算。変えるときは両方そろえる。
    """
    fee_rate = float(settings.get("fee_rate", 0.10))
    ship = int(settings.get("ship_yen", 210))
    intl = int(settings.get("intl_yen", 100))
    min_profit = int(settings.get("min_profit", 300))
    min_sold = int(settings.get("min_sold", 15))
    min_st = float(settings.get("min_sell_through", 0.3))
    price = metrics.get("price_median")
    out = {"price": price, "fee": None, "limit_yen": None, "limit_cny": None, "verdict": "unknown"}
    if price is None:
        return out
    fee = math.floor(price * fee_rate)
    limit = price - fee - ship - intl - min_profit
    out["fee"] = fee
    out["limit_yen"] = limit
    out["limit_cny"] = math.floor(limit * 10 / cny_jpy) / 10 if cny_jpy > 0 else None
    sold = int(metrics.get("sold_recent") or 0)
    st = metrics.get("sell_through")
    if sold >= min_sold and st is not None and st >= min_st and limit >= 150:
        out["verdict"] = "go"
    elif sold >= max(1, min_sold // 3) and limit >= 50:
        out["verdict"] = "maybe"
    else:
        out["verdict"] = "no"
    return out
