// The game server of server.py, inside the browser (GitHub Pages build, tools/build_site.sh): the engine and the
// NNUE compiled to WebAssembly (engine/wasm_api.cpp) answer the page's /api/... requests, posted as messages
// {id, path, body} -> {id, result}. One thread: the AI's move, the evaluation and the analysis take turns, and the
// pondering runs in short slices between requests.
importScripts('engine.js');

const TYPE_NAMES = ['--', 'FU', 'KY', 'KE', 'GI', 'KI', 'KA', 'HI', 'OU', 'TO', 'NY', 'NK', 'NG', 'UM', 'RY',
                    'CP', 'CN', 'CB', 'CR', 'CQ', 'CK', 'PQ', 'PR', 'PB', 'PN'];
const HAND_TYPES = ['FU', 'KY', 'KE', 'GI', 'KI', 'KA', 'HI', 'CP', 'CN', 'CB', 'CR', 'CQ'];
const REASONS = ['', '詰み', 'ステイルメイト', '千日手', '連続王手の千日手', '手数上限'];
const ONGOING = 0, WIN0 = 1, WIN1 = 2, DRAW = 3;
const SHOGI_TYPES = new Set(TYPE_NAMES.slice(1, 15));
const JP = {FU: '歩', KY: '香', KE: '桂', GI: '銀', KI: '金', KA: '角', HI: '飛', OU: '玉', TO: 'と', NY: '成香',
            NK: '成桂', NG: '成銀', UM: '馬', RY: '龍', CP: 'ポーン', CN: 'ナイト', CB: 'ビショップ', CR: 'ルーク',
            CQ: 'クイーン', CK: 'キング', PQ: 'クイーン', PR: 'ルーク', PB: 'ビショップ', PN: 'ナイト'};
const KAN = '一二三四五六七八九';
const MATE_PLY = 7, MATE_NODES = 5000;  // the AI plays a forced mate within 7 plies at once (as server.py)
const MATE_SCORE = 29000;
const MAX_THINK_MS = 10000;
const EVAL_MS = 500;
const PONDER_S = 300, PONDER_SLICE_MS = 200;
const ANALYSIS_TOP = 3, ANALYSIS_LINE_MS = 300;
const TT_BITS = 22;  // 64 MB

let M = null, NAME = 'nnue';
const W = {};  // engine calls
const buf = {};  // scratch memory in the engine's heap

const ready = (async () => {
  M = await createEngine();
  for (const [f, r, a] of [
    ['w_init', 'number', ['number']], ['w_nnue_load', 'number', ['string']], ['w_initial', null, []],
    ['w_set_packed', null, ['number', 'number']], ['w_pack', null, ['number', 'number']],
    ['w_view_from_game', null, ['number']], ['w_legal', 'number', ['number']], ['w_move', 'number', ['number']],
    ['w_make', 'number', ['number', 'number']], ['w_unmake', 'number', ['number']],
    ['w_status', 'number', ['number']], ['w_state', null, ['number', 'number', 'number', 'number']],
    ['w_move_str', 'string', ['number', 'number']], ['w_parse_move', 'number', ['number', 'string']],
    ['w_mate', 'number', ['number', 'number', 'number']], ['w_search_time', 'number', ['number', 'number']],
    ['w_res_score', 'number', []], ['w_res_depth', 'number', []], ['w_res_nodes', 'number', []],
    ['w_multipv', 'number', ['number', 'number', 'number', 'number']],
    ['w_line_move', 'number', ['number']], ['w_line_score', 'number', ['number']],
    ['w_line_depth', 'number', ['number']]]) W[f.slice(2)] = M.cwrap(f, r, a);
  W.init(TT_BITS);
  for (const [k, n] of [['board', 81], ['hands', 24], ['info', 16], ['packed', 112], ['nodes', 8]]) buf[k] = M._malloc(n);
  const [net, name] = await Promise.all([fetch('nnue.bin').then(r => r.arrayBuffer()),
                                         fetch('nnue.name').then(r => r.ok ? r.text() : 'nnue').catch(() => 'nnue')]);
  M.FS.writeFile('/nnue.bin', new Uint8Array(net));
  if (!W.nnue_load('/nnue.bin')) throw new Error('NNUE を読み込めませんでした');
  NAME = name.trim();
})();

// ---------------- positions (0 = the game, 1 = the view: a copy to look at or search) ----------------
function moveParts(m) {
  const frm = (m >> 7) & 127, promo = (m >> 19) & 31;
  return {to: m & 127, from: frm === 127 ? null : frm, drop: frm === 127 ? HAND_TYPES[(m >> 14) & 31] : null,
          promo: promo ? TYPE_NAMES[promo] : null};
}
function cellInfo(c) { return c ? {t: TYPE_NAMES[c & 31], o: (c >> 5) & 1} : null; }
function posState(which) {
  W.state(which, buf.board, buf.hands, buf.info);
  const board = M.HEAPU8.slice(buf.board, buf.board + 81), hands = M.HEAPU8.slice(buf.hands, buf.hands + 24);
  const info = M.HEAP32.slice(buf.info >> 2, (buf.info >> 2) + 4);
  return {board, hands, side: info[0], ply: info[1], check: !!info[2], last: info[3] >>> 0};
}
function legal(which) {
  const n = W.legal(which), out = [];
  for (let i = 0; i < n; i++) out.push(W.move(i) >>> 0);
  return out;
}
function status(which) { const s = W.status(which); return [s >> 4, s & 15]; }
function pack(which) {
  W.pack(which, buf.packed);
  return M.HEAPU8.slice(buf.packed, buf.packed + 112);
}
function toHex(a) { return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(2 * i, 2), 16); return a; }
function setPacked(which, bytes) { M.HEAPU8.set(bytes, buf.packed); W.set_packed(which, buf.packed); }

// Japanese notation of move m in position `which` (before it is played), e.g. ☗7六歩, ☖同ナイト, ☗5五角打
function jpLabel(which, m) {
  const st = posState(which), p = moveParts(m);
  const mark = st.side === 0 ? '☗' : '☖';
  const dest = st.last && moveParts(st.last).to === p.to ? '同' : `${9 - p.to % 9}${KAN[Math.floor(p.to / 9)]}`;
  if (p.drop) return mark + dest + JP[p.drop] + '打';
  const t = cellInfo(st.board[p.from]).t;
  let s = mark + dest + JP[t];
  if (p.promo) s += SHOGI_TYPES.has(p.promo) ? '成' : '成' + JP[p.promo];
  else if (['FU', 'KY', 'KE', 'GI', 'KA', 'HI'].includes(t) &&
           legal(which).map(moveParts).some(q => q.from === p.from && q.to === p.to && q.promo)) s += '不成';
  return s;
}

// alpha-beta score (600 per win-probability logit) -> value: exactly +-1 for a forced mate, else within +-0.9999
function nonmate(v) { return Math.max(-0.9999, Math.min(0.9999, Math.round(v * 1e4) / 1e4)); }
function scoreValue(score) {
  if (Math.abs(score) >= MATE_SCORE) return score > 0 ? 1 : -1;
  return nonmate(2 / (1 + Math.exp(-score / 600)) - 1);
}

// ---------------- the game ----------------
const G = {start: '', history: [], labels: [], ai_sides: [1], think_ms: 2000, last_info: null};

function resetGame(start) {
  if (start) setPacked(0, fromHex(start)); else W.initial();
  G.start = start || '';
  G.history = []; G.labels = []; G.last_info = null;
}
function apply(m) {
  const s = W.move_str(0, m), jp = jpLabel(0, m);
  if (!W.make(0, m)) throw new Error('illegal move');
  G.history.push(s); G.labels.push(jp);
}
function viewAt(ply) { W.view_from_game(G.history.length - ply); }
function gameKey(ply) { return G.start + '|' + G.history.slice(0, ply).join(','); }

function state(ply) {
  const n = G.history.length, live = ply === undefined || ply === null || ply >= n;
  const which = live ? 0 : 1;
  if (!live) viewAt(Math.max(0, ply));
  const st = posState(which), [s, reason] = status(which);
  const legalMoves = s === ONGOING && live ? legal(0).map(m => ({s: W.move_str(0, m), ...moveParts(m)})) : [];
  const hands = [0, 1].map(o => {
    const h = {};
    HAND_TYPES.forEach((t, i) => { if (st.hands[o * 12 + i]) h[t] = st.hands[o * 12 + i]; });
    return h;
  });
  const lp = st.last ? moveParts(st.last) : null;
  return {
    board: Array.from(st.board, cellInfo), hands, side: st.side, ply: st.ply, check: st.check,
    status: s, reason: REASONS[reason], legal: legalMoves, last: lp ? {from: lp.from, to: lp.to} : null,
    history: G.history, labels: G.labels, ai_sides: G.ai_sides, model: {name: 'nnue-' + NAME},
    engine: 'nnue', eval_model: 'nnue-' + NAME, think_ms: G.think_ms, start: G.start, ai_info: G.last_info,
    view_ply: live ? null : ply, nnue: NAME,
  };
}

function aiMove() {
  stopPonder();
  if (status(0)[0] !== ONGOING) return;
  const t0 = performance.now();
  viewAt(G.history.length);
  const sign = posState(1).side === 0 ? 1 : -1;
  // the mate search gets at most a quarter of the thinking time (in an endgame full of checks its nodes cost a lot),
  // the alpha-beta search the rest
  let m = W.mate(MATE_PLY, MATE_NODES, Math.max(1, G.think_ms >> 2)) >>> 0, info;
  if (m) info = {engine: `NNUE ${NAME} + 詰み探索`, model: 'nnue-' + NAME, value: 1, mate: true, value_sente: sign};
  else {
    // a lone legal move is read only for its value (as the evaluation does), the rest for the whole time left
    const lone = legal(1).length === 1;
    m = W.search_time(lone ? Math.min(EVAL_MS, G.think_ms) : Math.max(1, G.think_ms - (performance.now() - t0)),
                      lone ? 1 : 0) >>> 0;
    const v = scoreValue(W.res_score());
    info = {engine: `NNUE ${NAME} + αβ`, model: 'nnue-' + NAME, value: v, depth: W.res_depth(),
            sims: W.res_nodes(), value_sente: sign * v};
  }
  apply(m);
  info.ms = Math.round(performance.now() - t0);
  G.last_info = info;
  startPonder();
}

// ---------------- pondering: while the player thinks, search the position in short slices ----------------
let ponder = null, ponderQueued = false;  // {key, until}; a slice waiting to run
function stopPonder() { ponder = null; }
function queuePonder() {
  if (ponder && !ponderQueued) { ponderQueued = true; setTimeout(ponderStep, 0); }  // requests that came in go first
}
function startPonder() {
  if (G.ai_sides.includes(posState(0).side) || status(0)[0] !== ONGOING) return;
  ponder = {key: gameKey(G.history.length), until: performance.now() + PONDER_S * 1000};
}
function ponderStep() {
  ponderQueued = false;
  if (!ponder || busy) return;
  if (ponder.key !== gameKey(G.history.length) || performance.now() > ponder.until) { ponder = null; return; }
  viewAt(G.history.length);
  W.search_time(PONDER_SLICE_MS, 0);
  queuePonder();
}

// ---------------- evaluation and analysis ----------------
const evalCache = new Map();
function evalAt(ply) {
  const key = gameKey(ply);
  if (evalCache.has(key)) return evalCache.get(key);
  viewAt(ply);
  const [s] = status(1);
  let r;
  if (s !== ONGOING) r = {value: s === DRAW ? 0 : s === WIN0 ? 1 : -1, final: true};
  else {
    const side = posState(1).side;
    W.search_time(EVAL_MS, 1);
    const v = scoreValue(W.res_score());
    r = {value: Math.round((side === 0 ? v : -v) * 1e4) / 1e4, engine: `NNUE ${NAME}`, depth: W.res_depth()};
  }
  evalCache.set(key, r);
  return r;
}

// one step of the analysis of the position after `ply` moves: the 3 best lines to the next depth, each line at most
// ANALYSIS_LINE_MS (an unfinished depth is tried again on the next request, from what the table kept)
const A = {key: null, depth: 4, shown: null, nodes: 0};
function analyze(ply) {
  const n = G.history.length;
  ply = ply === undefined || ply === null ? n : Math.max(0, Math.min(n, ply));
  viewAt(ply);
  if (status(1)[0] !== ONGOING) return {final: true};
  const side = posState(1).side;
  if (ply === n && G.ai_sides.includes(side)) return {paused: true};
  const key = gameKey(ply);
  if (A.key !== key) Object.assign(A, {key, depth: 4, shown: null, nodes: 0});
  if (!(A.shown && A.shown.done)) {
    const k = W.multipv(ANALYSIS_TOP, A.depth, ANALYSIS_LINE_MS, buf.nodes);
    A.nodes += M.HEAPF64[buf.nodes >> 3];
    const lines = [];
    for (let i = 0; i < k; i++) lines.push([W.line_move(i) >>> 0, W.line_score(i), W.line_depth(i)]);
    // a line that found a forced mate stops deepening by itself: it is as finished as it will get
    const finished = lines.length && lines.every(([, sc, d]) => d >= A.depth || Math.abs(sc) >= MATE_SCORE);
    if (finished) {
      const sign = side === 0 ? 1 : -1;
      const allMate = lines.every(([, sc]) => Math.abs(sc) >= MATE_SCORE);
      lines.sort((a, b) => b[1] - a[1]);
      const cands = lines.map(([m, sc, d]) => ({label: jpLabel(1, m), move: W.move_str(1, m), visits: d,
                                                value: Math.round(sign * scoreValue(sc) * 1e4) / 1e4}));
      const done = A.depth >= 60 || allMate;
      A.shown = {depth: A.depth, value: cands[0].value, cands, done,
                 stopped: done ? (allMate ? 'mate' : 'limit') : null, model: 'nnue-' + NAME};
      A.depth++;
    }
  }
  return {sims: A.nodes, cands: [], done: false, stopped: null, ...(A.shown || {})};
}

// ---------------- the board editor (build_position of server.py) ----------------
const PAWN_LIKE = new Set(['FU', 'KY', 'CP']);
function buildPosition(board, hands, side) {
  if (board.length !== 81 || ![0, 1].includes(side)) return '盤面のデータが正しくありません';
  const packed = new Uint8Array(112), royals = [0, 0], pawnFiles = new Set();
  for (let sq = 0; sq < 81; sq++) {
    const c = board[sq];
    if (!c) continue;
    const {t, o} = c, y = Math.floor(sq / 9), x = sq % 9;
    if (!TYPE_NAMES.slice(1).includes(t) || ![0, 1].includes(o)) return '盤面のデータが正しくありません';
    if (t === 'OU' || t === 'CK') {
      if ((t === 'OU') !== (o === 0)) return '玉は先手（将棋）、キングは後手（チェス）だけが持てます';
      royals[o]++;
    }
    const last = o === 0 ? 0 : 8;
    if ((PAWN_LIKE.has(t) && y === last) || (t === 'KE' && Math.abs(y - last) <= 1))
      return `${9 - x}筋の${KAN[y]}段の駒はそれ以上動けません`;
    if (t === 'FU') {
      if (pawnFiles.has(o * 9 + x)) return `二歩です（${9 - x}筋）`;
      pawnFiles.add(o * 9 + x);
    }
    const unmoved = t === 'CP' && o === 1 && y === 1;
    packed[sq] = TYPE_NAMES.indexOf(t) | (o << 5) | (unmoved ? 64 : 0);
  }
  if (royals[0] !== 1 || royals[1] !== 1) return '玉とキングを1枚ずつ置いてください';
  for (const o of [0, 1])
    for (const [h, n] of Object.entries(hands[o] || {})) {
      if (!HAND_TYPES.includes(h) || !(n >= 0 && n <= 18)) return '持ち駒のデータが正しくありません';
      packed[(o === 0 ? 81 : 93) + HAND_TYPES.indexOf(h)] = n;
    }
  const k = packed[4] === (TYPE_NAMES.indexOf('CK') | 32), cr = TYPE_NAMES.indexOf('CR') | 32;
  packed[107] = (k && packed[7] === cr ? 1 : 0) | (k && packed[0] === cr ? 2 : 0);
  packed[106] = packed[111] = 255;
  // the side that is not to move must not be in check (its king could just be taken)
  packed[105] = 1 - side;
  setPacked(1, packed);
  if (posState(1).check)
    return (side === 1 ? '☗先手（将棋）' : '☖後手（チェス）') + 'の玉が取れる状態です（手番でない側が王手されています）';
  packed[105] = side;
  return packed;
}

// ---------------- requests ----------------
function handle(path, req) {
  if (path === '/api/state') return state();
  if (path === '/api/restore') {  // the page's saved game (localStorage), played back after a reload
    resetGame(req.start);
    Object.assign(G, {ai_sides: req.ai_sides || [1], think_ms: req.think_ms || 2000});
    for (const s of req.history || []) {
      const m = W.parse_move(0, s) >>> 0;
      if (!m) break;
      apply(m);
    }
    return state();
  }
  if (path === '/api/new') {
    resetGame('');
    G.ai_sides = req.ai_sides || [1];
    if ('think_ms' in req) G.think_ms = Math.max(100, Math.min(MAX_THINK_MS, req.think_ms | 0));
  } else if (path === '/api/move') {
    const m = W.parse_move(0, req.move) >>> 0;
    if (!m) return {error: `その手は指せません（${req.move}）`, state: state()};
    apply(m);
  } else if (path === '/api/ai') aiMove();
  else if (path === '/api/analyze') {
    stopPonder();
    return {ply: req.ply === undefined || req.ply === null ? G.history.length : req.ply | 0, ...analyze(req.ply)};
  } else if (path === '/api/view') return state(req.ply === undefined ? G.history.length : req.ply | 0);
  else if (path === '/api/eval') {
    const n = G.history.length, ply = Math.max(0, Math.min(n, req.ply === undefined ? n : req.ply | 0));
    return {ply, ...evalAt(ply)};
  } else if (path === '/api/setpos') {
    const r = buildPosition(req.board || [], req.hands || [{}, {}], req.side);
    if (typeof r === 'string') return {error: r, edit: true};
    resetGame(toHex(r));
  } else if (path === '/api/undo') {
    for (let i = 0; i < (req.n || 1); i++)
      if (W.unmake(0)) { G.history.pop(); G.labels.pop(); }
    G.last_info = null;
  } else if (path === '/api/settings') {
    if ('ai_sides' in req) G.ai_sides = req.ai_sides;
    if ('think_ms' in req) G.think_ms = Math.max(100, Math.min(MAX_THINK_MS, req.think_ms | 0));
  } else return {error: 'not found'};
  return state();
}

let busy = false;
onmessage = async ev => {
  const {id, path, body} = ev.data;
  let result;
  try {
    await ready;
    busy = true;
    result = handle(path, body || {});
  } catch (e) {
    result = {error: String(e && e.message || e)};
  } finally {
    busy = false;
  }
  postMessage({id, result});
  queuePonder();
};
