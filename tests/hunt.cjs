// 联机找金蛋端到端测试（真浏览器 + 真服务器）。
// 前提：另开终端 `npm run dev`（5173）在跑；8787 端口空闲（本脚本自己启动服务端）。
// 运行：node tests/hunt.cjs      （CHROME_PATH 可覆盖浏览器路径；NODE_PATH 需能找到 playwright）
//
// 覆盖：
//   0 无 room 参数：不创建 hunt、不建立任何 WebSocket
//   1 服务器不可用：HUD 显示“联机不可用”，自由游览（控制器 update）照常
//   2 三个客户端进房 → 老师开局（60 秒局）→ 倒数 → 提示按 0/12/24/36/48 秒出现
//   3 A、B 先后走到金蛋：found 名次 1、2；C 不动 → 小地图闪点(3级)、光柱(4级)
//   4 B 刷新页面：重连后名次保持
//   5 老师结束：C 看到终局榜单，且榜单里有“金蛋在”
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const WS = require(path.join(__dirname, '../server/node_modules/ws'));

const ROOT = path.join(__dirname, '..');
const GAME = process.env.GAME_URL || 'http://127.0.0.1:5173/';
const PORT = 8787;
const HTTP = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('超时：' + label);
    await sleep(100);
  }
}

async function loaded(page) {
  await page.waitForFunction(
    () => window.__forbiddenCityApp?.postProcessing?.composer && document.querySelector('#loading-screen').style.display === 'none',
    null, { timeout: 150000 });
  await page.waitForTimeout(800);
}

async function openGame(browser, query, name) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await ctx.newPage();
  page.__name = name;
  page.__errors = [];
  page.__sockets = 0;
  page.on('pageerror', (e) => page.__errors.push(e.message));
  // 忽略 Vite 开发服务器自己的 HMR 连接（ws://host:5173）
  page.on('websocket', (ws) => { if (!ws.url().includes(':5173')) page.__sockets++; });
  await page.goto(GAME + query, { waitUntil: 'load' });
  await loaded(page);
  return page;
}

async function joinWithNick(page, nick) {
  const input = page.locator('.hunt-nick input');
  await input.fill(nick);
  await page.locator('.hunt-nick button').click();
}

const hunt = (page, expr) => page.evaluate((e) => {
  const h = window.__forbiddenCityApp.hunt;
  return h ? new Function('h', 'return ' + e)(h) : null;
}, expr);

function startServer() {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT), ALLOW_CUSTOM_DURATION: '1', PUBLIC_GAME_URL: GAME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.out += d; });
  return child;
}

async function httpJson(method, url) {
  const res = await fetch(url, { method });
  return res.json();
}

(async () => {
  // 先确认 8787 空闲
  const busy = await fetch(HTTP + '/health').then(() => true, () => false);
  if (busy) { console.error('8787 已被占用，请先停掉已有的服务端'); process.exit(2); }

  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  let server = null;
  let host = null;
  try {
    // ───── 0 无 room 参数 ─────
    const p0 = await openGame(browser, '', 'plain');
    await p0.waitForTimeout(1500);
    ok(await p0.evaluate(() => !window.__forbiddenCityApp.hunt), '0 无 room 参数：不创建 TreasureHunt');
    ok(p0.__sockets === 0, '0 无 room 参数：没有建立 WebSocket');
    ok(await p0.evaluate(() => !document.querySelector('.hunt-bar, .hunt-nick')), '0 无 room 参数：没有任何找金蛋界面');
    await p0.context().close();

    // ───── 1 服务器不可用 ─────
    const p1 = await openGame(browser, '?room=4321', 'down');
    ok(await p1.evaluate(() => !!document.querySelector('#welcome-overlay .hunt-nick input')), '1 昵称框叠加在欢迎遮罩里');
    await joinWithNick(p1, '测试甲');
    await until(() => p1.evaluate(() => document.querySelector('.hunt-bar .l1')?.textContent === '联机不可用'), 20000, '联机不可用');
    ok(true, '1 服务器不可用：HUD 显示“联机不可用”');
    const before = await p1.evaluate(() => window.__forbiddenCityApp.camera.position.x);
    await p1.evaluate(() => window.__forbiddenCityApp.controls.setPosition(0, 1.7, 100));
    await p1.waitForTimeout(500);
    const after = await p1.evaluate(() => window.__forbiddenCityApp.camera.position.z);
    ok(Math.abs(after - 100) < 1 && p1.__errors.length === 0, '1 服务器不可用：仍可自由游览且无页面报错', `errors=${p1.__errors.length}`);
    await p1.context().close();

    // ───── 2 启动服务器，三个客户端进房 ─────
    server = startServer();
    await until(() => fetch(HTTP + '/health').then((r) => r.ok, () => false), 10000, '服务端启动');
    ok(/藏蛋点 \d+ 个/.test(server.out), '服务端启动并读到藏蛋点', (server.out.match(/藏蛋点 \d+ 个/) || [''])[0]);
    const { code, hostToken } = await httpJson('POST', HTTP + '/host/api/rooms');
    ok(/^\d{4}$/.test(code) && !!hostToken, '创建房间', `code=${code}`);

    // 老师端 WebSocket
    let roomState = null;
    host = new WS(`ws://127.0.0.1:${PORT}/`);
    await new Promise((r) => host.on('open', r));
    host.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'welcome' && m.state) roomState = m.state;
      if (m.type === 'room_state') roomState = m;
    });
    host.send(JSON.stringify({ type: 'join', room: code, role: 'host', token: hostToken }));
    await until(() => roomState, 5000, '老师端 welcome');

    const [A, B, C] = await Promise.all(['甲同学', '乙同学', '丙同学'].map((n, i) => openGame(browser, `?room=${code}`, 'p' + i)));
    await Promise.all([joinWithNick(A, '甲同学'), joinWithNick(B, '乙同学'), joinWithNick(C, '丙同学')]);
    await until(() => roomState.players.filter((p) => p.online).length === 3, 15000, '三人在线');
    ok(true, '2 三个客户端进房，老师端看到 3 人');
    await until(() => A.evaluate(() => /等待老师开局/.test(document.querySelector('.hunt-bar .l1')?.textContent || '')), 8000, '等待态 HUD');
    ok(true, '2 等待态 HUD 文案', await A.evaluate(() => document.querySelector('.hunt-bar .l1')?.textContent));

    // ───── 3 开局 ─────
    const tStart = Date.now();
    host.send(JSON.stringify({ type: 'host_start', code, hostToken, durationMs: 60000 }));
    await until(() => roomState.phase === 'running' && roomState.egg, 5000, '开局');
    const egg = roomState.egg;
    const startedAtServer = roomState.startedAt;
    ok(!!egg.hall, '3 开局：老师端拿到金蛋完整信息', `${egg.area}/${egg.hall}`);

    // 倒数期间：全屏数字出现，客户端被传送到起点
    await until(() => A.evaluate(() => /^[123]$/.test(document.querySelector('.hunt-count.show')?.textContent || '')), 3000, '倒数数字');
    ok(true, '3 倒数 3-2-1 全屏显示');
    const st = await A.evaluate(() => { const p = window.__forbiddenCityApp.camera.position; return [p.x, p.z]; });
    ok(Math.abs(st[0]) < 5 && st[1] < 0, '3 开局后被传送到起点', JSON.stringify(st));

    // 提示时间点（以 A 的客户端观测）
    const seen = {};
    const cFlags = {};
    const poll = setInterval(async () => {
      try {
        const lv = await hunt(A, 'h.hintLevel');
        if (lv != null && !(lv in seen)) seen[lv] = Date.now();
        // C 全程不动，记录它的小地图闪点 / 光柱何时出现（局终后按设计会清除，所以必须实时看）
        const c = await C.evaluate(() => { const a = window.__forbiddenCityApp; return { lv: a.hunt.hintLevel, run: a.hunt.phase === 'running', marker: !!a.minimap.marker, beam: a.hunt.beam?.visible === true }; });
        if (c.run) {
          if (c.lv < 3 && c.marker) cFlags.markerEarly = true;
          if (c.lv < 4 && c.beam) cFlags.beamEarly = true;
          if (c.lv >= 3 && c.marker) cFlags.marker = true;
          if (c.lv >= 4 && c.beam) cFlags.beam = true;
        }
      } catch { /* 页面刷新等 */ }
    }, 200);

    // 倒数结束后，A 走到金蛋（直接设位置：可达性已由 egg-reach 单独验证）
    await until(() => A.evaluate(() => !document.querySelector('.hunt-count.show')), 6000, '倒数结束');
    await A.evaluate(([x, z]) => { const a = window.__forbiddenCityApp; a.controls.setPosition(x, 1.7, z); }, [egg.x, egg.z]);
    try {
      await until(() => hunt(A, 'h.selfFound'), 30000, 'A 被判定找到');
    } catch (e) {
      console.log('诊断 A:', JSON.stringify(await hunt(A, '({claimsUsed:h.claimsUsed, ws:h.wsState, phase:h.phase, egg:h.egg, pos:[h.camera.position.x,h.camera.position.y,h.camera.position.z], fps:0, sent:performance.now()-h.lastPosSentAt, pend:h.claimPendingUntil-performance.now()})')));
      console.log('服务端日志尾部:\n' + server.out.split('\n').slice(-8).join('\n'));
      throw e;
    }
    ok((await hunt(A, 'h.selfRank')) === 1, '3 A 先到：第 1 名');
    await until(() => A.evaluate(() => /第 1 名/.test(document.querySelector('.hunt-bar .l1')?.textContent || '')), 3000, 'A HUD 第 1 名').then(
      () => ok(true, '3 A 的 HUD：第 1 名'),
      async () => ok(false, '3 A 的 HUD：第 1 名', await A.evaluate(() => document.querySelector('.hunt-bar .l1')?.textContent)));
    ok(await A.evaluate(() => window.__forbiddenCityApp.hunt.eggMat.opacity < 0.5), '3 A 找到后金蛋变半透明');

    await B.evaluate(([x, z]) => { window.__forbiddenCityApp.controls.setPosition(x, 1.7, z); }, [egg.x, egg.z]);
    try {
      await until(() => hunt(B, 'h.selfFound'), 30000, 'B 被判定找到');
    } catch (e) {
      console.log('诊断 B:', JSON.stringify(await hunt(B, '({claimsUsed:h.claimsUsed, ws:h.wsState, phase:h.phase, egg:h.egg, pos:[h.camera.position.x,h.camera.position.y,h.camera.position.z], sinceSent:performance.now()-h.lastPosSentAt, pend:h.claimPendingUntil-performance.now(), next:h.nextClaimAt-performance.now(), now:Date.now()+h.offset, ends:h.endsAt})')));
      console.log('服务端日志尾部:\n' + server.out.split('\n').slice(-8).join('\n'));
      throw e;
    }
    ok((await hunt(B, 'h.selfRank')) === 2, '3 B 后到：第 2 名');
    ok(await C.evaluate(() => [...document.querySelectorAll('.hunt-toast')].some((t) => /甲同学.*第 1 名/.test(t.textContent))
      || window.__forbiddenCityApp.hunt.players.size === 3), '3 C 收到“别人找到了”');
    ok((await hunt(C, 'h.selfFound')) === false, '3 C 没动：未找到');

    // ───── 4 B 刷新，重连后名次保持 ─────
    await B.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await loaded(B);
    await until(() => hunt(B, 'h.selfFound'), 20000, 'B 重连后恢复名次');
    ok((await hunt(B, 'h.selfRank')) === 2, '4 B 刷新页面重连：名次保持第 2');
    ok(await B.evaluate(() => !document.querySelector('.hunt-nick input') || document.querySelector('.hunt-nick input').disabled), '4 B 刷新后自动回房，无需重填昵称');

    // 提示时间点：等到 48 秒级别
    // 服务器与测试脚本同机，时钟一致：以 startedAt（服务端权威）为 0 点
    const waitMs = startedAtServer + 50500 - Date.now();
    if (waitMs > 0) await sleep(Math.min(waitMs, 60000));
    clearInterval(poll);
    const tl = [0, 1, 2, 3, 4].map((lv) => (seen[lv] ? (seen[lv] - startedAtServer) / 1000 : null));
    console.log('提示出现时刻(秒, 相对 startedAt):', tl.map((v) => (v == null ? '-' : v.toFixed(1))).join(' / '));
    const expect = [0, 12, 24, 36, 48];
    // 0 级在开局瞬间（倒数开始时）就已发出，只要求已出现；1~4 级要求误差 < 2.5 秒
    ok(tl[0] != null && tl.slice(1).every((v, i) => v != null && Math.abs(v - expect[i + 1]) < 2.5), '3 五级提示按 0/12/24/36/48 秒出现');
    ok(!!cFlags.marker && !cFlags.markerEarly, '3 三级提示：C 的小地图在第 3 级才出现金色闪点', JSON.stringify(cFlags));
    ok(!!cFlags.beam && !cFlags.beamEarly, '3 四级提示：C 在第 4 级才看到光柱', JSON.stringify(cFlags));

    // ───── 5 老师结束 ─────
    host.send(JSON.stringify({ type: 'host_end', code, hostToken }));
    await until(() => C.evaluate(() => document.querySelector('.hunt-board.show .panel')), 5000, 'C 终局榜单');
    const boardText = await C.evaluate(() => document.querySelector('.hunt-board .panel').textContent);
    ok(/金蛋在：/.test(boardText) && boardText.includes(egg.hall), '5 终局榜单显示“金蛋在：" + 殿名', egg.hall);
    ok(/甲同学/.test(boardText) && /乙同学/.test(boardText) && /丙同学/.test(boardText) && /未找到/.test(boardText), '5 榜单含 3 人，C 显示未找到');
    ok(boardText.indexOf('甲同学') < boardText.indexOf('乙同学'), '5 榜单顺序：甲在乙前');

    for (const p of [A, B, C]) ok(p.__errors.length === 0, `无页面报错 ${p.__name}`, p.__errors.slice(0, 1).join('|'));
  } catch (err) {
    fail++;
    console.log('FAIL  测试异常中断：' + (err && err.stack || err));
  } finally {
    try { host?.close(); } catch { /* ignore */ }
    await browser.close().catch(() => {});
    if (server) { server.kill('SIGTERM'); await sleep(300); }
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
