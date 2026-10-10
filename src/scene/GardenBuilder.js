import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildRoof } from './RoofBuilder.js';
import { buildHallBody, buildSumeruBase, buildBalustrade } from './HallKit.js';
import { applyBoxUV, applyBandUV, scaleCylinderUV } from '../utils/GeometryUV.js';
import { mergeByMaterial } from '../utils/MergeUtils.js';
import { mulberry32 } from './garden/noise.js';
import { buildTreeVariant, createFoliageMaterial } from './garden/trees.js';
import { buildRockery } from './garden/rocks.js';

const PATH_HW = 1.8; // 甬路半宽
const GRASS_Y = 0.012;
const PATH_Y = 0.028;
const BED_H = 0.32;
const PAVILION_BRIDGE_W = 2.4;     // 浮碧亭 / 澄瑞亭 南北石桥宽
const PAVILION_POND_BASE = 6.8;    // 池中亭台面宽（size 5.2 + 1.6）
const PAVILION_POND_BASE_H = 0.9;  // 池中亭台面高

/**
 * 御花园：钦安殿、堆秀山与御景亭、浮碧/澄瑞/万春/千秋四亭、古柏、卵石甬路、花坛、水池、石灯香炉。
 *
 * - 构造：new GardenBuilder(scene, library)
 * - build(data)：data 为 Layout.js 中 type === 'garden' 的条目
 * - getColliders()：世界坐标 THREE.Box3[]
 * - update(dt)：树冠风摆
 * - dispose()：移除自有对象，释放自有几何与自有材质（跳过 library.owns 的资源），可重复调用
 */
export class GardenBuilder {
  constructor(scene, library) {
    this.scene = scene;
    this.library = library;
    this.group = new THREE.Group();
    this.group.name = 'imperial_garden';
    this.colliders = [];
    this.walkables = [];
    this.ownedMaterials = new Set();
    this.windTime = { value: 0 };
    this.stats = {};
  }

  build(data) {
    const lib = this.library;
    const cx = data?.position?.x ?? 0;
    const cz = data?.position?.z ?? 350;
    const w = data?.dimensions?.width ?? 130;
    const d = data?.dimensions?.depth ?? 90;
    this.bounds = { x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 };
    const el = name => data?.elements?.find(e => e.name === name);
    const hallEl = el('钦安殿');
    const rockEl = el('堆秀山');
    this.hallPos = new THREE.Vector3(cx + (hallEl?.position.x ?? 0), 0, cz + (hallEl?.position.z ?? 0));
    this.hallDim = hallEl?.dimensions ?? { width: 15, depth: 15, height: 18 };
    this.rockPos = new THREE.Vector3(cx + (rockEl?.position.x ?? 30), 0, cz + (rockEl?.position.z ?? 20));
    this.rockDim = rockEl?.dimensions ?? { width: 10, depth: 10, height: 8 };

    // 自有材质
    this.goldMat = this.own(new THREE.MeshStandardMaterial({ color: 0xd8a83a, metalness: 0.85, roughness: 0.32, name: 'garden_gold' }));
    this.bronzeMat = this.own(new THREE.MeshStandardMaterial({ color: 0x4b3d2a, metalness: 0.7, roughness: 0.45, name: 'garden_bronze' }));

    const staticRoot = new THREE.Group();
    staticRoot.name = 'garden_static';
    this.buildGround(staticRoot, cx, cz);
    // 钦安殿改由 SideCourts 以可进入的殿座建造（台明 + 台阶 + 敞开殿门 + 殿内供台）
    this.buildPonds(staticRoot, cx, cz);
    this.buildPavilions(staticRoot, cx, cz);
    this.buildOrnaments(staticRoot, cx, cz);
    this.buildRockeryAndTop(staticRoot);

    // 收集屋顶等构件的自有材质，再按材质合并
    staticRoot.traverse(o => {
      const owned = o.userData?.ownedMaterials;
      if (owned) (Array.isArray(owned) ? owned : [...owned]).forEach(m => this.own(m));
    });
    const merged = mergeByMaterial(staticRoot, { name: 'garden_static' });
    merged.traverse(o => { if (o.isMesh && !o.isInstancedMesh) o.receiveShadow = true; });
    this.group.add(merged);

    this.buildTrees();
    this.scene.add(this.group);
    
    // 性能统计
    let drawCalls = 0, totalTris = 0;
    this.group.traverse(o => {
      if (o.isMesh || o.isInstancedMesh) {
        drawCalls++;
        const geo = o.geometry;
        const count = o.isInstancedMesh ? o.count : 1;
        const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
        totalTris += tris * count;
      }
    });
    this.stats.drawCalls = drawCalls;
    this.stats.triangles = Math.round(totalTris);
    console.log(`[GardenBuilder] 已构建御花园：draw calls=${drawCalls}, 三角面=${this.stats.triangles.toLocaleString()}, 树木=${this.stats.trees}棵, 碰撞器=${this.colliders.length}`);
    return this;
  }

  own(material) {
    if (material && !this.library.owns(material)) this.ownedMaterials.add(material);
    return material;
  }

  addCollider(box) {
    if (!box.isEmpty()) this.colliders.push(box);
  }

  /** group 局部 Box3[] → 世界坐标碰撞 */
  addLocalColliders(object, boxes = []) {
    object.updateWorldMatrix(true, false); // 必须包含父级变换（钦安殿 hall 组位于 z=350）
    boxes.forEach(b => this.addCollider(b.clone().applyMatrix4(object.matrixWorld)));
  }

  /* ---------------------------------------------------------------- 地面 */

  /** 花园布局：甬路矩形、花坛矩形、障碍区 */
  planLayout(cx, cz) {
    const { x0, x1, z0, z1 } = this.bounds;
    const hw = PATH_HW;
    const hz = this.hallPos.z;
    const paths = [
      [cx - hw, cx + hw, z0, hz - 12.5],
      [cx - hw, cx + hw, hz + 12.5, z1],
      [x0 + 1, x1 - 1, cz - 38 - hw, cz - 38 + hw],
      [x0 + 1, x1 - 1, cz + 36 - hw, cz + 36 + hw],
      [cx - 15.2, cx + 15.2, hz - 15.5, hz + 15.5], // 钦安殿四周铺装
    ];
    for (const s of [-1, 1]) {
      paths.push(rectX(s, cx, 17 - hw, 17 + hw, z0, z1));
      paths.push(rectX(s, cx, 48 - hw, 48 + hw, z0, z1));
      paths.push(rectX(s, cx, 17 + hw, 48 - hw, hz - hw, hz + hw));
    }
    const beds = [];
    for (const s of [-1, 1]) {
      beds.push(rectX(s, cx, 2.6, 14.4, cz - 35.4, hz - 16.3));
      beds.push(rectX(s, cx, 2.6, 14.4, hz + 16.3, cz + 33.4));
      beds.push(rectX(s, cx, 19.6, 45.4, cz - 35.4, cz - 29.4));
      beds.push(rectX(s, cx, 19.6, 26.6, hz - 13.8, hz - 2.6));
      beds.push(rectX(s, cx, 37.4, 45.4, hz - 13.8, hz - 2.6));
      if (s > 0) {
        beds.push(rectX(s, cx, 40.2, 45.4, hz + 6, cz + 33.4));
        beds.push(rectX(s, cx, 19.6, 40.2, cz + 28.6, cz + 33.4));
        beds.push(rectX(s, cx, 19.6, 22.2, hz + 6, cz + 28.6));
      } else {
        beds.push(rectX(s, cx, 19.6, 45.4, hz + 6, cz + 33.4));
      }
      beds.push(rectX(s, cx, 50.6, x1 - cx - 2.6, cz - 35.4, cz + 33.4));
    }
    return { paths, beds };
  }

  buildGround(root, cx, cz) {
    const lib = this.library;
    const { x0, x1, z0, z1 } = this.bounds;
    const { paths, beds } = this.planLayout(cx, cz);
    this.paths = paths;
    this.beds = beds;
    const grassMat = lib.material('grass', { roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    const pathMat = lib.material('pebble_path', { roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const marble = lib.material('marble', { roughness: 0.7 });

    // 草地底层（整园）
    root.add(new THREE.Mesh(quadGeometry(x0 + 0.5, x1 - 0.5, z0 + 0.5, z1 - 0.5, GRASS_Y, lib.tileSize('grass')), grassMat));
    // 卵石甬路
    const pathGeos = paths.map(([a, b, c, e]) => quadGeometry(a, b, c, e, PATH_Y, lib.tileSize('pebble_path')));
    root.add(new THREE.Mesh(mergeGeometries(pathGeos), pathMat));
    pathGeos.forEach(g => g.dispose());
    // 甬路边的青砖牙子（只沿主轴与东西向主路两侧，细条）
    const curbMat = lib.material('wall_brick', { roughness: 0.9 });
    for (const [a, b, c, e] of paths.slice(0, 4)) {
      const horizontal = b - a > e - c;
      for (const side of [0, 1]) {
        const geo = horizontal
          ? new THREE.BoxGeometry(b - a, 0.08, 0.16)
          : new THREE.BoxGeometry(0.16, 0.08, e - c);
        const m = new THREE.Mesh(applyBoxUV(geo, lib.tileSize('wall_brick')), curbMat);
        if (horizontal) m.position.set((a + b) / 2, 0.04, side ? e : c);
        else m.position.set(side ? b : a, 0.04, (c + e) / 2);
        root.add(m);
      }
    }

    // 花坛：汉白玉围边 + 草顶
    const bedTops = [];
    for (const [a, b, c, e] of beds) {
      bedTops.push(quadGeometry(a + 0.2, b - 0.2, c + 0.2, e - 0.2, BED_H - 0.03, lib.tileSize('grass')));
      const t = 0.3;
      const parts = [
        [(a + b) / 2, c + t / 2, b - a, t], [(a + b) / 2, e - t / 2, b - a, t],
        [a + t / 2, (c + e) / 2, t, e - c - 2 * t], [b - t / 2, (c + e) / 2, t, e - c - 2 * t],
      ];
      for (const [x, z, sx, sz] of parts) {
        const m = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(sx, BED_H, sz), lib.tileSize('marble')), marble);
        m.position.set(x, BED_H / 2, z);
        m.castShadow = true;
        root.add(m);
      }
    }
    const bedGrass = lib.material('grass', { roughness: 0.95 });
    root.add(new THREE.Mesh(mergeGeometries(bedTops), bedGrass));
    bedTops.forEach(g => g.dispose());
  }

  /** 可行走面：box 顶面 */
  walkBox(x0, z0, x1, z1, y) {
    this.walkables.push({ type: 'box', box: new THREE.Box3(new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z1)) });
  }

  /** 沿 Z 的坡道：z=zFrom 处高 yFrom → z=zTo 处高 yTo */
  walkRampZ(x0, x1, zFrom, zTo, yFrom, yTo) {
    this.walkables.push({
      type: 'ramp', minX: Math.min(x0, x1), maxX: Math.max(x0, x1),
      minZ: Math.min(zFrom, zTo), maxZ: Math.max(zFrom, zTo), axis: 'z', a0: zFrom, a1: zTo, y0: yFrom, y1: yTo,
    });
  }

  /* ---------------------------------------------------------------- 水池与亭 */

  pondSpecs(cx) {
    return [
      { name: '浮碧亭', x: cx + 32, z: this.bounds.z0 + 23 },
      { name: '澄瑞亭', x: cx - 32, z: this.bounds.z0 + 23 },
    ];
  }

  buildPonds(root, cx) {
    const lib = this.library;
    const marble = lib.material('marble', { roughness: 0.7 });
    const water = lib.material('water', { roughness: 0.12, metalness: 0.15 });
    const pw = 15, pd = 10, rimH = 0.55, rimT = 0.5;
    const BW = PAVILION_BRIDGE_W;          // 南北石桥（桥亭）通道宽
    const half = BW / 2 + 0.1;
    const seg = (pw + rimT) / 2 - half;    // 南北池壁/栏杆被桥口分成两段，每段长
    for (const p of this.pondSpecs(cx)) {
      const g = new THREE.Group();
      g.position.set(p.x, 0, p.z);
      root.add(g);
      // 池壁：东西整段，南北两段（中间为桥口）
      const rims = [[-pw / 2, 0, rimT, pd - rimT], [pw / 2, 0, rimT, pd - rimT]];
      for (const s of [-1, 1]) for (const zz of [-pd / 2, pd / 2]) rims.push([s * (half + seg / 2), zz, seg, rimT]);
      for (const [x, z, sx, sz] of rims) {
        const m = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(sx, rimH, sz), lib.tileSize('marble')), marble);
        m.position.set(x, rimH / 2, z);
        m.castShadow = true;
        g.add(m);
      }
      // 水面（水面略低于池沿）
      const wq = quadGeometry(-pw / 2 + rimT / 2, pw / 2 - rimT / 2, -pd / 2 + rimT / 2, pd / 2 - rimT / 2, 0.3, lib.tileSize('water'));
      g.add(new THREE.Mesh(wq, water));
      // 池沿栏杆：南北在桥口处断开
      const rails = [[-pw / 2, 0, pd, Math.PI / 2], [pw / 2, 0, pd, -Math.PI / 2]];
      for (const s of [-1, 1]) {
        rails.push([s * (half + (pw / 2 - half) / 2), -pd / 2, pw / 2 - half, 0]);
        rails.push([s * (half + (pw / 2 - half) / 2), pd / 2, pw / 2 - half, Math.PI]);
      }
      for (const [x, z, len, rot] of rails) {
        const rail = buildBalustrade(lib, { length: len, height: 0.85 });
        rail.position.set(x, rimH, z);
        rail.rotation.y = rot;
        g.add(rail);
      }
      // 碰撞：水面全部挡住，只留桥面通道与亭台（亭台东西两侧仍是水）
      const bw = PAVILION_POND_BASE / 2;
      const X0 = p.x - pw / 2 - 0.3, X1 = p.x + pw / 2 + 0.3, Z0 = p.z - pd / 2 - 0.3, Z1 = p.z + pd / 2 + 0.3;
      const box = (a, b, c, d) => this.addCollider(new THREE.Box3(new THREE.Vector3(a, 0, c), new THREE.Vector3(b, 1.6, d)));
      box(X0, p.x - bw, Z0, Z1);
      box(p.x + bw, X1, Z0, Z1);
      for (const s of [-1, 1]) {
        const xa = p.x + s * BW / 2, xb = p.x + s * bw;
        box(Math.min(xa, xb), Math.max(xa, xb), Z0, p.z - bw);
        box(Math.min(xa, xb), Math.max(xa, xb), p.z + bw, Z1);
      }
      // 石桥：池外地面 → 亭台面（坡道 + 两侧矮栏）
      const top = PAVILION_POND_BASE_H;
      for (const dir of [-1, 1]) {
        const zOut = p.z + dir * (pd / 2 + 2.2);
        const zIn = p.z + dir * bw;
        const run = Math.abs(zOut - zIn);
        const L = Math.hypot(run, top);
        const ang = Math.atan2(top, run);
        const deck = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(BW, 0.25, L), lib.tileSize('marble')), marble);
        deck.position.set(0, top / 2 - 0.1, (zOut + zIn) / 2 - p.z);
        deck.rotation.x = dir * ang;
        deck.castShadow = deck.receiveShadow = true;
        g.add(deck);
        for (const s of [-1, 1]) {
          const rail = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(0.22, 0.6, L), lib.tileSize('marble')), marble);
          rail.position.set(s * (BW / 2 + 0.05), top / 2 + 0.3, (zOut + zIn) / 2 - p.z);
          rail.rotation.x = dir * ang;
          rail.castShadow = true;
          g.add(rail);
          // 桥栏碰撞（只登记在水面上方那一段，桥头可以从地面走上去）
          const zr0 = p.z + dir * (pd / 2 + 0.3), zr1 = zIn;
          this.addCollider(new THREE.Box3(
            new THREE.Vector3(p.x + s * (BW / 2 + 0.05) - 0.12, 0, Math.min(zr0, zr1)),
            new THREE.Vector3(p.x + s * (BW / 2 + 0.05) + 0.12, top + 1.2, Math.max(zr0, zr1))));
        }
        this.walkRampZ(p.x - BW / 2, p.x + BW / 2, zOut, zIn, 0, top);
      }
    }
  }

  buildPavilions(root, cx) {
    const hz = this.hallPos.z;
    for (const p of this.pondSpecs(cx)) {
      this.makePavilion(root, { x: p.x, z: p.z, size: PAVILION_POND_BASE - 1.6, baseH: PAVILION_POND_BASE_H, colH: 3.3, cols: 'square4', sides: 4, layers: 1, pier: true });
    }
    // 万春亭（东）、千秋亭（西）：方形重檐攒尖，八柱
    for (const s of [1, -1]) {
      this.makePavilion(root, { x: cx + s * 32, z: hz, size: 7, baseH: 0.75, colH: 3.8, cols: 'square8', sides: 4, layers: 2, steps: true });
    }
  }

  /**
   * 亭：汉白玉台基、红柱、坐凳栏杆、倒挂楣子、彩画额枋、攒尖顶、宝顶。
   */
  makePavilion(root, { x, z, y = 0, size, baseH, colH, cols, sides, layers, steps = false, pier = false, collide = true }) {
    const lib = this.library;
    const g = new THREE.Group();
    g.position.set(x, y, z);
    root.add(g);
    const marble = lib.material('marble', { roughness: 0.7 });
    const wood = lib.material('wood_column');
    const half = size / 2;
    const baseW = size + 1.6;
    const base = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(baseW, baseH, baseW), lib.tileSize('marble')), marble);
    base.position.y = baseH / 2;
    base.castShadow = true;
    g.add(base);
    // 台基压面石（略出沿）
    const cap = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(baseW + 0.2, 0.14, baseW + 0.2), lib.tileSize('marble')), marble);
    cap.position.y = baseH - 0.07;
    g.add(cap);
    if (steps) {
      for (const sz of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const sh = baseH * (k + 1) / 3;
          const st = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(2.4, sh, 0.4), lib.tileSize('marble')), marble);
          st.position.set(0, sh / 2, sz * (baseW / 2 + 0.2 + (2 - k) * 0.4));
          g.add(st);
        }
      }
    }
    // 柱位
    const pts = [[-half, -half], [half, -half], [half, half], [-half, half]];
    // 八柱亭：南北面中柱改为门口两侧一对柱，正中留出进出口
    if (cols === 'square8') pts.push([-1.5, -half], [1.5, -half], [half, 0], [-1.5, half], [1.5, half], [-half, 0]);
    const r = 0.2;
    const colGeo = scaleCylinderUV(new THREE.CylinderGeometry(r * 0.92, r, colH, 12), r, colH, lib.tileSize('wood_column'));
    for (const [px, pz] of pts) {
      const c = new THREE.Mesh(colGeo.clone(), wood);
      c.position.set(px, baseH + colH / 2, pz);
      c.castShadow = true;
      g.add(c);
      // 柱础
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.5, r * 1.6, 0.18, 12), marble);
      plinth.position.set(px, baseH + 0.09, pz);
      g.add(plinth);
    }
    colGeo.dispose();
    // 额枋（彩画）
    const beamH = 0.42;
    const beamGeoX = applyBandUV(new THREE.BoxGeometry(size + 0.5, beamH, 0.3), lib.tileSize('caihua_beam'));
    const beamMat = lib.material('caihua_beam');
    for (const [bx, bz, rot] of [[0, -half, 0], [0, half, 0], [-half, 0, Math.PI / 2], [half, 0, Math.PI / 2]]) {
      const b = new THREE.Mesh(beamGeoX.clone(), beamMat);
      b.position.set(bx, baseH + colH - beamH / 2, bz);
      b.rotation.y = rot;
      g.add(b);
      // 倒挂楣子（额枋下方的木格）
      const lat = new THREE.Mesh(applyBandUV(new THREE.BoxGeometry(size - 0.4, 0.38, 0.08), 2), lib.material('lattice_doors'));
      lat.position.set(bx, baseH + colH - beamH - 0.19, bz);
      lat.rotation.y = rot;
      g.add(lat);
      // 坐凳栏杆：入口方向（南北：台阶 / 石桥）留空；山顶小亭只留南面
      const through = steps || pier;
      if (bz === 0 || !through) {
        const isEntrance = !through && bz < 0;
        if (!isEntrance) {
          if (collide) {
            const horiz = bz !== 0;
            const sx = horiz ? size - 0.4 : 0.42, sz = horiz ? 0.42 : size - 0.4;
            this.addCollider(new THREE.Box3().setFromCenterAndSize(
              new THREE.Vector3(x + bx, y + baseH + 0.4, z + bz), new THREE.Vector3(sx, 0.8, sz)));
          }
          const seat = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(size - 0.4, 0.12, 0.42), lib.tileSize('wood_column')), wood);
          seat.position.set(bx * 0.97, baseH + 0.48, bz * 0.97);
          seat.rotation.y = rot;
          g.add(seat);
          const panel = new THREE.Mesh(applyBandUV(new THREE.BoxGeometry(size - 0.4, 0.4, 0.1), 1.5), lib.material('lattice_doors'));
          panel.position.set(bx, baseH + 0.22, bz);
          panel.rotation.y = rot;
          g.add(panel);
        }
      }
    }
    beamGeoX.dispose();
    // 屋顶
    const roofBase = baseH + colH;
    const roof = buildRoof(lib, {
      type: 'pavilion', sides, width: size, depth: size, baseY: roofBase, layers,
      brackets: size >= 6, detail: 'high', height: size * (layers > 1 ? 0.62 : 0.7),
    });
    g.add(roof);
    this.addFinial(g, roof);
    if (collide) {
      // 台面可走；台基四边只在台阶 / 石桥口以外设矮挡（玩家站上台面后碰撞盒底高于挡块，不受影响）
      const hb = baseW / 2;
      const gap = (steps || pier) ? 1.2 : 0;
      this.walkBox(x - hb, z - hb, x + hb, z + hb, y + baseH);
      const edge = (x0, x1, z0, z1) => this.addCollider(new THREE.Box3(new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y + baseH, z1)));
      for (const s of [-1, 1]) {
        edge(x + s * hb - 0.15, x + s * hb + 0.15, z - hb, z + hb);               // 东西两边整段
        if (gap) {
          edge(x - hb, x - gap, z + s * hb - 0.15, z + s * hb + 0.15);            // 南北两边，中间留口
          edge(x + gap, x + hb, z + s * hb - 0.15, z + s * hb + 0.15);
        } else {
          edge(x - hb, x + hb, z + s * hb - 0.15, z + s * hb + 0.15);
        }
      }
      if (steps) {
        for (const s of [-1, 1]) this.walkRampZ(x - 1.2, x + 1.2, z + s * (hb + 1.2), z + s * hb, y, y + baseH);
      }
      for (const [px, pz] of pts) {
        this.addCollider(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x + px, y + baseH + 1.5, z + pz), new THREE.Vector3(r * 2, 3, r * 2)));
      }
    }
    return g;
  }

  addFinial(group, roof) {
    let has = false;
    roof.traverse(o => { if (/finial|baoding|宝顶/i.test(o.name)) has = true; });
    if (has) return;
    const top = roof.userData?.topY ?? 0;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.5, 10), this.goldMat);
    stem.position.y = top + 0.15;
    group.add(stem);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), this.goldMat);
    ball.position.y = top + 0.65;
    ball.scale.set(1, 1.15, 1);
    group.add(ball);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 10), this.goldMat);
    tip.position.y = top + 1.1;
    group.add(tip);
  }

  /* ---------------------------------------------------------------- 堆秀山 */

  buildRockeryAndTop(root) {
    const lib = this.library;
    const topY = Math.max(7, this.rockDim.height ?? 8);
    const { geometries, colliders } = buildRockery({
      center: this.rockPos, radiusX: (this.rockDim.width ?? 10) * 0.65, radiusZ: (this.rockDim.depth ?? 10) * 0.55,
      topY, seed: 2024, tile: lib.tileSize('rock'),
    });
    const geo = mergeGeometries(geometries, false);
    geometries.forEach(g => g.dispose());
    geo.computeBoundingSphere();
    const rockMat = this.own(new THREE.MeshStandardMaterial({
      name: 'garden_taihu_rock', map: lib.color('rock'), normalMap: lib.normal('rock'), vertexColors: true, roughness: 0.93, metalness: 0,
    }));
    if (rockMat.normalMap) rockMat.normalScale = new THREE.Vector2(1.4, 1.4);
    const rock = new THREE.Mesh(geo, rockMat);
    rock.name = 'duixiu_rockery';
    rock.castShadow = rock.receiveShadow = true;
    rock.userData.noMerge = true; // 顶点色需保留
    root.add(rock);
    colliders.forEach(b => this.addCollider(b));
    this.stats.rockTriangles = geo.attributes.position.count / 3;
    // 山顶御景亭
    const marble = lib.material('marble', { roughness: 0.7 });
    const plat = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(5.6, 0.5, 5.6), lib.tileSize('marble')), marble);
    plat.position.set(this.rockPos.x, topY + 0.25, this.rockPos.z);
    root.add(plat);
    this.makePavilion(root, { x: this.rockPos.x, y: topY + 0.5, z: this.rockPos.z, size: 3.6, baseH: 0.35, colH: 2.8, cols: 'square4', sides: 4, layers: 1, collide: false });
  }

  /* ---------------------------------------------------------------- 小品 */

  buildOrnaments(root, cx) {
    const lib = this.library;
    const marble = lib.material('marble', { roughness: 0.7 });
    const hz = this.hallPos.z;
    // 石灯：沿中轴两侧
    for (const z of [hz - 30, hz - 22]) {
      for (const s of [-1, 1]) this.makeLantern(root, cx + s * 3.3, z, marble);
    }
    // 铜香炉：钦安殿台阶前两侧（地面）
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(cx + s * 5, 0, hz - 12);
      this.addCollider(new THREE.Box3(new THREE.Vector3(cx + s * 5 - 0.6, 0, hz - 12.6), new THREE.Vector3(cx + s * 5 + 0.6, 2, hz - 11.4)));
      root.add(g);
      const ped = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(1.1, 0.5, 1.1), lib.tileSize('marble')), marble);
      ped.position.y = 0.25;
      g.add(ped);
      const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), this.bronzeMat);
      bowl.rotation.x = Math.PI;
      bowl.position.y = 1.15;
      g.add(bowl);
      for (let k = 0; k < 3; k++) {
        const a = k / 3 * Math.PI * 2;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.45, 6), this.bronzeMat);
        leg.position.set(Math.cos(a) * 0.35, 0.72, Math.sin(a) * 0.35);
        g.add(leg);
      }
      const lid = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.75, 12), this.bronzeMat);
      lid.position.y = 1.55;
      g.add(lid);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), this.bronzeMat);
      knob.position.y = 2.0;
      g.add(knob);
    }
    // 盆景石座（花坛中的立石）
    const rng = mulberry32(99);
    for (const [a, b, c, e] of this.beds.filter((_, i) => i % 3 === 0)) {
      const x = a + (b - a) * (0.3 + rng() * 0.4);
      const z = c + (e - c) * (0.3 + rng() * 0.4);
      this.stoneSpots = this.stoneSpots ?? [];
      this.stoneSpots.push([x, z]);
    }
  }

  makeLantern(root, x, z, marble) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    root.add(g);
    const part = (geo, y) => { const m = new THREE.Mesh(geo, marble); m.position.y = y; m.castShadow = true; g.add(m); return m; };
    part(new THREE.BoxGeometry(0.9, 0.3, 0.9), 0.15);
    part(new THREE.CylinderGeometry(0.16, 0.2, 1.3, 8), 0.95);
    part(new THREE.BoxGeometry(0.75, 0.16, 0.75), 1.68);
    part(new THREE.BoxGeometry(0.55, 0.5, 0.55), 2.0);
    const roof = part(new THREE.ConeGeometry(0.62, 0.45, 4), 2.48);
    roof.rotation.y = Math.PI / 4;
    part(new THREE.SphereGeometry(0.1, 8, 6), 2.75);
    this.addCollider(new THREE.Box3(new THREE.Vector3(x - 0.45, 0, z - 0.45), new THREE.Vector3(x + 0.45, 2.8, z + 0.45)));
  }

  /* ---------------------------------------------------------------- 古柏 */

  buildTrees() {
    const lib = this.library;
    const rng = mulberry32(1421);
    const variants = [
      ['oldCypress', 11], ['oldCypress', 23], ['cypress', 37], ['cypress', 41], ['tallCypress', 53], ['pine', 67],
    ].map(([kind, seed]) => ({ kind, ...buildTreeVariant(kind, seed, lib.tileSize('bark'), lib.tileSize('foliage')), items: [] }));
    const weights = [0.2, 0.2, 0.18, 0.17, 0.13, 0.12];
    const pick = () => { let t = rng(); for (let i = 0; i < weights.length; i++) { t -= weights[i]; if (t <= 0) return i; } return 0; };

    // 在花坛内采样，保持间距并避开障碍
    const obstacles = this.colliders.map(b => b.clone().expandByScalar(1.6));
    const placed = [];
    const area = this.beds.map(([a, b, c, e]) => Math.max(0, b - a - 3) * Math.max(0, e - c - 3));
    const total = area.reduce((s, v) => s + v, 0);
    const target = 34;
    const p = new THREE.Vector3();
    for (let attempt = 0; attempt < 4000 && placed.length < target; attempt++) {
      let t = rng() * total, bi = 0;
      while (t > area[bi] && bi < area.length - 1) { t -= area[bi]; bi++; }
      const [a, b, c, e] = this.beds[bi];
      const x = a + 1.5 + rng() * Math.max(0, b - a - 3);
      const z = c + 1.5 + rng() * Math.max(0, e - c - 3);
      const narrow = Math.min(b - a, e - c) < 8;
      const minGap = narrow ? 5 : 6;
      if (placed.some(q => Math.hypot(q.x - x, q.z - z) < minGap)) continue;
      p.set(x, 1, z);
      if (obstacles.some(box => box.containsPoint(p))) continue;
      if (Math.hypot(x - this.rockPos.x, z - this.rockPos.z) < 10) continue;
      placed.push({ x, z, bed: bi });
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (const t of placed) {
      const vi = pick();
      const v = variants[vi];
      const sc = 0.88 + rng() * 0.28;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
      s.set(sc * (0.95 + rng() * 0.1), sc, sc * (0.95 + rng() * 0.1));
      m.compose(new THREE.Vector3(t.x, BED_H - 0.02, t.z), q, s);
      v.items.push(m.clone());
      const rr = THREE.MathUtils.clamp(v.trunkRadius * sc * 1.25, 0.5, 0.8);
      this.addCollider(new THREE.Box3(new THREE.Vector3(t.x - rr, 0, t.z - rr), new THREE.Vector3(t.x + rr, 3, t.z + rr)));
    }
    const barkMat = lib.material('bark', { roughness: 0.95, normalScale: 1.5 });
    const foliageMat = this.own(createFoliageMaterial(lib, this.windTime));
    let tris = 0;
    for (const v of variants) {
      if (!v.items.length) { v.trunk.dispose(); v.crown.dispose(); continue; }
      for (const [geo, mat, name] of [[v.trunk, barkMat, 'trunk'], [v.crown, foliageMat, 'crown']]) {
        const mesh = new THREE.InstancedMesh(geo, mat, v.items.length);
        v.items.forEach((mx, i) => mesh.setMatrixAt(i, mx));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere?.();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `garden_${v.kind}_${name}`;
        this.group.add(mesh);
        tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3 * v.items.length;
      }
    }
    this.stats.trees = placed.length;
    this.stats.treeTriangles = tris;
  }

  getColliders() {
    return [...this.colliders];
  }

  getWalkables() {
    return [...this.walkables];
  }

  update(dt = 0.016) {
    this.windTime.value += Math.min(dt, 0.1);
  }

  dispose() {
    const lib = this.library;
    const geometries = new Set();
    const materials = new Set(this.ownedMaterials);
    this.group.traverse(child => {
      if (child.geometry) geometries.add(child.geometry);
      if (child.isInstancedMesh) child.dispose();
    });
    geometries.forEach(g => g.dispose());
    materials.forEach(mat => { if (!lib.owns(mat)) mat.dispose(); });
    this.ownedMaterials.clear();
    this.group.removeFromParent();
    this.group.clear();
    this.colliders.length = 0;
  }
}

/** 按 s（±1）镜像 x 范围的矩形 */
function rectX(s, cx, a, b, c, e) {
  return s > 0 ? [cx + a, cx + b, c, e] : [cx - b, cx - a, c, e];
}

/** 水平四边形（世界坐标 UV，法线朝上） */
function quadGeometry(x0, x1, z0, z1, y, tile) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([x0 / tile, -z0 / tile, x0 / tile, -z1 / tile, x1 / tile, -z1 / tile, x0 / tile, -z0 / tile, x1 / tile, -z1 / tile, x1 / tile, -z0 / tile], 2));
  return geo;
}
