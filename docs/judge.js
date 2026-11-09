"use strict";
// research/analyzer.py の judge() と同じ計算（tests/test_crypto_and_parity.py で一致を確認）。
// 相場から「いくら以下で仕入れれば目標の利益が出るか（仕入れ上限）」と判定を出す。

function judge(metrics, settings, cnyJpy) {
  const feeRate = Number(settings.fee_rate ?? 0.10);
  const ship = parseInt(settings.ship_yen ?? 210, 10);
  const intl = parseInt(settings.intl_yen ?? 100, 10);
  const minProfit = parseInt(settings.min_profit ?? 300, 10);
  const minSold = parseInt(settings.min_sold ?? 15, 10);
  const minSt = Number(settings.min_sell_through ?? 0.3);
  const price = metrics.price_median ?? null;
  const out = { price, fee: null, limit_yen: null, limit_cny: null, verdict: "unknown" };
  if (price == null) return out;
  const fee = Math.floor(price * feeRate);
  const limit = price - fee - ship - intl - minProfit;
  out.fee = fee;
  out.limit_yen = limit;
  out.limit_cny = cnyJpy > 0 ? Math.floor((limit * 10) / cnyJpy) / 10 : null;
  const sold = parseInt(metrics.sold_recent || 0, 10);
  const st = metrics.sell_through;
  if (sold >= minSold && st != null && st >= minSt && limit >= 150) out.verdict = "go";
  else if (sold >= Math.max(1, Math.floor(minSold / 3)) && limit >= 50) out.verdict = "maybe";
  else out.verdict = "no";
  return out;
}

if (typeof module !== "undefined") module.exports = { judge };
