// 截图工具：在本地开发服务上按指定机位渲染并截图，供开发时目视检查。
// 用法：node tests/shot.cjs 输出名 x,y,z lookX,lookY,lookZ [x,y,z lookX,lookY,lookZ ...]
//   多组机位依次截图，文件名为 输出名-1.png、输出名-2.png …，输出到 ../outputs/dev/
// 环境变量：PALACE_URL（默认 http://127.0.0.1:5173）、MOBILE=1（模拟手机低画质）、QUALITY=low
// 打印：页面错误、draw calls、三角面数、加载耗时、截图帧耗时
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const [name = 'shot', ...rest] = process.argv.slice(2);
  const views = [];
  for (let i = 0; i + 1 < rest.length; i += 2) views.push([rest[i].split(',').map(Number), rest[i + 1].split(',').map(Number)]);
  if (!views.length) views.push([[0, 1.7, -120], [0, 8, 0]]);
  const outDir = path.resolve(__dirname, '../../outputs/dev');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const mobile = process.env.MOBILE === '1';
  const context = await browser.newContext(mobile
    ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile' }
    : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`http ${r.status()} ${r.url()}`); });
  const t0 = Date.now();
  await page.goto(process.env.PALACE_URL || 'http://127.0.0.1:5173', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__forbiddenCityApp?.postProcessing?.composer && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 240000 });
  const loadMs = Date.now() - t0;
  if (process.env.QUALITY === 'low') await page.evaluate(() => { const a = window.__forbiddenCityApp; if (a.currentQuality !== 'low') a.toggleQuality(); });
  for (let i = 0; i < views.length; i++) {
    const [[x, y, z], [lx, ly, lz]] = views[i];
    const stats = await page.evaluate(({ x, y, z, lx, ly, lz }) => {
      const a = window.__forbiddenCityApp;
      cancelAnimationFrame(a.animationFrame);
      a.disposed = true; // 暂停动画循环，避免控制器把相机高度重置
      document.querySelector('#welcome-overlay').style.display = 'none';
      a.camera.position.set(x, y, z);
      a.camera.lookAt(lx, ly, lz);
      a.camera.updateMatrixWorld();
      a.environment.update(a.camera, 0.016);
      a.renderer.info.autoReset = false;
      a.renderer.info.reset();
      const t = performance.now();
      a.postProcessing.render();
      const ms = performance.now() - t;
      const info = { calls: a.renderer.info.render.calls, triangles: a.renderer.info.render.triangles, frameMs: Math.round(ms) };
      a.renderer.info.autoReset = true;
      return info;
    }, { x, y, z, lx, ly, lz });
    const file = path.join(outDir, `${name}-${i + 1}.png`);
    await page.screenshot({ path: file });
    console.log(JSON.stringify({ file, view: views[i], ...stats }));
  }
  const memory = await page.evaluate(() => ({ ...window.__forbiddenCityApp.renderer.info.memory }));
  console.log(JSON.stringify({ loadMs, memory, errors }));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
