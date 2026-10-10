// 藏蛋点可达验证：复用 stepwalk 的逐帧驱动（固定帧间隔调用真实 FirstPersonControls.update），
// 对 src/game/eggSpots.json 里每个点按 approach 路线走两遍：60 fps 慢走、10 fps 快走。
// 通过条件：终点与蛋点水平距离 < 1.2 m，且脚点与 y 相差 < 0.3 m。
// 用法：node tests/egg-reach.cjs            只验证，有失败则退出码 1
//       node tests/egg-reach.cjs --prune    把失败的点从 JSON 里删除（删除后需重新跑一遍确认）
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const SPOTS_PATH = path.resolve(__dirname, '../src/game/eggSpots.json');
const PRUNE = process.argv.includes('--prune');
const MIN_SPOTS = 20;

(async () => {
  const spots = JSON.parse(fs.readFileSync(SPOTS_PATH, 'utf8'));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  page.setDefaultTimeout(0);
  await page.goto(process.env.PALACE_URL || 'http://127.0.0.1:5173', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__forbiddenCityApp?.controls && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 240000 });

  const result = await page.evaluate(({ SPOTS }) => {
    const a = window.__forbiddenCityApp;
    cancelAnimationFrame(a.animationFrame);
    a.disposed = true; // 停掉主循环，由本脚本逐帧驱动
    const c = a.controls;
    Object.defineProperty(c.controls, 'isLocked', { get: () => true, configurable: true });
    const out = [];
    for (const spot of SPOTS) for (const [fps, sprint] of [[60, false], [10, true]]) {
      const pts = spot.approach;
      if (!pts || pts.length < 2) { out.push({ id: spot.id, fps, sprint, ok: false, why: 'approach 为空' }); continue; }
      const [x0, z0] = pts[0];
      c.setPosition(x0, 300, z0);
      c.velocity.set(0, 0, 0);
      c.moveForward = true;
      c.canSprint = sprint;
      const dt = 1 / fps;
      let arrived = true, stuckAt = null;
      for (let k = 1; k < pts.length && arrived; k++) {
        const [x1, z1] = pts[k];
        const p0 = a.camera.position;
        const limit = Math.ceil(Math.hypot(x1 - p0.x, z1 - p0.z) / 2 * fps) + fps * 4;
        let stuck = 0, last = [p0.x, p0.z], reached = false;
        for (let f = 0; f < limit; f++) {
          c.prevTime = performance.now() - dt * 1000;
          a.camera.lookAt(x1, a.camera.position.y, z1);
          c.update();
          const p = a.camera.position;
          // 最后一段到蛋点：只要进入 1.0 m 就算到，避免在角落里反复顶墙
          const tol = k === pts.length - 1 ? 0.8 : 0.8;
          if (Math.hypot(p.x - x1, p.z - z1) < tol) { reached = true; break; }
          if (f % fps === 0 && f > 0) {
            if (Math.hypot(p.x - last[0], p.z - last[1]) < 0.3) stuck++; else stuck = 0;
            last = [p.x, p.z];
            if (stuck >= 2) break;
          }
        }
        if (!reached) { arrived = false; stuckAt = pts[k]; }
      }
      c.moveForward = false;
      const p = a.camera.position;
      const dist = Math.hypot(p.x - spot.x, p.z - spot.z);
      const dy = Math.abs(c.feetY - spot.y);
      const ok = arrived && dist < 1.2 && dy < 0.3;
      out.push({
        id: spot.id, hall: spot.hall, corner: spot.corner, fps, sprint, ok,
        dist: +dist.toFixed(2), dy: +dy.toFixed(2), stuckAt,
        why: ok ? '' : (!arrived ? '未到达途经点' : dist >= 1.2 ? '终点偏离蛋点' : '高度不符'),
      });
    }
    return out;
  }, { SPOTS: spots });

  const badIds = new Set();
  for (const r of result) {
    if (!r.ok) badIds.add(r.id);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} fps=${r.fps} ${r.sprint ? '快走' : '慢走'} ${r.id} ${r.hall ?? ''} ${r.corner ?? ''} 偏离=${r.dist}m 高差=${r.dy}m${r.ok ? '' : ' ' + r.why + (r.stuckAt ? JSON.stringify(r.stuckAt) : '')}`);
  }
  const fail = result.filter(r => !r.ok).length;
  console.log(`共 ${result.length} 条（${spots.length} 点 × 2），失败 ${fail} 条，不可达点 ${badIds.size} 个`);

  let remain = spots.length;
  if (PRUNE && badIds.size) {
    const kept = spots.filter(s => !badIds.has(s.id));
    fs.writeFileSync(SPOTS_PATH, JSON.stringify(kept, null, 2) + '\n');
    remain = kept.length;
    console.log(`已从 JSON 删除 ${badIds.size} 个不可达点，剩余 ${remain} 个：${[...badIds].join(', ')}`);
  }
  if (remain < MIN_SPOTS) { console.log(`FAIL 点数 ${remain} < ${MIN_SPOTS}`); await browser.close(); process.exit(1); }
  await browser.close();
  process.exit(fail && !PRUNE ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
