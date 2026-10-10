/* =========================================================
 * shogi.js  — 詰め将棋用 将棋エンジン
 *  - SFEN 解析 / 出力
 *  - 合法手生成（二歩・行き所のない駒・打ち歩詰め・自玉の王手放置を除外）
 *  - USI表記 / 日本語棋譜表記
 *  - 詰み探索（別解判定・応手選択・解答手順の自動生成）
 * 座標: board[row][col]  row0=一段目(a) / col0=９筋
 * 駒: SFEN表記の文字列 ('P','+R','k' …) 大文字=先手 小文字=後手
 * ========================================================= */
(function (root) {
  'use strict';

  const HAND_ORDER = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
  const PROMOTABLE = { P: 1, L: 1, N: 1, S: 1, B: 1, R: 1 };
  const GOLD = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
  const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  const KANJI_BOARD = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
    '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍' };
  const KANJI_KIFU = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
    '+P': 'と', '+L': '成香', '+N': '成桂', '+S': '成銀', '+B': '馬', '+R': '龍' };
  const ZEN = ['０', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KAN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

  const baseOf = (p) => p.replace('+', '').toUpperCase();
  const sideOf = (p) => { const c = p[p.length - 1]; return c === c.toUpperCase() ? 0 : 1; };
  const isPromoted = (p) => p[0] === '+';
  const keyOf = (p) => (isPromoted(p) ? '+' : '') + baseOf(p);
  const inB = (r, c) => r >= 0 && r < 9 && c >= 0 && c < 9;
  const emptyHand = () => ({ R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 });

  const VEC_CACHE = {};
  function vec(p) {
    const k = keyOf(p);
    if (VEC_CACHE[k]) return VEC_CACHE[k];
    let v;
    switch (k) {
      case 'P': v = { steps: [[-1, 0]], slides: [] }; break;
      case 'L': v = { steps: [], slides: [[-1, 0]] }; break;
      case 'N': v = { steps: [[-2, -1], [-2, 1]], slides: [] }; break;
      case 'S': v = { steps: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]], slides: [] }; break;
      case 'G': case '+P': case '+L': case '+N': case '+S': v = { steps: GOLD, slides: [] }; break;
      case 'K': v = { steps: KING, slides: [] }; break;
      case 'B': v = { steps: [], slides: DIAG }; break;
      case 'R': v = { steps: [], slides: ORTHO }; break;
      case '+B': v = { steps: ORTHO, slides: DIAG }; break;
      case '+R': v = { steps: DIAG, slides: ORTHO }; break;
      default: v = { steps: [], slides: [] };
    }
    VEC_CACHE[k] = v;
    return v;
  }

  /* ---------- SFEN ---------- */
  function parseSFEN(text) {
    let s = String(text || '').trim().replace(/^position\s+/, '').replace(/^sfen\s+/, '');
    s = s.split(/\s+moves\s+/)[0];
    const parts = s.split(/\s+/);
    const rows = parts[0].split('/');
    if (rows.length !== 9) throw new Error('SFENの盤面が9段ではありません');
    const board = rows.map((row) => {
      const r = []; let prom = false;
      for (const ch of row) {
        if (/[1-9]/.test(ch)) { for (let i = 0; i < +ch; i++) r.push(null); }
        else if (ch === '+') prom = true;
        else if (/[plnsgbrkPLNSGBRK]/.test(ch)) { r.push(prom ? '+' + ch : ch); prom = false; }
        else throw new Error('SFENに不明な文字: ' + ch);
      }
      if (r.length !== 9) throw new Error('SFENの段が9マスではありません: ' + row);
      return r;
    });
    const turn = parts[1] === 'w' ? 1 : 0;
    const hands = [emptyHand(), emptyHand()];
    const h = parts[2] || '-';
    if (h !== '-') {
      let num = '';
      for (const ch of h) {
        if (/\d/.test(ch)) { num += ch; continue; }
        const n = num ? parseInt(num, 10) : 1; num = '';
        const side = ch === ch.toUpperCase() ? 0 : 1;
        const t = ch.toUpperCase();
        if (!(t in hands[side])) throw new Error('持ち駒が不正です: ' + ch);
        hands[side][t] += n;
      }
    }
    return { board, turn, hands };
  }

  function toSFEN(pos) {
    const rows = pos.board.map((r) => {
      let s = '', e = 0;
      for (const p of r) {
        if (!p) { e++; continue; }
        if (e) { s += e; e = 0; }
        s += p;
      }
      if (e) s += e;
      return s;
    });
    let h = '';
    [0, 1].forEach((side) => HAND_ORDER.forEach((t) => {
      const n = pos.hands[side][t];
      if (n) h += (n > 1 ? n : '') + (side === 0 ? t : t.toLowerCase());
    }));
    return rows.join('/') + ' ' + (pos.turn === 0 ? 'b' : 'w') + ' ' + (h || '-') + ' 1';
  }

  function posKey(pos) {
    let s = pos.turn + ':';
    for (const r of pos.board) for (const p of r) s += (p || '.') + ',';
    for (const side of [0, 1]) for (const t of HAND_ORDER) s += pos.hands[side][t];
    return s;
  }

  /* ---------- 移動ルール ---------- */
  const inZone = (side, r) => (side === 0 ? r <= 2 : r >= 6);
  function mustPromote(p, side, r) {
    if (isPromoted(p)) return false;
    const b = baseOf(p), rr = side === 0 ? r : 8 - r;
    if (b === 'P' || b === 'L') return rr === 0;
    if (b === 'N') return rr <= 1;
    return false;
  }

  function pseudoMoves(pos) {
    const side = pos.turn, B = pos.board, out = [];
    const d = side === 0 ? 1 : -1;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      const p = B[r][c];
      if (!p || sideOf(p) !== side) continue;
      const v = vec(p);
      const canPromoteBase = PROMOTABLE[baseOf(p)] && !isPromoted(p);
      const add = (tr, tc) => {
        const canP = canPromoteBase && (inZone(side, r) || inZone(side, tr));
        if (canP) out.push({ from: [r, c], to: [tr, tc], promote: true, piece: p });
        if (!mustPromote(p, side, tr)) out.push({ from: [r, c], to: [tr, tc], promote: false, piece: p });
      };
      for (const [dr, dc] of v.steps) {
        const tr = r + dr * d, tc = c + dc * d;
        if (inB(tr, tc) && (!B[tr][tc] || sideOf(B[tr][tc]) !== side)) add(tr, tc);
      }
      for (const [dr, dc] of v.slides) {
        let tr = r + dr * d, tc = c + dc * d;
        while (inB(tr, tc)) {
          const q = B[tr][tc];
          if (q) { if (sideOf(q) !== side) add(tr, tc); break; }
          add(tr, tc);
          tr += dr * d; tc += dc * d;
        }
      }
    }
    const hand = pos.hands[side];
    const pawnFiles = new Array(9).fill(false);
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      const p = B[r][c];
      if (p && p === (side === 0 ? 'P' : 'p')) pawnFiles[c] = true;
    }
    for (const t of HAND_ORDER) {
      if (!hand[t]) continue;
      const piece = side === 0 ? t : t.toLowerCase();
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        if (B[r][c]) continue;
        if (mustPromote(t, side, r)) continue;
        if (t === 'P' && pawnFiles[c]) continue;
        out.push({ drop: t, to: [r, c], promote: false, piece });
      }
    }
    return out;
  }

  function makeMove(pos, m) {
    const board = pos.board.map((r) => r.slice());
    const hands = [Object.assign({}, pos.hands[0]), Object.assign({}, pos.hands[1])];
    const side = pos.turn;
    if (m.drop) {
      hands[side][m.drop]--;
      board[m.to[0]][m.to[1]] = side === 0 ? m.drop : m.drop.toLowerCase();
    } else {
      const p = board[m.from[0]][m.from[1]];
      const cap = board[m.to[0]][m.to[1]];
      if (cap && baseOf(cap) !== 'K') hands[side][baseOf(cap)]++;
      board[m.from[0]][m.from[1]] = null;
      board[m.to[0]][m.to[1]] = m.promote ? '+' + p : p;
    }
    return { board, hands, turn: 1 - side };
  }

  function findKing(pos, side) {
    const k = side === 0 ? 'K' : 'k';
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (pos.board[r][c] === k) return [r, c];
    return null;
  }

  function attacked(B, r, c, by) {
    const d = by === 0 ? 1 : -1;
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
      const p = B[i][j];
      if (!p || sideOf(p) !== by) continue;
      const v = vec(p);
      for (const [dr, dc] of v.steps) if (i + dr * d === r && j + dc * d === c) return true;
      for (const [dr, dc] of v.slides) {
        let tr = i + dr * d, tc = j + dc * d;
        while (inB(tr, tc)) {
          if (tr === r && tc === c) return true;
          if (B[tr][tc]) break;
          tr += dr * d; tc += dc * d;
        }
      }
    }
    return false;
  }

  function inCheck(pos, side) {
    const k = findKing(pos, side);
    return k ? attacked(pos.board, k[0], k[1], 1 - side) : false;
  }

  /** 合法手を {m, np} の組で返す（np=指した後の局面） */
  function legalPairs(pos, opts) {
    opts = opts || {};
    const res = [];
    for (const m of pseudoMoves(pos)) {
      const np = makeMove(pos, m);
      if (inCheck(np, pos.turn)) continue;
      if (!opts.skipUchifuzume && m.drop === 'P' && inCheck(np, np.turn) &&
          legalPairs(np, { skipUchifuzume: true, limit: 1 }).length === 0) continue; // 打ち歩詰め
      res.push({ m, np });
      if (opts.limit && res.length >= opts.limit) break;
    }
    return res;
  }
  const legalMoves = (pos) => legalPairs(pos).map((x) => x.m);
  const isMated = (pos) => inCheck(pos, pos.turn) && legalPairs(pos, { limit: 1 }).length === 0;

  /* ---------- 表記 ---------- */
  const sqToUSI = (r, c) => (9 - c) + String.fromCharCode(97 + r);
  function moveToUSI(m) {
    return m.drop ? m.drop + '*' + sqToUSI(m.to[0], m.to[1])
      : sqToUSI(m.from[0], m.from[1]) + sqToUSI(m.to[0], m.to[1]) + (m.promote ? '+' : '');
  }
  function findMoveByUSI(pos, usi) {
    const u = String(usi || '').trim();
    return legalMoves(pos).find((m) => moveToUSI(m) === u) || null;
  }
  function moveToJa(pos, m, prevTo) {
    const mark = pos.turn === 0 ? '▲' : '△';
    const same = prevTo && prevTo[0] === m.to[0] && prevTo[1] === m.to[1];
    const sq = same ? '同' : ZEN[9 - m.to[1]] + KAN[m.to[0]];
    if (m.drop) return mark + sq + KANJI_KIFU[m.drop] + '打';
    let s = mark + sq + KANJI_KIFU[keyOf(m.piece)];
    if (m.promote) s += '成';
    else if (PROMOTABLE[baseOf(m.piece)] && !isPromoted(m.piece) &&
      (inZone(pos.turn, m.from[0]) || inZone(pos.turn, m.to[0]))) s += '不成';
    return s;
  }
  function kifuFromUSI(startPos, usiList) {
    let pos = startPos, prev = null; const out = [];
    for (const u of usiList) {
      const m = findMoveByUSI(pos, u);
      if (!m) break;
      out.push(moveToJa(pos, m, prev));
      prev = m.to; pos = makeMove(pos, m);
    }
    return out;
  }
  /** Geminiへ渡すテキスト盤面図 */
  function toDiagram(pos) {
    const handStr = (side) => {
      const s = HAND_ORDER.filter((t) => pos.hands[side][t])
        .map((t) => KANJI_KIFU[t] + (pos.hands[side][t] > 1 ? pos.hands[side][t] : '')).join(' ');
      return s || 'なし';
    };
    const lines = ['後手(玉方)の持駒：' + handStr(1), '  ９ ８ ７ ６ ５ ４ ３ ２ １'];
    pos.board.forEach((row, r) => {
      lines.push('|' + row.map((p) => (p ? (sideOf(p) === 1 ? 'v' : ' ') + KANJI_BOARD[keyOf(p)] : ' ・')).join('') + '|' + KAN[r]);
    });
    lines.push('先手(攻方)の持駒：' + handStr(0));
    lines.push('（vは後手の駒）手番：' + (pos.turn === 0 ? '先手' : '後手'));
    return lines.join('\n');
  }

  /* ---------- 詰み探索 ---------- */
  const BUDGET = { budget: true };
  function makeCtx(budget) { return { nodes: 0, budget: budget || 150000, memo: new Map() }; }
  function tick(ctx) { if (++ctx.nodes > ctx.budget) throw BUDGET; }

  /** 攻方手番。n手以内（n:残り手数, 奇数）に詰むか */
  function orNode(pos, n, ctx) {
    if (n < 1) return false;
    tick(ctx);
    const key = 'o' + n + posKey(pos);
    if (ctx.memo.has(key)) return ctx.memo.get(key);
    let ok = false;
    const checks = legalPairs(pos).filter((x) => inCheck(x.np, x.np.turn));
    // 取る手・成る手を先に読む
    checks.sort((a, b) => score(b.m, pos) - score(a.m, pos));
    for (const x of checks) { if (andNode(x.np, n - 1, ctx)) { ok = true; break; } }
    ctx.memo.set(key, ok);
    return ok;
  }
  function score(m, pos) {
    let s = 0;
    if (!m.drop && pos.board[m.to[0]][m.to[1]]) s += 2;
    if (m.promote) s += 1;
    return s;
  }
  /** 玉方手番（王手されている）。k手(偶数)以内に必ず詰むか */
  function andNode(pos, k, ctx) {
    tick(ctx);
    const key = 'a' + k + posKey(pos);
    if (ctx.memo.has(key)) return ctx.memo.get(key);
    const ev = legalPairs(pos);
    let ok;
    if (ev.length === 0) ok = true;
    else if (k < 2) ok = false;
    else {
      // 玉の移動 → 駒取り → 合駒 の順に反証を探す
      ev.sort((a, b) => defScore(b.m, pos) - defScore(a.m, pos));
      ok = ev.every((x) => orNode(x.np, k - 1, ctx));
    }
    ctx.memo.set(key, ok);
    return ok;
  }
  function defScore(m, pos) {
    if (!m.drop && baseOf(m.piece) === 'K') return 3;
    if (!m.drop && pos.board[m.to[0]][m.to[1]]) return 2;
    return m.drop ? 0 : 1;
  }

  function mateLength(pos, maxN, ctx) {
    for (let n = 1; n <= maxN; n += 2) if (orNode(pos, n, ctx)) return n;
    return -1;
  }
  /** 玉方手番。最も長く粘る応手（同手数なら合駒以外を優先） */
  function bestDefense(pos, remaining, ctx) {
    let best = null, bestScore = -Infinity, bestLen = -1;
    for (const x of legalPairs(pos)) {
      const L = mateLength(x.np, Math.max(1, remaining - 1), ctx);
      if (L < 0) return { m: x.m, len: Infinity };
      const s = L * 10 + (x.m.drop ? 0 : 1);
      if (s > bestScore) { bestScore = s; best = x.m; bestLen = L; }
    }
    return { m: best, len: bestLen };
  }
  /** 誤答の反証手（逃れる応手）を探す */
  function refutation(pos, remaining, ctx) {
    const ev = legalPairs(pos);
    ev.sort((a, b) => defScore(b.m, pos) - defScore(a.m, pos));
    for (const x of ev) if (remaining < 2 || !orNode(x.np, remaining - 1, ctx)) return x.m;
    return null;
  }
  /** 解答手順(USI配列)を探索で生成 */
  function solve(startPos, maxN, budget) {
    const ctx = makeCtx(budget || 400000);
    const n = mateLength(startPos, maxN || 9, ctx);
    if (n < 0) return null;
    const line = []; let pos = startPos, rem = n;
    while (rem > 0) {
      const mv = legalPairs(pos).filter((x) => inCheck(x.np, x.np.turn))
        .find((x) => andNode(x.np, rem - 1, ctx));
      if (!mv) break;
      line.push(moveToUSI(mv.m)); pos = mv.np; rem--;
      if (isMated(pos)) break;
      const d = bestDefense(pos, rem, ctx);
      if (!d.m) break;
      line.push(moveToUSI(d.m)); pos = makeMove(pos, d.m); rem = d.len;
    }
    return line;
  }

  const api = {
    HAND_ORDER, KANJI_BOARD, KANJI_KIFU, ZEN, KAN, BUDGET,
    baseOf, sideOf, isPromoted, keyOf, parseSFEN, toSFEN, posKey,
    legalPairs, legalMoves, makeMove, inCheck, isMated, findKing,
    moveToUSI, findMoveByUSI, moveToJa, kifuFromUSI, toDiagram,
    makeCtx, orNode, andNode, mateLength, bestDefense, refutation, solve,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shogi = api;
})(typeof window !== 'undefined' ? window : this);
