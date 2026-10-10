/* =========================================================
 * app.js — 詰め将棋道場 フロントエンド
 * 設定は js/config.js（GAS_URL を空にすると内蔵サンプル問題だけで動作）
 * ========================================================= */
'use strict';

const CONFIG = window.APP_CONFIG || {};
const GAS_URL = CONFIG.GAS_URL || '';
const HUB_URL = CONFIG.HUB_URL || 'https://kenken6291.github.io/retro-arcade-hub/';
const APP_VERSION = CONFIG.APP_VERSION || '-';
const APP_UPDATED = CONFIG.APP_UPDATED || '';
const PAGE_SIZE = 100;
const LS_CLEARED = 'tsumeShogi.cleared';
const LS_FILTER = 'tsumeShogi.filter';
const SOLVER_BUDGET = 150000;

/* 内蔵サンプル（GAS未設定時・オフライン時に使用） */
const SAMPLE_PROBLEMS = [
  { id: 1, moves: 1, difficulty: 1, title: '頭金', comment: '玉の頭に金を打つ基本形。',
    sfen: '4k4/9/4P4/9/9/9/9/9/9 b G2r2b3g4s4n4l17p 1', solution: 'G*5b' },
  { id: 2, moves: 3, difficulty: 2, title: '', comment: '',
    sfen: '9/6Rp1/6+B1k/9/9/9/9/9/9 b Nrb4g4s3n4l17p 1', solution: '3b2b+ 1c1d 2b2c' },
  { id: 3, moves: 3, difficulty: 2, title: '', comment: '',
    sfen: '7n1/6kn1/4+B2b1/9/9/9/9/9/9 b GL2r3g4s2n3l18p 1', solution: 'G*4c 3b4a 5c4b' },
  { id: 4, moves: 5, difficulty: 3, title: '', comment: '',
    sfen: '8k/9/9/7N1/9/9/9/9/9 b Rr2b4g4s3n4l18p 1', solution: 'R*1b 1a2a 1b3b+ 2a1a 3b1b' },
  { id: 5, moves: 7, difficulty: 4, title: '', comment: '',
    sfen: '6kp1/5b3/4+B+P3/4R4/9/9/9/9/9 b Nr4g4s3n4l16p 1', solution: '5c4b 3a2b 4b3c 2b1c N*2e 1c1b B*2c' },
];

const S = window.Shogi;
if (!S) throw new Error('shogi.js が読み込まれていません');
const $ = (sel) => document.querySelector(sel);

const state = {
  filter: '1', list: [], page: 0, meta: null,
  problem: null, start: null, pos: null, attacker: 0,
  solution: [], ply: 0, onLine: true, remaining: 0,
  history: [], kifu: [], lastTo: null,
  sel: null, targets: [], finished: false, failed: false, busy: false,
  peeked: false, wrongInfo: null, aiCache: {},
};

/* ---------------- 保存 ---------------- */
function loadCleared() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_CLEARED) || '[]')); } catch (e) { return new Set(); }
}
function saveCleared(set) {
  try { localStorage.setItem(LS_CLEARED, JSON.stringify([...set])); } catch (e) { /* 保存不可でも続行 */ }
}
let cleared = loadCleared();
try { state.filter = localStorage.getItem(LS_FILTER) || '1'; } catch (e) { /* noop */ }

/* ---------------- API ---------------- */
function matchFilter(moves, f) {
  if (f === 'all') return true;
  if (f === '9+') return moves >= 9;
  return moves === Number(f);
}
function localApi(params) {
  const P = SAMPLE_PROBLEMS;
  switch (params.action) {
    case 'meta': {
      const counts = {};
      P.forEach((p) => { counts[p.moves] = (counts[p.moves] || 0) + 1; });
      return { ok: true, total: P.length, counts, sample: true };
    }
    case 'list':
      return { ok: true, items: P.filter((p) => matchFilter(p.moves, params.moves))
        .map(({ id, moves, difficulty, title }) => ({ id, moves, difficulty, title })) };
    case 'get': {
      const p = P.find((x) => x.id === Number(params.id));
      return p ? { ok: true, problem: p } : { ok: false, error: '問題が見つかりません' };
    }
    default: return { ok: false, error: '不明なaction' };
  }
}
async function apiGet(params) {
  if (!GAS_URL) return localApi(params);
  const res = await fetch(GAS_URL + '?' + new URLSearchParams(params).toString());
  if (!res.ok) throw new Error('通信エラー (' + res.status + ')');
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'サーバーエラー');
  return j;
}
async function apiPost(body) {
  if (!GAS_URL) throw new Error('AI機能はGASを設定すると使えます。');
  const res = await fetch(GAS_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('通信エラー (' + res.status + ')');
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'サーバーエラー');
  return j;
}

/* ---------------- 画面切替 ---------------- */
function show(view) {
  $('#view-list').hidden = view !== 'list';
  $('#view-play').hidden = view !== 'play';
  window.scrollTo(0, 0);
}

/* ---------------- 一覧画面 ---------------- */
function renderVersion() {
  const parts = ['v' + APP_VERSION + (APP_UPDATED ? '（' + APP_UPDATED + '）' : '')];
  if (!GAS_URL) parts.push('サンプルモード');
  else if (state.meta) {
    if (state.meta.apiVersion) parts.push('API v' + state.meta.apiVersion);
    if (state.meta.updated) parts.push('問題データ ' + state.meta.updated);
  } else parts.push('API 未接続');
  $('#version').textContent = parts.join('　');
}

async function initList() {
  renderVersion();
  renderFilters();
  try {
    state.meta = await apiGet({ action: 'meta' });
    renderFilters();
    renderVersion();
    $('#list-note').textContent = state.meta.sample
      ? 'サンプル問題で動作中です（GAS未設定）。'
      : '全' + state.meta.total.toLocaleString() + '問　クリア済み ' + cleared.size + '問';
  } catch (e) {
    $('#list-note').textContent = '問題情報を読み込めませんでした：' + e.message;
  }
  await loadList();
}
function renderFilters() {
  const counts = (state.meta && state.meta.counts) || {};
  const sum9 = Object.keys(counts).filter((k) => +k >= 9).reduce((a, k) => a + counts[k], 0);
  const defs = [
    ['1', '1手詰', counts[1]], ['3', '3手詰', counts[3]], ['5', '5手詰', counts[5]],
    ['7', '7手詰', counts[7]], ['9+', '9手以上', sum9], ['all', 'すべて', state.meta && state.meta.total],
  ];
  $('#filters').innerHTML = defs.map(([v, label, n]) =>
    `<button class="tab" role="tab" aria-selected="${state.filter === v}" data-f="${v}">${label}` +
    (n != null ? `<small>${n}</small>` : '') + '</button>').join('');
}
async function loadList() {
  $('#grid').innerHTML = '<p class="loading">読み込み中…</p>';
  try {
    const j = await apiGet({ action: 'list', moves: state.filter });
    state.list = j.items || [];
    state.page = 0;
    renderList();
  } catch (e) {
    $('#grid').innerHTML = `<p class="err">一覧を読み込めませんでした：${escapeHtml(e.message)}</p>`;
  }
}
function renderList() {
  const items = state.list;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const slice = items.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const done = items.filter((p) => cleared.has(p.id)).length;
  $('#progress').textContent = items.length ? `この区分 ${done} / ${items.length} 問クリア` : '';
  $('#grid').innerHTML = slice.length ? slice.map((p) =>
    `<button class="qbtn${cleared.has(p.id) ? ' done' : ''}" data-id="${p.id}" title="${p.moves}手詰${p.title ? ' ' + escapeHtml(p.title) : ''}">` +
    `<span>${p.id}</span><em>${p.moves}手</em></button>`).join('')
    : '<p class="loading">この区分の問題はまだありません。</p>';
  $('#pager').innerHTML = pages > 1
    ? `<button data-p="${state.page - 1}" ${state.page === 0 ? 'disabled' : ''}>前へ</button>` +
      `<span>${state.page + 1} / ${pages}</span>` +
      `<button data-p="${state.page + 1}" ${state.page >= pages - 1 ? 'disabled' : ''}>次へ</button>`
    : '';
}
function pickRandomId() {
  if (!state.list.length) return null;
  const notYet = state.list.filter((p) => !cleared.has(p.id) && (!state.problem || p.id !== state.problem.id));
  const pool = notYet.length ? notYet : state.list;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/* ---------------- 問題開始 ---------------- */
async function openProblem(id) {
  show('play');
  setMsg('問題を読み込んでいます…');
  $('#board').innerHTML = '';
  try {
    const j = await apiGet({ action: 'get', id });
    setupProblem(j.problem);
  } catch (e) {
    setMsg('読み込めませんでした：' + e.message, 'bad');
  }
}

function setupProblem(p) {
  state.problem = p;
  try { state.start = S.parseSFEN(p.sfen); }
  catch (e) { setMsg('この問題のSFENが読めません：' + e.message, 'bad'); return; }
  state.attacker = state.start.turn;
  state.solution = String(p.solution || '').trim().split(/\s+/).filter(Boolean);
  state.peeked = false;
  resetPosition();
  $('#q-title').textContent = `第${p.id}問`;
  $('#q-moves').textContent = `${p.moves || state.solution.length || '?'}手詰`;
  $('#q-memo').textContent = p.title || '';

  if (!state.solution.length) {
    // 解答未登録の問題は探索で手順を作る
    state.busy = true;
    setMsg('解答手順を計算しています…');
    setTimeout(() => {
      try {
        const line = S.solve(state.start, p.moves || 9, 800000);
        if (line && line.length) {
          state.solution = line;
          if (!p.moves) $('#q-moves').textContent = `${line.length}手詰`;
          resetPosition();
          setMsg(openingMessage());
        } else setMsg('この問題は手順を計算できませんでした。自由に指して確かめられます。', 'bad');
      } catch (e) { setMsg('手順の計算が時間内に終わりませんでした。', 'bad'); }
      state.busy = false;
    }, 30);
  } else setMsg(openingMessage());
}
function openingMessage() {
  const side = state.attacker === 0 ? '先手' : '後手';
  return `${side}番です。王手の連続で玉を詰ませてください。`;
}
function resetPosition() {
  state.pos = state.start;
  state.ply = 0; state.onLine = true;
  state.remaining = state.problem.moves || state.solution.length || 9;
  state.history = []; state.kifu = []; state.lastTo = null;
  state.sel = null; state.targets = [];
  state.finished = false; state.failed = false; state.wrongInfo = null;
  $('#after').hidden = true; $('#stamp').hidden = true;
  $('#btn-explain').hidden = true;
  renderAll();
}

/* ---------------- 描画 ---------------- */
function renderAll() { renderBoard(); renderHands(); renderKifu(); renderButtons(); }

function pieceHtml(p, extra) {
  const k = S.keyOf(p);
  const gote = S.sideOf(p) === 1;
  const ch = (k === 'K' && !gote) ? '王' : S.KANJI_BOARD[k];
  return `<span class="pc${gote ? ' gote' : ''}${S.isPromoted(p) ? ' prom' : ''}${extra || ''}"><b>${ch}</b></span>`;
}
function renderBoard() {
  const B = state.pos.board;
  const tset = new Set(state.targets.map((m) => m.to[0] * 9 + m.to[1]));
  let h = '';
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const p = B[r][c];
    const cls = ['sq'];
    if (state.sel && state.sel.type === 'board' && state.sel.r === r && state.sel.c === c) cls.push('sel');
    if (tset.has(r * 9 + c)) cls.push(p ? 'tgt cap' : 'tgt');
    if (state.lastTo && state.lastTo[0] === r && state.lastTo[1] === c) cls.push('last');
    const label = (9 - c) + S.KAN[r] + (p ? ' ' + (S.sideOf(p) ? '後手' : '先手') + S.KANJI_KIFU[S.keyOf(p)] : '');
    h += `<button class="${cls.join(' ')}" data-r="${r}" data-c="${c}" aria-label="${label}">${p ? pieceHtml(p) : ''}</button>`;
  }
  $('#board').innerHTML = h;
}
function renderHands() {
  [0, 1].forEach((side) => {
    const el = side === 0 ? $('#hand-sente') : $('#hand-gote');
    const hand = state.pos.hands[side];
    const mine = side === state.attacker;
    const items = S.HAND_ORDER.filter((t) => hand[t] > 0).map((t) => {
      const sel = state.sel && state.sel.type === 'hand' && state.sel.t === t && mine;
      return `<button class="hp${sel ? ' sel' : ''}" data-t="${t}" ${mine ? '' : 'tabindex="-1"'} aria-label="${S.KANJI_KIFU[t]} ${hand[t]}枚">` +
        pieceHtml(side === 0 ? t : t.toLowerCase(), ' small') + (hand[t] > 1 ? `<i>${hand[t]}</i>` : '') + '</button>';
    });
    el.innerHTML = items.length ? items.join('') : '<span class="none">なし</span>';
    el.classList.toggle('mine', mine);
  });
}
function renderKifu() {
  $('#kifu').innerHTML = state.kifu.length
    ? state.kifu.map((k, i) => `<span${state.failed && i >= state.kifu.length - 2 ? ' class="ng"' : ''}>${k}</span>`).join('')
    : '<span class="dim">初手を指してください</span>';
}
function renderButtons() {
  $('#btn-undo').disabled = !state.history.length || state.busy;
  $('#btn-reset').disabled = state.busy;
  $('#btn-hint').disabled = state.busy || state.finished || state.failed || !state.solution.length;
  $('#btn-answer').disabled = state.busy || !state.solution.length;
}
function setMsg(text, tone) {
  const el = $('#msg');
  el.textContent = text;
  el.className = 'msg' + (tone ? ' ' + tone : '');
}

/* ---------------- 操作 ---------------- */
function canAct() {
  return !state.busy && !state.finished && !state.failed && state.pos.turn === state.attacker;
}
function onBoardClick(r, c) {
  if (!canAct()) return;
  const p = state.pos.board[r][c];
  const hit = state.targets.filter((m) => m.to[0] === r && m.to[1] === c);
  if (hit.length) { choosePromotion(hit).then((m) => { if (m) tryMove(m); }); return; }
  if (p && S.sideOf(p) === state.attacker) {
    if (state.sel && state.sel.type === 'board' && state.sel.r === r && state.sel.c === c) clearSel();
    else {
      state.sel = { type: 'board', r, c };
      state.targets = S.legalMoves(state.pos).filter((m) => m.from && m.from[0] === r && m.from[1] === c);
    }
  } else clearSel();
  renderBoard(); renderHands();
}
function onHandClick(t) {
  if (!canAct()) return;
  if (state.sel && state.sel.type === 'hand' && state.sel.t === t) clearSel();
  else {
    state.sel = { type: 'hand', t };
    state.targets = S.legalMoves(state.pos).filter((m) => m.drop === t);
  }
  renderBoard(); renderHands();
}
function clearSel() { state.sel = null; state.targets = []; }

function choosePromotion(cands) {
  if (cands.length === 1) return Promise.resolve(cands[0]);
  const dlg = $('#promo');
  const p = cands[0].piece;
  const side = S.sideOf(p);
  $('#promo-yes').innerHTML = pieceHtml(side === 0 ? '+' + S.baseOf(p) : '+' + S.baseOf(p).toLowerCase()) + '<span>成る</span>';
  $('#promo-no').innerHTML = pieceHtml(p) + '<span>成らない</span>';
  return new Promise((resolve) => {
    const done = (v) => {
      dlg.close();
      $('#promo-yes').onclick = $('#promo-no').onclick = null;
      dlg.oncancel = null;
      resolve(v);
    };
    $('#promo-yes').onclick = () => done(cands.find((m) => m.promote));
    $('#promo-no').onclick = () => done(cands.find((m) => !m.promote));
    dlg.oncancel = (ev) => { ev.preventDefault(); done(null); };
    dlg.showModal();
  });
}

function snapshot() {
  return { pos: state.pos, ply: state.ply, onLine: state.onLine, remaining: state.remaining,
    kifu: state.kifu.slice(), lastTo: state.lastTo };
}
function play(m) {
  state.kifu.push(S.moveToJa(state.pos, m, state.lastTo));
  state.lastTo = m.to;
  state.pos = S.makeMove(state.pos, m);
}

function tryMove(m) {
  clearSel();
  const before = state.pos;
  const np = S.makeMove(before, m);
  if (!S.inCheck(np, np.turn)) {
    renderAll();
    setMsg('王手になっていません。詰め将棋では攻め方は毎回王手をかけます。', 'bad');
    return;
  }
  const usi = S.moveToUSI(m);
  const expected = state.onLine ? state.solution[state.ply] : null;
  let ok = expected && usi === expected;
  let alt = false, unsure = false;
  if (!ok) {
    try {
      ok = S.andNode(np, state.remaining - 1, S.makeCtx(SOLVER_BUDGET));
      alt = ok;
    } catch (e) { if (e === S.BUDGET) unsure = true; else throw e; }
  }
  state.history.push(snapshot());

  if (!ok) { handleWrong(before, m, np, unsure); return; }

  play(m);
  state.remaining -= 1;
  if (alt) state.onLine = false; else state.ply += 1;

  if (S.isMated(state.pos)) { handleSolved(); return; }
  setMsg(alt ? 'それでも詰みます。続けてください。' : 'よい手です。玉方の応手を待っています…', 'good');
  renderAll();
  defenderReply();
}

function defenderReply() {
  state.busy = true; renderButtons();
  setTimeout(() => {
    let m = null;
    if (state.onLine && state.solution[state.ply]) m = S.findMoveByUSI(state.pos, state.solution[state.ply]);
    if (m) {
      state.ply += 1;
    } else {
      state.onLine = false;
      try {
        const d = S.bestDefense(state.pos, state.remaining, S.makeCtx(SOLVER_BUDGET * 2));
        m = d.m;
        if (isFinite(d.len) && d.len > 0) state.remaining = d.len + 1;
      } catch (e) {
        m = S.legalMoves(state.pos)[0];
      }
    }
    play(m);
    state.remaining -= 1;
    state.busy = false;
    setMsg(`玉方は ${state.kifu[state.kifu.length - 1]}。次の王手をどうぞ。`);
    renderAll();
  }, 420);
}

function handleWrong(before, m, np, unsure) {
  play(m);
  state.failed = true;
  let refute = null;
  try { refute = S.refutation(np, state.remaining - 1, S.makeCtx(SOLVER_BUDGET)); } catch (e) { /* 予算切れ */ }
  const wrongJa = state.kifu[state.kifu.length - 1];
  let refuteJa = '';
  if (refute) {
    refuteJa = S.moveToJa(state.pos, refute, state.lastTo);
    play(refute);
  }
  const correctJa = state.onLine && state.solution[state.ply]
    ? (() => { const cm = S.findMoveByUSI(before, state.solution[state.ply]); return cm ? S.moveToJa(before, cm, state.history[state.history.length - 1].lastTo) : ''; })()
    : '';
  state.wrongInfo = { sfen: S.toSFEN(before), diagram: S.toDiagram(before), wrongJa, refuteJa, correctJa,
    remaining: state.remaining, kifu: state.kifu.slice(0, -1 - (refute ? 1 : 0)) };
  renderAll();
  const why = unsure ? 'その手は正解手順と異なります。' :
    refute ? `その手では詰みません。${refuteJa} で逃れられます。` : 'その手では詰みません。';
  setMsg(why + '「一手戻す」でやり直せます。', 'bad');
  $('#btn-explain').hidden = !GAS_URL;
}

function handleSolved() {
  state.finished = true;
  renderAll();
  const p = state.problem;
  if (!state.peeked) { cleared.add(p.id); saveCleared(cleared); }
  setMsg(state.peeked ? '詰みました。次は答えを見ずに挑戦してみましょう。'
    : `詰みました！ ${state.kifu.length}手で正解です。`, 'good');
  if (p.comment) setMsg($('#msg').textContent + '　' + p.comment, 'good');
  const st = $('#stamp');
  st.hidden = false;
  st.classList.remove('on'); void st.offsetWidth; st.classList.add('on');
  $('#after').hidden = false;
  renderList();
}

function undo() {
  if (!state.history.length || state.busy) return;
  // 攻め方の手番まで戻す
  let s = state.history.pop();
  while (s.pos.turn !== state.attacker && state.history.length) s = state.history.pop();
  Object.assign(state, { pos: s.pos, ply: s.ply, onLine: s.onLine, remaining: s.remaining, kifu: s.kifu, lastTo: s.lastTo });
  state.finished = false; state.failed = false; state.wrongInfo = null;
  clearSel();
  $('#after').hidden = true; $('#stamp').hidden = true; $('#btn-explain').hidden = true;
  setMsg('一手戻しました。');
  renderAll();
}

function showAnswer() {
  if (!state.solution.length || state.busy) return;
  state.peeked = true;
  resetPosition();
  state.busy = true; renderButtons();
  setMsg('正解手順を再生します…');
  let i = 0;
  const step = () => {
    if (i >= state.solution.length) {
      state.busy = false;
      if (S.isMated(state.pos)) handleSolved();
      else { renderAll(); setMsg('手順の再生が終わりました。'); }
      return;
    }
    const m = S.findMoveByUSI(state.pos, state.solution[i]);
    if (!m) { state.busy = false; setMsg('登録された解答手順に不正な手があります（' + state.solution[i] + '）。', 'bad'); renderAll(); return; }
    state.history.push(snapshot());
    play(m); i++; state.ply = i;
    renderAll();
    setTimeout(step, 750);
  };
  setTimeout(step, 400);
}

/* ---------------- AI（Gemini） ---------------- */
async function askHint() {
  if (!canAct()) return;
  const usi = state.onLine ? state.solution[state.ply] : null;
  let m = usi ? S.findMoveByUSI(state.pos, usi) : null;
  if (!m) {
    try {
      const ctx = S.makeCtx(SOLVER_BUDGET);
      const x = S.legalPairs(state.pos).filter((y) => S.inCheck(y.np, y.np.turn))
        .find((y) => S.andNode(y.np, state.remaining - 1, ctx));
      m = x && x.m;
    } catch (e) { /* noop */ }
  }
  if (!m) { setMsg('ヒントを作れませんでした。', 'bad'); return; }
  const nextJa = S.moveToJa(state.pos, m, state.lastTo);
  const piece = S.KANJI_KIFU[m.drop || S.keyOf(m.piece)];
  if (!GAS_URL) {
    setMsg(`ヒント：${piece}を使う手を考えてみましょう。`);
    return;
  }
  const rest = state.onLine ? S.kifuFromUSI(state.pos, state.solution.slice(state.ply)) : [nextJa];
  const key = 'h' + S.toSFEN(state.pos);
  if (state.aiCache[key]) { setMsg('ヒント：' + state.aiCache[key]); return; }
  state.busy = true; renderButtons();
  setMsg('師範がヒントを考えています…');
  try {
    const j = await apiPost({ action: 'hint', problemId: state.problem.id, sfen: S.toSFEN(state.pos),
      diagram: S.toDiagram(state.pos), nextMove: nextJa, nextPiece: piece, line: rest.join(' '),
      remaining: state.remaining, played: state.kifu.join(' ') });
    state.aiCache[key] = j.text;
    setMsg('ヒント：' + j.text);
  } catch (e) {
    setMsg(`ヒント：${piece}を使う手を考えてみましょう。（AI：${e.message}）`);
  } finally { state.busy = false; renderButtons(); }
}

async function askExplain() {
  const w = state.wrongInfo;
  if (!w) return;
  const key = 'e' + w.sfen + w.wrongJa;
  if (state.aiCache[key]) { setMsg(state.aiCache[key]); return; }
  $('#btn-explain').disabled = true;
  setMsg('師範が解説を書いています…');
  try {
    const j = await apiPost({ action: 'explain', problemId: state.problem.id, sfen: w.sfen, diagram: w.diagram,
      wrongMove: w.wrongJa, refutation: w.refuteJa, correctMove: w.correctJa, remaining: w.remaining,
      played: w.kifu.join(' ') });
    state.aiCache[key] = j.text;
    setMsg(j.text, 'bad');
  } catch (e) {
    setMsg('解説を取得できませんでした：' + e.message, 'bad');
  } finally { $('#btn-explain').disabled = false; }
}

/* ---------------- 共通 ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bind() {
  $('#hub-link').href = HUB_URL;
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    state.filter = b.dataset.f;
    try { localStorage.setItem(LS_FILTER, state.filter); } catch (err) { /* noop */ }
    renderFilters(); loadList();
  });
  $('#grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]'); if (b) openProblem(Number(b.dataset.id));
  });
  $('#pager').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]'); if (!b || b.disabled) return;
    state.page = Number(b.dataset.p); renderList();
  });
  $('#btn-random').addEventListener('click', () => { const id = pickRandomId(); if (id) openProblem(id); });
  $('#board').addEventListener('click', (e) => {
    const b = e.target.closest('.sq'); if (b) onBoardClick(+b.dataset.r, +b.dataset.c);
  });
  $('#hand-sente').addEventListener('click', (e) => {
    const b = e.target.closest('.hp'); if (b && state.attacker === 0) onHandClick(b.dataset.t);
  });
  $('#hand-gote').addEventListener('click', (e) => {
    const b = e.target.closest('.hp'); if (b && state.attacker === 1) onHandClick(b.dataset.t);
  });
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-reset').addEventListener('click', () => { if (!state.busy) { resetPosition(); setMsg(openingMessage()); } });
  $('#btn-hint').addEventListener('click', askHint);
  $('#btn-answer').addEventListener('click', showAnswer);
  $('#btn-explain').addEventListener('click', askExplain);
  $('#btn-next').addEventListener('click', () => { const id = pickRandomId(); if (id) openProblem(id); });
  $('#btn-back').addEventListener('click', () => { show('list'); renderList(); });
  $('#btn-back2').addEventListener('click', () => { show('list'); renderList(); });
}

bind();
initList();
