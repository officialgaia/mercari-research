"use strict";

/* =========================================================
   メルカリ相場リサーチ（GitHub Pages 版）
   - データ：docs/data/config.enc.json（候補と設定）／results.enc.json（取得結果）
   - どちらも暗号化。復号はこのブラウザの中だけで行う
   - 編集・更新は GitHub API（トークンが必要）
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const yen = (v) => (v == null ? "—" : `${Math.round(v).toLocaleString("ja-JP")}円`);
const num = (v) => (v == null ? "—" : Number(v).toLocaleString("ja-JP"));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const VERDICT = { go: "仕入れOK", maybe: "微妙", no: "見送り", unknown: "データ不足" };
const ORDER = { go: 0, maybe: 1, no: 2, unknown: 3 };
const WORKFLOW = "update.yml";
const CONFIG_PATH = "docs/data/config.enc.json";
const RESULTS_PATH = "docs/data/results.enc.json";
const LS = { pw: "mr_password", token: "mr_token", repo: "mr_repo" };
const DEFAULT_SETTINGS = {
  fee_rate: 0.1, default_ship: 210, cny_jpy: 21.0, price_basis: "median",
  min_profit: 300, min_sold: 10, min_sell_through: 0.3,
  window_days: 30, max_pages: 3, request_interval: 2.5,
};

const state = {
  password: "", token: "", repo: "",
  config: null, configSha: null, results: { items: {} },
  rows: [], openId: null, itemTab: "sold",
  run: { active: false, expectUntil: 0, pending: null, lastFailed: null, lastUrl: null },
  pollTimer: null,
};

/* ---------------- 小物 ---------------- */
function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
function ago(iso) {
  if (!iso) return "未取得";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "たった今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}
const shortDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const settings = () => ({ ...DEFAULT_SETTINGS, ...(state.config?.settings || {}) });
const canEdit = () => !!state.token && !!state.repo;
const newId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function guessRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : "";
}

/* ---------------- GitHub API ---------------- */
async function gh(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).message || ""; } catch {}
    const e = new Error(ghErrorText(res.status, msg));
    e.status = res.status;
    throw e;
  }
  return raw ? res.text() : res.json();
}
function ghErrorText(status, msg) {
  if (status === 401) return "GitHubトークンが無効か、期限切れです（作り直した場合は新しいトークンを貼ってください）";
  if (status === 403) return `権限が足りません（トークンの権限を確認してください）${msg ? "：" + msg : ""}`;
  if (status === 404) return "リポジトリかファイルが見つかりません（名前とトークンの対象リポジトリを確認）";
  if (status === 409 || status === 422) return "ほかの端末で同時に更新されました。もう一度やり直してください";
  return `GitHubエラー ${status}${msg ? "：" + msg : ""}`;
}

/* 暗号化ファイルを読む。なければ null。 */
async function readEnc(path) {
  if (canEdit()) {
    try {
      const meta = await gh(`/repos/${state.repo}/contents/${path}?ref=main`);
      const text = meta.content ? Crypto.b64ToStr(meta.content)
        : await gh(`/repos/${state.repo}/contents/${path}?ref=main`, { raw: true }); // 1MB超
      return { env: JSON.parse(text), sha: meta.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  // トークンなし：Pages から読む（数分キャッシュされることがある）
  const res = await fetch(`${path.replace(/^docs\//, "")}?t=${Date.now()}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`データを読めませんでした（${res.status}）`);
  return { env: await res.json(), sha: null };
}

async function loadAll() {
  const [cf, rs] = await Promise.all([readEnc(CONFIG_PATH), readEnc(RESULTS_PATH)]);
  state.config = cf ? await Crypto.decrypt(cf.env, state.password) : { version: 1, settings: { ...DEFAULT_SETTINGS }, candidates: [] };
  state.configSha = cf?.sha ?? null;
  state.results = rs ? await Crypto.decrypt(rs.env, state.password) : { items: {} };
  state.configMissing = !cf;
  buildRows();
}

async function saveConfig(message) {
  const env = await Crypto.encrypt(state.config, state.password);
  const body = { message, content: Crypto.strToB64(JSON.stringify(env) + "\n"), branch: "main" };
  if (state.configSha) body.sha = state.configSha;
  try {
    const res = await gh(`/repos/${state.repo}/contents/${CONFIG_PATH}`, { method: "PUT", body });
    state.configSha = res.content.sha;
    state.configMissing = false;
  } catch (e) {
    if (e.status === 409 || e.status === 422) await loadAll().catch(() => {});
    throw e;
  }
}

async function dispatch(ids) {
  await gh(`/repos/${state.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: { ref: "main", inputs: { ids: ids ? ids.join(",") : "all" } },
  });
}

/* ---------------- 実行状況のポーリング ---------------- */
function expectRun(ids) {
  state.run.expectUntil = Date.now() + 90_000;
  state.run.pending = ids; // null = 全部
  renderProgress();
  schedulePoll(3000);
}
function schedulePoll(ms) {
  clearTimeout(state.pollTimer);
  if (!canEdit()) return;
  state.pollTimer = setTimeout(pollRuns, ms);
}
async function pollRuns() {
  let wasActive = state.run.active;
  try {
    const r = await gh(`/repos/${state.repo}/actions/workflows/${WORKFLOW}/runs?per_page=5`);
    const runs = r.workflow_runs || [];
    const active = runs.some((x) => x.status !== "completed");
    const latest = runs.find((x) => x.status === "completed");
    state.run.lastFailed = latest && latest.conclusion === "failure" ? latest : null;
    state.run.lastUrl = runs[0]?.html_url ?? null;
    state.run.active = active;
    if (active) state.run.expectUntil = 0;
    if (wasActive && !active) {
      state.run.pending = null;
      await loadAll();
      renderAll();
      toast(state.run.lastFailed ? "取得に失敗しました（詳しくは設定→実行履歴）" : "取得が終わりました");
    }
  } catch (e) {
    console.warn(e);
  }
  renderProgress();
  const busy = state.run.active || Date.now() < state.run.expectUntil;
  if (!busy && !state.run.active) state.run.pending = state.run.expectUntil ? state.run.pending : null;
  schedulePoll(busy ? 8000 : 60000);
}
function renderProgress() {
  const busy = state.run.active || Date.now() < state.run.expectUntil;
  $("#progress").hidden = !busy;
  $("#progressText").textContent = state.run.active
    ? "GitHubでメルカリの相場を取得中…（数分かかります。閉じても大丈夫）"
    : "GitHubに取得を依頼しました。開始を待っています…";
  $("#refreshAll").disabled = busy;
  if (state.rows.length) { buildRows(); renderList(); }
}

/* ---------------- データの組み立て ---------------- */
function buildRows() {
  const s = settings();
  const busy = state.run.active || Date.now() < state.run.expectUntil;
  state.rows = (state.config?.candidates || []).map((c) => {
    const it = state.results.items?.[c.id];
    return {
      ...c,
      metrics: it?.metrics ?? null,
      eval: it?.metrics ? evaluate(it.metrics, c, s) : null,
      fetched_at: it?.fetched_at ?? null,
      last_error: it?.error ?? null,
      samples: it?.samples ?? [],
      history: it?.history ?? [],
      queued: busy && (!it || state.run.pending === null || state.run.pending?.includes(c.id)),
    };
  });
}

/* ---------------- 画面切り替え ---------------- */
function go(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.goto === view));
  $("#tabbar").hidden = view === "setup";
  if (view === "settings") loadSettingsForm();
  if (view === "add") {
    if (!$("#candForm").cid.value) resetForm();
    $("#roNote").hidden = canEdit();
    $$("#candForm input, #candForm select, #candForm textarea, #candForm button").forEach((el) => (el.disabled = !canEdit()));
  }
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) go(g.dataset.goto);
});

function renderAll() {
  $("#roBadge").hidden = canEdit();
  $("#refreshAll").hidden = !canEdit();
  const gen = state.results.generated_at;
  let txt = gen ? `最終取得：${ago(gen)}` : "まだ取得していません";
  if (state.run.lastFailed) txt += `　⚠ 前回の取得が失敗`;
  $("#genAt").innerHTML = state.run.lastFailed
    ? `${esc(txt)} <a href="${esc(state.run.lastFailed.html_url)}" target="_blank" rel="noopener">詳細</a>`
    : esc(txt);
  renderList();
  if (state.openId) openDetail(state.openId, true);
}

/* ---------------- ランキング ---------------- */
function sortRows(list) {
  const by = $("#sortBy").value;
  const p = (c) => c.eval?.profit ?? -1e9;
  const s = (c) => c.metrics?.sold_recent ?? -1;
  const st = (c) => c.metrics?.sell_through ?? -1;
  const fn = {
    verdict: (a, b) => ORDER[a.eval?.verdict ?? "unknown"] - ORDER[b.eval?.verdict ?? "unknown"] || p(b) - p(a),
    profit: (a, b) => p(b) - p(a),
    sold: (a, b) => s(b) - s(a),
    st: (a, b) => st(b) - st(a),
  }[by];
  return [...list].sort(fn);
}
function stText(v) { return v == null ? "—" : v >= 99 ? "競合なし" : v.toFixed(2); }

function renderList() {
  $("#empty").hidden = state.rows.length > 0;
  $("#list").innerHTML = sortRows(state.rows).map((c) => {
    const m = c.metrics, e = c.eval;
    const v = e?.verdict ?? "unknown";
    const profit = e?.profit;
    const sold = m ? `${num(m.sold_recent)}${m.sold_capped ? "+" : ""}` : "—";
    return `
    <button class="card" data-id="${esc(c.id)}">
      <div class="card-top">
        <span class="badge ${v}">${VERDICT[v]}</span>
        <span class="card-title">${esc(c.keyword)}</span>
        <span class="profit num ${profit < 0 ? "neg" : ""}">${profit == null ? "" : (profit >= 0 ? "+" : "") + yen(profit)}</span>
      </div>
      <div class="stats num">
        <div class="stat"><span class="k">相場</span><span class="v">${yen(e?.sell_price)}</span></div>
        <div class="stat"><span class="k">${m?.window_days ?? 30}日で売れた</span><span class="v">${sold}</span></div>
        <div class="stat"><span class="k">出品中</span><span class="v">${num(m?.on_sale_total)}</span></div>
        <div class="stat"><span class="k">売れやすさ</span><span class="v">${stText(m?.sell_through)}</span></div>
      </div>
      ${c.last_error ? `<div class="err">⚠ ${esc(c.last_error)}</div>` : ""}
      <div class="card-foot"><span>${c.queued ? '<span class="spin"></span> 取得中…' : m ? `更新：${ago(c.fetched_at)}` : "取得待ち"}</span>
        <span>${c.cost_value ? `仕入れ ${c.cost_currency === "CNY" ? c.cost_value + "元" : yen(c.cost_value)}` : "仕入れ値未入力"}</span></div>
    </button>`;
  }).join("");
}
$("#list").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openDetail(card.dataset.id);
});
$("#sortBy").addEventListener("change", renderList);

$("#refreshAll").addEventListener("click", async () => {
  try {
    await dispatch(null);
    expectRun(null);
    toast("全部の取り直しを依頼しました（数分かかります）");
  } catch (e) { toast(e.message); }
});

/* ---------------- 詳細 ---------------- */
function openDetail(id, silent = false) {
  const c = state.rows.find((r) => r.id === id);
  if (!c) { if (silent) closeDetail(); return; }
  state.openId = id;
  const sheet = $("#sheet");
  const keep = silent ? sheet.scrollTop : 0;
  $("#dTitle").textContent = c.keyword;
  $("#detail").innerHTML = detailHTML(c);
  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  sheet.scrollTop = keep;
  bindDetail(c);
}
function closeDetail() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
  state.openId = null;
  $("#tooltip").hidden = true;
}
$("#sheetClose").addEventListener("click", closeDetail);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.openId) closeDetail(); });

function mercariSearchURL(c, status) {
  const p = new URLSearchParams({ keyword: c.keyword, status });
  if (c.exclude) p.set("exclude_keyword", c.exclude);
  if (c.new_only) p.set("item_condition_id", "1");
  if (c.price_min) p.set("price_min", c.price_min);
  if (c.price_max) p.set("price_max", c.price_max);
  return `https://jp.mercari.com/search?${p}`;
}

function detailHTML(c) {
  const m = c.metrics, e = c.eval, s = settings();
  const v = e?.verdict ?? "unknown";
  const edit = canEdit();
  const buttons = `
    <div class="btnrow">
      ${edit ? `<button class="btn primary" id="dRefresh" ${c.queued ? "disabled" : ""}>${c.queued ? '<span class="spin"></span>&nbsp;取得中' : "今すぐ更新"}</button>
      <button class="btn" id="dEdit">編集</button>` : ""}
      <a class="btn" href="${mercariSearchURL(c, "sold_out")}" target="_blank" rel="noopener">メルカリ</a>
    </div>`;
  if (!m) {
    return buttons + `<div class="panel">${c.last_error ? `<p class="err">⚠ ${esc(c.last_error)}</p>` : "<p>まだデータがありません。GitHubでの取得が終わるまで数分待ってください。</p>"}</div>` + (edit ? dangerZone() : "");
  }
  const breakEven = Math.ceil((e.unit_cost + e.intl + e.ship) / (1 - s.fee_rate));
  const sold = `${num(m.sold_recent)}${m.sold_capped ? "件以上" : "件"}`;
  const soldItems = c.samples.filter((x) => x.sold);
  const saleItems = c.samples.filter((x) => !x.sold);
  const h = m.histogram || [];
  const lineInside = h.length && breakEven > h[0].from && breakEven < h[h.length - 1].to;

  return `
  ${buttons}
  ${c.last_error ? `<p class="err">⚠ 最新の取得に失敗しました：${esc(c.last_error)}（表示は前回のデータ）</p>` : ""}
  <div class="panel">
    <div class="hero">
      <span class="badge ${v}">${VERDICT[v]}</span>
      <span class="big num">${e.profit == null ? "—" : (e.profit >= 0 ? "+" : "") + yen(e.profit)}</span>
      <span class="unit">1個あたりの利益</span>
    </div>
    <table class="breakdown num">
      <tr><td>想定売値（${s.price_basis === "p25" ? "安め" : "中央値"}）</td><td>${yen(e.sell_price)}</td></tr>
      <tr><td>販売手数料 ${Math.round(s.fee_rate * 100)}%</td><td>−${yen(e.fee)}</td></tr>
      <tr><td>国内送料</td><td>−${yen(e.ship)}</td></tr>
      <tr><td>仕入れ値${c.cost_currency === "CNY" ? `（${c.cost_value}元×${s.cny_jpy}）` : ""}</td><td>−${yen(e.unit_cost)}</td></tr>
      <tr><td>国際送料・代行</td><td>−${yen(e.intl)}</td></tr>
      <tr class="total"><td>利益（利益率 ${e.margin == null ? "—" : Math.round(e.margin * 100) + "%"}）</td><td>${yen(e.profit)}</td></tr>
    </table>
    <ul class="reasons">${e.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <p class="note">赤字にならない最低売値：<b class="num">${yen(breakEven)}</b></p>
  </div>

  <div class="panel">
    <h3>相場と競合</h3>
    <div class="grid3 num">
      <div><div class="k">${m.window_days}日で売れた</div><div class="v">${sold}</div></div>
      <div><div class="k">出品中</div><div class="v">${num(m.on_sale_total)}件</div></div>
      <div><div class="k">売れやすさ</div><div class="v">${stText(m.sell_through)}</div></div>
      <div><div class="k">売れた価格（中央値）</div><div class="v">${yen(m.price_median)}</div></div>
      <div><div class="k">よく売れる価格帯</div><div class="v">${m.price_p25 == null ? "—" : `${num(m.price_p25)}〜${num(m.price_p75)}円`}</div></div>
      <div><div class="k">売れるまで（中央値）</div><div class="v">${m.days_to_sell_median == null ? "—" : m.days_to_sell_median + "日"}</div></div>
      <div><div class="k">出品中の最安値</div><div class="v">${yen(m.on_sale_min)}</div></div>
      <div><div class="k">出品中の中央値</div><div class="v">${yen(m.on_sale_median)}</div></div>
    </div>
    ${m.price_basis === "all_sold" ? `<p class="note">直近の売れた数が少ないため、相場は取得した売り切れ全体（${m.sold_fetched}件）から出しています。</p>` : ""}
    <p class="note">更新：${ago(c.fetched_at)}（${new Date(c.fetched_at).toLocaleString("ja-JP")}）</p>
  </div>

  <div class="panel">
    <h3>売れた価格の分布</h3>
    ${histogramSVG(h, breakEven)}
    <div class="legend-note"><span><span class="swatch"></span>売れた件数</span>${lineInside ? '<span><span class="swatch dash"></span>赤字ライン</span>' : ""}</div>
    <details><summary>数値で見る</summary>
      <table class="tbl num"><tr><th>価格帯</th><th>件数</th></tr>
      ${h.map((b) => `<tr><td>${num(b.from)}〜${num(b.to)}円</td><td>${b.count}</td></tr>`).join("")}</table>
    </details>
  </div>

  ${c.history.length >= 2 ? `
  <div class="panel">
    <h3>推移（${c.history.length}回分）</h3>
    <div class="spark-wrap">
      <div><div class="k">売れた数</div><div class="v num">${sold}</div>${sparkSVG(c.history, "sold_recent", "件")}</div>
      <div><div class="k">相場（中央値）</div><div class="v num">${yen(m.price_median)}</div>${sparkSVG(c.history, "price_median", "円")}</div>
    </div>
  </div>` : ""}

  <div class="panel">
    <div class="seg" role="tablist">
      <button class="${state.itemTab === "sold" ? "on" : ""}" data-itab="sold">最近売れた（${soldItems.length}）</button>
      <button class="${state.itemTab === "sale" ? "on" : ""}" data-itab="sale">出品中の安い順（${saleItems.length}）</button>
    </div>
    <ul class="items">${(state.itemTab === "sold" ? soldItems : saleItems).map(itemHTML).join("") || '<li class="note">ありません</li>'}</ul>
  </div>

  ${c.memo ? `<div class="panel"><h3>メモ</h3><p style="white-space:pre-wrap;margin:0">${linkify(esc(c.memo))}</p></div>` : ""}
  ${edit ? dangerZone() : ""}`;
}
function dangerZone() {
  return `<div class="btnrow" style="margin-top:20px"><button class="btn danger" id="dDelete">この候補を削除</button></div>`;
}
function linkify(s) { return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }
function itemHTML(x) {
  const img = x.thumbnail ? `<img src="${esc(x.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg"></span>';
  const days = Math.max(0, Math.round((new Date(x.updated) - new Date(x.created)) / 864e5));
  const when = x.sold ? `${shortDate(x.updated)}に売れた・出品から${days}日` : `${shortDate(x.created)}に出品`;
  return `<li><a href="https://jp.mercari.com/item/${encodeURIComponent(x.id)}" target="_blank" rel="noopener">${img}
    <span><span class="nm">${esc(x.name)}</span><span class="meta">${when}</span></span>
    <span class="pr num">${yen(x.price)}</span></a></li>`;
}

function bindDetail(c) {
  $("#dRefresh")?.addEventListener("click", async () => {
    try {
      await dispatch([c.id]);
      expectRun([c.id]);
      openDetail(c.id, true);
      toast("取り直しを依頼しました（1〜3分かかります）");
    } catch (e) { toast(e.message); }
  });
  $("#dEdit")?.addEventListener("click", () => { closeDetail(); editCand(c); });
  $("#dDelete")?.addEventListener("click", async () => {
    if (!confirm(`「${c.keyword}」を削除しますか？`)) return;
    const before = state.config.candidates;
    state.config.candidates = before.filter((x) => x.id !== c.id);
    try {
      await saveConfig(`候補を削除: ${c.keyword}`);
      closeDetail();
      buildRows(); renderList();
      toast("削除しました");
    } catch (e) {
      state.config.candidates = before;
      toast(e.message);
    }
  });
  $$("[data-itab]").forEach((b) => b.addEventListener("click", () => { state.itemTab = b.dataset.itab; openDetail(c.id, true); }));
  bindTooltips($("#detail"));
}

/* ---------------- チャート ---------------- */
function histogramSVG(bins, breakEven) {
  if (!bins?.length) return '<p class="note">データがありません</p>';
  const W = 340, H = 170, pl = 30, pr = 8, pt = 22, pb = 28;
  const iw = W - pl - pr, ih = H - pt - pb;
  const max = Math.max(...bins.map((b) => b.count), 1);
  const lo = bins[0].from, hi = bins[bins.length - 1].to;
  const xOf = (v) => pl + ((v - lo) / (hi - lo || 1)) * iw;
  const slot = iw / bins.length;
  const bw = Math.min(24, slot - 2);
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="売れた価格の分布">`;
  niceTicks(max).forEach((t) => {
    const y = pt + ih - (t / max) * ih;
    out += `<line class="axis" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke-width="${t === 0 ? 1 : 0.5}"/>`;
    out += `<text x="${pl - 5}" y="${y + 4}" text-anchor="end">${t}</text>`;
  });
  bins.forEach((b, i) => {
    const h = (b.count / max) * ih;
    const x = pl + i * slot + (slot - bw) / 2;
    const y = pt + ih - h;
    if (h > 0) out += `<path class="bar" d="${roundTopRect(x, y, bw, h, Math.min(4, h))}"/>`;
    out += `<rect class="hit" x="${pl + i * slot}" y="${pt}" width="${slot}" height="${ih}" data-tip="${num(b.from)}〜${num(b.to)}円：${b.count}件"/>`;
  });
  [lo, Math.round((lo + hi) / 2), hi].forEach((v, i) => {
    out += `<text x="${xOf(v)}" y="${H - 8}" text-anchor="${["start", "middle", "end"][i]}">${num(v)}円</text>`;
  });
  if (breakEven > lo && breakEven < hi) {
    const x = xOf(breakEven);
    out += `<line class="ref-line" x1="${x}" x2="${x}" y1="${pt - 4}" y2="${pt + ih}"/>`;
    const right = x > W - 90;
    out += `<text class="ref-label" x="${right ? x - 4 : x + 4}" y="${pt - 8}" text-anchor="${right ? "end" : "start"}">赤字ライン ${num(breakEven)}円</text>`;
  } else if (breakEven <= lo) {
    out += `<text class="ref-label" x="${pl}" y="${pt - 8}">赤字ライン ${num(breakEven)}円 → ほぼ全部が黒字</text>`;
  } else {
    out += `<text class="ref-label" x="${W - pr}" y="${pt - 8}" text-anchor="end">赤字ライン ${num(breakEven)}円 → ほぼ全部が赤字</text>`;
  }
  return out + "</svg>";
}
function roundTopRect(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceTicks(max) {
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const t = [];
  for (let v = 0; v <= max; v += step) t.push(v);
  return t;
}
function sparkSVG(hist, key, unit) {
  const pts = hist.filter((h) => h[key] != null);
  if (pts.length < 2) return "";
  const W = 160, H = 54, p = 5;
  const vals = pts.map((h) => h[key]);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const x = (i) => p + (i / (pts.length - 1)) * (W - 2 * p);
  const y = (v) => (mx === mn ? H / 2 : p + (1 - (v - mn) / (mx - mn)) * (H - 2 * p));
  const d = pts.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h[key]).toFixed(1)}`).join("");
  const last = pts.length - 1;
  const slot = (W - 2 * p) / (pts.length - 1);
  const hits = pts.map((h, i) => `<rect class="hit" x="${x(i) - slot / 2}" y="0" width="${slot}" height="${H}" data-tip="${new Date(h.fetched_at).toLocaleDateString("ja-JP")}：${num(h[key])}${unit}"/>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="推移">
    <path class="line" d="${d}"/><circle class="dot" cx="${x(last)}" cy="${y(vals[last])}" r="4"/>${hits}</svg>`;
}
function bindTooltips(root) {
  const tip = $("#tooltip");
  const show = (el, cx, cy) => {
    tip.textContent = el.dataset.tip;
    tip.style.left = `${cx}px`;
    tip.style.top = `${cy}px`;
    tip.hidden = false;
  };
  $$(".hit", root).forEach((el) => {
    el.addEventListener("pointerenter", (e) => show(el, e.clientX, e.clientY));
    el.addEventListener("pointermove", (e) => show(el, e.clientX, e.clientY));
    el.addEventListener("pointerdown", (e) => { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, e.clientY); });
    el.addEventListener("pointerleave", () => (tip.hidden = true));
  });
}
$("#sheet").addEventListener("scroll", () => ($("#tooltip").hidden = true), { passive: true });

/* ---------------- 追加・編集 ---------------- */
const CAND_KEYS = ["keyword", "exclude", "price_min", "price_max", "cost_value", "cost_currency", "intl_yen", "ship_yen", "memo"];
function resetForm() {
  const f = $("#candForm");
  f.reset();
  f.cid.value = "";
  $("#formTitle").textContent = "候補を追加";
  $("#saveBtn").textContent = "追加して調べる";
  $("#cancelEdit").hidden = true;
}
function editCand(c) {
  const f = $("#candForm");
  f.cid.value = c.id;
  go("add");
  CAND_KEYS.forEach((k) => (f[k].value = c[k] ?? ""));
  f.new_only.checked = !!c.new_only;
  $("#formTitle").textContent = "候補を編集";
  $("#saveBtn").textContent = "保存";
  $("#cancelEdit").hidden = false;
}
$("#cancelEdit").addEventListener("click", () => { resetForm(); go("list"); });
$("#candForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const intOrNull = (v) => (v === "" ? null : parseInt(v, 10));
  const data = {
    keyword: f.keyword.value.trim(),
    exclude: f.exclude.value.trim(),
    new_only: f.new_only.checked,
    price_min: intOrNull(f.price_min.value),
    price_max: intOrNull(f.price_max.value),
    cost_value: parseFloat(f.cost_value.value || "0"),
    cost_currency: f.cost_currency.value,
    intl_yen: parseInt(f.intl_yen.value || "0", 10),
    ship_yen: intOrNull(f.ship_yen.value),
    memo: f.memo.value,
  };
  if (!data.keyword) return;
  const before = structuredClone(state.config.candidates);
  const editing = f.cid.value;
  if (editing) {
    const c = state.config.candidates.find((x) => x.id === editing);
    if (!c) { toast("見つかりません"); return; }
    Object.assign(c, data);
  } else {
    state.config.candidates.push({ id: newId(), ...data, created_at: new Date().toISOString() });
  }
  $("#saveBtn").disabled = true;
  try {
    await saveConfig(editing ? `候補を編集: ${data.keyword}` : `候補を追加: ${data.keyword}`);
    // 検索条件が変われば、push をきっかけに Actions が自動で取り直す
    const prev = editing ? before.find((x) => x.id === editing) : null;
    const searchChanged = !prev || ["keyword", "exclude", "new_only", "price_min", "price_max"].some((k) => (prev[k] || null) !== (data[k] || null));
    if (searchChanged) expectRun(editing ? [editing] : [state.config.candidates.at(-1).id]);
    toast(searchChanged ? "保存しました。GitHubで相場を取得します（数分）" : "保存しました");
    resetForm();
    buildRows();
    go("list");
    renderAll();
  } catch (e) {
    state.config.candidates = before;
    toast(`保存できませんでした：${e.message}`, 4000);
  } finally {
    $("#saveBtn").disabled = false;
  }
});

/* ---------------- 設定 ---------------- */
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
function loadSettingsForm() {
  const f = $("#settingsForm");
  const s = settings();
  SETTING_KEYS.forEach((k) => (f[k].value = s[k]));
  $$("#settingsForm input, #settingsForm select, #settingsForm button").forEach((el) => (el.disabled = !canEdit()));
  $("#connInfo").innerHTML = `リポジトリ：<b>${esc(state.repo || "未設定")}</b><br>${canEdit() ? "編集できます（トークンあり）" : "閲覧のみ（トークンなし）"}`;
  const a = $("#actionsLink");
  a.href = state.repo ? `https://github.com/${state.repo}/actions` : "#";
  a.hidden = !state.repo;
}
$("#settingsForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const before = { ...state.config.settings };
  const next = {};
  for (const k of SETTING_KEYS) {
    const def = DEFAULT_SETTINGS[k];
    const v = f[k].value;
    if (typeof def === "number") {
      const n = Number(v);
      if (v === "" || !Number.isFinite(n)) { toast(`「${f[k].closest("label").firstChild.textContent.trim()}」の値が正しくありません`); return; }
      next[k] = Number.isInteger(def) && !String(v).includes(".") ? parseInt(v, 10) : n;
    } else next[k] = v;
  }
  state.config.settings = next;
  try {
    await saveConfig("設定を変更");
    buildRows();
    renderAll();
    toast("保存しました");
  } catch (e) {
    state.config.settings = before;
    toast(e.message);
  }
});
$("#fxBtn").addEventListener("click", async () => {
  $("#fxNote").textContent = "取得中…";
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=CNY&to=JPY");
    const j = await r.json();
    const rate = Math.round(j.rates.JPY * 100) / 100;
    $("#settingsForm").cny_jpy.value = rate;
    $("#fxNote").textContent = `${j.date} 時点：1元＝${rate}円（「設定を保存」で反映）`;
  } catch {
    $("#fxNote").textContent = "取得できませんでした。手入力してください";
  }
});
$("#logout").addEventListener("click", () => {
  if (!confirm("このブラウザに保存したパスワードとトークンを消しますか？")) return;
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
  location.reload();
});
$("#changeConn").addEventListener("click", () => showSetup());

/* ---------------- 初期設定 ---------------- */
function showSetup(err) {
  const f = $("#setupForm");
  f.password.value = state.password;
  f.token.value = state.token;
  f.repo.value = state.repo || guessRepo();
  $("#setupErr").hidden = !err;
  $("#setupErr").textContent = err || "";
  closeDetail();
  go("setup");
}
$("#setupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  state.password = f.password.value;
  // 貼り付けで混ざりやすい空白・改行・見えない文字を取り除く
  state.token = f.token.value.replace(/[\s​-‍⁠﻿]/g, "");
  f.token.value = state.token;
  state.repo = f.repo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
  $("#setupBtn").disabled = true;
  $("#setupBtn").textContent = "確認中…";
  try {
    if (state.token) {
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(state.token)) {
        throw new Error(`トークンの形が正しくありません（github_pat_ で始まる英数字のはずです。今は${state.token.length}文字）`);
      }
      if (!state.repo) throw new Error("リポジトリを入れてください（例：officialgaia/mercari-research）");
      const repo = await gh(`/repos/${state.repo}`);
      if (!repo.permissions?.push) throw new Error("このトークンではリポジトリに書き込めません");
    }
    await loadAll();
    localStorage.setItem(LS.pw, state.password);
    localStorage.setItem(LS.token, state.token);
    localStorage.setItem(LS.repo, state.repo);
    start();
  } catch (e) {
    $("#setupErr").textContent = e.message;
    $("#setupErr").hidden = false;
  } finally {
    $("#setupBtn").disabled = false;
    $("#setupBtn").textContent = "はじめる";
  }
});

function start() {
  go("list");
  renderAll();
  if (state.configMissing && canEdit()) toast("最初の候補を追加すると、データファイルが作られます", 4000);
  if (canEdit()) pollRuns();
}

(async function init() {
  state.password = localStorage.getItem(LS.pw) || "";
  state.token = localStorage.getItem(LS.token) || "";
  state.repo = localStorage.getItem(LS.repo) || guessRepo();
  if (!state.password) return showSetup();
  try {
    await loadAll();
    start();
  } catch (e) {
    showSetup(e.wrongPassword ? "パスワードが違います" : e.message);
  }
})();
