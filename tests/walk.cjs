// 步行实测：沿路线逐步移动（使用真实碰撞 getValidPosition + 地面高度 getGroundHeight），
// 报告每条路线是否走通、最高脚点、卡住位置。
// 用法：node tests/walk.cjs
const { chromium } = require('playwright');

// 连续路线：每段从上一段终点继续（脚点高度延续），段名只用于报告。
// 殿内宝座区挡住中轴，需从宝座侧面绕行（与真实一致）。
const ROUTES = {
  '午门→东侧金水桥→太和门': [[0, -200], [0, -125], [18, -125], [18, -90.9], [0, -90.9], [0, -60]],
  '上三台→太和殿前门': [[0, -60], [0, -5]],
  // 太和殿柱网：x 每 5.73m 一根，z 每 7.4m 一排（-18.5,-11.1,-3.7,3.7,11.1,18.5）
  '太和殿内绕行': [[-17, -5], [-17, 1], [17, 1], [17, -5], [11.5, -5], [11.5, 1]],
  '绕宝座→太和殿后门': [[11.5, 16], [0, 16], [0, 30]],
  '中和殿穿行': [[0, 50], [-6, 54], [-6, 66], [0, 70]],
  // 保和殿：9 间 bayW≈6.1，柱 x=±3.05/±9.2；进深 34/5 排 z=93,99.8,106.6,113.4,120.2,127
  '保和殿穿行→北下台': [[0, 96], [6.8, 96], [6.8, 124], [0, 124], [0, 160]],
  // 乾清宫 9 间 bayW≈4.7，柱 x=±2.3/±7；进深 28/3 排 z=196,205.3,214.7,224
  '乾清门→乾清宫': [[0, 199], [5.2, 199], [5.2, 222.5], [0, 222.5], [0, 230]],
  // 交泰殿小（3 间），宝座占满后部：从前门进去看，再退出绕殿外到坤宁宫
  '交泰殿进出→绕行→坤宁宫→下台': [[0, 246], [0, 234], [-13, 234], [-13, 266], [0, 266], [0, 275], [4.7, 275], [4.7, 296], [0, 296], [0, 325]],
  '御花园绕钦安殿→神武门': [[20, 335], [20, 372], [0, 385], [0, 440]],
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__forbiddenCityApp?.collisionManager && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 180000 });
  const res = await page.evaluate(async routes => {
    const a = window.__forbiddenCityApp;
    const THREE = await import('/node_modules/three/build/three.module.js');
    const cm = a.collisionManager;
    const H = 1.7;
    const out = {};
    const first = Object.values(routes)[0][0];
    let feet = 0;
    let pos = new THREE.Vector3(first[0], H, first[1]);
    let dead = false;
    for (const [name, pts] of Object.entries(routes)) {
      if (dead) { out[name] = { ok: false, skipped: true, maxFeet: 0, end: [] }; continue; }
      let maxFeet = feet;
      let stuck = null;
      const trace = [];
      for (let i = 0; i < pts.length && !stuck; i++) {
        const target = new THREE.Vector3(pts[i][0], 0, pts[i][1]);
        let guard = 0;
        while (guard++ < 4000) {
          const d = new THREE.Vector3(target.x - pos.x, 0, target.z - pos.z);
          const dist = d.length();
          if (dist < 0.15) break;
          d.normalize().multiplyScalar(Math.min(0.12, dist));
          const want = pos.clone().add(d);
          const next = cm.getValidPosition(pos, want, 0.4);
          const g = cm.getGroundHeight(next.x, next.z, feet, 0.6);
          feet = g >= feet - 0.02 ? g : Math.max(g, feet - 0.12);
          next.y = feet + H;
          if (next.distanceTo(pos) < 0.01) {
            stuck = [+pos.x.toFixed(1), +pos.z.toFixed(1), +feet.toFixed(2)];
            const p = want.clone(); p.y = feet + H;
            const b = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(p.x, feet + 0.35 + (H - 0.4) / 2, p.z), new THREE.Vector3(0.8, H - 0.4, 0.8));
            stuck.push(cm.colliders.filter(c => c.box.intersectsBox(b)).slice(0, 3)
              .map(c => { const x = c.box; return [x.min.x, x.min.y, x.min.z, x.max.x, x.max.y, x.max.z].map(n => +n.toFixed(1)); }));
            break;
          }
          pos = next;
          maxFeet = Math.max(maxFeet, feet);
          if (guard % 40 === 0) trace.push([+pos.z.toFixed(0), +feet.toFixed(1)]);
        }
      }
      if (stuck) dead = true;
      out[name] = { ok: !stuck, stuck, maxFeet: +maxFeet.toFixed(2), end: [+pos.x.toFixed(1), +pos.z.toFixed(1), +feet.toFixed(2)], trace: trace.slice(0, 40) };
    }
    return out;
  }, ROUTES);
  for (const [k, v] of Object.entries(res)) {
    console.log(`${v.ok ? 'PASS' : 'FAIL'} ${k}  最高脚点=${v.maxFeet}  终点=${v.end}${v.stuck ? '  卡在=' + JSON.stringify(v.stuck) : ''}`);
    if (process.env.TRACE) console.log('   ', JSON.stringify(v.trace));
  }
  await browser.close();
})();
