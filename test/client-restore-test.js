// 端到端客户端测试：模拟"第二次打开页面 → 恢复存档 → 点击落球"
// 用 jsdom 跑真实游戏代码，通过 Matter 陷阱观察物理世界状态
// 用法: node client-restore-test.js [normal|overline]
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const scenario = process.argv[2] || 'normal';
const html = fs.readFileSync(path.join(__dirname, '..', '合成大吕布-掉落版.html'), 'utf8');

// 模拟一个"被挤压保存"的存档：25 个球纵向间距 18px（远小于半径和，深度重叠）
function makePieces() {
  if (scenario === 'overline') {
    // 从地面密堆到警戒线上方的宽棋盘（相邻球等级交错、不会互合成，物理稳定）
    // 顶行球顶边 ~96 < LINE_Y=130 → 豁免期结束后应被判负
    const pieces = [];
    const step = 56.4, rowH = step * Math.sqrt(3) / 2;
    for (let k = 0; k <= 10; k++) {
      const y = 612 - rowH * k;
      const off = k % 2 ? step / 2 : 0;
      for (let x = 28.2 + off; x <= 392; x += step) {
        pieces.push({ lvl: (Math.round(x / step) + k) % 2 ? 3 : 4, x, y });
      }
    }
    return pieces;
  }
  const levels = '0123401203102410230120123'.split('');
  return levels.map((lvl, i) => ({ lvl: +lvl, x: 40 + (i % 9) * 40, y: 620 - Math.floor(i / 9) * 18 }));
}

const snap = {
  snapshot: {
    score: 123, dropsCount: 8, curIdx: 2, nextIdx: 3, lvbuCount: 0,
    savedAt: new Date().toISOString(), pieces: makePieces(),
  },
};

const errors = [];
const hooks = { bodies: 0, updates: 0, removes: 0 };

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
    window.localStorage.setItem('lvbu_drop_auth', JSON.stringify({ name: '测试玩家', token: 'faketoken', best: 0 }));
    window.confirm = () => true;
    window.fetch = (url) => {
      if (String(url).endsWith('/api/snapshot')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(snap) });
      }
      if (String(url).endsWith('/api/me')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ name: '测试玩家', best: 0, maxLevel: 0, games: 0 }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
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
          for (const x of arr) if (x.label === 'fruit') { hooks.bodies++; window.__world = w; }
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

(async () => {
  if (scenario === 'overline') {
    // 豁免期内注入：静态平台(无法被推走) + 平台上的动态球，球顶 top=34 < LINE_Y=130。
    // 豁免期结束后该球持续超线 → 必须触发判负。这验证豁免不会永久关闭判定。
    await sleep(1500);
    const M = window.__M, w = window.__world;
    M.Composite.add(w, M.Bodies.rectangle(210, 100, 300, 20, { isStatic: true, label: 'wall' }));
    const bb = M.Bodies.circle(210, 62, 28, { label: 'fruit', restitution: 0.15, friction: 0.4 });
    bb.plugin = { lvl: 3, aboveSince: null, born: performance.now() };
    M.Composite.add(w, bb);
    hooks.bodies++;
  }
  await sleep(4500);   // 覆盖豁免期结束 + 1.5s 判线窗口
  const $ = id => window.document.getElementById(id);
  const overShown = $('resultOverlay').classList.contains('show');
  console.log(`[${scenario}] 物理步进:`, hooks.updates, '| 恢复+合成累计加球:', hooks.bodies, '| resultOverlay:', overShown ? '已弹出' : '未弹出', '| JS错误:', errors.length ? errors : '无');

  let pass = true;
  if (scenario === 'overline') {
    // 存档里真有球超线：豁免期(2.5s)+判线(1.5s)后应已判负
    pass = pass && overShown === true;
    console.log(`[${scenario}] 预期: 超线球在豁免期后被判负 →`, overShown ? '✔ 正常判负' : '✘ 未判负（豁免逻辑破坏了判定）');
  } else {
    // 正常存档：不应误判失败，且能落球
    pass = pass && overShown === false;
    console.log(`[${scenario}] 预期: 不弹结算 →`, overShown ? '✘ 误判失败!' : '✔ 未误判');
    const canvas = window.document.getElementById('game');
    const down = new window.MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 300 });
    const up = new window.MouseEvent('pointerup', { bubbles: true, clientX: 200, clientY: 300 });
    const before = hooks.bodies;
    canvas.dispatchEvent(down);
    await sleep(50);
    canvas.dispatchEvent(up);
    await sleep(600);
    const dropped = hooks.bodies === before + 1;
    console.log(`[${scenario}] 落球:`, dropped ? '✔ 正常' : '✘ 卡住');
    pass = pass && dropped;
  }
  pass = pass && errors.length === 0 && hooks.updates > 0;
  console.log(`[${scenario}] 结论:`, pass ? '✔✔ 通过' : '✘✘ 失败');
  process.exit(pass ? 0 : 1);
})();
