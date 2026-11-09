from datetime import datetime, timedelta, timezone

from research.analyzer import Listing, extract_terms, histogram, judge, percentile, summarize

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


def test_judge_limit_and_verdict():
    m = {"price_median": 2000, "sold_recent": 30, "sell_through": 0.5}
    j = judge(m, {"min_profit": 300, "intl_yen": 100, "ship_yen": 210}, 20.0)
    # 2000 - 200(手数料) - 210 - 100 - 300 = 1190円 → 59.5元
    assert j["limit_yen"] == 1190
    assert j["limit_cny"] == 59.5
    assert j["verdict"] == "go"


def test_judge_maybe_and_no():
    s = {"min_profit": 300, "intl_yen": 100, "ship_yen": 210}
    assert judge({"price_median": 2000, "sold_recent": 6, "sell_through": 0.1}, s, 20)["verdict"] == "maybe"
    assert judge({"price_median": 700, "sold_recent": 50, "sell_through": 1}, s, 20)["verdict"] == "no"
    assert judge({"price_median": None}, s, 20)["verdict"] == "unknown"


def test_extract_terms():
    titles = [
        "バッグチャーム パール 新品 韓国",
        "【新品】バッグチャーム パール リボン",
        "バッグチャーム くま パール",
        "バッグチャーム ビーズ リボン 匿名配送",
        "バッグチャーム ちいかわ パール",
        "バッグチャーム 10cm リボン",
    ]
    from research.seeds import BLOCK_WORDS, STOP_WORDS
    terms = extract_terms(titles, "バッグチャーム", stop=STOP_WORDS, block=BLOCK_WORDS, top=3, min_count=2)
    assert terms[:2] == ["パール", "リボン"]
    assert "ちいかわ" not in terms and "新品" not in terms and "10cm" not in terms


def test_histogram_counts_all():
    vals = list(range(500, 1500, 7))
    h = histogram(vals)
    assert sum(b["count"] for b in h) == len(vals)
    assert all(b["to"] > b["from"] for b in h)
