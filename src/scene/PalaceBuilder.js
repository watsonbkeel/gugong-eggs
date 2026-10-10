import * as THREE from 'three';
import { COLORS } from '../config/constants.js';
import { buildWumen } from './palace/gate.js';
import { buildGateAscent, toWorld } from './palace/gateAscent.js';
import { buildRoof } from './RoofBuilder.js';
import { buildHallBody, buildBalustrade, buildStuddedDoor } from './HallKit.js';
import { mergeByMaterial } from '../utils/MergeUtils.js';
import { applyBoxUV, applyBandUV, applyPlanarUV } from '../utils/GeometryUV.js';

/**
 * 真实形制参数（按故宫现状）：
 * bays 面阔间数；roof/layers 屋顶形式；throne 是否设宝座；inner 殿内匾额；open 前后敞开可进出的间数；
 * 门的 depth/baseH/margin/apron 为场景压缩比例下的修正，避免与金水河、乾清宫台阶冲突。
 */
/**
 * plinth：殿座自身台明高度（米）。同一大台基上相邻两殿之间是"下台阶 → 台面 → 上台阶"，
 * 台明要足够高、台阶足够长，参观时才能明显感到先下后上（受台基前后余量约束，台阶水平长 = 高 × 1.6）。
 */
const REAL = {
  太和殿: { bays: 11, roof: 'wudian', layers: 2, throne: true, inner: '建极绥猷', open: 3, plinth: 2.2 },
  中和殿: { bays: 5, roof: 'pavilion', layers: 1, throne: true, inner: '允执厥中', open: 3, plinth: 1.6 },
  保和殿: { bays: 9, roof: 'xieshan', layers: 2, throne: true, inner: '皇建有极', open: 3, plinth: 2.0 },
  太和门: { bays: 9, roof: 'xieshan', layers: 2, open: 3, depth: 14, baseH: 1.5, margin: 1, apron: 1 },
  乾清门: { bays: 5, roof: 'xieshan', layers: 1, open: 3, depth: 12, baseH: 1.5, margin: 0, apron: 1 },
  乾清宫: { bays: 9, roof: 'wudian', layers: 2, throne: true, inner: '正大光明', open: 3, plinth: 2.0 },
  交泰殿: { bays: 3, roof: 'pavilion', layers: 1, throne: true, inner: '无为', open: 3, plinth: 1.5 },
  坤宁宫: { bays: 9, roof: 'wudian', layers: 2, open: 3, plinth: 2.0 },
};
const PLINTH_PAD = 1.5; // 台明比殿身四周外扩

function dimsOf(h) {
  const s = REAL[h.name] ?? {};
  return { width: h.dimensions.width, depth: s.depth ?? h.dimensions.depth, height: h.dimensions.height };
}

/**
 * 中轴线建筑：宫殿 / 门 / 金水河。
 *
 * 坐标约定：每座建筑在局部 Group 中建模（原点 = 建筑中心，地面 y=0，正面朝 -Z 南），
 * 建完后 mergeByMaterial 合并并放到世界坐标。
 * 碰撞体与可行走面（walkables）直接登记世界坐标（局部坐标 + this.ox / this.oz）。
 * 可行走面：台基每层顶面（box）、台阶（ramp）、桥面（ramp）。碰撞体只登记人身高范围内的实体。
 */
export class PalaceBuilder {
  constructor(scene, library) {
    this.scene = scene;
    this.library = library;

    // 回归脚本依赖：materials.water（射线检测水面材质）与 textures（色彩空间检查，可为空）
    this.materials = {
      water: new THREE.MeshStandardMaterial({
        color: COLORS.WATER_BLUE,
        roughness: 0.1,
        metalness: 0.8,
        transparent: true,
        opacity: 0.7,
      }),
    };
    this.textures = {};

    this.colliders = [];
    this.walkables = [];
    this.ownedMaterials = [];
    this.ownedObjects = new Set();
    this.ox = 0;
    this.oz = 0;
    this._own = new Map();
  }

  buildAll(layout) {
    for (const item of layout) {
      if (item.type === 'gate') this.buildGate(item);
      else if (item.type === 'river') this.buildRiver(item);
    }
    this.buildPalaces(layout.filter(item => item.type === 'palace'));
  }

  // ───────────────────────── 通用工具 ─────────────────────────

  begin(data) {
    this.ox = data.position.x;
    this.oz = data.position.z;
    const g = new THREE.Group();
    g.name = data.name ?? 'building';
    return g;
  }

  finish(g) {
    const merged = mergeByMaterial(g, { castShadow: true, receiveShadow: true, name: g.name });
    merged.position.set(this.ox, 0, this.oz);
    this.addObject(merged);
    return merged;
  }

  addObject(obj) {
    this.scene.add(obj);
    this.ownedObjects.add(obj);
  }

  ownMat(key, params) {
    if (!this._own.has(key)) {
      const m = new THREE.MeshStandardMaterial(params);
      this._own.set(key, m);
      this.ownedMaterials.push(m);
    }
    return this._own.get(key);
  }

  /** 普通盒子；uv = { box: tile } | { band: width } | null */
  box(parent, mat, w, h, d, x, y, z, uv = null) {
    let geo = new THREE.BoxGeometry(w, h, d);
    if (uv?.box) geo = applyBoxUV(geo, uv.box);
    else if (uv?.band) geo = applyBandUV(geo, uv.band);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /** 贴图库材质盒子；mode = 'box' | 'band' | 'raw' */
  libBox(parent, name, w, h, d, x, y, z, mode = 'box', params) {
    const t = this.library.tileSize(name);
    const uv = mode === 'band' ? { band: t } : mode === 'box' ? { box: t } : null;
    return this.box(parent, this.library.material(name, params), w, h, d, x, y, z, uv);
  }

  /** 局部坐标 → 世界坐标碰撞盒 */
  col(x0, y0, z0, x1, y1, z1) {
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1) + this.ox, Math.min(y0, y1), Math.min(z0, z1) + this.oz),
      new THREE.Vector3(Math.max(x0, x1) + this.ox, Math.max(y0, y1), Math.max(z0, z1) + this.oz),
    ));
  }

  walkBox(x0, z0, x1, z1, y) {
    this.walkables.push({
      type: 'box',
      box: new THREE.Box3(
        new THREE.Vector3(Math.min(x0, x1) + this.ox, y, Math.min(z0, z1) + this.oz),
        new THREE.Vector3(Math.max(x0, x1) + this.ox, y, Math.max(z0, z1) + this.oz),
      ),
    });
  }

  /** 沿 Z 的坡道：zFrom 处高 yFrom，zTo 处高 yTo */
  walkRampZ(x0, x1, zFrom, zTo, yFrom, yTo) {
    this.walkables.push({
      type: 'ramp',
      minX: Math.min(x0, x1) + this.ox,
      maxX: Math.max(x0, x1) + this.ox,
      minZ: Math.min(zFrom, zTo) + this.oz,
      maxZ: Math.max(zFrom, zTo) + this.oz,
      axis: 'z',
      a0: zFrom + this.oz,
      a1: zTo + this.oz,
      y0: yFrom,
      y1: yTo,
    });
  }

  column(g, geo, mat, x, z, y, h, r) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + h / 2, z);
    m.castShadow = true;
    g.add(m);
    this.col(x - r, y, z - r, x + r, y + 3, z + r);
  }

  /** 汉白玉栏杆一段（沿 X 或 Z），带碰撞 */
  rail(g, x0, z0, x1, z1, y, h = 1.1) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.6) return;
    const r = buildBalustrade(this.library, { length: len, height: h });
    r.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    r.rotation.y = Math.abs(z1 - z0) > Math.abs(x1 - x0) ? Math.PI / 2 : 0;
    g.add(r);
    this.col(Math.min(x0, x1) - 0.15, y + 0.2, Math.min(z0, z1) - 0.15,
      Math.max(x0, x1) + 0.15, y + h + 0.3, Math.max(z0, z1) + 0.15);
  }

  /** 台面四周栏杆，前后两边在中央留 ±half 的楼梯口 */
  edgeRails(g, w, d, y, half) {
    const ix = w / 2 - 0.2;
    const iz = d / 2 - 0.2;
    for (const s of [-1, 1]) {
      this.rail(g, -ix, s * iz, -half, s * iz, y);
      this.rail(g, half, s * iz, ix, s * iz, y);
      this.rail(g, s * ix, -iz, s * ix, iz, y);
    }
  }

  // ───────────────────────── 台基与台阶 ─────────────────────────

  /**
   * 多层须弥座台基：每层顶面可走；每层南北都有台阶（含垂带、御路），栏杆在台阶处开口。
   * 每层比上层四周外扩 setback（= 台阶水平长度 + 1m 平台）。
   * @returns {number} 顶层台面高度
   */
  buildTerrace(g, { topW, topD, layers, lh, run, setback, stairW }) {
    const half = stairW / 2;
    for (let i = 0; i < layers; i++) {
      const w = topW + 2 * (layers - 1 - i) * setback;
      const d = topD + 2 * (layers - 1 - i) * setback;
      const y0 = i * lh;
      const y1 = y0 + lh;
      const ch = Math.min(lh, 3);
      const t = 0.5;

      this.libBox(g, 'sumeru_band', w, lh, d, 0, y0 + lh / 2, 0, 'band');
      this.libBox(g, 'stone_slab', w + 0.2, 0.1, d + 0.2, 0, y1 - 0.03, 0, 'box');
      this.walkBox(-w / 2, -d / 2, w / 2, d / 2, y1);

      // 侧面挡墙（只在本层高度范围内，站在台面上的人不受影响）
      this.col(-w / 2, y0, -d / 2, -w / 2 + t, y0 + ch, d / 2);
      this.col(w / 2 - t, y0, -d / 2, w / 2, y0 + ch, d / 2);
      for (const s of [-1, 1]) {
        const ze = s * d / 2;
        this.col(-w / 2, y0, ze, -half, y0 + ch, ze - s * t);
        this.col(half, y0, ze, w / 2, y0 + ch, ze - s * t);
        this.buildStair(g, { zEdge: ze, dir: s, y0, y1, run, width: stairW });
      }
      this.edgeRails(g, w, d, y1, half);
    }
    return layers * lh;
  }

  /**
   * 台阶：从台边 zEdge（高 y1）向外 dir 方向下行 run 米到 y0。
   * 视觉 = 逐级踏步 + 两侧垂带 + 中央御路石；行走 = ramp；两侧垂带碰撞防止从侧面钻进台阶。
   */
  buildStair(g, { zEdge, dir, y0, y1, run, width }) {
    const rise = y1 - y0;
    const n = Math.max(3, Math.round(rise / 0.16));
    const sr = run / n;
    const cw = 0.45;
    const marble = this.library.material('marble');
    const tile = this.library.tileSize('marble');

    for (let k = 0; k < n; k++) {
      const top = y1 - (k + 1) * rise / (n + 1);
      this.box(g, marble, width, top - y0, sr, 0, (top + y0) / 2, zEdge + dir * (k + 0.5) * sr, { box: tile });
    }

    const L = Math.hypot(run, rise);
    const ang = dir * Math.atan2(rise, run);
    const zc = zEdge + dir * run / 2;
    for (const sx of [-1, 1]) {
      const m = this.box(g, marble, cw, 0.4, L, sx * (width / 2 - cw / 2), (y0 + y1) / 2 + 0.1, zc, { box: tile });
      m.rotation.x = ang;
      // 垂带碰撞：分 4 段，每段高度随坡度递减
      for (let j = 0; j < 4; j++) {
        const za = zEdge + dir * j * run / 4;
        const zb = zEdge + dir * (j + 1) * run / 4;
        const hi = y1 - j * rise / 4 + 0.9;
        this.col(sx * (width / 2 - cw), y0, za, sx * width / 2, Math.min(hi, y0 + Math.max(rise + 0.9, 1)), zb);
      }
    }

    if (width >= 9) {
      const yw = width * 0.22;
      const m = this.box(g, this.library.material('yulu'), yw, 0.3, L, 0, (y0 + y1) / 2 + 0.05, zc);
      m.rotation.x = ang;
    }

    this.walkRampZ(-width / 2 + cw, width / 2 - cw, zEdge, zEdge + dir * run, y1, y0);
  }

  // ───────────────────────── 宫殿群（共享台基） ─────────────────────────

  /**
   * 多块矩形沿 Z 拼接的台基（土字形三台 / 工字形后三宫）。
   * rects: [{ hw, z0, z1 }]（顶层，局部坐标），每下一层 hw 与首尾 z 向外扩 setback。
   * 只在首块南边、末块北边设台阶；矩形交界处宽出的部分设挡墙与栏杆。
   */
  buildTerraceUnion(g, rects, { layers, lh, run, setback, stairW }) {
    const half = stairW / 2;
    const t = 0.5;
    const last = rects.length - 1;
    for (let i = 0; i < layers; i++) {
      const e = (layers - 1 - i) * setback;
      const y0 = i * lh;
      const y1 = y0 + lh;
      const ch = Math.min(lh, 3);
      const R = rects.map((r, k) => ({
        hw: r.hw + e,
        z0: k === 0 ? r.z0 - e : r.z0,
        z1: k === last ? r.z1 + e : r.z1,
      }));
      R.forEach((r, k) => {
        const d = r.z1 - r.z0;
        const zc = (r.z0 + r.z1) / 2;
        this.libBox(g, 'sumeru_band', r.hw * 2, lh, d, 0, y0 + lh / 2, zc, 'band');
        this.libBox(g, 'stone_slab', r.hw * 2 + 0.2, 0.1, d + (k === 0 || k === last ? 0.2 : 0), 0, y1 - 0.03, zc, 'box');
        this.walkBox(-r.hw, r.z0, r.hw, r.z1, y1);
        for (const s of [-1, 1]) {
          this.col(s * r.hw, y0, r.z0, s * (r.hw - t), y0 + ch, r.z1);
          this.rail(g, s * (r.hw - 0.2), r.z0 + (k === 0 ? 0.2 : 0), s * (r.hw - 0.2), r.z1 - (k === last ? 0.2 : 0), y1);
        }
        if (k < last) {
          const n = R[k + 1];
          if (Math.abs(r.hw - n.hw) > 0.6) {
            const wide = r.hw > n.hw ? r.hw : n.hw;
            const narrow = Math.min(r.hw, n.hw);
            const dz = r.hw > n.hw ? -1 : 1; // 墙体朝宽块内侧
            for (const s of [-1, 1]) {
              this.col(s * narrow, y0, r.z1, s * wide, y0 + ch, r.z1 + dz * t);
              this.rail(g, s * (narrow - 0.2), r.z1 + dz * 0.2, s * (wide - 0.2), r.z1 + dz * 0.2, y1);
            }
          }
        }
      });
      // 南北两端：分段挡墙 + 台阶 + 栏杆开口
      for (const [r, s, ze] of [[R[0], -1, R[0].z0], [R[last], 1, R[last].z1]]) {
        this.col(-r.hw, y0, ze, -half, y0 + ch, ze - s * t);
        this.col(half, y0, ze, r.hw, y0 + ch, ze - s * t);
        this.buildStair(g, { zEdge: ze, dir: s, y0, y1, run, width: stairW });
        const zr = ze - s * 0.2;
        this.rail(g, -(r.hw - 0.2), zr, -half, zr, y1);
        this.rail(g, half, zr, r.hw - 0.2, zr, y1);
      }
    }
    return layers * lh;
  }

  /** 中轴宫殿群：三台（太和/中和/保和）、后三宫（乾清/交泰/坤宁），其他宫殿各自成台 */
  buildPalaces(list) {
    const groups = [
      { names: ['太和殿', '中和殿', '保和殿'], name: '三台', apron: 14, margin: 4 },
      { names: ['乾清宫', '交泰殿', '坤宁宫'], name: '后三宫', apron: 6, margin: 4 },
    ];
    const used = new Set();
    for (const grp of groups) {
      const halls = list.filter(p => grp.names.includes(p.name)).sort((a, b) => a.position.z - b.position.z);
      if (!halls.length) continue;
      halls.forEach(h => used.add(h));
      this.buildComplex(halls, grp);
    }
    list.filter(p => !used.has(p)).forEach(p => this.buildComplex([p], { name: p.name, apron: 6, margin: 4 }));
  }

  buildComplex(halls, { name, apron, margin, maxH }) {
    this.ox = 0;
    this.oz = 0;
    const g = new THREE.Group();
    g.name = name;
    const first = halls[0].dimensions;
    const spec0 = REAL[halls[0].name] ?? {};
    const layers = first.baseLayers ?? 1;
    const height = Math.min(spec0.baseH ?? first.baseHeight ?? 3, maxH ?? Infinity);
    const lh = height / layers;
    const run = lh * 1.6;
    const setback = run + 1.2;
    const mg = spec0.margin ?? margin;
    const ap = spec0.apron ?? apron;

    const rects = halls.map((h, k) => {
      const { width: w, depth: d } = dimsOf(h);
      const z = h.position.z;
      const r = { hw: w / 2 + mg + (k === 0 && halls.length > 1 ? 1 : 0), z0: z - d / 2 - mg, z1: z + d / 2 + mg + 1 };
      if (k === 0) r.z0 = z - d / 2 - ap;
      return r;
    });
    for (let k = 1; k < rects.length; k++) rects[k].z0 = rects[k - 1].z1;

    const bayW = first.width / (spec0.bays ?? 9);
    const stairW = Math.min(12, bayW * 2.2);
    const top = this.buildTerraceUnion(g, rects, { layers, lh, run, setback, stairW });

    if (halls.length > 1) {
      // 真实格局：大台基上每座殿还有各自的台明（须弥座），殿与殿之间要先下台阶、再上台阶
      halls.forEach(h => {
        const spec = REAL[h.name] ?? {};
        const { width: w, depth: d } = dimsOf(h);
        const hb = w / (spec.bays ?? 9);
        const sw = Math.min(stairW, (spec.open ?? 3) * hb);
        // 台阶不能伸出所在台面：按该殿前后可用余量限制台明高度
        const r = rects[halls.indexOf(h)];
        const room = Math.min(h.position.z - d / 2 - PLINTH_PAD - r.z0, r.z1 - (h.position.z + d / 2 + PLINTH_PAD)) - 0.4;
        const ph = Math.min(spec.plinth ?? 1.3, room / 1.6);
        const y = this.buildPlinth(g, { z0: h.position.z, w: w + 2 * PLINTH_PAD, d: d + 2 * PLINTH_PAD, y: top, ph, stairW: sw });
        this.buildHall(g, h, y);
      });
    } else {
      halls.forEach(h => this.buildHall(g, h, top));
    }
    if (name === '三台') this.terraceOrnaments(g, rects[0], top);

    this.finish(g);
  }

  /**
   * 单殿台明：高 ph 的须弥座，前后各一道台阶（ramp），四面挡墙只挡台下的人。
   * @returns {number} 台明顶面高度
   */
  buildPlinth(g, { z0, w, d, y, ph, stairW }) {
    const half = stairW / 2;
    const run = ph * 1.6;
    const t = 0.5;
    const y1 = y + ph;
    this.libBox(g, 'sumeru_band', w, ph, d, 0, y + ph / 2, z0, 'band');
    this.libBox(g, 'stone_slab', w + 0.2, 0.1, d + 0.2, 0, y1 - 0.03, z0, 'box');
    this.walkBox(-w / 2, z0 - d / 2, w / 2, z0 + d / 2, y1);
    this.col(-w / 2, y, z0 - d / 2, -w / 2 + t, y1, z0 + d / 2);
    this.col(w / 2 - t, y, z0 - d / 2, w / 2, y1, z0 + d / 2);
    for (const s of [-1, 1]) {
      const ze = z0 + s * d / 2;
      this.col(-w / 2, y, ze, -half, y1, ze - s * t);
      this.col(half, y, ze, w / 2, y1, ze - s * t);
      this.buildStair(g, { zEdge: ze, dir: s, y0: y, y1, run, width: stairW });
    }
    return y1;
  }

  /** 太和殿月台陈设：铜鼎、日晷（东）、嘉量（西）、铜龟铜鹤 */
  terraceOrnaments(g, r, y) {
    const bronze = this.ownMat('bronze', { color: 0x4a3b28, metalness: 0.7, roughness: 0.45 });
    const marble = this.library.material('marble');
    const zf = r.z0 + 3;
    for (const s of [-1, 1]) {
      for (let k = 0; k < 3; k++) this.tripod(g, bronze, s * (r.hw - 3), y, zf + k * 3.8);
      this.box(g, marble, 1.6, 1.2, 1.6, s * 9, y + 0.6, zf + 1, { box: 2 });
      // 铜龟 / 铜鹤
      const turtle = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 10), bronze);
      turtle.scale.set(1, 0.6, 1.3);
      turtle.position.set(s * 9, y + 1.6, zf + 1);
      g.add(turtle);
      this.box(g, marble, 1.6, 1.2, 1.6, s * 13, y + 0.6, zf + 1, { box: 2 });
      const crane = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.35, 2.2, 8), bronze);
      crane.position.set(s * 13, y + 2.3, zf + 1);
      g.add(crane);
      this.col(s * 9 - 0.8, y, zf + 0.2, s * 9 + 0.8, y + 3, zf + 1.8);
      this.col(s * 13 - 0.8, y, zf + 0.2, s * 13 + 0.8, y + 3, zf + 1.8);
    }
    // 日晷：东侧（本场景东 = -X 方向不确定时以中轴对称处理）
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.15, 32), marble);
    dial.rotation.x = Math.PI / 4;
    dial.position.set(-17, y + 1.9, zf + 1);
    g.add(dial);
    this.box(g, marble, 1.4, 1.4, 1.4, -17, y + 0.7, zf + 1, { box: 2 });
    this.box(g, bronze, 1.2, 1.0, 1.2, 17, y + 1.9, zf + 1);
    this.box(g, marble, 1.4, 1.4, 1.4, 17, y + 0.7, zf + 1, { box: 2 });
    for (const x of [-17, 17]) this.col(x - 0.8, y, zf + 0.2, x + 0.8, y + 3, zf + 1.8);
  }

  tripod(g, mat, x, y, z) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.45, 0.8, 16), mat);
    body.position.set(x, y + 1.0, z);
    g.add(body);
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    lid.position.set(x, y + 1.4, z);
    g.add(lid);
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI * 2 / 3;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.65, 6), mat);
      leg.position.set(x + Math.cos(a) * 0.35, y + 0.32, z + Math.sin(a) * 0.35);
      g.add(leg);
    }
    this.col(x - 0.6, y, z - 0.6, x + 0.6, y + 2, z + 0.6);
  }

  // ───────────────────────── 殿身（可进入） ─────────────────────────

  /**
   * 殿身：檐柱 + 金柱网格（太和殿 11×5 间 = 72 柱）、前后隔扇门（中间几间敞开可进出）、
   * 两山红墙、额枋彩画、井口天花、金砖地面、宝座台/屏风/藻井/殿内匾额、殿外竖匾、屋顶。
   */
  buildHall(g, data, y) {
    const spec = REAL[data.name] ?? {};
    const { width: w, depth: d, height } = dimsOf(data);
    const x0 = data.position.x;
    const z0 = data.position.z;
    const bays = spec.bays ?? Math.max(3, Math.round(w / 6) | 1);
    const nd = Math.max(3, Math.round(d / 7.4) | 1);
    const bayW = w / bays;
    const dBay = d / nd;
    const H = THREE.MathUtils.clamp((height - y) * 0.38, 5, 11);
    const beamH = THREE.MathUtils.clamp(H * 0.12, 0.6, 1.4);
    const r = THREE.MathUtils.clamp(bayW * 0.08, 0.3, 0.6);
    const openHalf = (spec.open ?? 3) * bayW / 2;
    const throne = !!spec.throne;

    const colMat = this.library.material('wood_column');
    const gold = this.ownMat('gold', { color: 0xc9a13b, metalness: 0.85, roughness: 0.3 });
    const colGeo = new THREE.CylinderGeometry(r, r * 1.05, H, 14);

    // 宝座区（后部中间）
    const ztb1 = z0 + d / 2 - Math.min(0.6 * dBay, 4.5);
    const ztb0 = ztb1 - Math.min(1.6 * dBay, 7);
    const thW = Math.min(1.6 * bayW, w * 0.25);

    // 柱网
    for (let i = 0; i <= bays; i++) {
      const x = x0 - w / 2 + i * bayW;
      for (let k = 0; k <= nd; k++) {
        const z = z0 - d / 2 + k * dBay;
        const edge = i === 0 || i === bays || k === 0 || k === nd;
        if (!edge && throne && Math.abs(x - x0) < bayW * 0.6 && z > ztb0 - 1 && z < ztb1 + 1) continue;
        const isGold = throne && !edge && Math.abs(x - x0) < bayW * 1.6 && z > ztb0 - dBay;
        this.column(g, colGeo, isGold ? gold : colMat, x, z, y, H, r);
      }
    }

    // 金砖地面
    const floorGeo = new THREE.PlaneGeometry(w, d);
    floorGeo.rotateX(-Math.PI / 2);
    applyPlanarUV(floorGeo, 'y', 1.4);
    const floor = new THREE.Mesh(floorGeo, this.library.material('stone_slab', { color: 0x55524e, roughness: 0.35 }));
    floor.position.set(x0, y + 0.03, z0);
    floor.receiveShadow = true;
    g.add(floor);

    // 前后檐：隔扇门（中间敞开）+ 上部走马板 + 额枋彩画
    const doorH = (H - beamH) * 0.8;
    for (const s of [-1, 1]) {
      const zf = z0 + s * d / 2;
      for (let i = 0; i < bays; i++) {
        const xc = x0 - w / 2 + (i + 0.5) * bayW;
        if (Math.abs(xc - x0) < openHalf - 0.01) {
          // 敞开的门：两扇隔扇折向两侧
          for (const side of [-1, 1]) {
            const leaf = this.libBox(g, 'lattice_doors', bayW * 0.25, doorH, 0.12,
              xc + side * (bayW / 2 - r - 0.1), y + doorH / 2, zf - s * (bayW * 0.13 + 0.2), 'band');
            leaf.rotation.y = Math.PI / 2;
          }
          continue;
        }
        this.libBox(g, 'lattice_doors', bayW - 2 * r, doorH, 0.15, xc, y + doorH / 2, zf, 'band');
      }
      this.libBox(g, 'wall_red', w, H - beamH - doorH, 0.3, x0, y + doorH + (H - beamH - doorH) / 2, zf, 'box');
      this.libBox(g, 'caihua_beam', w + 0.6, beamH, 0.6, x0, y + H - beamH / 2, zf, 'band');
      this.col(x0 - w / 2, y, zf - 0.25, x0 - openHalf, y + 3, zf + 0.25);
      this.col(x0 + openHalf, y, zf - 0.25, x0 + w / 2, y + 3, zf + 0.25);
    }
    // 门槛（矮，可跨过）
    for (const s of [-1, 1]) this.libBox(g, 'wood_column', openHalf * 2, 0.25, 0.3, x0, y + 0.125, z0 + s * d / 2, 'box');

    // 两山：红墙 + 下碱
    for (const s of [-1, 1]) {
      const xs = x0 + s * w / 2;
      this.libBox(g, 'wall_red', 0.9, H - beamH, d, xs, y + (H - beamH) / 2, z0, 'box');
      this.libBox(g, 'wall_brick', 1.0, 1.2, d + 0.1, xs, y + 0.6, z0, 'box');
      this.libBox(g, 'caihua_beam', 0.6, beamH, d + 0.6, xs, y + H - beamH / 2, z0, 'band');
      this.col(xs - 0.5, y, z0 - d / 2, xs + 0.5, y + 3, z0 + d / 2);
    }

    // 井口天花
    const ceilGeo = new THREE.PlaneGeometry(w, d);
    ceilGeo.rotateX(Math.PI / 2);
    applyPlanarUV(ceilGeo, 'y', 1.6);
    const ceiling = new THREE.Mesh(ceilGeo, this.ceilingMaterial());
    ceiling.position.set(x0, y + H - 0.05, z0);
    g.add(ceiling);

    if (throne) this.throneArea(g, { x0, y, H, ztb0, ztb1, thW, bayW, text: spec.inner });

    // 殿外竖匾
    if (spec.plaque !== false) {
      const ph = THREE.MathUtils.clamp(H * 0.32, 1.8, 3.4);
      const plaque = this.plaqueMesh(data.name, ph * 0.62, ph, true);
      plaque.position.set(x0, y + doorH + (H - beamH - doorH) / 2 + 0.2, z0 - d / 2 - 0.4);
      plaque.rotation.y = Math.PI;
      g.add(plaque);
    }

    // 屋顶
    const roof = buildRoof(this.library, {
      type: spec.roof ?? data.features?.roofType ?? 'wudian',
      width: w + 0.6,
      depth: d + 0.6,
      baseY: y + H,
      layers: spec.layers ?? data.features?.roofLayers ?? 1,
      brackets: true,
      sides: 4,
    });
    roof.position.set(x0, 0, z0);
    g.add(roof);
    this.ownedMaterials.push(...(roof.userData.ownedMaterials ?? []));
  }

  throneArea(g, { x0, y, H, ztb0, ztb1, thW, bayW, text }) {
    const lacquer = this.ownMat('lacquer', { color: 0x7a1d12, roughness: 0.4, metalness: 0.1 });
    const gold = this.ownMat('gold', { color: 0xc9a13b, metalness: 0.85, roughness: 0.3 });
    const bronze = this.ownMat('bronze', { color: 0x4a3b28, metalness: 0.7, roughness: 0.45 });
    const depth = ztb1 - ztb0;
    const zc = (ztb0 + ztb1) / 2;
    // 地平床：两级，金边
    this.box(g, lacquer, thW, 0.6, depth, x0, y + 0.3, zc);
    this.box(g, gold, thW + 0.1, 0.08, depth + 0.1, x0, y + 0.62, zc);
    this.box(g, lacquer, thW * 0.75, 0.6, depth * 0.75, x0, y + 0.95, zc + depth * 0.1);
    for (let k = 0; k < 3; k++) {
      this.box(g, lacquer, thW * 0.3, 0.2 * (k + 1), 0.4, x0, y + 0.1 * (k + 1), ztb0 - 1.2 + k * 0.4);
    }
    this.col(x0 - thW / 2, y, ztb0 - 1.3, x0 + thW / 2, y + 3, ztb1);
    // 宝座 + 屏风
    const ty = y + 1.25;
    const tz = zc + depth * 0.1;
    this.box(g, gold, 1.8, 0.7, 1.3, x0, ty + 0.35, tz);
    this.box(g, gold, 1.9, 1.5, 0.25, x0, ty + 1.2, tz + 0.6);
    for (const s of [-1, 1]) this.box(g, gold, 0.2, 0.6, 1.2, x0 + s * 0.9, ty + 0.9, tz);
    this.box(g, gold, Math.min(thW * 0.7, 6), 3.2, 0.3, x0, ty + 1.6, tz + depth * 0.32);
    for (let k = 0; k < 3; k++) {
      this.box(g, gold, 1.2, 0.5, 0.32, x0 + (k - 1) * 1.6, ty + 3.4, tz + depth * 0.32);
    }
    // 香炉、甪端
    for (const s of [-1, 1]) {
      this.tripod(g, bronze, x0 + s * (thW * 0.35), y, ztb0 - 2.2);
    }
    // 藻井 + 轩辕镜
    const cz = zc - depth * 0.15;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(bayW * 0.9, bayW * 1.05, 0.6, 8, 1, true), gold);
    ring.material.side = THREE.DoubleSide;
    ring.position.set(x0, y + H - 0.35, cz);
    g.add(ring);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(bayW * 0.55, bayW * 0.55, 0.1, 32), gold);
    disc.position.set(x0, y + H - 0.12, cz);
    g.add(disc);
    const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.35, 20, 14),
      this.ownMat('silver', { color: 0xdddddd, metalness: 1, roughness: 0.08 }));
    pearl.position.set(x0, y + H - 1.6, cz);
    g.add(pearl);
    // 殿内横匾
    if (text) {
      const p = this.plaqueMesh(text, 4.2, 1.3, false);
      p.position.set(x0, y + H - 1.1, ztb0 - 0.5);
      p.rotation.y = Math.PI;
      g.add(p);
    }
  }

  // ───────────────────────── Canvas 纹理（匾额 / 天花） ─────────────────────────

  plaqueMesh(text, w, h, vertical) {
    const key = `plaque:${text}`;
    if (!this._own.has(key)) {
      const cw = vertical ? 256 : 512;
      const chh = Math.round(cw * h / w);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = chh;
      const c = canvas.getContext('2d');
      c.fillStyle = '#c8a23c';
      c.fillRect(0, 0, cw, chh);
      c.fillStyle = '#7a5a12';
      c.fillRect(10, 10, cw - 20, chh - 20);
      c.fillStyle = '#c8a23c';
      c.fillRect(16, 16, cw - 32, chh - 32);
      c.fillStyle = '#1e3a6b';
      c.fillRect(28, 28, cw - 56, chh - 56);
      c.fillStyle = '#e8c55a';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const chars = [...text];
      const font = '"STKaiti","KaiTi","Kaiti SC","Songti SC","SimSun",serif';
      if (vertical) {
        const step = (chh - 80) / chars.length;
        c.font = `bold ${Math.floor(Math.min(step * 0.85, cw * 0.6))}px ${font}`;
        chars.forEach((ch, i) => c.fillText(ch, cw / 2, 40 + step * (i + 0.5)));
      } else {
        const step = (cw - 80) / chars.length;
        c.font = `bold ${Math.floor(Math.min(step * 0.85, chh * 0.6))}px ${font}`;
        chars.forEach((ch, i) => c.fillText(ch, 40 + step * (i + 0.5), chh / 2));
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.ownMat(key, { map: tex, roughness: 0.5, metalness: 0.2 });
    }
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.15), this._own.get(key));
    m.userData.noMerge = true;
    return m;
  }

  ceilingMaterial() {
    const key = 'ceiling';
    if (!this._own.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const c = canvas.getContext('2d');
      c.fillStyle = '#c9a24a';
      c.fillRect(0, 0, 256, 256);
      c.fillStyle = '#2d5a4c';
      c.fillRect(12, 12, 232, 232);
      c.strokeStyle = '#c9a24a';
      c.lineWidth = 6;
      c.strokeRect(34, 34, 188, 188);
      c.fillStyle = '#2a4b7c';
      c.beginPath();
      c.arc(128, 128, 70, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 5;
      c.stroke();
      c.fillStyle = '#e0bb55';
      c.beginPath();
      c.arc(128, 128, 26, 0, Math.PI * 2);
      c.fill();
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        c.beginPath();
        c.arc(128 + Math.cos(a) * 48, 128 + Math.sin(a) * 48, 9, 0, Math.PI * 2);
        c.fill();
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this.ownMat(key, { map: tex, roughness: 0.8, side: THREE.DoubleSide });
    }
    return this._own.get(key);
  }

  // ───────────────────────── 门 ─────────────────────────

  buildGate(data) {
    if (data.name === '午门') {
      const { group, colliders, walkables, ownedMaterials } = buildWumen(this.library, data);
      this.addObject(group);
      // buildWumen 在设置 group.position 之前计算碰撞盒，得到的是局部坐标，这里平移到世界坐标
      const p = data.position;
      const shift = new THREE.Vector3(p.x, p.y ?? 0, p.z);
      this.colliders.push(...colliders.map(b => b.clone().translate(shift)));
      this.walkables.push(...toWorld({ colliders: [], walkables: walkables ?? [] },
        new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z)).walkables);
      this.ownedMaterials.push(...(ownedMaterials ?? []));
      return;
    }
    if (data.name === '神武门') {
      this.cityGate(data);
      return;
    }
    // 宫门（太和门、乾清门）：台基 + 门殿（中柱一线设门，前后檐敞开）
    this.buildComplex([data], { name: data.name, apron: 3, margin: 3 });
  }

  /** 城台式门楼（神武门）：红墙城台 + 三个门洞 + 重檐城楼 */
  cityGate(data) {
    const g = this.begin(data);
    const { width: W, depth: D } = data.dimensions;
    const PH = 10;
    const tunnelH = 6.5;
    const openings = [{ x: -13, w: 5 }, { x: 0, w: 6.5 }, { x: 13, w: 5 }];
    let prev = -W / 2;
    const segs = [];
    for (const o of openings) {
      segs.push([prev, o.x - o.w / 2]);
      prev = o.x + o.w / 2;
    }
    segs.push([prev, W / 2]);
    for (const [a, b] of segs) {
      this.libBox(g, 'wall_red', b - a, PH, D, (a + b) / 2, PH / 2, 0, 'box');
      this.libBox(g, 'sumeru_band', b - a + 0.2, 1, D + 0.2, (a + b) / 2, 0.5, 0, 'band');
      this.col(a, 0, -D / 2, b, 3, D / 2);
    }
    for (const o of openings) {
      this.libBox(g, 'wall_red', o.w, PH - tunnelH, D, o.x, tunnelH + (PH - tunnelH) / 2, 0, 'box');
      this.libBox(g, 'wall_brick', o.w, 0.3, D - 0.2, o.x, tunnelH - 0.15, 0, 'box');
      for (const s of [-1, 1]) {
        const leaf = buildStuddedDoor(this.library, { width: o.w * 0.48, height: tunnelH - 0.5 });
        leaf.position.set(o.x + s * (o.w / 2 - 0.15), 0, -D / 2 + 2 + o.w * 0.24);
        leaf.rotation.y = Math.PI / 2;
        g.add(leaf);
      }
    }
    this.libBox(g, 'stone_slab', W + 0.4, 0.3, D + 0.4, 0, PH + 0.15, 0, 'box');
    // 登城马道：城台南面（宫内一侧）东西两端各一条；城台顶四周红色宇墙（带碰撞），马道处开口
    const top = PH + 0.3;
    const asc = toWorld(buildGateAscent(this.library, g, {
      W, D, topY: top, band: [-D / 2, -D / 2 + 5], edge: 'wall',
    }), new THREE.Matrix4().makeTranslation(this.ox, 0, this.oz));
    this.colliders.push(...asc.colliders);
    this.walkables.push(...asc.walkables);
    const body = buildHallBody(this.library, { width: W * 0.62, depth: D * 0.55, height: 7, bays: 5, facade: 'lattice' });
    body.position.y = top;
    g.add(body);
    // 城楼屋身碰撞（在城台顶面上），绕城楼一圈可走
    for (const b of body.userData.colliders ?? []) {
      this.col(b.min.x, b.min.y + top, b.min.z, b.max.x, b.max.y + top, b.max.z);
    }
    const roof = buildRoof(this.library, {
      type: 'wudian', width: W * 0.62 + 0.6, depth: D * 0.55 + 0.6,
      baseY: PH + 0.3 + body.userData.topY, layers: 2, brackets: true,
    });
    g.add(roof);
    this.ownedMaterials.push(...(roof.userData.ownedMaterials ?? []));
    const plaque = this.plaqueMesh('神武门', 1.6, 2.6, true);
    plaque.position.set(0, PH + 5.5, -D * 0.275 - 0.5);
    plaque.rotation.y = Math.PI;
    g.add(plaque);
    this.finish(g);
  }

  // ───────────────────────── 内金水河与五座金水桥 ─────────────────────────

  buildRiver(data) {
    const g = this.begin(data);
    const { width: W, depth: D } = data.dimensions;
    const waterY = -1.1;
    const bridges = [-0.3, -0.15, 0, 0.15, 0.3].map(f => f * W);
    const BW = 2.4;           // 桥面半宽（与 Collision.checkRiverCrossing 一致）
    const L = D + 2;          // 桥长（含两岸引桥，各伸出驳岸 1m）
    const crest = 0.9;        // 拱顶抬高

    // 河道：驳岸石墙 + 河床
    for (const s of [-1, 1]) {
      this.libBox(g, 'wall_brick', W, 2.4, 0.6, 0, -1.2, s * (D / 2 - 0.3), 'box');
      this.libBox(g, 'marble', W + 1.6, 0.12, 0.9, 0, 0.04, s * (D / 2 + 0.45), 'box');
      this.libBox(g, 'wall_brick', 0.6, 2.4, D, s * (W / 2 - 0.3), -1.2, 0, 'box');
    }
    this.libBox(g, 'stone_slab', W, 0.2, D, 0, -2.3, 0, 'box');

    // 岸边栏杆：在桥位留口
    for (const s of [-1, 1]) {
      const z = s * (D / 2 + 0.45);
      let a = -W / 2;
      for (const bx of bridges) {
        this.rail(g, a, z, bx - BW - 0.3, z, 0.1);
        a = bx + BW + 0.3;
      }
      this.rail(g, a, z, W / 2, z, 0.1);
    }
    for (const s of [-1, 1]) this.rail(g, s * (W / 2 + 0.5), -D / 2 - 0.45, s * (W / 2 + 0.5), D / 2 + 0.45, 0.1);

    // 金水桥：两段坡面（与行走 ramp 一致）+ 桥身 + 桥栏
    const hl = L / 2;
    const slope = Math.atan2(crest, hl);
    const sl = Math.hypot(hl, crest);
    const marble = this.library.material('marble');
    for (const bx of bridges) {
      for (const s of [-1, 1]) {
        const deck = this.box(g, marble, BW * 2, 0.4, sl, bx, crest / 2 - 0.2, s * hl / 2, { box: 2 });
        deck.rotation.x = s * slope;
        for (const sx of [-1, 1]) {
          const holder = new THREE.Group();
          holder.position.set(bx + sx * (BW - 0.1), crest / 2, s * hl / 2);
          holder.rotation.x = s * slope;
          const r = buildBalustrade(this.library, { length: sl, height: 0.95 });
          r.rotation.y = Math.PI / 2;
          holder.add(r);
          g.add(holder);
        }
        this.walkRampZ(bx - BW + 0.3, bx + BW - 0.3, s * hl, 0, 0, crest);
      }
      // 桥身（水中拱券墩，含暗色券洞）
      this.box(g, marble, BW * 2 - 0.2, 1.6, D - 1.4, bx, -0.6, 0, { box: 2 });
      const arch = new THREE.Mesh(new THREE.CircleGeometry(1.3, 20, 0, Math.PI),
        this.ownMat('archShadow', { color: 0x161412, roughness: 1, side: THREE.DoubleSide }));
      arch.position.set(bx, waterY + 0.05, 0);
      arch.rotation.y = Math.PI / 2;
      for (const sx of [-1, 1]) {
        const a = arch.clone();
        a.position.x = bx + sx * (BW - 0.05);
        g.add(a);
      }
      for (const sx of [-1, 1]) this.col(bx + sx * BW - 0.15, -0.5, -hl, bx + sx * BW + 0.15, crest + 1.4, hl);
    }
    this.finish(g);

    // 水面：单独网格，保持 materials.water（回归测试按材质识别水面）
    const water = new THREE.Mesh(new THREE.PlaneGeometry(W - 1.2, D - 1.2), this.materials.water);
    water.rotation.x = -Math.PI / 2;
    water.position.set(this.ox, waterY, this.oz);
    water.userData.isWater = true;
    water.receiveShadow = true;
    this.addObject(water);
  }

  getWalkables() {
    return [...this.walkables];
  }

  getColliders() {
    return [...this.colliders];
  }

  dispose() {
    const geos = new Set();
    const mats = new Set([this.materials.water, ...this.ownedMaterials].filter(Boolean));
    this.ownedObjects.forEach(obj => {
      obj.traverse(c => {
        if (c.geometry) geos.add(c.geometry);
        const list = c.material ? (Array.isArray(c.material) ? c.material : [c.material]) : [];
        list.forEach(m => { if (!this.library?.owns?.(m)) mats.add(m); });
      });
      obj.removeFromParent();
    });
    geos.forEach(g => g.dispose());
    mats.forEach(m => m.dispose());
    this.ownedObjects.clear();
    this.colliders.length = 0;
    this.walkables.length = 0;
    this.ownedMaterials.length = 0;
    this._own.clear();
    this.materials = {};
    this.textures = {};
  }
}
