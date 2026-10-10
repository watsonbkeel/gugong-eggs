// 确定性步行：用固定帧间隔逐帧调用真实 FirstPersonControls.update，复现低帧率/冲刺下的台阶问题。
// 用法：node tests/stepwalk.cjs [fps=60,20,10] [sprint=0,1]
//   内置路线覆盖中轴、偏中轴、侧门；报告每条路线的终点、最高脚点、是否"掉到台下"（站在台基投影内却脚点为 0）。
const { chromium } = require('playwright');

// 每条路线是一串途经点 [x, z]；殿内宝座挡在中轴，按真实参观路线从宝座侧面绕过
const AXIS_ROUTES = [
  ['午门→太和门', [[0, -200], [0, -60]]],
  ['太和门→太和殿内', [[0, -60], [0, 5]]],
  // 过殿门时走中间一间（x≈0），进殿后从宝座侧面绕过
  ['太和殿→中和殿→保和殿', [[0, 3], [0, 0], [6.2, 0], [6.2, 16], [0, 16.5], [0, 50], [5, 51], [5, 71], [0, 71], [0, 103], [6.1, 103], [6.1, 125], [0, 125]]],
  ['保和殿→北下台→乾清门', [[0, 125], [0, 160]]],
  ['乾清门→乾清宫', [[0, 160], [0, 204]]],
  ['乾清宫→交泰殿→坤宁宫', [[0, 204], [4.7, 204], [4.7, 222], [0, 222], [0, 245.3], [6.5, 245.3], [6.5, 258], [0, 258], [0, 295]]],
  ['坤宁宫→御花园→神武门', [[0, 295], [0, 328], [17, 332], [17, 368], [0, 372], [0, 445]]],
  ['乾清宫偏中轴(x=2.3)', [[2.3, 176], [2.3, 194.8]]],
  ['太和殿后→中和殿前(x=2.5)', [[2.5, 21], [2.5, 45]]],
];

// 两侧宫院路线（node tests/stepwalk.cjs 60 0 side）
const SIDE_ROUTES = [
  ['协和门→文华门→文华殿内', [[-30, -115], [-90, -115], [-110, -112], [-110, -83], [-113.5, -83], [-113.5, -76.5]]],
  ['协和门→东华门→出宫', [[-30, -115], [-90, -115], [-172, -115]]],
  ['熙和门→武英门→武英殿内', [[30, -115], [90, -115], [111, -112], [111, -83]]],
  ['熙和门→西华门→出宫', [[30, -115], [90, -115], [172, -115]]],
  ['左翼门→文渊阁一带', [[-40, -50], [-80, -50]]],
  ['内左门→东一长街→景仁宫内', [[-45, 150], [-45, 173], [-65, 173], [-65, 187]]],
  ['内右门→养心殿内', [[45, 150], [45, 184], [70, 180], [85, 180], [85, 188]]],
  ['西一长街→月华门→乾清宫院', [[45, 150], [45, 205], [30, 205]]],
  ['乾清宫院→日精门→东一长街→基化门', [[-30, 205], [-45, 205], [-45, 284], [-30, 284]]],
  ['御花园→钦安殿内→穿殿北出', [[0, 316], [0, 330], [0, 349], [3.5, 349], [3.5, 354.6], [0, 354.6], [0, 366]]],
  ['御花园→万春/千秋亭', [[0, 316], [0, 313.3], [17, 313.3], [17, 340], [32, 340], [32, 354]]],
  ['御花园→千秋亭(西)', [[0, 316], [0, 313.3], [-17, 313.3], [-17, 340], [-32, 340], [-32, 354]]],
  ['御花园→浮碧亭(桥)', [[0, 316], [0, 313.3], [32, 313.3], [32, 337]]],
  ['御花园→澄瑞亭(桥)', [[0, 316], [0, 313.3], [-32, 313.3], [-32, 337]]],
  ['景运门→箭亭→东路', [[-30, 153], [-85, 153], [-85, 143], [-100, 143], [-100, 153]]],
];

(async () => {
  const fpsList = (process.argv[2] || '60,20,10').split(',').map(Number);
  const sprints = (process.argv[3] || '0,1').split(',').map(v => v === '1');
  const which = process.argv[4] || 'axis';
  const ROUTES_RUN = which === 'side' ? SIDE_ROUTES : which === 'all' ? [...AXIS_ROUTES, ...SIDE_ROUTES] : AXIS_ROUTES;
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  await page.goto(process.env.PALACE_URL || 'http://127.0.0.1:5173', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__forbiddenCityApp?.controls && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 240000 });
  const result = await page.evaluate(({ ROUTES, fpsList, sprints }) => {
    const a = window.__forbiddenCityApp;
    cancelAnimationFrame(a.animationFrame);
    a.disposed = true; // 停掉主循环，由本脚本逐帧驱动
    const c = a.controls;
    const cm = a.collisionManager;
    Object.defineProperty(c.controls, 'isLocked', { get: () => true, configurable: true });
    // 台基投影（box 型可行走面中顶面 >= 1m 的），用于判断"在台基里面却站在 0 高度"
    const terraces = cm.walkables.filter(w => w.type === 'box' && w.box.max.y >= 1).map(w => w.box);
    const under = (x, z, feet) => terraces.some(b => x > b.min.x + 1 && x < b.max.x - 1 && z > b.min.z + 1 && z < b.max.z - 1 && feet < b.max.y - 1.2);
    const out = [];
    for (const fps of fpsList) for (const sprint of sprints) for (const [name, pts] of ROUTES) {
      const [x0, z0] = pts[0];
      c.setPosition(x0, 300, z0); // 起点取该处最高可行走面（起点在台基上时站在台面上）
      c.velocity.set(0, 0, 0);
      c.moveForward = true;
      c.canSprint = sprint;
      const dt = 1 / fps;
      let maxFeet = 0, minFeet = Infinity, bad = null, arrived = true, stuckAt = null;
      const profile = [];
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
          maxFeet = Math.max(maxFeet, c.feetY);
          if (f % Math.max(1, Math.round(fps / 2)) === 0) profile.push(+c.feetY.toFixed(1));
          if (!bad && under(p.x, p.z, c.feetY) && c.verticalVelocity === 0) bad = [+p.x.toFixed(1), +p.z.toFixed(1), +c.feetY.toFixed(2)];
          if (Math.hypot(p.x - x1, p.z - z1) < 0.8) { reached = true; break; }
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
      out.push({ fps, sprint, name, arrived, stuckAt, end: [+p.x.toFixed(1), +p.z.toFixed(1), +c.feetY.toFixed(2)], maxFeet: +maxFeet.toFixed(2), fellUnder: bad, profile });
    }
    return out;
  }, { ROUTES: ROUTES_RUN, fpsList, sprints });
  let fail = 0;
  for (const r of result) {
    const ok = r.arrived && !r.fellUnder;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} fps=${r.fps} ${r.sprint ? '快走' : '慢走'} ${r.name} 终点=${JSON.stringify(r.end)} 最高脚点=${r.maxFeet}${r.fellUnder ? ' 掉到台下@' + JSON.stringify(r.fellUnder) : ''}${r.arrived ? '' : ' 未到达途经点' + JSON.stringify(r.stuckAt)}`);
    if (process.env.PROFILE) console.log('   高度剖面', r.profile.join(' '));
  }
  console.log(`共 ${result.length} 条，失败 ${fail} 条`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
