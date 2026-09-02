// 端到端客户端测试：双存档槽 + 主动读档面板 + 死亡线判定公平性
// 用法: node client-restore-test.js [main|fastdrop|overline]
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const scenario = process.argv[2] || 'main';
const html = fs.readFileSync(path.join(__dirname, '..', '合成大吕布-掉落版.html'), 'utf8');

const store = { auto: null, manual: null };
let confirmCalls = 0;
const hooks = { bodies: 0, updates: 0, lastFruitPos: null };
const errors = [];
const saveCalls = [];     // 记录 /api/save 上报内容
const lbCalls = [];       // 记录排行榜拉取次数

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost:8080/',
  beforeParse(window) {
    const noop = () => {};
    window.HTMLCanvasElement.prototype.getContext = function () {
      return new Proxy({}, {
        get: (t, p) => {
          if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => ({ addColorStop: noop });
          if (p === 'measureText') return () => ({ width: 10 });
          return noop;
        },
        set: () => true,
      });
    };
    window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 420, height: 640, right: 420, bottom: 640, x: 0, y: 0 };
    };
    window.localStorage.setItem('lvbu_drop_auth', JSON.stringify({ name: '测试玩家', token: 'faketoken', best: 0 }));
    // jsdom 未实现 matchMedia（侧栏窄屏判断用）与 offsetParent，桩之
    window.matchMedia = q => ({ matches: false, addListener() {}, removeListener() {} });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return {}; }, configurable: true });
    window.confirm = () => { confirmCalls++; return true; };
    const json = data => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
    window.fetch = (url, opts) => {
      url = String(url);
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (url.endsWith('/api/save')) { saveCalls.push(body); return json({ ok: true, best: 999, maxLevel: 3, games: 2, rank: 1 }); }
      if (url.endsWith('/api/leaderboard')) {
        lbCalls.push(1);
        return json({ top: [{ rank: 1, name: '测试玩家', best: 999, maxLevel: 3, games: 2 }], me: { rank: 1, name: '测试玩家', best: 999, maxLevel: 3 } });
      }
      if (url.endsWith('/api/autosave')) {
        store.auto = { ...body.snapshot, savedAt: new Date().toISOString() };
        return json({ ok: true });
      }
      if (url.endsWith('/api/manualsave')) {
        store.manual = { ...body.snapshot, savedAt: new Date().toISOString() };
        return json({ ok: true });
      }
      if (url.endsWith('/api/snapshots')) return json({ auto: store.auto, manual: store.manual });
      if (url.endsWith('/api/snapshot/clear')) {
        if (body.slot === 'manual' || body.slot === 'all') store.manual = null;
        if (body.slot === 'auto' || body.slot === 'all') store.auto = null;
        return json({ ok: true });
      }
      if (url.endsWith('/api/me')) return json({ name: '测试玩家', best: 0, maxLevel: 0, games: 0 });
      return json({ ok: true });
    };
    let matter;
    Object.defineProperty(window, 'Matter', {
      configurable: true,
      get() { return matter; },
      set(v) {
        matter = v;
        window.__M = v;
        const origAdd = v.Composite.add.bind(v.Composite);
        v.Composite.add = (w, b) => {
          const arr = Array.isArray(b) ? b : [b];
          window.__world = w;                       // 任何 add 都捕获 world（含建墙）
          for (const x of arr) {
            if (x.label === 'fruit') {
              hooks.bodies++;
              hooks.lastFruitPos = { x: x.position.x, y: x.position.y };
            }
          }
          return origAdd(w, b);
        };
        const origUpdate = v.Engine.update.bind(v.Engine);
        v.Engine.update = (e, d) => { hooks.updates++; return origUpdate(e, d); };
      },
    });
    window.addEventListener('error', e => errors.push(e.message));
    window.addEventListener('unhandledrejection', e => errors.push('rejection: ' + e.reason));
  },
});

const { window } = dom;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => window.document.getElementById(id);
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log((ok ? '✔' : '✘') + ' ' + name); };

async function dropBall(clientX) {
  const canvas = window.document.getElementById('game');
  canvas.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX, clientY: 300 }));
  await sleep(30);
  canvas.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX, clientY: 300 }));
}

async function scenarioMain() {
  // 启动后：无弹窗、无自动恢复、棋盘为空
  await sleep(1500);
  check('[main] 启动无 confirm 弹窗', confirmCalls === 0);
  check('[main] 启动不自动恢复（棋盘空）', hooks.bodies === 0);
  check('[main] 主循环存活', hooks.updates > 0);

  // 落 3 步 → 触发自动存档
  await dropBall(100); await sleep(700);
  await dropBall(200); await sleep(700);
  await dropBall(300); await sleep(900);
  check('[main] 3 步后触发自动存档', !!store.auto);
  check('[main] 自动存档含 3 个武将', store.auto && store.auto.pieces.length === 3);
  check('[main] 存档坐标均为有效数字', store.auto && store.auto.pieces.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));

  // 手动存档
  $('saveBtn').click();
  await sleep(500);
  check('[main] 💾 按钮触发手动存档', !!store.manual);

  // 读档面板
  $('loadBtn').click();
  await sleep(400);
  check('[main] 📂 打开存档面板', $('slotOverlay').classList.contains('show'));
  check('[main] 面板显示自动存档信息', $('autoInfo').textContent.includes('个武将'));

  // 恢复手动存档
  const addsBefore = hooks.bodies;
  $('restoreManual').click();
  await sleep(600);
  check('[main] 读档面板自动关闭', !$('slotOverlay').classList.contains('show'));
  check('[main] 恢复重建了棋面（+3 球）', hooks.bodies === addsBefore + 3);
  check('[main] 恢复坐标有效', hooks.lastFruitPos && Number.isFinite(hooks.lastFruitPos.x) && Number.isFinite(hooks.lastFruitPos.y));

  // 删除自动存档
  $('loadBtn').click();
  await sleep(300);
  $('delAuto').click();
  await sleep(700);
  check('[main] 删除自动存档走 confirm', confirmCalls >= 1);
  check('[main] 删除后自动槽为空', store.auto === null);
  check('[main] 面板显示（空）', $('autoInfo').textContent.includes('空'));

  check('[main] 全程零 JS 错误', errors.length === 0);
}

async function scenarioFastdrop() {
  // 快速连点 3 球（同一落点），球堆未达警戒线：不允许误判失败
  await sleep(1200);
  await dropBall(210); await sleep(620);
  await dropBall(210); await sleep(620);
  await dropBall(210); await sleep(2500);
  check('[fastdrop] 主循环存活', hooks.updates > 0);
  check('[fastdrop] 快速连点未误判失败', !$('resultOverlay').classList.contains('show'));
  check('[fastdrop] 零 JS 错误', errors.length === 0);
}

async function scenarioOverline() {
  // 静态平台托住一个球持续停在警戒线上方：豁免期结束后必须正常判负
  await sleep(1500);
  const M = window.__M, w = window.__world;
  M.Composite.add(w, M.Bodies.rectangle(210, 100, 300, 20, { isStatic: true, label: 'wall' }));
  const bb = M.Bodies.circle(210, 62, 28, { label: 'fruit', restitution: 0.15, friction: 0.4 });
  bb.plugin = { lvl: 3, aboveSince: null, born: performance.now() };
  M.Composite.add(w, bb);
  hooks.bodies++;
  await sleep(4500);   // 1s 年龄门槛 + 1.5s 判线窗口
  check('[overline] 持续超线的落定球被判负', $('resultOverlay').classList.contains('show'));
  check('[overline] 零 JS 错误', errors.length === 0);
}

async function scenarioSidelb() {
  // 侧边实时排行榜：渲染、折叠、实时上报（读档后 5 秒内 /api/save）
  await sleep(1500);
  check('[sidelb] 侧栏存在且展开', !!window.document.getElementById('sideLb') && !$('sideLb').classList.contains('collapsed'));
  check('[sidelb] 初始化拉取了排行榜', lbCalls.length >= 1);
  check('[sidelb] 空榜显示虚位以待', $('sideList').textContent.includes('虚位以待') || $('sideList').textContent.includes('测试玩家'));

  // 折叠/展开 + 状态持久化
  $('sideToggle').click();
  await sleep(200);
  check('[sidelb] 点击后折叠', $('sideLb').classList.contains('collapsed'));
  check('[sidelb] 折叠状态持久化', window.localStorage.getItem('lvbu_side') === '1');
  $('sideToggle').click();
  await sleep(200);
  check('[sidelb] 再次点击展开', !$('sideLb').classList.contains('collapsed'));

  // 实时上报：预置一份高分手动存档 → 读档 → 分数变化 → 5 秒内 /api/save
  store.manual = { score: 555, dropsCount: 3, curIdx: 1, nextIdx: 2, lvbuCount: 0, savedAt: new Date().toISOString(), pieces: [{ lvl: 0, x: 100, y: 600 }] };
  $('loadBtn').click();
  await sleep(400);
  $('restoreManual').click();
  await sleep(5600);   // 覆盖 5s 上报去抖窗口
  check('[sidelb] 分数变化触发实时上报', saveCalls.some(c => c.score === 555));
  check('[sidelb] 上报后侧栏显示我的排名', $('sideMe').textContent.includes('第 1 名'));
  check('[sidelb] 头部分数同步为服务器最高', $('best').textContent === '999');
  check('[sidelb] 零 JS 错误', errors.length === 0);
}

(async () => {
  if (scenario === 'fastdrop') await scenarioFastdrop();
  else if (scenario === 'overline') await scenarioOverline();
  else if (scenario === 'sidelb') await scenarioSidelb();
  else await scenarioMain();
  const pass = results.every(r => r[1]);
  console.log(pass ? `=== [${scenario}] 全部通过 ===` : `=== [${scenario}] 存在失败项 ===`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('HARNESS FAIL:', e); process.exit(1); });
