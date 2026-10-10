// 藏蛋点导出：从运行中的场景读取房间清单与碰撞体，生成 src/game/eggSpots.json。
// 用法：先 npm run dev，再 node tests/dump-egg-spots.cjs
// 规则见需求文档第 8 节；本脚本相对需求的偏离（已与老师确认）：
//   - 宝座殿(throne)也可藏，但只取靠门一侧的两个角（避开宝座与供台）；钦安殿四角都可取，保证御花园区 ≥ 4 点
//   - 名字重复的廊房（庑房/朝房）不作为候选
//   - approach 不手工拼，而是在真实碰撞数据上做网格寻路后再做直线化简
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '../src/game/eggSpots.json');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  page.setDefaultTimeout(0);
  await page.goto(process.env.PALACE_URL || 'http://127.0.0.1:5173', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__forbiddenCityApp?.rooms && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 240000 });

  const result = await page.evaluate(() => {
    const a = window.__forbiddenCityApp;
    cancelAnimationFrame(a.animationFrame);
    a.disposed = true; // 停掉主循环，节省 CPU
    const cm = a.collisionManager;
    const H = 1.7;
    const START = { x: 0, z: -200 };
    const BOUND = { minX: -175, maxX: 175, minZ: -220, maxZ: 450 };
    const free = (x, z, y, r = 0.5) => !cm.checkCollision({ x, y: y + H, z }, r);

    // ───────── 1. 候选房间 ─────────
    const strip = n => n.replace(/·\d+$/, '');
    const counts = {};
    a.rooms.forEach(r => { if (r.name) counts[strip(r.name)] = (counts[strip(r.name)] || 0) + 1; });
    const rooms = a.rooms.filter(r => r.name && ['hall', 'room', 'storage', 'throne'].includes(r.kind) && counts[strip(r.name)] === 1);

    const areaOf = r => {
      const cx = (r.min.x + r.max.x) / 2, cz = (r.min.z + r.max.z) / 2;
      const side = cx < 0 ? '东' : '西';
      if (cz >= 305 && Math.abs(cx) < 67) return { area: '御花园', group: '御花园' };
      if (cz < 150 && Math.abs(cx) <= 75 && Math.abs(cx) > 40) return { area: `太和殿广场${side}侧`, group: '外朝' };
      if (cz >= 170 && cz < 305 && Math.abs(cx) > 40 && Math.abs(cx) <= 118) return { area: `${side}六宫`, group: `${side}六宫` };
      if (cz >= 305 && Math.abs(cx) > 67 && Math.abs(cx) <= 118) return { area: '西路·建福宫一带', group: '西路' };
      if (Math.abs(cx) > 118 && cz >= 170) return cx < 0 ? { area: '东路·宁寿宫一带', group: '东路' } : { area: '西路·寿康宫一带', group: '西路' };
      if (Math.abs(cx) > 75) return cx < 0
        ? { area: cz >= 40 ? '东路·奉先殿一带' : '东路·文华殿一带', group: '东路' }
        : { area: cz >= 40 ? '西路·慈宁宫一带' : '西路·武英殿一带', group: '西路' };
      return null;
    };
    const CAP = { 东六宫: 7, 西六宫: 7, 东路: 9, 西路: 9, 御花园: 4, 外朝: 4 };

    // ───────── 2. 每个房间的候选角点 ─────────
    const pickCorners = r => {
      const cx = (r.min.x + r.max.x) / 2, cz = (r.min.z + r.max.z) / 2;
      const hw = (r.max.x - r.min.x) / 2, hd = (r.max.z - r.min.z) / 2;
      const door = r.doors[0];
      const alongX = Math.abs(door.x - cx) / hw > Math.abs(door.z - cz) / hd; // 门开在 x 方向的墙上
      const doorSign = alongX ? Math.sign(door.x - cx) : Math.sign(door.z - cz);
      const out = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        if (r.kind === 'throne' && r.name !== '钦安殿') { // 宝座殿：只取靠门一侧
          const front = alongX ? sx === doorSign : sz === doorSign;
          if (!front) continue;
        }
        let placed = null;
        for (const inset of [1.0, 1.3, 1.6]) {
          const ix = sx < 0 ? r.min.x + inset : r.max.x - inset;
          const iz = sz < 0 ? r.min.z + inset : r.max.z - inset;
          // 有 cover 时优先用离角最近的 cover 点（家具旁的空位）
          let tx = ix, tz = iz, withCover = false;
          const cov = r.cover.filter(c => c.x > r.min.x + 0.8 && c.x < r.max.x - 0.8 && c.z > r.min.z + 0.8 && c.z < r.max.z - 0.8)
            .map(c => ({ c, d: Math.hypot(c.x - ix, c.z - iz) })).sort((p, q) => p.d - q.d)[0];
          const tryList = [];
          if (cov && cov.d < 3) tryList.push({ x: cov.c.x, z: cov.c.z, cover: true });
          tryList.push({ x: ix, z: iz, cover: false });
          let found = null;
          for (const t of tryList) {
            // 在附近 1.5m 内找第一个可站立点（离理想点最近）
            const cands = [];
            for (let dx = -1.5; dx <= 1.5; dx += 0.25) for (let dz = -1.5; dz <= 1.5; dz += 0.25) {
              const x = t.x + dx, z = t.z + dz;
              if (x < r.min.x + 0.8 || x > r.max.x - 0.8 || z < r.min.z + 0.8 || z > r.max.z - 0.8) continue;
              cands.push({ x, z, d: Math.hypot(dx, dz) });
            }
            cands.sort((p, q) => p.d - q.d);
            const hit = cands.find(p => free(p.x, p.z, r.floorY));
            if (hit) { found = { x: hit.x, z: hit.z, cover: t.cover }; break; }
          }
          if (!found) continue;
          // 不能从殿外隔墙捡到：蛋周围 1.5m 内殿外不得有可站立点
          let leak = false;
          for (let rad = 0.4; rad <= 1.5 && !leak; rad += 0.1) for (let k = 0; k < 24; k++) {
            const ang = (k / 24) * Math.PI * 2;
            const x = found.x + Math.cos(ang) * rad, z = found.z + Math.sin(ang) * rad;
            if ((x < r.min.x || x > r.max.x || z < r.min.z || z > r.max.z) && free(x, z, r.floorY)) { leak = true; break; }
          }
          if (leak) continue;
          placed = found;
          break;
        }
        if (!placed) continue;
        const east = placed.x < cx ? '东' : '西'; // -X 是东
        const north = placed.z > cz ? '北' : '南';
        out.push({ x: placed.x, z: placed.z, cover: placed.cover, dir: `${east}${north}` });
      }
      return out;
    };

    // ───────── 3. 选点（按区域配额，轮流取各房间第 1、2 个点） ─────────
    const byGroup = {};
    for (const r of rooms) {
      const ar = areaOf(r);
      if (!ar) continue;
      const corners = pickCorners(r);
      // 稳定排序：带 cover 的优先，其余按坐标哈希错开
      corners.sort((p, q) => (q.cover - p.cover) || (((p.x * 7 + p.z * 13) % 1) - ((q.x * 7 + q.z * 13) % 1)));
      (byGroup[ar.group] ??= []).push({ r, ar, corners });
    }
    const picked = [];
    for (const [group, list] of Object.entries(byGroup)) {
      const cap = CAP[group] ?? 0;
      const maxPer = group === '御花园' ? 4 : 2;
      let n = 0;
      for (let round = 0; round < maxPer && n < cap; round++) for (const item of list) {
        if (n >= cap) break;
        const c = item.corners[round];
        if (!c) continue;
        picked.push({ r: item.r, ar: item.ar, c });
        n++;
      }
    }

    // ───────── 4. 网格寻路：出生点 → 各点（多档安全半径，优先走离墙远的路线） ─────────
    const CELL = 0.5;
    const W = Math.floor((BOUND.maxX - BOUND.minX) / CELL) + 1;
    const D = Math.floor((BOUND.maxZ - BOUND.minZ) / CELL) + 1;
    const N = W * D;
    const ci = x => Math.round((x - BOUND.minX) / CELL);
    const cj = z => Math.round((z - BOUND.minZ) / CELL);
    const px = i => BOUND.minX + (i % W) * CELL;
    const pz = i => BOUND.minZ + Math.floor(i / W) * CELL;
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const RADII = [0.7, 0.55];
    // Dijkstra：以 R 为可通行半径，但离墙近的格子加惩罚，使路线尽量走开阔处（贴墙滑行慢且易被判卡住）
    const runBfs = (R) => {
      const feet = new Float32Array(N).fill(NaN);
      const parent = new Int32Array(N).fill(-2);
      const dist = new Float32Array(N).fill(Infinity);
      const done = new Uint8Array(N);
      const s = cj(START.z) * W + ci(START.x);
      feet[s] = cm.getGroundHeight(START.x, START.z, 0, 0.6);
      parent[s] = -1; dist[s] = 0;
      // 二叉堆（存格子下标，按 dist 比较，允许重复入堆）
      const heap = []; 
      const push = (i) => { heap.push(i); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (dist[heap[p]] <= dist[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { let l = 2 * k + 1, r = l + 1, m = k; if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l; if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
      push(s);
      let reached = 0;
      while (heap.length) {
        const cur = pop();
        if (done[cur]) continue;
        done[cur] = 1; reached++;
        const cx = cur % W, cz = (cur / W) | 0;
        const f0 = feet[cur];
        const x0 = px(cur), z0 = pz(cur);
        for (const [dx, dz] of DIRS) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
          const ni = nz * W + nx;
          if (done[ni]) continue;
          const x = px(ni), z = pz(ni);
          const g = cm.getGroundHeight(x, z, f0, 0.6);
          if (g - f0 > 0.65 || f0 - g > 1.2) continue;
          if (cm.checkCollision({ x, y: g + H, z }, R)) continue;
          if (dx && dz) {
            const mx = (x0 + x) / 2, mz = (z0 + z) / 2;
            if (cm.checkCollision({ x: mx, y: Math.max(f0, g) + H, z: mz }, R)) continue;
          }
          const pen = cm.checkCollision({ x, y: g + H, z }, 1.0) ? 3 : cm.checkCollision({ x, y: g + H, z }, 0.8) ? 1.5 : 0;
          const nd = dist[cur] + (dx && dz ? 1.414 : 1) * (1 + pen);
          if (nd < dist[ni]) { dist[ni] = nd; parent[ni] = cur; feet[ni] = g; push(ni); }
        }
      }
      return { R, feet, parent, reached };
    };

    const t0 = performance.now();
    const fields = RADII.map(runBfs);
    const bfsMs = Math.round(performance.now() - t0);
    const qt = fields[fields.length - 1].reached;

    const los = (x0, z0, f0, x1, z1, R) => {
      const d = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.ceil(d / 0.25));
      let f = f0;
      for (let k = 1; k <= n; k++) {
        const x = x0 + (x1 - x0) * k / n, z = z0 + (z1 - z0) * k / n;
        const g = cm.getGroundHeight(x, z, f, 0.6);
        if (g - f > 0.65 || f - g > 1.2) return false;
        if (cm.checkCollision({ x, y: g + H, z }, R)) return false;
        f = g;
      }
      return true;
    };

    const spots = [];
    const failed = [];
    for (const { r, ar, c } of picked) {
      const label = `${r.name}(${c.dir}角)`;
      let chosen = null;
      // 从最大安全半径开始，找到第一个能走到蛋点附近的档位
      for (const fld of fields) {
        let best = -1, bd = 1e9;
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          const i = (cj(c.z) + dz) * W + (ci(c.x) + dx);
          if (i < 0 || i >= N || fld.parent[i] === -2) continue;
          const d = Math.hypot(px(i) - c.x, pz(i) - c.z);
          if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0 && bd <= 1.6) { chosen = { fld, best }; break; }
      }
      if (!chosen) { failed.push(label + ' 寻路不可达'); continue; }
      const { fld, best } = chosen;
      const cells = [];
      for (let i = best; i !== -1; i = fld.parent[i]) cells.push(i);
      cells.reverse();
      const pts = cells.map(i => ({ x: px(i), z: pz(i), f: fld.feet[i] }));
      pts.push({ x: c.x, z: c.z, f: r.floorY });
      // 直线化简：每段不超过 12 m，且每段在该档半径下全程可通行；路径越多拐点，控制器越不容易偏离
      const route = [[pts[0].x, pts[0].z]];
      let i = 0;
      while (i < pts.length - 1) {
        let j = pts.length - 1;
        while (j > i + 1 && (Math.hypot(pts[j].x - pts[i].x, pts[j].z - pts[i].z) > 5 || !los(pts[i].x, pts[i].z, pts[i].f, pts[j].x, pts[j].z, Math.max(fld.R, 0.8)))) j--;
        route.push([pts[j].x, pts[j].z]);
        i = j;
      }
      const round1 = v => +v.toFixed(1);
      route[0] = [START.x, START.z];
      const last = route[route.length - 1];
      last[0] = round1(c.x); last[1] = round1(c.z);
      const where = c.cover ? (r.kind === 'storage' ? '，木箱旁边' : '，案几旁边') : '';
      spots.push({
        id: `r${String(r.id).padStart(3, '0')}-${{ 东北: 'ne', 东南: 'se', 西北: 'nw', 西南: 'sw' }[c.dir]}`,
        x: round1(c.x), y: r.floorY, z: round1(c.z),
        area: ar.area, hall: strip(r.name), corner: `殿内${c.dir}角${where}`,
        approach: route.map(([x, z]) => [round1(x), round1(z)]),
      });
    }
    return { spots, failed, bfsMs, reached: qt, roomsConsidered: rooms.length, walkables: cm.walkables.length, radii: fields.map(f => f.R + ':' + f.reached) };
  });

  console.log(`候选房间 ${result.roomsConsidered}，walkables ${result.walkables}，BFS ${result.bfsMs}ms，各档可达格 ${result.radii.join(' ')}`);
  if (result.failed.length) console.log('寻路失败：', result.failed.join('；'));
  const areaCount = {};
  result.spots.forEach(s => { areaCount[s.area] = (areaCount[s.area] || 0) + 1; });
  console.log('点数', result.spots.length, JSON.stringify(areaCount));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result.spots, null, 2) + '\n');
  console.log('已写入', OUT);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
