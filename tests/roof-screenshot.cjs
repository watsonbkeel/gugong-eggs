const { chromium } = require('playwright');
const path = require('node:path');

(async () => {
  const outDir = '/Users/watson/Documents/Codex/故宫/outputs/dev';
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  
  console.log('加载预览页面...');
  await page.goto('http://127.0.0.1:5173/tests/roof-preview.html', { waitUntil: 'load', timeout: 120000 });
  
  await page.waitForFunction(() => window.__roofPreview?.roofs?.length > 0, null, { timeout: 120000 });
  await page.waitForTimeout(3000);
  
  const stats = await page.evaluate(() => {
    const app = window.__roofPreview;
    const info = { roofs: [] };
    app.roofs.forEach(r => {
      let tris = 0, meshes = 0;
      r.obj.traverse(o => {
        if (o.isMesh) {
          meshes++;
          tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
        }
      });
      info.roofs.push({ name: r.name, tris: Math.round(tris), meshes });
    });
    return info;
  });
  
  console.log('屋顶统计:', JSON.stringify(stats, null, 2));
  
  const views = [
    { name: 'overview', pos: [0, 35, 100], target: [0, 15, 0] },
    { name: 'wudian-close', pos: [-100, 18, -5], target: [-100, 20, -20] },
    { name: 'xieshan-close', pos: [160, 16, 50], target: [160, 18, 60] },
    { name: 'pavilion', pos: [-65, 16, 75], target: [-65, 18, 60] },
    { name: 'corner-tower', pos: [50, 12, -50], target: [50, 8, -60] },
    { name: 'gable-wallcap', pos: [105, 10, 40], target: [105, 8, 60] },
  ];
  
  for (const view of views) {
    await page.evaluate(({ pos, target }) => {
      const app = window.__roofPreview;
      app.camera.position.set(pos[0], pos[1], pos[2]);
      app.camera.lookAt(target[0], target[1], target[2]);
      app.camera.updateMatrixWorld();
      app.renderer.render(app.scene, app.camera);
    }, view);
    
    await page.waitForTimeout(500);
    const file = path.join(outDir, `roof-${view.name}.png`);
    await page.screenshot({ path: file });
    console.log(`截图: ${file}`);
  }
  
  if (errors.length) console.error('错误:', errors);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
