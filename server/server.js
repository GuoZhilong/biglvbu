/* ============================================================
 * 合成大吕布·掉落版 —— 后端服务
 * 零依赖（无需 npm install），要求 Node.js >= 18
 *
 *   启动:  node server.js
 *   端口:  默认 8080，可用环境变量 PORT 覆盖
 *   数据:  同目录 users.json（自动创建，含用户与登录令牌）
 *   页面:  托管仓库根目录的 index.html（主页）+ 两个游戏页面（白名单）
 *
 * API:
 *   POST /api/register     {name, pass}            → {name, token, best, maxLevel}
 *                                                  （昵称全局唯一 = 账号用户名）
 *   POST /api/login        {name, pass}            → {name, token, best, maxLevel, games}
 *   GET  /api/me           (Authorization)         → {name, best, maxLevel, games}
 *   POST /api/save         (Authorization)         → {best, maxLevel, games, rank}
 *                          {score, maxLevel, games}
 *   POST /api/logout       (Authorization)         → {ok:true}
 *   GET  /api/leaderboard  (Authorization 可选)    → {top:[...], me:{rank,...}|null}
 *   POST /api/autosave     (Authorization)         → {ok:true}   自动存档槽
 *                          {snapshot:{score,dropsCount,curIdx,nextIdx,lvbuCount,pieces}}
 *   POST /api/manualsave   (Authorization)         → {ok:true}   手动存档槽（同结构）
 *   GET  /api/snapshots    (Authorization)         → {auto, manual}
 *   POST /api/snapshot/clear (Authorization)        → {ok:true}   {slot:'auto'|'manual'|'all'}
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const DB_FILE = path.join(__dirname, 'users.json');
const STATIC_DIR = path.resolve(__dirname, '..');
// 允许托管的静态页面白名单（防路径穿越）
const STATIC_PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/合成大吕布-掉落版.html': '合成大吕布-掉落版.html',
  '/合成大吕布.html': '合成大吕布.html',
};
const MAX_BODY = 10 * 1024;          // 请求体上限
const SESSION_TTL = 30 * 24 * 3600 * 1000;  // 登录令牌 30 天有效

/* ---------- 存储（JSON 文件，原子写入） ---------- */
let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* 首次启动无文件 */ }
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('[db] 保存失败:', e.message); }
  }, 200);
}

/* ---------- 工具 ---------- */
const hash = (pass, salt) => crypto.scryptSync(pass, salt, 32).toString('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');
const nowStr = () => new Date().toISOString();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
const bad = (res, msg) => send(res, 400, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function authUser(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return null;
  const sess = db.sessions[m[1]];
  if (!sess || Date.now() - new Date(sess.created).getTime() > SESSION_TTL) return null;
  return db.users[sess.userId] || null;
}

function createSession(userId) {
  // 顺手清理过期会话
  const cutoff = Date.now() - SESSION_TTL;
  for (const [t, s] of Object.entries(db.sessions)) {
    if (new Date(s.created).getTime() < cutoff) delete db.sessions[t];
  }
  const token = genToken();
  db.sessions[token] = { userId, created: nowStr() };
  return token;
}

function profile(u) {
  return { name: u.name, best: u.best, maxLevel: u.maxLevel, games: u.games };
}

// 全量排序（当前规模下 Object.entries 足够快；上榜人数破万再考虑优化）
function sortedUsers() {
  return Object.values(db.users)
    .filter(u => u.best > 0)
    .sort((a, b) => b.best - a.best || (a.updated < b.updated ? -1 : 1));
}

// 校验单局中途快照：{score, dropsCount, curIdx, nextIdx, lvbuCount, pieces:[{lvl,x,y}]}
function validSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return { err: '快照格式错误' };
  const score = Math.floor(Number(raw.score));
  if (!Number.isFinite(score) || score < 0 || score > 10_000_000) return { err: '快照分数非法' };
  const drops = Math.floor(Number(raw.dropsCount));
  if (!Number.isFinite(drops) || drops < 0 || drops > 100000) return { err: '快照局数非法' };
  const cur = Number(raw.curIdx), next = Number(raw.nextIdx);
  if (!Number.isInteger(cur) || cur < 0 || cur > 10 || !Number.isInteger(next) || next < 0 || next > 10) return { err: '快照武将非法' };
  if (!Array.isArray(raw.pieces) || raw.pieces.length > 150) return { err: '快照棋面非法' };
  const pieces = [];
  for (const p of raw.pieces) {
    const lvl = Number(p.lvl), x = Number(p.x), y = Number(p.y);
    if (!Number.isInteger(lvl) || lvl < 0 || lvl > 10 ||
        !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1000 || y < 0 || y > 1000) {
      return { err: '快照棋面非法' };
    }
    pieces.push({ lvl, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  const lvbu = Math.floor(Number(raw.lvbuCount));
  return { data: { score, dropsCount: drops, curIdx: cur, nextIdx: next,
                   lvbuCount: Number.isFinite(lvbu) && lvbu >= 0 ? Math.min(lvbu, 9999) : 0, pieces } };
}

/* ---------- 简易限流：每 IP 每分钟 120 次 ---------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();  // 防止 Map 无限膨胀
  return arr.length > 120;
}

/* ---------- API 路由 ---------- */
const routes = {

  'POST /api/register': async (req, res) => {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const pass = String(b.pass || '');
    if (!name || name.length > 12) return bad(res, '昵称需要 1-12 个字');
    if (pass.length < 4 || pass.length > 32) return bad(res, '密码需要 4-32 位');
    // 昵称即用户名（作存储主键），需唯一；同时挡掉危险的对象键名
    if (['__proto__', 'constructor', 'prototype'].includes(name)) return bad(res, '这个昵称不能用');
    if (db.users[name]) return bad(res, '该昵称已被注册，换一个试试');
    const salt = crypto.randomBytes(8).toString('hex');
    const u = { name, salt, hash: hash(pass, salt), best: 0, maxLevel: 0, games: 0, created: nowStr(), updated: nowStr() };
    db.users[name] = u;
    const token = createSession(name);
    saveDb();
    send(res, 200, { token, ...profile(u) });
  },

  'POST /api/login': async (req, res) => {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const pass = String(b.pass || '');
    if (!name) return bad(res, '请输入昵称');
    const u = db.users[name];
    if (!u) return bad(res, '昵称不存在，检查一下有没有输错');
    const expect = Buffer.from(u.hash, 'hex');
    const actual = Buffer.from(hash(pass, u.salt), 'hex');
    if (expect.length !== actual.length || !crypto.timingSafeEqual(expect, actual)) {
      return bad(res, '密码不对');
    }
    const token = createSession(name);
    saveDb();
    send(res, 200, { token, ...profile(u) });
  },

  'GET /api/me': async (req, res) => {
    const u = authUser(req);
    if (!u) return send(res, 401, { error: '未登录或登录已过期' });
    send(res, 200, profile(u));
  },

  'POST /api/save': async (req, res) => {
    const u = authUser(req);
    if (!u) return send(res, 401, { error: '未登录或登录已过期' });
    const b = await readBody(req);
    const score = Math.floor(Number(b.score));
    const maxLevel = Math.floor(Number(b.maxLevel));
    const games = Math.floor(Number(b.games));
    if (!Number.isFinite(score) || score < 0 || score > 10_000_000) return bad(res, '分数非法');
    if (!Number.isFinite(maxLevel) || maxLevel < 0 || maxLevel > 10) return bad(res, '等级非法');
    if (!Number.isFinite(games) || games < 0 || games > 1_000_000) return bad(res, '局数非法');
    // 各维度只增不减，避免多设备/旧数据回滚
    u.best = Math.max(u.best, score);
    u.maxLevel = Math.max(u.maxLevel, maxLevel);
    u.games = Math.max(u.games, games);
    u.updated = nowStr();
    saveDb();
    const rank = sortedUsers().findIndex(x => x.name === u.name);
    send(res, 200, { best: u.best, maxLevel: u.maxLevel, games: u.games, rank: rank >= 0 ? rank + 1 : null });
  },

  'POST /api/logout': async (req, res) => {
    const m = /^Bearer\s+(.+)$/.exec(req.headers['authorization'] || '');
    if (m && db.sessions[m[1]]) { delete db.sessions[m[1]]; saveDb(); }
    send(res, 200, { ok: true });
  },

  'POST /api/autosave': async (req, res) => {
    const u = authUser(req);
    if (!u) return send(res, 401, { error: '未登录或登录已过期' });
    const b = await readBody(req);
    const s = validSnapshot(b.snapshot);
    if (s.err) return bad(res, s.err);
    s.data.savedAt = nowStr();
    u.auto = s.data;
    delete u.snapshot;        // 旧版单存档字段迁移清理
    saveDb();
    send(res, 200, { ok: true });
  },

  'POST /api/manualsave': async (req, res) => {
    const u = authUser(req);
    if (!u) return send(res, 401, { error: '未登录或登录已过期' });
    const b = await readBody(req);
    const s = validSnapshot(b.snapshot);
    if (s.err) return bad(res, s.err);
    s.data.savedAt = nowStr();
    u.manual = s.data;
    saveDb();
    send(res, 200, { ok: true });
  },

  'GET /api/snapshots': async (req, res) => {
    const u = authUser(req);
    if (!u) return send(res, 401, { error: '未登录或登录已过期' });
    // 旧版数据迁移：单存档 snapshot 视为自动存档
    send(res, 200, { auto: u.auto || u.snapshot || null, manual: u.manual || null });
  },

  'POST /api/snapshot/clear': async (req, res) => {
    const u = authUser(req);
    if (!u) return send(res, 401, { error: '未登录或登录已过期' });
    const b = await readBody(req);
    const slot = b.slot || 'auto';
    if (slot !== 'auto' && slot !== 'manual' && slot !== 'all') return bad(res, 'slot 非法');
    if (slot === 'auto' || slot === 'all') { u.auto = null; delete u.snapshot; }
    if (slot === 'manual' || slot === 'all') u.manual = null;
    saveDb();
    send(res, 200, { ok: true });
  },

  'GET /api/leaderboard': async (req, res) => {
    const sorted = sortedUsers();
    const top = sorted.slice(0, 50).map((u, i) => ({
      rank: i + 1, name: u.name, best: u.best, maxLevel: u.maxLevel, games: u.games,
    }));
    let me = null;
    const u = authUser(req);
    if (u && u.best > 0) {
      const rank = sorted.findIndex(x => x.name === u.name) + 1;
      me = { rank, name: u.name, best: u.best, maxLevel: u.maxLevel };
    }
    send(res, 200, { top, me });
  },
};

/* ---------- 静态页面 ---------- */
function serveStatic(res, filename) {
  fs.readFile(path.join(STATIC_DIR, filename), (err, buf) => {
    if (err) { send(res, 500, { error: '页面文件缺失: ' + filename }); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------- HTTP 服务 ---------- */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  try {
    const url = new URL(req.url, 'http://localhost');
    // 中文路径会以百分号编码到达，需解码后再匹配白名单
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch (e) {}
    const route = routes[req.method + ' ' + pathname];
    if (route) {
      if (rateLimited(ip)) return send(res, 429, { error: '请求太频繁，稍后再试' });
      await route(req, res);
      return;
    }
    if (req.method === 'GET' && STATIC_PAGES[pathname]) {
      return serveStatic(res, STATIC_PAGES[pathname]);
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: '接口不存在' });
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error('[err]', ip, req.method, req.url, '-', e.message);
    if (!res.headersSent) send(res, 400, { error: e.message || '服务器错误' });
  }
});

server.listen(PORT, () => {
  console.log(`合成大吕布·掉落版 服务已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${DB_FILE}`);
  console.log(`游戏页面: ${STATIC_DIR} (index.html + 游戏页白名单)`);
});
