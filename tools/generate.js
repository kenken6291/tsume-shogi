/* =========================================================
 * generate.js — 正しい詰将棋を自動で作るツール（パソコンのNode.jsで実行）
 *
 *   node tools/generate.js <手数> <問題数> [最大秒数]
 *   例) node tools/generate.js 5 100 3600   … 5手詰を100問（最大1時間）
 *
 * 出来上がった問題は「詰将棋_自動生成_5手_xxxx.txt」に保存されます。
 * そのファイルをGoogleドライブの取り込みフォルダに入れて importFromDrive を実行してください。
 *
 * 作る問題の条件
 *  - 玉方は残りの駒をすべて持ち駒にする（合駒あり）
 *  - 指定手数より短い詰みがない
 *  - 初手が1通りしかない
 *  - 解答手順はエンジンで最後まで検証済み
 * ========================================================= */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'shogi.js'));

const target = parseInt(process.argv[2], 10) || 3;
const want = parseInt(process.argv[3], 10) || 50;
const seconds = parseInt(process.argv[4], 10) || 600;
if (target % 2 === 0) { console.error('手数は奇数で指定してください'); process.exit(1); }

const TOT = { R: 2, B: 2, G: 4, S: 4, N: 4, L: 4, P: 18 };
const GOTE = ['g', 's', 'n', 'l', 'p', 'b', 'r', '+p'];
const SENTE = ['G', 'S', 'N', 'L', 'B', 'R', 'P', '+P', '+R', '+B', '+S'];
const HAND = ['G', 'S', 'N', 'R', 'B', 'L', 'P', 'G', 'S'];
const rnd = (n) => Math.floor(Math.random() * n);

function randomPosition() {
  const B = [...Array(9)].map(() => Array(9).fill(null));
  const kr = rnd(3), kc = 3 + rnd(6);
  B[kr][kc] = 'k';
  const place = (p, r, c) => { if (r >= 0 && r < 9 && c >= 0 && c < 9 && !B[r][c]) B[r][c] = p; };
  for (let i = 0, n = 1 + rnd(4); i < n; i++) place(GOTE[rnd(GOTE.length)], kr + rnd(3) - 1, kc + rnd(3) - 1);
  for (let i = 0, n = 1 + rnd(3 + (target > 3 ? 1 : 0)); i < n; i++) place(SENTE[rnd(SENTE.length)], kr + rnd(5) - 1, kc + rnd(5) - 2);
  const hand = { R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 };
  for (let i = 0, n = rnd(4); i < n; i++) hand[HAND[rnd(HAND.length)]]++;

  const cnt = { R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 };
  const pawnFile = [[], []];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const p = B[r][c]; if (!p) continue;
    const b = S.baseOf(p), sd = S.sideOf(p);
    if (b !== 'K') cnt[b]++;
    if (S.isPromoted(p)) continue;
    const rr = sd === 0 ? r : 8 - r;
    if (((b === 'P' || b === 'L') && rr === 0) || (b === 'N' && rr <= 1)) return null;
    if (b === 'P') { if (pawnFile[sd][c]) return null; pawnFile[sd][c] = true; }
  }
  for (const t in hand) cnt[t] += hand[t];
  const gote = {};
  for (const t in TOT) { if (cnt[t] > TOT[t]) return null; gote[t] = TOT[t] - cnt[t]; }
  const pos = { board: B, turn: 0, hands: [hand, gote] };
  return S.inCheck(pos, 1) ? null : pos;
}

const out = [], seen = new Set();
const t0 = Date.now();
let tries = 0, lastLog = 0;
while (out.length < want && Date.now() - t0 < seconds * 1000) {
  tries++;
  const pos = randomPosition();
  if (!pos) continue;
  try {
    const ctx = S.makeCtx(target >= 5 ? 20000 : 80000);
    let shorter = false;
    for (let n = 1; n < target; n += 2) if (S.orNode(pos, n, ctx)) { shorter = true; break; }
    if (shorter || !S.orNode(pos, target, ctx)) continue;
    const ctx2 = S.makeCtx(400000);
    const firsts = S.legalPairs(pos, { checksOnly: true }).filter((x) => S.andNode(x.np, target - 1, ctx2));
    if (firsts.length !== 1) continue;
    const sol = S.solve(pos, target, 600000);
    if (!sol || sol.length !== target) continue;
    let p = pos;
    for (const u of sol) p = S.makeMove(p, S.findMoveByUSI(p, u));
    if (!S.isMated(p)) continue;
    const sfen = S.toSFEN(pos);
    const key = sfen.split(' ').slice(0, 3).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`# 自動生成 ${target}手詰\nsfen ${sfen} moves ${sol.join(' ')}`);
  } catch (e) { if (e !== S.BUDGET) throw e; }
  if (Date.now() - lastLog > 10000) {
    lastLog = Date.now();
    console.log(`${out.length}/${want}問  試行${tries}回  ${Math.round((Date.now() - t0) / 1000)}秒`);
  }
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const file = path.join(process.cwd(), `詰将棋_自動生成_${target}手_${stamp}.txt`);
fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
console.log(`完了: ${out.length}問 → ${file}`);
