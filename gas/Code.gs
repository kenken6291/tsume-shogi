/**
 * 詰め将棋道場 — GAS Web API
 *
 * スクリプトプロパティ
 *   SPREADSHEET_ID   問題データのスプレッドシートID（必須）
 *   GEMINI_API_KEY   Gemini APIキー（AIヒント・解説を使う場合）
 *   GEMINI_MODEL     使うモデル名（省略時 gemini-2.5-flash）
 *   IMPORT_FOLDER_ID 取り込み用のDriveフォルダID（URLのままでも可）
 *   IMPORT_FILE_ID   1ファイルだけ取り込む場合のファイルID
 *   AI_PER_MINUTE    AI呼び出し上限/分（省略時 20）
 *
 * シート「problems」の列: id | moves | sfen | solution | difficulty | title | comment
 *   solution は USI形式を空白区切り（例: "3b2b+ 1c1d 2b2c"）。空でもフロント側で探索して補完します。
 *
 * GET  ?action=meta                         総数と手数別件数
 * GET  ?action=list&moves=1|3|5|7|9+|all    一覧（id, moves, difficulty, title）
 * GET  ?action=get&id=123                   問題詳細
 * GET  ?action=random&moves=3&exclude=1,2   ランダム出題
 * POST {action:'hint'|'explain', ...}       Content-Type: text/plain で送信
 */

const API_VERSION = '1.2.0';   // Code.gs を変えたら上げる
const SHEET_NAME = 'problems';
const HEADERS = ['id', 'moves', 'sfen', 'solution', 'difficulty', 'title', 'comment'];
const CACHE_TTL = 21600;      // 6時間
const CHUNK = 30000;          // キャッシュ1キーあたりの文字数（100KB制限対策）
const AI_CACHE_TTL = 21600;

/* ================= 共通 ================= */
function props_() { return PropertiesService.getScriptProperties(); }
function ss_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID が未設定です');
  return SpreadsheetApp.openById(id);
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function dataVersion_() { return props_().getProperty('DATA_VERSION') || '1'; }

/** データ更新後に実行（キャッシュ無効化） */
function clearCache() {
  props_().setProperty('DATA_VERSION', String(Date.now()));
}
/** 問題データの最終更新日（yyyy-MM-dd HH:mm） */
function dataUpdated_() {
  const v = Number(props_().getProperty('DATA_VERSION'));
  return v > 100000 ? Utilities.formatDate(new Date(v), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : '';
}

/* ================= データ読込（キャッシュ付き） ================= */
function loadAll_() {
  const cache = CacheService.getScriptCache();
  const prefix = 'tsume_' + dataVersion_() + '_';
  const head = cache.get(prefix + 'n');
  if (head) {
    const keys = [];
    for (let i = 0; i < Number(head); i++) keys.push(prefix + i);
    const got = cache.getAll(keys);
    if (keys.every(function (k) { return got[k] != null; })) {
      return JSON.parse(keys.map(function (k) { return got[k]; }).join(''));
    }
  }
  const sh = ss_().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('シート「' + SHEET_NAME + '」がありません。setupSheet を実行してください');
  const values = sh.getDataRange().getValues();
  const hdr = values.shift().map(function (h) { return String(h).trim(); });
  const ix = {};
  HEADERS.forEach(function (h) { ix[h] = hdr.indexOf(h); });
  if (ix.id < 0 || ix.sfen < 0) throw new Error('見出し行に id / sfen 列が必要です');
  const col = function (r, k) { return ix[k] >= 0 ? r[ix[k]] : ''; };
  const rows = values
    .filter(function (r) { return col(r, 'id') !== '' && String(col(r, 'sfen')).trim(); })
    .map(function (r) {
      const solution = String(col(r, 'solution') || '').trim();
      return {
        id: Number(col(r, 'id')),
        moves: Number(col(r, 'moves')) || (solution ? solution.split(/\s+/).length : 0),
        sfen: String(col(r, 'sfen')).trim(),
        solution: solution,
        difficulty: Number(col(r, 'difficulty')) || 0,
        title: String(col(r, 'title') || ''),
        comment: String(col(r, 'comment') || ''),
      };
    })
    .sort(function (a, b) { return a.id - b.id; });

  const s = JSON.stringify(rows);
  const n = Math.ceil(s.length / CHUNK);
  const put = {};
  for (let i = 0; i < n; i++) put[prefix + i] = s.substr(i * CHUNK, CHUNK);
  put[prefix + 'n'] = String(n);
  try { cache.putAll(put, CACHE_TTL); } catch (e) { console.warn('cache put failed: ' + e); }
  return rows;
}

function matchMoves_(p, f) {
  if (!f || f === 'all') return true;
  if (f === '9+') return p.moves >= 9;
  return p.moves === Number(f);
}

/* ================= GET ================= */
function doGet(e) {
  try {
    const q = (e && e.parameter) || {};
    const action = q.action || 'meta';
    const all = loadAll_();

    if (action === 'meta') {
      const counts = {};
      all.forEach(function (p) { counts[p.moves] = (counts[p.moves] || 0) + 1; });
      return json_({ ok: true, total: all.length, counts: counts, version: dataVersion_(),
        apiVersion: API_VERSION, updated: dataUpdated_() });
    }
    if (action === 'list') {
      const items = all.filter(function (p) { return matchMoves_(p, q.moves); })
        .map(function (p) { return { id: p.id, moves: p.moves, difficulty: p.difficulty, title: p.title }; });
      return json_({ ok: true, items: items });
    }
    if (action === 'get') {
      const id = Number(q.id);
      const p = all.filter(function (x) { return x.id === id; })[0];
      return json_(p ? { ok: true, problem: p } : { ok: false, error: '問題 ' + q.id + ' が見つかりません' });
    }
    if (action === 'random') {
      const ex = {};
      String(q.exclude || '').split(',').forEach(function (v) { if (v) ex[Number(v)] = true; });
      let pool = all.filter(function (p) { return matchMoves_(p, q.moves) && !ex[p.id]; });
      if (!pool.length) pool = all.filter(function (p) { return matchMoves_(p, q.moves); });
      if (!pool.length) return json_({ ok: false, error: '該当する問題がありません' });
      return json_({ ok: true, problem: pool[Math.floor(Math.random() * pool.length)] });
    }
    return json_({ ok: false, error: '不明な action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ================= POST（Gemini） ================= */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    if (action !== 'hint' && action !== 'explain') return json_({ ok: false, error: '不明な action' });

    const clip = function (v, n) { return String(v == null ? '' : v).slice(0, n || 1500); };
    const data = {
      problemId: Number(body.problemId) || 0,
      sfen: clip(body.sfen, 300),
      diagram: clip(body.diagram, 1500),
      nextMove: clip(body.nextMove, 40),
      nextPiece: clip(body.nextPiece, 10),
      line: clip(body.line, 300),
      wrongMove: clip(body.wrongMove, 40),
      refutation: clip(body.refutation, 40),
      correctMove: clip(body.correctMove, 40),
      remaining: Number(body.remaining) || 0,
      played: clip(body.played, 400),
    };
    if (!data.sfen || !data.diagram) return json_({ ok: false, error: '局面データがありません' });

    // 同じ局面・同じ質問はキャッシュから返す
    const cache = CacheService.getScriptCache();
    const ckey = 'ai_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, action + '|' + data.sfen + '|' + data.wrongMove + '|' + data.nextMove, Utilities.Charset.UTF_8));
    const hit = cache.get(ckey);
    if (hit) return json_({ ok: true, text: hit, cached: true });

    rateLimit_();
    const prompt = action === 'hint' ? hintPrompt_(data) : explainPrompt_(data);
    const text = gemini_(prompt);
    cache.put(ckey, text, AI_CACHE_TTL);
    return json_({ ok: true, text: text });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function rateLimit_() {
  const limit = Number(props_().getProperty('AI_PER_MINUTE')) || 20;
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + Math.floor(Date.now() / 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    const n = Number(cache.get(key) || 0);
    if (n >= limit) throw new Error('AIが混み合っています。1分ほど待ってからお試しください');
    cache.put(key, String(n + 1), 120);
  } finally { lock.releaseLock(); }
}

const COMMON_RULES_ = [
  'あなたは詰め将棋道場の師範です。初心者〜中級者のシニアにもわかる、やさしく簡潔な日本語で話します。',
  '盤面と手順の事実は、下に与えた【検証済みの情報】だけを使ってください。',
  'そこに書かれていない手・駒・マスを新しく作ったり、詰む／詰まないを独自に判断したりしてはいけません。',
  'マスの呼び方は「２三」のように筋（算用数字）＋段（漢数字）で書きます。',
  '前置きや見出し、箇条書き、記号装飾は使わず、地の文だけで答えてください。',
].join('\n');

function hintPrompt_(d) {
  return [
    COMMON_RULES_,
    '',
    '【依頼】次の一手のヒントを1〜2文、80字以内で出してください。',
    '正解の手そのもの（駒とマスの組み合わせ）は絶対に書かないでください。',
    '使う駒の種類、狙う場所の方向（玉の上・横・退路など）、考え方（捨て駒・退路封鎖など）のうち1つか2つをほのめかします。',
    '',
    '【検証済みの情報】',
    '現在の局面（SFEN）：' + d.sfen,
    d.diagram,
    'ここまでの手順：' + (d.played || 'まだ指していない'),
    '残り手数：' + d.remaining + '手',
    '正解の次の一手（秘密・本文に書かない）：' + d.nextMove,
    '使う駒：' + d.nextPiece,
    '正解の残り手順（参考・本文に書かない）：' + d.line,
  ].join('\n');
}

function explainPrompt_(d) {
  return [
    COMMON_RULES_,
    '',
    '【依頼】プレイヤーの指した手では詰まない理由を、2〜3文・140字以内で説明してください。',
    '玉方の逃れ方（下の「逃れる応手」）を中心に、なぜそこから逃げられるのか（利きが足りない、退路が空く、駒を取られる等）を盤面図から読み取れる範囲で述べます。',
    '最後に、正解手は書かずに「どこに注目すると良いか」を一言添えてください。',
    '',
    '【検証済みの情報】',
    '誤答の直前の局面（SFEN）：' + d.sfen,
    d.diagram,
    'ここまでの手順：' + (d.played || 'まだ指していない'),
    'プレイヤーの手（詰まない）：' + d.wrongMove,
    '逃れる応手：' + (d.refutation || '（探索で特定できず）'),
    '本来の残り手数：' + d.remaining + '手',
    '正解の手（秘密・本文に書かない）：' + (d.correctMove || '（別の手順）'),
  ].join('\n');
}

function gemini_(prompt) {
  const key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が未設定です');
  const model = props_().getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
    }),
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    console.error('Gemini ' + code + ': ' + res.getContentText().slice(0, 500));
    throw new Error('AIの呼び出しに失敗しました（' + code + '）');
  }
  const j = JSON.parse(res.getContentText());
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const text = parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('AIから回答がありませんでした');
  return text;
}

/* ================= 初期設定・データ取り込み ================= */

/** シートを作成して見出し行を入れる（初回に1度実行） */
function setupSheet() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
}

/**
 * Googleドライブから問題を取り込む（検証付き）
 *
 * スクリプトプロパティ IMPORT_FOLDER_ID に「フォルダ」のID（またはURL）を入れると、
 * フォルダ内の .txt / .sfen / .json をすべて読み込みます。
 * IMPORT_FILE_ID に1ファイルだけ指定することもできます。
 *
 * 1問ずつ将棋エンジン（shogi.gs）で検証し、
 *   - 正しい問題 → シート「problems」に追加
 *   - 不正な問題 → シート「import_errors」に理由つきで記録（取り込まない）
 * 同じ局面の問題は1つにまとめます。
 *
 * 対応形式（# で始まる行はコメント。直前の「# No.123」はタイトルとして保存）:
 *   sfen <盤面> <手番> <持駒> <手数> moves <USI手順...>
 *   position sfen ... moves ...
 *   SFEN<TAB>USI手順<TAB>タイトル<TAB>コメント
 *   SFENのみ（解答はフロント側で自動計算）
 *   JSON配列 [{ "sfen": "...", "solution": "..." }]
 */
function importFromDrive() {
  const files = importFiles_();
  if (!files.length) throw new Error('取り込むファイルが見つかりません');

  setupSheet();
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME);
  const last = sh.getLastRow();
  const existing = {};
  let maxId = 0;
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
      maxId = Math.max(maxId, Number(r[0]) || 0);
      existing[normSfen_(r[2])] = true;
    });
  }

  const rows = [], errors = [];
  let read = 0, dup = 0;
  files.forEach(function (f) {
    const parsed = parseImport_(f.getBlob().getDataAsString('UTF-8'));
    parsed.forEach(function (p) {
      read++;
      const reason = validateProblem_(p.sfen, p.solution);
      if (reason) {
        errors.push([f.getName(), p.title || '', p.sfen, p.solution.join(' '), reason]);
        return;
      }
      const key = normSfen_(p.sfen);
      if (existing[key]) { dup++; return; }
      existing[key] = true;
      rows.push([++maxId, p.solution.length || p.moves || '', p.sfen, p.solution.join(' '),
        p.difficulty || '', p.title || '', p.comment || '']);
    });
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);

  // エラー一覧（毎回作り直し）
  let es = ss.getSheetByName('import_errors');
  if (!es) es = ss.insertSheet('import_errors');
  es.clear();
  es.getRange(1, 1, 1, 5).setValues([['file', 'title', 'sfen', 'moves', 'reason']]).setFontWeight('bold');
  if (errors.length) es.getRange(2, 1, errors.length, 5).setValues(errors);

  clearCache();
  const msg = 'ファイル ' + files.length + '件 / 読み取り ' + read + '問 → 追加 ' + rows.length +
    '問、重複 ' + dup + '問、不正 ' + errors.length + '問（不正な問題は import_errors シート参照）';
  console.log(msg);
  return msg;
}

/** IMPORT_FOLDER_ID / IMPORT_FILE_ID から対象ファイル一覧を作る（名前順） */
function importFiles_() {
  const pickId = function (v) {
    const m = String(v || '').match(/[-\w]{25,}/);
    return m ? m[0] : '';
  };
  const folderId = pickId(props_().getProperty('IMPORT_FOLDER_ID'));
  const fileId = pickId(props_().getProperty('IMPORT_FILE_ID'));
  const out = [];
  if (folderId) {
    const it = DriveApp.getFolderById(folderId).getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (/\.(txt|sfen|json|csv|tsv)$/i.test(f.getName()) || f.getMimeType() === 'text/plain') out.push(f);
    }
  } else if (fileId) {
    out.push(DriveApp.getFileById(fileId));
  } else {
    throw new Error('IMPORT_FOLDER_ID（フォルダ）か IMPORT_FILE_ID（ファイル）を設定してください');
  }
  // 「詰将棋2」が「詰将棋10」より前に来るよう数字を考慮して並べる
  const norm = function (s) { return s.normalize('NFKC').replace(/\d+/g, function (d) { return ('0000000' + d).slice(-8); }); };
  return out.sort(function (a, b) { return norm(a.getName()) < norm(b.getName()) ? -1 : 1; });
}

/** 問題の検証。正しければ空文字、不正なら理由を返す */
function validateProblem_(sfen, sol) {
  const S = Shogi;
  let pos;
  try { pos = S.parseSFEN(sfen); } catch (e) { return 'SFENが読めない（' + e.message + '）'; }
  const att = pos.turn, def = 1 - att;
  if (!S.findKing(pos, def)) return '玉方の玉がない';
  if (S.inCheck(pos, def)) return '最初から玉に王手がかかっている';
  if (!sol.length) return '';
  if (sol.length % 2 === 0) return '手数が偶数（' + sol.length + '手）';
  for (let i = 0; i < sol.length; i++) {
    const m = S.findMoveByUSI(pos, sol[i]);
    if (!m) return (i + 1) + '手目 ' + sol[i] + ' は指せない手';
    const np = S.makeMove(pos, m);
    if (i % 2 === 0 && !S.inCheck(np, np.turn)) return (i + 1) + '手目 ' + sol[i] + ' が王手になっていない';
    pos = np;
    if (i < sol.length - 1 && S.isMated(pos)) return (i + 1) + '手目で詰んでいる（手数が合わない）';
  }
  if (!S.isMated(pos)) return '最後の局面が詰んでいない';
  return '';
}

function normSfen_(s) {
  const p = String(s || '').trim().split(/\s+/);
  return p.length >= 3 ? p.slice(0, 3).join(' ') : '';
}

function parseImport_(text) {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (t.charAt(0) === '[') {
    return JSON.parse(t).map(function (o) {
      const sol = Array.isArray(o.solution) ? o.solution : String(o.solution || o.moves_usi || '').trim().split(/\s+/).filter(String);
      return { sfen: completeSfen_(o.sfen), solution: sol, moves: Number(o.moves) || 0,
        title: o.title || '', comment: o.comment || '', difficulty: Number(o.difficulty) || 0 };
    }).filter(function (p) { return p.sfen; });
  }
  const out = [];
  let title = '';
  t.split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line) return;
    if (line.charAt(0) === '#') {
      const m = line.match(/No\.?\s*(\d+)/i);
      if (m) title = 'No.' + m[1];
      return;
    }
    if (line.indexOf('\t') >= 0) {
      const c = line.split('\t');
      out.push({ sfen: completeSfen_(c[0]), solution: String(c[1] || '').trim().split(/\s+/).filter(String),
        title: c[2] || title, comment: c[3] || '' });
      title = '';
      return;
    }
    let s = line.replace(/^position\s+/, '').replace(/^sfen\s+/, '');
    let sol = [];
    const mi = s.search(/\smoves\s/);
    if (mi >= 0) { sol = s.slice(mi).replace(/^\s*moves\s+/, '').trim().split(/\s+/); s = s.slice(0, mi); }
    out.push({ sfen: completeSfen_(s), solution: sol, title: title });
    title = '';
  });
  return out.filter(function (p) { return p.sfen; });
}

function completeSfen_(s) {
  const p = String(s || '').trim().replace(/^sfen\s+/, '').split(/\s+/);
  if (p.length < 1 || p[0].split('/').length !== 9) return '';
  return [p[0], p[1] || 'b', p[2] || '-', p[3] || '1'].join(' ');
}

/** problemsシートの全問題を検証し直し、不正な行を import_errors に書き出す（削除はしない） */
function checkAllProblems() {
  const ss = ss_();
  const sh = ss.getSheetByName(SHEET_NAME);
  const vals = sh.getDataRange().getValues();
  vals.shift();
  const bad = [];
  vals.forEach(function (r) {
    const reason = validateProblem_(String(r[2]), String(r[3] || '').trim().split(/\s+/).filter(String));
    if (reason) bad.push(['problems id=' + r[0], r[5] || '', r[2], r[3], reason]);
  });
  let es = ss.getSheetByName('import_errors');
  if (!es) es = ss.insertSheet('import_errors');
  es.clear();
  es.getRange(1, 1, 1, 5).setValues([['file', 'title', 'sfen', 'moves', 'reason']]).setFontWeight('bold');
  if (bad.length) es.getRange(2, 1, bad.length, 5).setValues(bad);
  console.log('検証: ' + vals.length + '問中 不正 ' + bad.length + '問');
}

/** 動作確認用：エディタから実行してログを見る */
function testApi() {
  console.log(doGet({ parameter: { action: 'meta' } }).getContent());
  console.log(doGet({ parameter: { action: 'random', moves: '3' } }).getContent());
}
