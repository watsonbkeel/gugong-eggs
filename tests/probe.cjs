// 调试探针：node tests/probe.cjs "<JS 表达式，可用 a=app, THREE, v(x,z,feetY)>"
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__forbiddenCityApp?.postProcessing?.composer && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 180000 });
  const out = await page.evaluate(async expr => {
    const a = window.__forbiddenCityApp;
    const THREE = await import('/node_modules/three/build/three.module.js');
    const v = (x, z, f = 0) => new THREE.Vector3(x, f + 1.7, z);
    // eslint-disable-next-line no-eval
    return JSON.stringify(await eval(expr));
  }, process.argv[2] || '1');
  console.log(out);
  if (errors.length) console.log('ERRORS:', errors.slice(0, 5).join('\n'));
  await browser.close();
})();
