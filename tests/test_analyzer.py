from datetime import datetime, timedelta, timezone

from research.analyzer import Listing, evaluate, histogram, percentile, summarize, unit_cost_yen

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)


def L(price, sold_days_ago, listed_days=3, sold=True, i=0):
    upd = NOW - timedelta(days=sold_days_ago)
    return Listing(id=f"m{i}", name="x", price=price, created=upd - timedelta(days=listed_days), updated=upd, sold=sold)


def test_percentile():
    assert percentile([1, 2, 3, 4, 5], 50) == 3
    assert percentile([10, 20], 25) == 12.5
    assert percentile([], 50) is None


def test_summarize_counts_only_window():
    sold = [L(1000, 5, i=1), L(1200, 10, i=2), L(800, 20, i=3), L(5000, 45, i=4)]
    on_sale = [L(900, 0, sold=False, i=9)]
    m = summarize(sold, on_sale, on_sale_total=10, window_days=30, now=NOW)
    assert m["sold_recent"] == 3
    assert m["price_median"] == 1000  # 45日前の5000円は相場に入れない
    assert m["sell_through"] == 0.3
    assert m["days_to_sell_median"] == 3.0
    assert m["on_sale_min"] == 900


def test_summarize_falls_back_when_few_recent():
    sold = [L(1000, 5, i=1), L(3000, 50, i=2), L(3200, 60, i=3)]
    m = summarize(sold, [], on_sale_total=0, now=NOW)
    assert m["price_basis"] == "all_sold"
    assert m["price_median"] == 3000
    assert m["sell_through"] == 99.0  # 出品0件で売れている＝競合なし


def test_evaluate_profit_and_verdict():
    metrics = {"price_median": 1000, "price_p25": 900, "sold_recent": 20, "sell_through": 0.5, "window_days": 30}
    cand = {"cost_value": 200, "cost_currency": "JPY", "intl_yen": 100, "ship_yen": 210}
    e = evaluate(metrics, cand, {"fee_rate": 0.10, "min_profit": 300, "min_sold": 10, "min_sell_through": 0.3})
    # 1000 - 100(手数料) - 210 - 200 - 100 = 390
    assert e["profit"] == 390
    assert e["verdict"] == "go"


def test_evaluate_p25_basis_and_cny():
    metrics = {"price_median": 1000, "price_p25": 900, "sold_recent": 20, "sell_through": 0.5}
    cand = {"cost_value": 10, "cost_currency": "CNY", "intl_yen": 0, "ship_yen": None}
    s = {"price_basis": "p25", "cny_jpy": 21, "default_ship": 210}
    assert unit_cost_yen(cand, s) == 210
    e = evaluate(metrics, cand, s)
    assert e["sell_price"] == 900
    assert e["profit"] == 900 - 90 - 210 - 210


def test_evaluate_no_data():
    e = evaluate({"price_median": None}, {}, {})
    assert e["verdict"] == "unknown"


def test_fee_is_floored():
    metrics = {"price_median": 999, "sold_recent": 0, "sell_through": 0}
    e = evaluate(metrics, {"ship_yen": 0}, {})
    assert e["fee"] == 99


def test_histogram_counts_all():
    vals = list(range(500, 1500, 7))
    h = histogram(vals)
    assert sum(b["count"] for b in h) == len(vals)
    assert all(b["to"] > b["from"] for b in h)
