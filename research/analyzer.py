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


def evaluate(metrics: dict, cand: dict, settings: dict) -> dict:
    """相場の指標と、候補ごとのコスト・設定から利益と判定を出す。

    コストや設定を変えても再取得せずに計算し直せるよう、表示のたびに呼ぶ。
    """
    fee_rate = float(settings.get("fee_rate", 0.10))
    basis = settings.get("price_basis", "median")  # median / p25（控えめ）
    price = metrics.get("price_p25") if basis == "p25" else metrics.get("price_median")

    cost = unit_cost_yen(cand, settings)
    intl = int(cand.get("intl_yen") or 0)
    ship = int(cand.get("ship_yen") if cand.get("ship_yen") is not None else settings.get("default_ship", 210))

    result: dict = {
        "sell_price": price,
        "unit_cost": cost,
        "intl": intl,
        "ship": ship,
        "fee": None,
        "profit": None,
        "margin": None,
        "roi": None,
        "verdict": "unknown",
        "reasons": [],
    }
    if price is None:
        result["reasons"].append("売れた実績が見つからず、相場を出せません")
        return result

    fee = math.floor(price * fee_rate)  # メルカリは端数切り捨て
    profit = price - fee - ship - cost - intl
    result.update(
        fee=fee,
        profit=profit,
        margin=round(profit / price, 3) if price else None,
        roi=round(profit / (cost + intl), 3) if (cost + intl) > 0 else None,
    )

    min_profit = int(settings.get("min_profit", 300))
    min_sold = int(settings.get("min_sold", 10))
    min_st = float(settings.get("min_sell_through", 0.3))
    sold = int(metrics.get("sold_recent") or 0)
    st = metrics.get("sell_through")

    ok_profit = profit >= min_profit
    ok_sold = sold >= min_sold
    ok_st = st is not None and st >= min_st
    reasons = result["reasons"]
    if cost + intl == 0:
        reasons.append("仕入れ値が未入力なので、利益は手数料と送料だけ引いた金額です")
    reasons.append(
        f"{'✓' if ok_profit else '✗'} 1個あたりの利益 {profit:,}円（目安 {min_profit:,}円以上）"
    )
    reasons.append(
        f"{'✓' if ok_sold else '✗'} 直近{metrics.get('window_days', 30)}日の売れた数 "
        f"{sold}{'件以上' if metrics.get('sold_capped') else '件'}（目安 {min_sold}件以上）"
    )
    st_txt = "—" if st is None else f"{st:.2f}"
    reasons.append(f"{'✓' if ok_st else '✗'} 売れやすさ {st_txt}（売れた数÷出品中の数、目安 {min_st}以上）")

    if ok_profit and ok_sold and ok_st:
        verdict = "go"
    elif profit >= min_profit * 0.5 and sold >= max(1, min_sold // 2):
        verdict = "maybe"
    else:
        verdict = "no"
    result["verdict"] = verdict
    return result


def unit_cost_yen(cand: dict, settings: dict) -> int:
    """仕入れ単価を円に直す（元で入力された場合は為替レートで換算）。"""
    value = float(cand.get("cost_value") or 0)
    if cand.get("cost_currency") == "CNY":
        return round(value * float(settings.get("cny_jpy", 21.0)))
    return round(value)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _round(x: float | None) -> int | None:
    return None if x is None else int(round(x))
