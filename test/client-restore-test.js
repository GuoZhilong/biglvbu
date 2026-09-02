// 端到端客户端测试：双存档槽（自动每3步 + 手动按钮）+ 主动读档面板
// 用法: node client-restore-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', '合成大吕布-掉落版.html'), 'utf8');

// 内存版存档服务器
const store = { auto: null, manual: null };
let confirmCalls = 0;
const hooks = { bodies: 0, updates: 0, lastFruitPos: null };
const errors = [];

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
    window.confirm = () => { confirmCalls++; return true; };
    const json = data => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
    window.fetch = (url, opts) => {
      url = String(url);
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
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

(async () => {
  // 1. 启动后：无弹窗、无自动恢复、棋盘为空
  await sleep(1500);
  check('启动无 confirm 弹窗', confirmCalls === 0);
  check('启动不自动恢复（棋盘空）', hooks.bodies === 0);
  check('主循环存活', hooks.updates > 0);

  // 2. 落 3 步 → 触发自动存档
  await dropBall(100); await sleep(700);
  await dropBall(200); await sleep(700);
  await dropBall(300); await sleep(900);   // 第 3 步触发 /api/autosave
  check('3 步后触发自动存档', !!store.auto);
  check('自动存档含 3 个武将', store.auto && store.auto.pieces.length === 3);
  check('存档坐标均为有效数字', store.auto && store.auto.pieces.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));

  // 3. 手动存档
  $('saveBtn').click();
  await sleep(500);
  check('💾 按钮触发手动存档', !!store.manual);

  // 4. 打开读档面板
  $('loadBtn').click();
  await sleep(400);
  check('📂 打开存档面板', $('slotOverlay').classList.contains('show'));
  check('面板显示自动存档信息', $('autoInfo').textContent.includes('个武将'));

  // 5. 恢复手动存档（覆盖当前局面）
  const addsBefore = hooks.bodies;
  $('restoreManual').click();
  await sleep(600);
  check('读档面板自动关闭', !$('slotOverlay').classList.contains('show'));
  check('恢复重建了棋面（+3 球）', hooks.bodies === addsBefore + 3);
  check('恢复坐标有效', hooks.lastFruitPos && Number.isFinite(hooks.lastFruitPos.x) && Number.isFinite(hooks.lastFruitPos.y));

  // 6. 删除自动存档（走 confirm）
  $('loadBtn').click();
  await sleep(300);
  $('delAuto').click();
  await sleep(700);
  check('删除自动存档走 confirm', confirmCalls >= 1);
  check('删除后自动槽为空', store.auto === null);
  check('面板显示（空）', $('autoInfo').textContent.includes('空'));

  check('全程零 JS 错误', errors.length === 0);

  const pass = results.every(r => r[1]);
  console.log(pass ? '=== 全部通过 ===' : '=== 存在失败项 ===');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('HARNESS FAIL:', e); process.exit(1); });
