"use strict";
// research/analyzer.py の evaluate() / unit_cost_yen() をブラウザ用に移したもの。
// 変えるときは両方そろえること（tests/test_parity.py で一致を確認している）。

function unitCostYen(cand, settings) {
  const v = Number(cand.cost_value || 0);
  if (cand.cost_currency === "CNY") return pyRound(v * Number(settings.cny_jpy ?? 21));
  return pyRound(v);
}

// Python の round()（偶数丸め）に合わせる
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

function evaluate(metrics, cand, settings) {
  const feeRate = Number(settings.fee_rate ?? 0.10);
  const basis = settings.price_basis ?? "median";
  const price = basis === "p25" ? metrics.price_p25 : metrics.price_median;
  const cost = unitCostYen(cand, settings);
  const intl = parseInt(cand.intl_yen || 0, 10);
  const ship = parseInt(cand.ship_yen != null && cand.ship_yen !== "" ? cand.ship_yen : (settings.default_ship ?? 210), 10);

  const r = { sell_price: price ?? null, unit_cost: cost, intl, ship, fee: null, profit: null, margin: null, roi: null, verdict: "unknown", reasons: [] };
  if (price == null) {
    r.reasons.push("売れた実績が見つからず、相場を出せません");
    return r;
  }
  const fee = Math.floor(price * feeRate); // Python の math.floor と同じ浮動小数で計算
  const profit = price - fee - ship - cost - intl;
  r.fee = fee;
  r.profit = profit;
  r.margin = price ? Math.round((profit / price) * 1000) / 1000 : null;
  r.roi = cost + intl > 0 ? Math.round((profit / (cost + intl)) * 1000) / 1000 : null;

  const minProfit = parseInt(settings.min_profit ?? 300, 10);
  const minSold = parseInt(settings.min_sold ?? 10, 10);
  const minSt = Number(settings.min_sell_through ?? 0.3);
  const sold = parseInt(metrics.sold_recent || 0, 10);
  const st = metrics.sell_through;

  const okProfit = profit >= minProfit;
  const okSold = sold >= minSold;
  const okSt = st != null && st >= minSt;
  if (cost + intl === 0) r.reasons.push("仕入れ値が未入力なので、利益は手数料と送料だけ引いた金額です");
  r.reasons.push(`${okProfit ? "✓" : "✗"} 1個あたりの利益 ${profit.toLocaleString("ja-JP")}円（目安 ${minProfit.toLocaleString("ja-JP")}円以上）`);
  r.reasons.push(`${okSold ? "✓" : "✗"} 直近${metrics.window_days ?? 30}日の売れた数 ${sold}${metrics.sold_capped ? "件以上" : "件"}（目安 ${minSold}件以上）`);
  r.reasons.push(`${okSt ? "✓" : "✗"} 売れやすさ ${st == null ? "—" : st.toFixed(2)}（売れた数÷出品中の数、目安 ${minSt}以上）`);

  if (okProfit && okSold && okSt) r.verdict = "go";
  else if (profit >= minProfit * 0.5 && sold >= Math.max(1, Math.floor(minSold / 2))) r.verdict = "maybe";
  else r.verdict = "no";
  return r;
}

if (typeof module !== "undefined") module.exports = { evaluate, unitCostYen };
