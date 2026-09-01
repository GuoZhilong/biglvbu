// 自动化验证：node test/solution-test.js
// 从 index.html 提取核心逻辑层并模拟对局
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '合成大吕布.html'), 'utf8');
const m = html.match(/<script id="game-core">([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 game-core 脚本段'); process.exit(1); }
const mod = { exports: {} };
new Function('module', 'window', m[1])(mod, {});
const G = mod.exports;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅ ' + msg); }
  else { failed++; console.error('  ❌ ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

const piece = (s, key) => s.pieces.find(p => p.key === key);
const lvOf = (s, key) => { const p = piece(s, key); return p ? p.level : null; };
const lbPiece = s => piece(s, 'lvbu');
const lbId = s => { const p = lbPiece(s); return p ? p.id : null; };

/* ---------- 1. 正解路线（中间数值动态推算，结局恒为999） ---------- */
section('正解路线：卖猪八戒 → 传承 → 遗志(中) → 换帅借大堆 → 三连合成回手 → 换帅借666 → 终极合成999');

// rng：第1次调用留给遗志选目标（0.99→候选[曹操,蔡文姬,赵云]中第3个=赵云），
// 其余调用（传承分配/并列）返回0.5——分配比例任意不影响结局（见不变量测试）
const rngOK = () => { let first = true; return () => { if (first) { first = false; return 0.99; } return 0.5; }; };

let s = G.createInitialState();
let r;
// 1. 卖猪八戒
r = G.sellPiece(s, 'zhubajie');
assert(!r.error, '售卖猪八戒成功');
s = r.state;
assert(!piece(s, 'zhubajie'), '猪八戒已消失');
assert(s.hand.length === 9, '售卖不消耗手牌（仍9张）');

// 2. 传承蔡文姬 → 三家≈333
r = G.useChuancheng(s, 'chuancheng0', 'caiwenji', rngOK());
assert(!r.error, '传承蔡文姬成功');
s = r.state;
assert(lvOf(s, 'caiwenji') === 1, '蔡文姬保留1级');
const lvCao = lvOf(s, 'caocao'), lvSun = lvOf(s, 'sunshangxiang'), lvZhao = lvOf(s, 'zhaoyun');
assert(lvCao + lvSun + lvZhao === 999, `曹操+孙尚香+赵云 = ${lvCao + lvSun + lvZhao}（249全部分配，≈各333）`);
assert(s.hand.length === 8, '传承消耗1张（剩8张）');

// 3. 遗志孙尚香 → 随机给赵云（孙尚香的等级并入赵云）
r = G.useYizhi(s, 'yizhi0', 'sunshangxiang', rngOK());
assert(!r.error, '遗志孙尚香成功');
s = r.state;
assert(!piece(s, 'sunshangxiang'), '孙尚香已消失');
const lvZhao2 = lvOf(s, 'zhaoyun');
assert(lvZhao2 === lvZhao + lvSun, `赵云吸收孙尚香：${lvZhao2} = ${lvZhao}+${lvSun}`);
assert(s.hand.length === 7, '遗志消耗1张（剩7张）');

// 4. 吕布① 落 (0,1)，换帅借曹操
r = G.playLvbu(s, 'lvbu0', 0, 1, rngOK());
assert(!r.error && lbPiece(s) && lvOf(s, 'lvbu') === 1, '吕布①落子(0,1)，1级');
s = r.state;
const nb = G.nearestSanguo(s, lbId(s));
assert(nb.targets.length === 1 && nb.targets[0] === 'caocao', `吕布(0,1)最近三国唯一=曹操（无并列）`);
r = G.useHuanshuai(s, 'huanshuai0', lbId(s));
assert(!r.error, '换帅①自动锁定最近目标（曹操）');
s = r.state;
assert(lvOf(s, 'lvbu') === lvCao && lvOf(s, 'caocao') === 1, `吕布借到曹操的${lvCao}级（曹操变1级）`);
assert(s.hand.length === 5, '换帅①消耗1张（剩5张：4张吕布+1张换帅）');

// 5. 吕布②③④ 三连合成 → 回手
const expAfter = [lvCao + 4, lvCao + 8, lvCao + 12];
r = G.playLvbu(s, 'lvbu1', null, null, rngOK());
assert(!r.error && lvOf(s, 'lvbu') === expAfter[0] && lbPiece(s).merges === 1, `合成②→${expAfter[0]} (1/3)`);
s = r.state;
r = G.playLvbu(s, 'lvbu2', null, null, rngOK());
assert(!r.error && lvOf(s, 'lvbu') === expAfter[1] && lbPiece(s).merges === 2, `合成③→${expAfter[1]} (2/3)`);
s = r.state;
r = G.playLvbu(s, 'lvbu3', null, null, rngOK());
assert(!r.error, '合成④执行');
s = r.state;
assert(!lbPiece(s), '第3次合成后场上吕布消失');
const backCard = s.hand.find(c => c.type === 'lvbu' && c.level > 1);
assert(backCard && backCard.level === expAfter[2], `吕布回手为${expAfter[2]}级卡（实际${backCard && backCard.level}）`);
assert(s.hand.length === 3, '合成消耗3张、回手+1张（剩3张）');

// 6. 吕布⑤ 落 (4,0)，换帅借赵云
r = G.playLvbu(s, 'lvbu4', 4, 0, rngOK());
assert(!r.error && lvOf(s, 'lvbu') === 1, '吕布⑤(1级)落子(4,0)');
s = r.state;
const nb2 = G.nearestSanguo(s, lbId(s));
assert(nb2.targets.length === 1 && nb2.targets[0] === 'zhaoyun', `吕布(4,0)最近三国唯一=赵云`);
r = G.useHuanshuai(s, 'huanshuai1', lbId(s), 'zhaoyun');
assert(!r.error, '换帅②指定赵云');
s = r.state;
assert(lvOf(s, 'lvbu') === lvZhao2, `吕布借到赵云的${lvZhao2}级`);
assert(s.hand.length === 1, '换帅②消耗后仅剩回手卡');

// 7. 打出回手卡 → 999 胜利
// 不变量：lvZhao2 + expAfter[2] + 3 = (lvZhao+lvSun) + (lvCao+12) + 3 = 999+15 = 1014 → 截断999
r = G.playLvbu(s, backCard.uid, null, null, rngOK());
assert(!r.error, '打出回手的高等级吕布卡');
s = r.state;
assert(lvOf(s, 'lvbu') === 999, `最终吕布等级=${lvOf(s, 'lvbu')}（${lvZhao2}+${expAfter[2]}+3=1014截断为999）`);
assert(s.status === 'won', '游戏胜利！');
assert(s.cardsPlayed === 10, `共出牌${s.cardsPlayed}次（9张牌+回手卡重打1次=10）`);

/* ---------- 2. 传承随机分配不变量：任意分配比例结局恒为999 ---------- */
section('不变量：传承随机分配比例不影响结局（500次随机）');
let allWon = true;
for (let i = 0; i < 500; i++) {
  let st = G.createInitialState();
  st = G.sellPiece(st, 'zhubajie').state;
  st = G.useChuancheng(st, 'chuancheng0', 'caiwenji', Math.random).state;
  st = G.useYizhi(st, 'yizhi0', 'sunshangxiang', () => 0.99).state; // 强制命中赵云
  st = G.playLvbu(st, 'lvbu0', 0, 1, Math.random).state;
  st = G.useHuanshuai(st, 'huanshuai0', lbId(st)).state;
  st = G.playLvbu(st, 'lvbu1', null, null, Math.random).state;
  st = G.playLvbu(st, 'lvbu2', null, null, Math.random).state;
  st = G.playLvbu(st, 'lvbu3', null, null, Math.random).state;
  st = G.playLvbu(st, 'lvbu4', 4, 0, Math.random).state;
  st = G.useHuanshuai(st, 'huanshuai1', lbId(st), 'zhaoyun').state;
  const back = st.hand.find(c => c.type === 'lvbu' && c.level > 1);
  st = G.playLvbu(st, back.uid, null, null, Math.random).state;
  if (st.status !== 'won' || lvOf(st, 'lvbu') !== 999) { allWon = false; break; }
}
assert(allWon, '500次随机传承分配下全部通关且吕布=999');

/* ---------- 3. 先卖掉1级棋子：遗志任意随机结果均通关 ---------- */
section('稳健路线：卖猪八戒+传承+卖1级蔡文姬 → 遗志必中，200次全随机通关');
let allWon2 = true;
for (let i = 0; i < 200; i++) {
  let st = G.createInitialState();
  st = G.sellPiece(st, 'zhubajie').state;
  st = G.useChuancheng(st, 'chuancheng0', 'caiwenji', Math.random).state;
  st = G.sellPiece(st, 'caiwenji').state; // 卖掉1级蔡文姬 → 遗志目标只剩两个大堆，命中即赢
  st = G.useYizhi(st, 'yizhi0', 'sunshangxiang', Math.random).state;
  st = G.playLvbu(st, 'lvbu0', 0, 1, Math.random).state;
  st = G.useHuanshuai(st, 'huanshuai0', lbId(st)).state;
  st = G.playLvbu(st, 'lvbu1', null, null, Math.random).state;
  st = G.playLvbu(st, 'lvbu2', null, null, Math.random).state;
  st = G.playLvbu(st, 'lvbu3', null, null, Math.random).state;
  st = G.playLvbu(st, 'lvbu4', 4, 0, Math.random).state;
  const nb3 = G.nearestSanguo(st, lbId(st));
  st = G.useHuanshuai(st, 'huanshuai1', lbId(st), nb3.targets[0]).state;
  const back = st.hand.find(c => c.type === 'lvbu' && c.level > 1);
  st = G.playLvbu(st, back.uid, null, null, Math.random).state;
  if (st.status !== 'won') {
    allWon2 = false;
    console.error('    失败局：', st.pieces.map(p => `${p.name}${p.level}@(${p.x},${p.y})`).join(' '));
    break;
  }
}
assert(allWon2, '200次全随机（含遗志任意目标）下稳健路线全部通关');

/* ---------- 4. 边界用例 ---------- */
section('边界用例');

// 4.1 换帅并列 → needsPick（曹(0,0) 蔡(1,0) 孙(2,0)，蔡到曹/孙均距1）
{
  let st = G.createInitialState();
  st = G.movePiece(st, 'sunshangxiang', 0, 4).state; // 先腾位
  st = G.movePiece(st, 'caiwenji', 0, 4) ? st : st;  // 占用校验另行测试
  st = G.movePiece(st, 'caiwenji', 1, 0).state;      // 蔡文姬移到(1,0)
  st = G.movePiece(st, 'sunshangxiang', 2, 0).state; // 孙尚香补到(2,0)
  const r1 = G.useHuanshuai(st, 'huanshuai0', 'caiwenji');
  assert(r1.needsPick && r1.candidates.length === 2, `距离并列时返回needsPick+2候选（${r1.candidates}）`);
  assert(st.hand.length === 9, 'needsPick阶段不消耗手牌');
  const r2 = G.useHuanshuai(st, 'huanshuai0', 'caiwenji', 'caocao');
  assert(!r2.error && lvOf(st, 'caiwenji') === 250 && lvOf(st, 'caocao') === 250, '指定目标后成功互换');
  assert(st.hand.length === 8, '正式施放消耗1张');
}

// 4.2 换帅不能指定猪八戒（非三国）
{
  const st = G.createInitialState();
  const r1 = G.useHuanshuai(st, 'huanshuai0', 'zhubajie');
  assert(!!r1.error, '换帅指定猪八戒被拒绝');
  const nb = G.nearestSanguo(st, 'caocao');
  assert(!nb.targets.includes('zhubajie'), '猪八戒不进入换帅候选');
}

// 4.3 999截断
{
  let st = G.createInitialState();
  st.pieces.find(p => p.key === 'zhubajie').level = 900;
  // 遗志曹操→猪八戒：others=[孙尚香,蔡文姬,赵云,猪八戒]，rng=0.99→index3=猪八戒
  const r2 = G.useYizhi(st, 'yizhi0', 'caocao', () => 0.99);
  assert(!r2.error && lvOf(r2.state, 'zhubajie') === 999, `900+250=1150截断为999（实际${lvOf(r2.state, 'zhubajie')}）`);
}

// 4.4 9张打完未达成 → 失败
{
  let st = G.createInitialState();
  st = G.playLvbu(st, 'lvbu0', 0, 4, Math.random).state;      // 落1级
  for (const u of ['lvbu1', 'lvbu2', 'lvbu3']) st = G.playLvbu(st, u, null, null, Math.random).state; // →13 回手
  const back = st.hand.find(c => c.type === 'lvbu' && c.level > 1);
  st = G.playLvbu(st, back.uid, 4, 0, Math.random).state;     // 落13级
  st = G.playLvbu(st, 'lvbu4', null, null, Math.random).state; // 合成→17 (1/3)
  st = G.useYizhi(st, 'yizhi0', 'caocao', Math.random).state;
  st = G.useChuancheng(st, 'chuancheng0', 'zhaoyun', Math.random).state;
  const nb4 = G.nearestSanguo(st, lbId(st));
  st = G.useHuanshuai(st, 'huanshuai0', lbId(st), nb4.targets[0]).state;
  const nb5 = G.nearestSanguo(st, lbId(st));
  st = G.useHuanshuai(st, 'huanshuai1', lbId(st), nb5.targets[0]).state;
  assert(st.hand.length === 0, '9张全部打完');
  assert(st.status === 'lost', `未达成999 → 失败（吕布=${lvOf(st, 'lvbu')}）`);
}

// 4.5 移动/占用校验
{
  const st = G.createInitialState();
  const r1 = G.movePiece(st, 'caocao', 1, 0); // 孙尚香占用
  assert(!!r1.error, '移动到占用格被拒绝');
  const r2 = G.movePiece(st, 'caocao', 9, 9);
  assert(!!r2.error, '移动出界被拒绝');
  const r3 = G.movePiece(st, 'caocao', 2, 2);
  assert(!r3.error && r3.state.pieces.find(p => p.key === 'caocao').x === 2, '正常移动成功');
}

// 4.6 售卖吕布后再打吕布 → 重新落子
{
  let st = G.createInitialState();
  st = G.playLvbu(st, 'lvbu0', 0, 4, Math.random).state;
  st = G.sellPiece(st, lbId(st)).state;
  const r = G.playLvbu(st, 'lvbu1', 2, 4, Math.random);
  assert(!r.error && lvOf(r.state, 'lvbu') === 1, '场上吕布被卖后，再打吕布重新落子(1级)');
}

/* ---------- 5. 第二关手牌 + 传承消散规则 ---------- */
section('第二关手牌与传承消散规则');
{
  const st0 = G.createInitialState(2);
  assert(st0.level === 2 && st0.levelName === '第二关', 'createInitialState(2) 生成第二关');
  assert(st0.hand.filter(c => c.type === 'chuancheng').length === 2
      && st0.hand.filter(c => c.type === 'huanshuai').length === 1
      && st0.hand.filter(c => c.type === 'yizhi').length === 1
      && st0.hand.filter(c => c.type === 'lvbu').length === 5, '第二关手牌组成正确');

  // 传承：其他棋子不足3个 → 永远三等分，多余份数消散（独苗必然拿不全）
  {
    let st = G.createInitialState(2);
    for (const id of ['sunshangxiang', 'caiwenji', 'zhaoyun', 'zhubajie']) st = G.sellPiece(st, id).state;
    st = G.playLvbu(st, 'lvbu0', 4, 3, Math.random).state; // 场上：曹操250 + 吕布1
    const before = lvOf(st, 'caocao');
    st = G.useChuancheng(st, 'chuancheng0', 'caocao', Math.random).state;
    const gained = lvOf(st, 'lvbu') - 1;
    assert(lvOf(st, 'caocao') === 1, '传承源保留1级');
    assert(gained < before - 1, `唯一队友只拿到三份之一（+${gained} < ${before - 1}），其余消散`);
    // 200次随机验证：独苗永远拿不全
    let ok = true;
    for (let i = 0; i < 200; i++) {
      let t = G.createInitialState(2);
      for (const id of ['sunshangxiang', 'caiwenji', 'zhaoyun', 'zhubajie']) t = G.sellPiece(t, id).state;
      t = G.playLvbu(t, 'lvbu0', 4, 3, Math.random).state;
      t = G.useChuancheng(t, 'chuancheng0', 'caocao', Math.random).state;
      if (lvOf(t, 'lvbu') - 1 >= before - 1) { ok = false; break; }
    }
    assert(ok, '200次随机：独苗必然存在消散（拿不全三等分总量）');
  }

  // 三名队友时传承行为不变（总和守恒，无消散）
  {
    let st = G.createInitialState();
    st = G.sellPiece(st, 'zhubajie').state;
    st = G.useChuancheng(st, 'chuancheng0', 'caiwenji', Math.random).state;
    const sum = st.pieces.reduce((a, p) => a + p.level, 0);
    assert(sum === 1000, `三名队友时无消散（总和${sum}=1000）`);
  }
}

/* ---------- 6. 自由挑战模式（第三关） ---------- */
section('自由挑战模式：空手牌、不判负、加卡可玩、达成999仍判胜');
{
  const st0 = G.createInitialState(3);
  assert(st0.level === 3 && st0.levelName === '自由挑战' && st0.hand.length === 0,
    'createInitialState(3)：自由挑战空手牌起始，棋盘不变');
  assert(st0.pieces.length === 5 && lvOf(st0, 'caocao') === 250 && lvOf(st0, 'zhubajie') === 50,
    '自由挑战初始棋盘与关卡一致');

  let st = G.createInitialState(3);
  st.hand.push({ uid: 't0', type: 'lvbu', level: 1 });   // 模拟从卡牌库加入
  st = G.playLvbu(st, 't0', 0, 4, Math.random).state;
  assert(st.hand.length === 0 && st.status === 'playing', '自由模式手牌打空不判负');

  st.hand.push({ uid: 't1', type: 'lvbu', level: 1 });
  st = G.playLvbu(st, 't1', null, null, Math.random).state;
  assert(lvOf(st, 'lvbu') === 5, '自由模式合成正常（1+1+3=5）');

  st.pieces = st.pieces.filter(p => p.key !== 'lvbu');    // 清场后放一张999吕布验证胜利判定
  st.hand.push({ uid: 't2', type: 'lvbu', level: 999 });
  st = G.playLvbu(st, 't2', 2, 2, Math.random).state;
  assert(st.status === 'won', '自由模式达成999仍判胜');
}

console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
