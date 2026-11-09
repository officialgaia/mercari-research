"use strict";

/* =========================================================
   相場リサーチ（GitHub Pages）
   - GitHub Actions が毎日、種ジャンル＋売れ筋語をメルカリで調べて
     docs/data/results.enc.json に保存する（暗号化）
   - このページは、それを復号して「いくら以下で仕入れれば儲かるか」を出す
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const yen = (v) => (v == null ? "—" : `${Math.round(v).toLocaleString("ja-JP")}円`);
const num = (v) => (v == null ? "—" : Number(v).toLocaleString("ja-JP"));
const cny = (v) => (v == null ? "—" : `${v.toFixed(1)}元`);

const WORKFLOW = "update.yml";
const CONFIG_PATH = "docs/data/config.enc.json";
const RESULTS_PATH = "docs/data/results.enc.json";
const LS = { pw: "mr_password", token: "mr_token", repo: "mr_repo" };
const DEFAULTS = { min_profit: 300, intl_yen: 100, ship_yen: 210 };
const MARK = { go: "◎", maybe: "△", no: "×", unknown: "?" };
const VERDICT = { go: "おすすめ", maybe: "候補", no: "見送り", unknown: "データ不足" };
const ORDER = { go: 0, maybe: 1, no: 2, unknown: 3 };

const state = {
  password: "", token: "", repo: "",
  config: null, configSha: null, results: { items: {} },
  rows: [], filter: "go", open: null,
  run: { active: false, expectUntil: 0, lastFailed: null },
  pollTimer: null,
};

/* ---------------- 小物 ---------------- */
function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}
function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "たった今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}
const settings = () => ({ ...DEFAULTS, ...(state.config?.settings || {}) });
const canEdit = () => !!state.token && !!state.repo;
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
    const e = new Error(
      res.status === 401 ? "GitHubトークンが無効か、期限切れです"
      : res.status === 403 ? "トークンの権限が足りません（Contents と Actions を Read and write に）"
      : res.status === 404 ? "リポジトリが見つかりません（名前とトークンの対象を確認）"
      : res.status === 409 || res.status === 422 ? "ほかの端末で同時に更新されました。もう一度やり直してください"
      : `GitHubエラー ${res.status} ${msg}`);
    e.status = res.status;
    throw e;
  }
  return raw ? res.text() : res.json();
}

async function readEnc(path) {
  if (canEdit()) {
    try {
      const meta = await gh(`/repos/${state.repo}/contents/${path}?ref=main`);
      const text = meta.content ? Crypto.b64ToStr(meta.content) : await gh(`/repos/${state.repo}/contents/${path}?ref=main`, { raw: true });
      return { env: JSON.parse(text), sha: meta.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  const res = await fetch(`${path.replace(/^docs\//, "")}?t=${Date.now()}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`データを読めませんでした（${res.status}）`);
  return { env: await res.json(), sha: null };
}

function normalizeConfig(c) {
  c = c || {};
  c.settings = { ...DEFAULTS, ...(c.settings || {}) };
  c.extra_keywords = c.extra_keywords || (c.candidates || []).map((x) => x.keyword).filter(Boolean);
  c.hidden = c.hidden || [];
  delete c.candidates;
  c.version = 2;
  return c;
}

async function loadAll() {
  const [cf, rs] = await Promise.all([readEnc(CONFIG_PATH), readEnc(RESULTS_PATH)]);
  state.config = normalizeConfig(cf ? await Crypto.decrypt(cf.env, state.password) : null);
  state.configSha = cf?.sha ?? null;
  state.results = rs ? await Crypto.decrypt(rs.env, state.password) : { items: {} };
  buildRows();
}

async function saveConfig(message) {
  const env = await Crypto.encrypt(state.config, state.password);
  const body = { message, content: Crypto.strToB64(JSON.stringify(env) + "\n"), branch: "main" };
  if (state.configSha) body.sha = state.configSha;
  try {
    const res = await gh(`/repos/${state.repo}/contents/${CONFIG_PATH}`, { method: "PUT", body });
    state.configSha = res.content.sha;
  } catch (e) {
    if (e.status === 409 || e.status === 422) await loadAll().catch(() => {});
    throw e;
  }
}

/* ---------------- Actions の実行状況 ---------------- */
function expectRun() {
  state.run.expectUntil = Date.now() + 90_000;
  renderProgress();
  schedulePoll(3000);
}
function schedulePoll(ms) {
  clearTimeout(state.pollTimer);
  if (canEdit()) state.pollTimer = setTimeout(pollRuns, ms);
}
async function pollRuns() {
  const wasActive = state.run.active;
  try {
    const r = await gh(`/repos/${state.repo}/actions/workflows/${WORKFLOW}/runs?per_page=5`);
    const runs = r.workflow_runs || [];
    state.run.active = runs.some((x) => x.status !== "completed");
    const latest = runs.find((x) => x.status === "completed");
    state.run.lastFailed = latest && latest.conclusion === "failure" ? latest : null;
    if (state.run.active) state.run.expectUntil = 0;
    if (wasActive && !state.run.active) {
      await loadAll();
      render();
      toast(state.run.lastFailed ? "調べるのに失敗しました（設定→実行履歴）" : "調べ終わりました");
    }
  } catch (e) { console.warn(e); }
  renderProgress();
  renderHeader();
  schedulePoll(state.run.active || Date.now() < state.run.expectUntil ? 8000 : 60000);
}
function renderProgress() {
  const busy = state.run.active || Date.now() < state.run.expectUntil;
  $("#progress").hidden = !busy;
  $("#progressText").textContent = state.run.active
    ? "メルカリを調べています…（10分ほど。閉じても大丈夫）"
    : "調べる準備をしています…";
}

/* ---------------- データ → 行 ---------------- */
function buildRows() {
  const s = settings();
  const rate = state.results.cny_jpy || 21;
  state.rows = Object.values(state.results.items || {})
    .filter((it) => !state.config.hidden.includes(it.keyword))
    .map((it) => ({ ...it, j: it.metrics ? judge(it.metrics, s, rate) : { verdict: "unknown" } }))
    .sort((a, b) =>
      ORDER[a.j.verdict] - ORDER[b.j.verdict]
      || (b.metrics?.sold_recent ?? -1) - (a.metrics?.sold_recent ?? -1));
}

/* ---------------- 画面 ---------------- */
function renderHeader() {
  const gen = state.results.generated_at;
  let t = gen ? `${ago(gen)}に調べました` : "まだ調べていません";
  if (state.run.lastFailed) t += "・前回失敗";
  $("#genAt").textContent = t;
}

function render() {
  renderHeader();
  const counts = { go: 0, maybe: 0, all: state.rows.length };
  state.rows.forEach((r) => { if (r.j.verdict in counts) counts[r.j.verdict]++; });
  $("#cntGo").textContent = counts.go;
  $("#cntMaybe").textContent = counts.maybe;
  $("#cntAll").textContent = counts.all;
  $$(".chip").forEach((c) => c.classList.toggle("on", c.dataset.filter === state.filter));

  const rows = state.rows.filter((r) => state.filter === "all" || r.j.verdict === state.filter);
  $("#list").hidden = rows.length === 0;
  $("#list").innerHTML = rows.map((r) => {
    const m = r.metrics, j = r.j;
    const pos = j.limit_yen != null && j.limit_yen > 0;
    return `<li><button class="row" data-kw="${esc(r.keyword)}">
      <span class="mark ${j.verdict}" aria-label="${VERDICT[j.verdict]}">${MARK[j.verdict]}</span>
      <span class="row-main">
        <span class="kw">${esc(r.keyword)}${r.source === "found" ? '<span class="tag">発見</span>' : r.source === "user" ? '<span class="tag">追加</span>' : ""}</span>
        <span class="meta num">${m ? `30日で${num(m.sold_recent)}${m.sold_capped ? "+" : ""}個売れた・相場${yen(m.price_median)}` : esc(r.error || "データなし")}</span>
      </span>
      <span class="limit num">
        <span class="k">仕入れ上限</span>
        ${pos ? `<span class="v">${cny(j.limit_cny)}</span><span class="y">${yen(j.limit_yen)}</span>` : `<span class="v neg">利益なし</span>`}
      </span>
    </button></li>`;
  }).join("");

  const empty = $("#empty");
  empty.hidden = rows.length > 0;
  if (!state.rows.length) {
    empty.innerHTML = state.results.generated_at
      ? "データがありません。"
      : `まだ調べていません。${canEdit() ? `<br><br><button class="btn primary" id="firstRun">今すぐ調べる</button><br><br><small>10分ほどかかります。以降は毎朝6時に自動で調べます</small>` : "<br>毎朝6時に自動で調べます"}`;
    $("#firstRun")?.addEventListener("click", runNow);
  } else {
    empty.textContent = state.filter === "go" ? "今は「おすすめ」がありません。「候補」も見てみてください" : "ありません";
  }
  const rate = state.results.cny_jpy;
  $("#foot").textContent = state.rows.length
    ? `仕入れ上限＝この値段以下で仕入れれば1個${num(settings().min_profit)}円以上もうかる（手数料・送料込み）${rate ? `／1元＝${rate}円` : ""}`
    : "";
  if (state.open === "settings") openSettings(true);
  else if (state.open) openDetail(state.open, true);
}

$$(".chip").forEach((c) => c.addEventListener("click", () => { state.filter = c.dataset.filter; render(); }));
$("#list").addEventListener("click", (e) => {
  const b = e.target.closest(".row");
  if (b) openDetail(b.dataset.kw);
});

/* ---------------- シート ---------------- */
function showSheet(title, html, keepScroll) {
  const sh = $("#sheet");
  const top = keepScroll ? sh.scrollTop : 0;
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = html;
  sh.hidden = false;
  document.body.style.overflow = "hidden";
  sh.scrollTop = top;
}
function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
  state.open = null;
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

function mercariURL(kw) {
  const p = new URLSearchParams({ keyword: kw, status: "sold_out", item_condition_id: "1" });
  return `https://jp.mercari.com/search?${p}`;
}

function openDetail(kw, keep = false) {
  const r = state.rows.find((x) => x.keyword === kw);
  if (!r) return closeSheet();
  state.open = kw;
  const m = r.metrics, j = r.j, s = settings();
  const pos = j.limit_yen != null && j.limit_yen > 0;
  const st = m?.sell_through == null ? "—" : m.sell_through >= 99 ? "競合なし" : m.sell_through.toFixed(2);
  const html = !m ? `<div class="panel"><p class="err">${esc(r.error || "まだデータがありません")}</p></div>` : `
    <div class="panel hero">
      <span class="verdict ${j.verdict}">${MARK[j.verdict]} ${VERDICT[j.verdict]}</span>
      <div class="k">仕入れ上限（1個あたり）</div>
      <div class="big num">${pos ? cny(j.limit_cny) : "利益なし"}</div>
      ${pos ? `<div class="y num">${yen(j.limit_yen)}</div>` : ""}
      <p class="why num">相場${yen(m.price_median)}で売ると、手数料${yen(j.fee)}・送料${yen(s.ship_yen)}・国際送料${yen(s.intl_yen)}を引いて、<br>この値段以下で仕入れれば1個${yen(s.min_profit)}以上もうかります</p>
      ${r.cn ? `<div class="cn">中国語：<b>${esc(r.cn)}</b></div>` : ""}
    </div>
    <div class="actions">
      ${r.url_1688 ? `<a class="btn primary" href="${esc(r.url_1688)}" target="_blank" rel="noopener">1688で探す</a>` : `<a class="btn primary" href="https://s.1688.com/" target="_blank" rel="noopener">1688を開く</a>`}
      <a class="btn" href="${mercariURL(r.keyword)}" target="_blank" rel="noopener">メルカリで見る</a>
    </div>
    <div class="panel">
      <div class="facts num">
        <div><div class="k">30日で売れた</div><div class="v">${num(m.sold_recent)}${m.sold_capped ? "個以上" : "個"}</div></div>
        <div><div class="k">今の出品数</div><div class="v">${num(m.on_sale_total)}件</div></div>
        <div><div class="k">よく売れる価格</div><div class="v">${m.price_p25 == null ? "—" : `${num(m.price_p25)}〜${num(m.price_p75)}円`}</div></div>
        <div><div class="k">売れやすさ</div><div class="v">${st}</div></div>
        <div><div class="k">売れるまで</div><div class="v">${m.days_to_sell_median == null ? "—" : `${m.days_to_sell_median}日`}</div></div>
        <div><div class="k">出品中の最安値</div><div class="v">${yen(m.on_sale_min)}</div></div>
      </div>
      <p class="note">売れやすさ＝売れた数÷今の出品数。0.3以上なら競合が少なめ${r.parent ? `／「${esc(r.parent)}」の売れた商品によく出てくる言葉から見つけました` : ""}</p>
    </div>
    ${r.samples?.length ? `<div class="panel"><h3>最近売れた商品</h3><ul class="items">${r.samples.map((x) => `
      <li><a href="https://jp.mercari.com/item/${encodeURIComponent(x.id)}" target="_blank" rel="noopener">
        ${x.thumbnail ? `<img src="${esc(x.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg"></span>'}
        <span><span class="nm">${esc(x.name)}</span><span class="when">${ago(x.sold_at)}に売れた</span></span>
        <span class="pr num">${yen(x.price)}</span></a></li>`).join("")}</ul></div>` : ""}`;
  showSheet(r.keyword, html + (canEdit() ? `<button class="btn link" id="hideKw" style="width:100%">このキーワードを表示しない</button>` : ""), keep);
  $("#hideKw")?.addEventListener("click", async () => {
    state.config.hidden.push(kw);
    try {
      await saveConfig(`非表示: ${kw}`);
      closeSheet(); buildRows(); render();
      toast("表示しないようにしました（設定から戻せます）");
    } catch (e) { state.config.hidden.pop(); toast(e.message); }
  });
}

/* ---------------- 設定 ---------------- */
$("#openSettings").addEventListener("click", () => openSettings());
function openSettings(keep = false) {
  state.open = "settings";
  const s = settings(), c = state.config, ed = canEdit();
  const dis = ed ? "" : "disabled";
  showSheet("設定", `
    ${ed ? `<button class="btn primary" id="runNow" style="width:100%;margin-bottom:12px" ${state.run.active ? "disabled" : ""}>今すぐ調べる</button>` : ""}
    <div class="panel">
      <h3>もうけの目安</h3>
      <form id="sForm" class="form">
        <label>1個あたりの目標利益（円）<input name="min_profit" type="number" min="0" inputmode="numeric" value="${s.min_profit}" ${dis}></label>
        <div class="row2">
          <label>国際送料・代行（円／個）<input name="intl_yen" type="number" min="0" inputmode="numeric" value="${s.intl_yen}" ${dis}></label>
          <label>国内送料（円）<input name="ship_yen" type="number" min="0" inputmode="numeric" value="${s.ship_yen}" ${dis}></label>
        </div>
        ${ed ? `<button class="btn" type="submit">保存</button>` : ""}
      </form>
      <p class="note">国内送料はネコポスなら210円。保存するとすぐ計算し直します。</p>
    </div>
    <div class="panel">
      <h3>自分でも調べたいキーワード</h3>
      ${ed ? `<form id="kwForm" class="inline"><input name="kw" placeholder="例：キーホルダー パール" maxlength="60"><button class="btn small" type="submit">追加</button></form>` : ""}
      <ul class="kwlist">${c.extra_keywords.map((k) => `<li>${esc(k)}${ed ? `<button data-rm="${esc(k)}" aria-label="削除">×</button>` : ""}</li>`).join("") || '<li style="background:none;padding-left:0;color:var(--text-3)">なし</li>'}</ul>
      <p class="note">ふだんは約50ジャンルと、そこから見つけた売れ筋を自動で調べています。</p>
    </div>
    ${c.hidden.length ? `<div class="panel"><h3>表示しないキーワード</h3><ul class="kwlist">${c.hidden.map((k) => `<li>${esc(k)}${ed ? `<button data-unhide="${esc(k)}" aria-label="戻す">↺</button>` : ""}</li>`).join("")}</ul></div>` : ""}
    <div class="panel">
      <h3>接続</h3>
      <p class="note" style="margin-top:0">${esc(state.repo || "未設定")}・${ed ? "編集できます" : "見るだけ（トークンなし）"}</p>
      <div class="actions" style="margin:10px 0 0">
        <a class="btn small" href="https://github.com/${esc(state.repo)}/actions" target="_blank" rel="noopener">実行履歴</a>
        <button class="btn small" id="relogin">接続を変える</button>
      </div>
    </div>`, keep);

  $("#runNow")?.addEventListener("click", runNow);
  $("#sForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, before = { ...state.config.settings };
    for (const k of ["min_profit", "intl_yen", "ship_yen"]) {
      const v = parseInt(f[k].value, 10);
      if (!Number.isFinite(v) || v < 0) return toast("数字を入れてください");
      state.config.settings[k] = v;
    }
    try { await saveConfig("設定を変更"); buildRows(); render(); toast("保存しました"); }
    catch (err) { state.config.settings = before; toast(err.message); }
  });
  $("#kwForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kw = e.target.kw.value.replace(/\s+/g, " ").trim();
    if (!kw) return;
    if (c.extra_keywords.includes(kw)) return toast("もう入っています");
    c.extra_keywords.push(kw);
    c.hidden = c.hidden.filter((x) => x !== kw);
    try { await saveConfig(`キーワード追加: ${kw}`); expectRun(); openSettings(true); toast("追加しました。数分で結果が出ます"); }
    catch (err) { c.extra_keywords.pop(); toast(err.message); }
  });
  $$("[data-rm]").forEach((b) => b.addEventListener("click", async () => {
    const before = [...c.extra_keywords];
    c.extra_keywords = c.extra_keywords.filter((x) => x !== b.dataset.rm);
    try { await saveConfig(`キーワード削除: ${b.dataset.rm}`); openSettings(true); }
    catch (err) { c.extra_keywords = before; toast(err.message); }
  }));
  $$("[data-unhide]").forEach((b) => b.addEventListener("click", async () => {
    const before = [...c.hidden];
    c.hidden = c.hidden.filter((x) => x !== b.dataset.unhide);
    try { await saveConfig(`表示に戻す: ${b.dataset.unhide}`); buildRows(); render(); openSettings(true); }
    catch (err) { c.hidden = before; toast(err.message); }
  }));
  $("#relogin").addEventListener("click", () => showSetup());
}

async function runNow() {
  try {
    await gh(`/repos/${state.repo}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main" } });
    expectRun();
    closeSheet();
    toast("調べ始めました（10分ほどかかります）");
  } catch (e) { toast(e.message); }
}

/* ---------------- ログイン ---------------- */
function go(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $("#openSettings").hidden = view !== "list";
}
function showSetup(err) {
  closeSheet();
  const f = $("#setupForm");
  f.password.value = state.password;
  f.token.value = state.token;
  f.repo.value = state.repo || guessRepo();
  $("#setupErr").textContent = err || "";
  $("#setupErr").hidden = !err;
  $("#genAt").textContent = "";
  go("setup");
}
$("#setupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  state.password = f.password.value;
  state.token = f.token.value.replace(/[\s​-‍⁠﻿]/g, "");
  f.token.value = state.token;
  state.repo = f.repo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
  const btn = $("#setupBtn");
  btn.disabled = true;
  btn.textContent = "確認中…";
  try {
    if (state.token) {
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(state.token)) {
        throw new Error(`トークンの形が正しくありません（github_pat_ で始まるはず。今は${state.token.length}文字）`);
      }
      if (!state.repo) throw new Error("リポジトリを入れてください");
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
    btn.disabled = false;
    btn.textContent = "はじめる";
  }
});

function start() {
  go("list");
  render();
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
