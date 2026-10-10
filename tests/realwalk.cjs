// 用真实 FirstPersonControls.update（游戏主循环）按住"前进"直走，记录脚点高度
// 用法: node tests/realwalk.cjs x0,z0 x1,z1 [秒数]
const { chromium } = require('playwright');
const [s0, s1, secs = '12'] = process.argv.slice(2);
const [x0, z0] = s0.split(',').map(Number);
const [x1, z1] = s1.split(',').map(Number);

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__forbiddenCityApp?.controls && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 180000 });
  const log = await page.evaluate(async ({ x0, z0, x1, z1, secs, SPRINT }) => {
    const a = window.__forbiddenCityApp;
    const c = a.controls;
    Object.defineProperty(c.controls, 'isLocked', { get: () => true, configurable: true });
    c.setPosition(x0, 1.7, z0);
    a.camera.lookAt(x1, a.camera.position.y, z1);
    c.moveForward = true;
    c.canSprint = SPRINT;
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      await new Promise(r => setTimeout(r, 150));
      const p = a.camera.position;
      out.push([+p.x.toFixed(1), +p.z.toFixed(1), +c.feetY.toFixed(2)]);
      if (Math.hypot(p.x - x1, p.z - z1) < 0.8) break;
    }
    c.moveForward = false;
    return out;
  }, { x0, z0, x1, z1, secs: +secs, SPRINT: !!process.env.SPRINT });
  let minAfterMax = Infinity, max = 0, drops = [];
  for (let i = 1; i < log.length; i++) {
    if (log[i][2] < log[i - 1][2] - 0.8) drops.push([log[i - 1], log[i]]);
    max = Math.max(max, log[i][2]);
  }
  console.log('样本', log.length, '终点', JSON.stringify(log[log.length - 1]), '最高脚点', max);
  console.log('骤降(>0.8m/帧组)', JSON.stringify(drops));
  console.log('轨迹', JSON.stringify(log.filter((_, i) => i % 3 === 0)));
  await browser.close();
})();
