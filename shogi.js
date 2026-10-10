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

  const baseOf = (p) => (p.length === 2 ? p[1] : p).toUpperCase();
  const sideOf = (p) => { const c = p[p.length - 1]; return c === c.toUpperCase() ? 0 : 1; };
  const isPromoted = (p) => p.length === 2;
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
  const ALL_SQUARES = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) ALL_SQUARES.push([r, c]);
  const inZone = (side, r) => (side === 0 ? r <= 2 : r >= 6);
  function mustPromote(p, side, r) {
    if (isPromoted(p)) return false;
    const b = baseOf(p), rr = side === 0 ? r : 8 - r;
    if (b === 'P' || b === 'L') return rr === 0;
    if (b === 'N') return rr <= 1;
    return false;
  }

  function pseudoMoves(pos, dropSquares) {
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
    const squares = dropSquares || ALL_SQUARES;
    for (const t of HAND_ORDER) {
      if (!hand[t]) continue;
      const piece = side === 0 ? t : t.toLowerCase();
      for (const [r, c] of squares) {
        if (B[r][c]) continue;
        if (mustPromote(t, side, r)) continue;
        if (t === 'P' && pawnFiles[c]) continue;
        out.push({ drop: t, to: [r, c], promote: false, piece });
      }
    }
    return out;
  }

  function makeMove(pos, m) {
    const board = pos.board.slice();
    const hands = [Object.assign({}, pos.hands[0]), Object.assign({}, pos.hands[1])];
    const side = pos.turn;
    const kings = pos.kings ? pos.kings.slice() : undefined;
    const tr = m.to[0];
    board[tr] = board[tr].slice();
    if (m.drop) {
      hands[side][m.drop]--;
      board[tr][m.to[1]] = side === 0 ? m.drop : m.drop.toLowerCase();
    } else {
      const fr = m.from[0];
      if (fr !== tr) board[fr] = board[fr].slice();
      const p = board[fr][m.from[1]];
      const cap = board[tr][m.to[1]];
      if (cap && baseOf(cap) !== 'K') hands[side][baseOf(cap)]++;
      board[fr][m.from[1]] = null;
      board[tr][m.to[1]] = m.promote ? '+' + p : p;
      if (kings && (p === 'K' || p === 'k')) kings[side] = [tr, m.to[1]];
    }
    const np = { board, hands, turn: 1 - side };
    if (kings) np.kings = kings;
    return np;
  }

  function findKing(pos, side) {
    if (pos.kings && pos.kings[side] !== undefined) return pos.kings[side];
    const k = side === 0 ? 'K' : 'k';
    let found = null;
    for (let r = 0; r < 9 && !found; r++) for (let c = 0; c < 9; c++) if (pos.board[r][c] === k) { found = [r, c]; break; }
    if (!pos.kings) pos.kings = [undefined, undefined];
    pos.kings[side] = found;
    return found;
  }

  const DIRS8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  /** 駒pが（盤上の向きで）(dr,dc)方向・距離distの相手に利くか */
  function pieceHits(p, dr, dc, dist, by) {
    const d = by === 0 ? 1 : -1, v = vec(p), ldr = dr * d, ldc = dc * d;
    if (dist === 1) for (const [a, b] of v.steps) if (a === ldr && b === ldc) return true;
    for (const [a, b] of v.slides) if (a === ldr && b === ldc) return true;
    return false;
  }
  /** (r,c) に利いている by 側の駒の一覧（玉から逆にたどる高速版） */
  function attackersOf(B, r, c, by, firstOnly) {
    const res = [];
    for (const [dr, dc] of DIRS8) {
      let i = r + dr, j = c + dc, dist = 1;
      while (inB(i, j)) {
        const p = B[i][j];
        if (p) {
          if (sideOf(p) === by && pieceHits(p, -dr, -dc, dist, by)) {
            res.push({ r: i, c: j, dist, dr, dc });
            if (firstOnly) return res;
          }
          break;
        }
        i += dr; j += dc; dist++;
      }
    }
    const d = by === 0 ? 1 : -1, kn = by === 0 ? 'N' : 'n';
    for (const dc of [-1, 1]) {
      const i = r + 2 * d, j = c + dc;
      if (inB(i, j) && B[i][j] === kn) { res.push({ r: i, c: j, dist: 1, dr: 2 * d, dc }); if (firstOnly) return res; }
    }
    return res;
  }
  const attacked = (B, r, c, by) => attackersOf(B, r, c, by, true).length > 0;

  function inCheck(pos, side) {
    const k = findKing(pos, side);
    return k ? attacked(pos.board, k[0], k[1], 1 - side) : false;
  }

  /** (r,c)に置いた駒pが (tr,tc) に直接利くか */
  function hitsFrom(B, r, c, p, tr, tc) {
    const side = sideOf(p), d = side === 0 ? 1 : -1;
    if (baseOf(p) === 'N' && !isPromoted(p)) return tr === r - 2 * d && Math.abs(tc - c) === 1;
    const dr = tr - r, dc = tc - c;
    if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) return false;
    const ur = Math.sign(dr), uc = Math.sign(dc), dist = Math.max(Math.abs(dr), Math.abs(dc));
    if (!pieceHits(p, ur, uc, dist, side)) return false;
    for (let k = 1; k < dist; k++) if (B[r + ur * k][c + uc * k]) return false;
    return true;
  }

  /**
   * 合法手を {m, np} の組で返す（np=指した後の局面）
   * opts.checksOnly: 王手になる手だけ  opts.limit: 件数上限  opts.skipUchifuzume: 打ち歩詰め判定を省略
   */
  function legalPairs(pos, opts) {
    opts = opts || {};
    const side = pos.turn, B = pos.board;
    let drops = null; // 打てるマスの候補（null=全マス）
    const myK = findKing(pos, side);
    if (myK) {
      const chk = attackersOf(B, myK[0], myK[1], 1 - side, false);
      if (chk.length) {
        // 王手されている：合駒は飛び駒との間のマスだけ
        drops = [];
        if (chk.length === 1 && chk[0].dist > 1) {
          for (let k = 1; k < chk[0].dist; k++) drops.push([myK[0] + chk[0].dr * k, myK[1] + chk[0].dc * k]);
        }
      }
    }
    if (opts.checksOnly) {
      const ek = findKing(pos, 1 - side);
      if (!ek) return [];
      // 玉から8方向の空きマスと桂の位置だけが王手になる打ち場所の候補
      const cand = [];
      for (const [dr, dc] of DIRS8) {
        let i = ek[0] + dr, j = ek[1] + dc;
        while (inB(i, j) && !B[i][j]) { cand.push([i, j]); i += dr; j += dc; }
      }
      const d = side === 0 ? 1 : -1;
      for (const dc of [-1, 1]) { const i = ek[0] + 2 * d, j = ek[1] + dc; if (inB(i, j) && !B[i][j]) cand.push([i, j]); }
      const filtered = [];
      const allow = drops ? new Set(drops.map(([r, c]) => r * 9 + c)) : null;
      for (const sq of cand) if (!allow || allow.has(sq[0] * 9 + sq[1])) filtered.push(sq);
      drops = filtered;
    }
    const res = [];
    for (const m of pseudoMoves(pos, drops)) {
      const np = makeMove(pos, m);
      if (inCheck(np, side)) continue;
      const givesCheck = (opts.checksOnly || m.drop === 'P') ? inCheck(np, np.turn) : false;
      if (opts.checksOnly && !givesCheck) continue;
      if (!opts.skipUchifuzume && m.drop === 'P' && givesCheck &&
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

  /** 置換表：局面ごとに「n手以内で詰む最小n」「n手以内では詰まない最大n」を覚える */
  function memoGet(ctx, key, n) {
    const e = ctx.memo.get(key);
    if (!e) return undefined;
    if (e.t <= n) return true;
    if (e.f >= n) return false;
    return undefined;
  }
  function memoSet(ctx, key, n, ok) {
    let e = ctx.memo.get(key);
    if (!e) { e = { t: Infinity, f: -1 }; ctx.memo.set(key, e); }
    if (ok) { if (n < e.t) e.t = n; } else if (n > e.f) e.f = n;
  }

  /** 攻方手番。n手以内（n:残り手数, 奇数）に詰むか */
  function orNode(pos, n, ctx) {
    if (n < 1) return false;
    tick(ctx);
    const key = 'o' + posKey(pos);
    const hit = memoGet(ctx, key, n);
    if (hit !== undefined) return hit;
    let ok = false;
    const checks = legalPairs(pos, { checksOnly: true });
    // 取る手・成る手を先に読む
    checks.sort((a, b) => score(b.m, pos) - score(a.m, pos));
    for (const x of checks) { if (andNode(x.np, n - 1, ctx)) { ok = true; break; } }
    memoSet(ctx, key, n, ok);
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
    const key = 'a' + posKey(pos);
    const hit = memoGet(ctx, key, k);
    if (hit !== undefined) return hit;
    let ok;
    if (k < 2) { ok = legalPairs(pos, { limit: 1 }).length === 0; memoSet(ctx, key, k, ok); return ok; }
    const ev = legalPairs(pos);
    if (ev.length === 0) ok = true;
    else {
      // 玉の移動 → 駒取り → 合駒 の順に反証を探す
      ev.sort((a, b) => defScore(b.m, pos) - defScore(a.m, pos));
      ok = ev.every((x) => orNode(x.np, k - 1, ctx));
    }
    memoSet(ctx, key, k, ok);
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
  function solve(startPos, maxN, budget, sharedCtx) {
    const ctx = sharedCtx || makeCtx(budget || 400000);
    const n = mateLength(startPos, maxN || 9, ctx);
    if (n < 0) return null;
    const line = []; let pos = startPos, rem = n;
    while (rem > 0) {
      const mv = legalPairs(pos, { checksOnly: true })
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
})(typeof window !== 'undefined' ? window : globalThis);
