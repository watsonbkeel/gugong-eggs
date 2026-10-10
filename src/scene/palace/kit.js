import * as THREE from 'three';
import { applyBoxUV, applyBandUV } from '../../utils/GeometryUV.js';
import { buildRoof, buildWallCap } from '../RoofBuilder.js';
import { buildStuddedDoor } from '../HallKit.js';
import { mergeByMaterial } from '../../utils/MergeUtils.js';
import { furnishRoom } from './interiors.js';

const STEP_RUN = 1.6; // 台阶水平长 / 高
const _v = new THREE.Vector3();

/**
 * 院落建筑构件库：宫墙、宫门（随墙门 / 门殿 / 城台门）、可进入的殿座、庑房、匾额。
 *
 * 坐标约定（与 PalaceBuilder 一致）：+Z 北，-X 东（玩家面向北时东在右手），y=0 为地面。
 * 每个构件在一个 frame（位置 + 绕 Y 旋转 0/±90°/180°）里按"正面朝局部 -Z"建模，
 * 碰撞体 / 可行走面直接换算为世界坐标登记；finish() 时整组按材质合并，绘制调用很少。
 *
 * 门扇统一做法（与神武门一致）：门打开后两扇门板贴在门洞两侧墙面上，不挡通道。
 */
export class CourtKit {
  constructor(lib, name = 'courts') {
    this.lib = lib;
    this.root = new THREE.Group();
    this.root.name = name;
    this.colliders = [];
    this.walkables = [];
    this.mapItems = [];
    this.regions = [];
    this.plaques = [];
    /** 可进入的房间（世界坐标），供小地图 / 位置显示 / 未来玩法（刷怪点、掩体、巷战区域）使用 */
    this.rooms = [];
    this.ridge = new THREE.MeshStandardMaterial({ color: 0xc98f2c, roughness: 0.36, metalness: 0.05, name: 'kit_ridge' });
    this.gold = new THREE.MeshStandardMaterial({ color: 0xe2b048, roughness: 0.28, metalness: 0.8, name: 'kit_gold' });
    this.lacquer = new THREE.MeshStandardMaterial({ color: 0x7a1d12, roughness: 0.4, metalness: 0.1, name: 'kit_lacquer' });
    this.floorMat = lib.material('stone_slab', { color: 0x55524e, roughness: 0.35 });
    this.owned = [this.ridge, this.gold, this.lacquer];
  }

  // ───────────────────────── 基础 ─────────────────────────

  /** 局部坐标系：原点 (x, 0, z)，绕 Y 旋转 rot（正面 -Z 旋转后朝向 (-sin rot, 0, -cos rot)） */
  frame(x, z, rot = 0) {
    const f = new THREE.Group();
    f.position.set(x, 0, z);
    f.rotation.y = rot;
    this.root.add(f);
    f.updateMatrixWorld(true);
    return f;
  }

  box(f, name, w, h, d, x, y, z, mode = 'box', params) {
    const t = this.lib.tileSize(name);
    let geo = new THREE.BoxGeometry(w, h, d);
    if (mode === 'band') geo = applyBandUV(geo, t);
    else if (mode === 'box') geo = applyBoxUV(geo, t);
    const m = new THREE.Mesh(geo, this.lib.material(name, params));
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    f.add(m);
    return m;
  }

  mesh(f, geo, mat, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    f.add(m);
    return m;
  }

  col(f, x0, y0, z0, x1, y1, z1) {
    const b = new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
    );
    this.colliders.push(b.applyMatrix4(f.matrixWorld));
  }

  walkBox(f, x0, z0, x1, z1, y) {
    const b = new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1), y, Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), y, Math.max(z0, z1)),
    ).applyMatrix4(f.matrixWorld);
    this.walkables.push({ type: 'box', box: b });
  }

  /** 局部沿 Z 的坡道（zFrom 处高 yFrom → zTo 处高 yTo），旋转后自动换算为世界轴向 */
  walkRamp(f, x0, x1, zFrom, zTo, yFrom, yTo) {
    const p = (x, z) => new THREE.Vector3(x, 0, z).applyMatrix4(f.matrixWorld);
    const a = p(x0, zFrom), b = p(x1, zTo);
    const s = p((x0 + x1) / 2, zFrom), e = p((x0 + x1) / 2, zTo);
    const alongZ = Math.abs(e.z - s.z) >= Math.abs(e.x - s.x);
    this.walkables.push({
      type: 'ramp',
      minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
      axis: alongZ ? 'z' : 'x',
      a0: alongZ ? s.z : s.x, a1: alongZ ? e.z : e.x,
      y0: yFrom, y1: yTo,
    });
  }

  /** 屋顶 / 墙帽等自带材质的构件：把屋脊、宝顶材质换成共享材质，合并后只占两个绘制调用 */
  adopt(obj) {
    obj.traverse(m => {
      if (!m.isMesh) return;
      if (m.material.name === 'roof_ridge_glaze') m.material = this.ridge;
      else if (m.material.name === 'roof_finial_gold') m.material = this.gold;
    });
    (obj.userData.ownedMaterials ?? []).forEach(m => m.dispose());
    obj.userData.ownedMaterials = [];
    return obj;
  }

  roof(f, opts, x = 0, z = 0) {
    const r = this.adopt(buildRoof(this.lib, { detail: 'low', ...opts }));
    r.position.set(x, 0, z);
    f.add(r);
    return r;
  }

  /** 世界坐标轴对齐矩形，供小地图与"当前位置"使用 */
  mapRect(f, kind, name, w, d, extra = {}) {
    const c = new THREE.Vector3().applyMatrix4(f.matrixWorld);
    const q = Math.abs(Math.sin(f.rotation.y)) > 0.5;
    this.mapItems.push({ kind, name, x: c.x, z: c.z, w: q ? d : w, d: q ? w : d, ...extra });
  }

  // ───────────────────────── 室内 ─────────────────────────

  interiorMaterials() {
    if (!this._interiorMats) {
      const mk = (name, color, roughness = 0.6) => {
        const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05, name });
        this.owned.push(m);
        return m;
      };
      this._interiorMats = {
        wood: mk('kit_furn_wood', 0x5a2f1c, 0.55),
        crate: mk('kit_furn_crate', 0x7a5634, 0.85),
        cloth: mk('kit_furn_cloth', 0xb98a2e, 0.9),
        lacquer: this.lacquer,
        gold: this.gold,
      };
    }
    return this._interiorMats;
  }

  furnish(f, kind, room) {
    const seed = Math.round(Math.abs(f.position.x * 131 + f.position.z * 17 + room.x0 * 7));
    const res = furnishRoom(this, f, kind, room, seed);
    this._lastFurnish = res;
    return res;
  }

  /** 登记一个房间：局部矩形 → 世界 AABB，门 / 掩体 / 刷怪点 → 世界坐标 */
  registerRoom(f, { name, kind, x0, x1, z0, z1, y, h, doors }) {
    const toW = (x, z) => new THREE.Vector3(x, 0, z).applyMatrix4(f.matrixWorld);
    const a = toW(x0, z0), b = toW(x1, z1);
    const pt = p => { const v = toW(p.x, p.z); return { x: +v.x.toFixed(2), z: +v.z.toFixed(2) }; };
    const extra = kind === 'throne' ? { cover: [], spawns: [] } : (this._lastFurnish ?? { cover: [], spawns: [] });
    this._lastFurnish = null;
    if (name) this.region(name, a.x, b.x, a.z, b.z);
    this.rooms.push({
      id: this.rooms.length,
      name, kind,
      min: { x: Math.min(a.x, b.x), y, z: Math.min(a.z, b.z) },
      max: { x: Math.max(a.x, b.x), y: y + h, z: Math.max(a.z, b.z) },
      floorY: y,
      doors: doors.map(pt),
      cover: extra.cover.map(pt),
      spawns: (extra.spawns.length ? extra.spawns : [{ x: (x0 + x1) / 2, z: (z0 + z1) / 2 }]).map(pt),
    });
  }

  region(name, x0, x1, z0, z1) {
    this.regions.push({ name, minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) });
  }

  // ───────────────────────── 宫墙 ─────────────────────────

  /**
   * 轴对齐红墙（灰砖下碱 + 黄琉璃墙帽）。gaps: [{ at, w }]，at 为沿墙方向的世界坐标。
   */
  wall(x1, z1, x2, z2, { h = 6.5, t = 1, gaps = [] } = {}) {
    const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1);
    const a0 = alongX ? Math.min(x1, x2) : Math.min(z1, z2);
    const a1 = alongX ? Math.max(x1, x2) : Math.max(z1, z2);
    const c = alongX ? z1 : x1;
    const cuts = gaps.map(g => [g.at - g.w / 2, g.at + g.w / 2]).sort((p, q) => p[0] - q[0]);
    let s = a0;
    const segs = [];
    for (const [g0, g1] of cuts) {
      if (g0 > s + 0.05) segs.push([s, Math.min(g0, a1)]);
      s = Math.max(s, g1);
    }
    if (a1 > s + 0.05) segs.push([s, a1]);
    for (const [p0, p1] of segs) {
      const len = p1 - p0;
      const mid = (p0 + p1) / 2;
      const f = alongX ? this.frame(mid, c, 0) : this.frame(c, mid, Math.PI / 2);
      this.box(f, 'wall_brick', len, 1.0, t + 0.12, 0, 0.5, 0);
      this.box(f, 'wall_red', len, h - 1.0, t, 0, 1.0 + (h - 1) / 2, 0);
      const cap = this.adopt(buildWallCap(this.lib, { length: len, thickness: t }));
      cap.position.y = h;
      f.add(cap);
      this.col(f, -len / 2, 0, -t / 2, len / 2, 3, t / 2);
    }
  }

  /** 矩形院墙，gates: [{ side: 's'|'n'|'xmin'|'xmax', at, w }]（at 为沿墙世界坐标，w 为墙上开口宽） */
  courtWalls(x0, x1, z0, z1, gates = [], opts = {}) {
    const by = side => gates.filter(g => g.side === side).map(g => ({ at: g.at, w: g.w }));
    this.wall(x0, z0, x1, z0, { ...opts, gaps: by('s') });
    this.wall(x0, z1, x1, z1, { ...opts, gaps: by('n') });
    this.wall(x0, z0, x0, z1, { ...opts, gaps: by('xmin') });
    this.wall(x1, z0, x1, z1, { ...opts, gaps: by('xmax') });
  }

  // ───────────────────────── 门 ─────────────────────────

  /**
   * 打开的门扇：两扇门板贴在门洞两侧墙面上（铰链在 zHinge，门板向 +Z 方向展开）。
   * @param jamb 门洞半宽（门板外侧贴住的墙面位置）
   */
  doors(f, { jamb, height, zHinge, leaf }) {
    for (const s of [-1, 1]) {
      const d = buildStuddedDoor(this.lib, { width: leaf, height });
      d.position.set(s * (jamb - 0.14), 0, zHinge + leaf / 2);
      d.rotation.y = Math.PI / 2;
      f.add(d);
    }
  }

  /**
   * 宫门。原点 = 门道中心，通行方向沿局部 Z，正面朝局部 -Z。返回墙上需要留出的开口宽度。
   * - style 'wall'：随墙门（两侧门垛 + 门罩），开口宽 = w + 2.8
   * - style 'hall'：门殿（三间，明间为门道，门扇在中柱一线、打开后贴两侧隔墙），开口宽 = 门殿面阔
   */
  gate({ x, z, rot = 0, w = 3.6, h = 4.4, t = 1, style = 'wall', name, roof = 'xieshan', brackets = true, layers = 1 }) {
    const f = this.frame(x, z, rot);
    if (style === 'hall') return this.gateHall(f, { w, h, name, roof, brackets, layers });
    const pw = 1.4;
    const gd = Math.max(t + 1.4, w / 2 + 1.0);
    const H = h + 1.5;
    for (const s of [-1, 1]) {
      const px = s * (w / 2 + pw / 2);
      this.box(f, 'wall_brick', pw + 0.1, 1.0, gd + 0.1, px, 0.5, 0);
      this.box(f, 'wall_red', pw, H - 1, gd, px, 1 + (H - 1) / 2, 0);
      this.col(f, px - pw / 2, 0, -gd / 2, px + pw / 2, 3, gd / 2);
    }
    this.box(f, 'wall_red', w, H - h, gd, 0, h + (H - h) / 2, 0);
    this.box(f, 'wall_brick', w, 0.1, gd - 0.02, 0, h - 0.05, 0);
    this.box(f, 'stone_slab', w + 2 * pw + 0.2, 0.1, gd + 0.5, 0, 0.05, 0);
    this.doors(f, { jamb: w / 2, height: h - 0.1, zHinge: -gd / 2 + 0.3, leaf: w / 2 - 0.05 });
    this.roof(f, { type: roof, width: w + 2 * pw + 0.3, depth: gd + 0.5, baseY: H, brackets: false, height: 1.3 });
    if (name) this.plaque(f, name, 0, h + (H - h) / 2, -gd / 2 - 0.06, 0.72, 1.2);
    this.mapRect(f, 'gate', name, w + 2 * pw, gd);
    return w + 2 * pw;
  }

  gateHall(f, { w, h, name, roof, brackets, layers }) {
    const bw = w + 1.6;               // 明间（门道）面阔
    const sw = 3.6;                   // 次间面阔
    const W = bw + 2 * sw;
    const D = 6.4;
    const ph = 0.45;
    const colH = h + 1.8;
    const r = 0.26;
    this.box(f, 'sumeru_band', W + 1.6, ph, D + 1.6, 0, ph / 2, 0, 'band');
    this.box(f, 'stone_slab', W + 1.7, 0.08, D + 1.7, 0, ph - 0.03, 0);
    this.walkBox(f, -(W + 1.6) / 2, -(D + 1.6) / 2, (W + 1.6) / 2, (D + 1.6) / 2, ph);
    const colGeo = new THREE.CylinderGeometry(r, r * 1.05, colH, 12);
    const colMat = this.lib.material('wood_column');
    const xs = [-W / 2, -bw / 2, bw / 2, W / 2];
    for (const cx of xs) for (const cz of [-D / 2, 0, D / 2]) {
      this.mesh(f, cx === xs[0] || cx === xs[3] || cz !== 0 ? colGeo : colGeo, colMat, cx, ph + colH / 2, cz);
      this.col(f, cx - r, ph, cz - r, cx + r, ph + 3, cz + r);
    }
    // 中柱一线：次间砌墙；两山墙；明间后半两侧隔墙（门扇打开后贴在隔墙上）
    for (const s of [-1, 1]) {
      const xc = s * (bw / 2 + sw / 2);
      this.box(f, 'wall_red', sw, colH, 0.6, xc, ph + colH / 2, 0);
      this.box(f, 'wall_brick', sw + 0.05, 1.0, 0.7, xc, ph + 0.5, 0);
      this.col(f, xc - sw / 2, ph, -0.3, xc + sw / 2, ph + 3, 0.3);
      this.box(f, 'wall_red', 0.7, colH, D, s * W / 2, ph + colH / 2, 0);
      this.col(f, s * W / 2 - 0.35, ph, -D / 2, s * W / 2 + 0.35, ph + 3, D / 2);
      this.box(f, 'wall_red', 0.35, h + 0.2, D / 2 - 0.3, s * (bw / 2 - 0.1), ph + (h + 0.2) / 2, D / 4 + 0.15);
      this.col(f, s * (bw / 2 - 0.28), ph, 0, s * (bw / 2 + 0.1), ph + 3, D / 2 - 0.1);
    }
    // 门楣、门槛、门扇
    this.box(f, 'wall_red', bw, colH - h, 0.6, 0, ph + h + (colH - h) / 2, 0);
    this.box(f, 'wood_column', bw, 0.2, 0.4, 0, ph + 0.1, 0);
    this.doors(f, { jamb: bw / 2 - 0.28, height: h, zHinge: 0.3, leaf: Math.min(bw / 2 - 0.35, D / 2 - 0.6) });
    // 额枋彩画
    for (const s of [-1, 1]) {
      this.box(f, 'caihua_beam', W + 0.5, 0.6, 0.4, 0, ph + colH - 0.3, s * D / 2, 'band');
      this.box(f, 'caihua_beam', 0.4, 0.6, D, s * W / 2, ph + colH - 0.3, 0, 'band');
    }
    this.roof(f, { type: roof, width: W + 0.5, depth: D + 0.5, baseY: ph + colH, layers, brackets });
    if (name) this.plaque(f, name, 0, ph + h + (colH - h) / 2, -0.34, 0.8, Math.min(1.5, colH - h - 0.1));
    this.mapRect(f, 'gate', name, W, D);
    return W;
  }

  /**
   * 城台门（东华门 / 西华门 等）：红色城台 + 单门洞 + 重檐城楼；门扇与神武门一致贴门洞内壁。
   * 原点 = 门洞中心，通行方向沿局部 Z。
   */
  cityGate({ x, z, rot = 0, W = 30, D = 14, PH = 9, w = 5.5, h = 6.5, name }) {
    const f = this.frame(x, z, rot);
    for (const s of [-1, 1]) {
      const len = W / 2 - w / 2;
      const xc = s * (w / 2 + len / 2);
      this.box(f, 'wall_red', len, PH, D, xc, PH / 2, 0);
      this.box(f, 'sumeru_band', len + 0.2, 1, D + 0.2, xc, 0.5, 0, 'band');
      this.col(f, xc - len / 2, 0, -D / 2, xc + len / 2, 3, D / 2);
    }
    this.box(f, 'wall_red', w, PH - h, D, 0, h + (PH - h) / 2, 0);
    this.box(f, 'wall_brick', w, 0.3, D - 0.2, 0, h - 0.15, 0);
    this.doors(f, { jamb: w / 2, height: h - 0.5, zHinge: -D / 2 + 2, leaf: w * 0.48 });
    this.box(f, 'stone_slab', W + 0.4, 0.3, D + 0.4, 0, PH + 0.15, 0);
    const bw = W * 0.6, bd = D * 0.55, bh = 6;
    this.box(f, 'wall_red', bw - 1, bh, bd - 1, 0, PH + 0.3 + bh / 2, 0);
    this.box(f, 'lattice_doors', bw - 0.9, bh * 0.85, bd - 0.9, 0, PH + 0.3 + bh * 0.425, 0, 'band');
    this.box(f, 'caihua_beam', bw + 0.3, 0.7, bd + 0.3, 0, PH + 0.3 + bh - 0.35, 0, 'band');
    this.roof(f, { type: 'xieshan', width: bw + 0.6, depth: bd + 0.6, baseY: PH + 0.3 + bh, layers: 2, brackets: true });
    if (name) this.plaque(f, name, 0, PH + 3.6, -bd / 2 - 0.55, 1.3, 2.2);
    this.mapRect(f, 'gate', name, W, D);
  }

  // ───────────────────────── 殿座 ─────────────────────────

  steps(f, { zEdge, dir, y, width }) {
    const run = y * STEP_RUN;
    const n = Math.max(2, Math.round(y / 0.16));
    const sr = run / n;
    const marble = this.lib.material('marble');
    const tile = this.lib.tileSize('marble');
    for (let k = 0; k < n; k++) {
      const top = y - (k + 1) * y / (n + 1);
      this.mesh(f, applyBoxUV(new THREE.BoxGeometry(width, top, sr), tile), marble, 0, top / 2, zEdge + dir * (k + 0.5) * sr);
    }
    // 垂带（两侧斜石）
    const L = Math.hypot(run, y);
    for (const sx of [-1, 1]) {
      const m = this.mesh(f, applyBoxUV(new THREE.BoxGeometry(0.4, 0.3, L), tile), marble, sx * (width / 2 + 0.2), y / 2 + 0.05, zEdge + dir * run / 2);
      m.rotation.x = dir * Math.atan2(y, run);
    }
    this.walkRampZ(f, -width / 2, width / 2, zEdge, zEdge + dir * run, y, 0);
  }

  walkRampZ(f, x0, x1, zFrom, zTo, yFrom, yTo) {
    this.walkRamp(f, x0, x1, zFrom, zTo, yFrom, yTo);
  }

  /**
   * 殿座：台明（可走）+ 台阶 + 柱网 + 山墙/后檐墙 + 前檐隔扇（enter 时明间敞开、隔扇折向两侧可进入）
   * + 殿内金砖地面/宝座 + 屋顶 + 匾额。原点为殿身中心，正面朝局部 -Z。
   *
   * open：只有柱子的敞厅（箭亭、亭榭）；closed（enter=false）时整座殿身为实体碰撞。
   */
  hall(o) {
    const {
      x, z, rot = 0, w, d, colH = 4.6, ph = 0.9, pad = 1.0,
      roof = 'xieshan', layers = 1, brackets = true, roofH,
      enter: enterOpt, backDoor = false, open = false, throne = false,
      name, plaque = true, map = 'hall', bays,
      interior, roomBays = 0,
    } = o;
    // 默认所有殿座都可进入（open 敞厅本来就能穿行）
    const enter = !open && enterOpt !== false;
    const f = this.frame(x, z, rot);
    const n = bays ?? Math.max(3, Math.round(w / 3.6) | 1);
    const bay = w / n;
    // 房间划分：roomBays>0 时每 roomBays 间隔成一个房间（不足 2 间的尾巴并入上一间），每间房正中一扇门
    const segs = [];
    if (enter && roomBays > 0 && n > roomBays + 1) {
      for (let a = 0; a < n; a += roomBays) segs.push([a, Math.min(n, a + roomBays)]);
      const last = segs[segs.length - 1];
      if (last[1] - last[0] < 2 && segs.length > 1) { segs.pop(); segs[segs.length - 1][1] = n; }
    } else {
      segs.push([0, n]);
    }
    const doorBays = new Set(segs.map(([a, b]) => Math.floor((a + b - 1) / 2)));
    const PW = w + 2 * pad;
    const PD = d + 2 * pad;
    const y0 = ph;
    const big = ph >= 0.8;

    // 台明
    this.box(f, big ? 'sumeru_band' : 'wall_brick', PW, ph, PD, 0, ph / 2, 0, big ? 'band' : 'box');
    this.box(f, 'stone_slab', PW + 0.12, 0.08, PD + 0.12, 0, ph - 0.03, 0);
    this.walkBox(f, -PW / 2, -PD / 2, PW / 2, PD / 2, ph);
    // 低于可迈高度（0.55m）的台明直接跨上去，不做实体（否则玩家半径会被台沿挡住）
    if (ph > 0.55) this.col(f, -PW / 2 + 0.05, 0, -PD / 2 + 0.05, PW / 2 - 0.05, Math.min(ph, 3), PD / 2 - 0.05);
    if (ph > 0.55) {
      const sw = Math.min(Math.max(bay * 1.05, 2.4), 4.6);
      const dirs = open ? [-1, 1] : backDoor ? [-1, 1] : [-1];
      for (const s of dirs) this.steps(f, { zEdge: s * PD / 2, dir: s, y: ph, width: sw });
    }

    const r = THREE.MathUtils.clamp(bay * 0.07, 0.2, 0.34);
    const colGeo = new THREE.CylinderGeometry(r, r * 1.05, colH, 12);
    const colMat = this.lib.material('wood_column');
    const beamH = THREE.MathUtils.clamp(colH * 0.12, 0.45, 0.85);
    const doorH = (colH - beamH) * 0.8;

    for (let i = 0; i <= n; i++) {
      const cx = -w / 2 + i * bay;
      for (const cz of [-d / 2, d / 2]) {
        this.mesh(f, colGeo, colMat, cx, y0 + colH / 2, cz);
        if (open || enter) this.col(f, cx - r, y0, cz - r, cx + r, y0 + 3, cz + r);
      }
    }
    // 额枋彩画（一圈）
    for (const s of [-1, 1]) {
      this.box(f, 'caihua_beam', w + 0.5, beamH, 0.45, 0, y0 + colH - beamH / 2, s * d / 2, 'band');
      this.box(f, 'caihua_beam', 0.45, beamH, d + 0.5, s * w / 2, y0 + colH - beamH / 2, 0, 'band');
    }

    if (!open) {
      // 两山墙
      for (const s of [-1, 1]) {
        this.box(f, 'wall_red', 0.7, colH - beamH, d, s * w / 2, y0 + (colH - beamH) / 2, 0);
        if (enter) this.col(f, s * w / 2 - 0.35, y0, -d / 2, s * w / 2 + 0.35, y0 + 3, d / 2);
      }
      // 前后檐
      for (const side of [-1, 1]) {
        const zf = side * d / 2;
        const openFace = enter && (side < 0 || backDoor);
        if (side > 0 && !openFace) {
          this.box(f, 'wall_red', w, colH - beamH, 0.6, 0, y0 + (colH - beamH) / 2, zf);
          if (enter) this.col(f, -w / 2, y0, zf - 0.3, w / 2, y0 + 3, zf + 0.3);
          continue;
        }
        for (let i = 0; i < n; i++) {
          const xc = -w / 2 + (i + 0.5) * bay;
          if (openFace && doorBays.has(i)) {
            // 敞开的明间：两扇隔扇门折向两侧，贴在柱边
            for (const s of [-1, 1]) {
              const leaf = this.box(f, 'lattice_doors', bay * 0.26, doorH, 0.1, xc + s * (bay / 2 - r - 0.08), y0 + doorH / 2, zf - side * (bay * 0.13 + 0.2), 'band');
              leaf.rotation.y = Math.PI / 2;
            }
            continue;
          }
          this.box(f, 'lattice_doors', bay - 2 * r, doorH, 0.14, xc, y0 + doorH / 2, zf, 'band');
          if (enter) this.col(f, xc - bay / 2, y0, zf - 0.25, xc + bay / 2, y0 + 3, zf + 0.25);
        }
        this.box(f, 'wall_red', w, colH - beamH - doorH, 0.3, 0, y0 + doorH + (colH - beamH - doorH) / 2, zf);
        if (openFace) {
          for (const i of doorBays) this.box(f, 'wood_column', bay - 2 * r, 0.22, 0.3, -w / 2 + (i + 0.5) * bay, y0 + 0.11, zf);
        }
      }
      // 房间隔墙（贯通进深，到额枋下）
      if (enter) {
        for (let k = 1; k < segs.length; k++) {
          const xb = -w / 2 + segs[k][0] * bay;
          this.box(f, 'wall_red', 0.3, colH - beamH, d - 0.2, xb, y0 + (colH - beamH) / 2, 0);
          this.col(f, xb - 0.15, y0, -d / 2, xb + 0.15, y0 + 3, d / 2);
        }
      }
      if (!enter) this.col(f, -w / 2 - 0.3, y0, -d / 2 - 0.3, w / 2 + 0.3, y0 + 3, d / 2 + 0.3);
    }

    if (enter || open) {
      const fg = new THREE.PlaneGeometry(w, d);
      fg.rotateX(-Math.PI / 2);
      this.mesh(f, fg, this.floorMat, 0, y0 + 0.02, 0).castShadow = false;
    }
    if (enter && !open) {
      const cg = new THREE.PlaneGeometry(w, d);
      cg.rotateX(Math.PI / 2);
      this.mesh(f, cg, this.lib.material('caihua_beam'), 0, y0 + colH - beamH - 0.02, 0).castShadow = false;
    }
    if (throne && enter) {
      // 有后门时宝座前移，宝座与后檐之间留出 ≥1.6m 的穿行通道
      const tz = d / 2 - (backDoor ? Math.min(3.4, d * 0.36) : Math.min(2.6, d * 0.3));
      const tw = Math.min(bay * 1.4, 5);
      this.mesh(f, new THREE.BoxGeometry(tw, 0.5, 2.4), this.lacquer, 0, y0 + 0.25, tz);
      this.mesh(f, new THREE.BoxGeometry(1.4, 0.6, 1.0), this.gold, 0, y0 + 0.8, tz);
      this.mesh(f, new THREE.BoxGeometry(1.5, 1.2, 0.2), this.gold, 0, y0 + 1.6, tz + 0.5);
      this.mesh(f, new THREE.BoxGeometry(tw * 0.8, 2.6, 0.25), this.gold, 0, y0 + 1.8, tz + 1.15);
      this.col(f, -tw / 2, y0, tz - 1.2, tw / 2, y0 + 3, tz + 1.3);
    }

    // 室内陈设 + 房间登记（宝座殿以外的每个房间）
    if (enter) {
      const kind = interior ?? (throne ? 'throne' : map === 'corridor' ? 'room' : w >= 14 ? 'hall' : 'room');
      segs.forEach(([a, b], idx) => {
        const x0 = -w / 2 + a * bay + (a > 0 ? 0.15 : 0.35);
        const x1 = -w / 2 + b * bay - (b < n ? 0.15 : 0.35);
        const doorX = -w / 2 + (Math.floor((a + b - 1) / 2) + 0.5) * bay;
        const roomKind = kind === 'room' && segs.length > 2 && idx % 3 === 2 ? 'storage' : kind;
        if (roomKind !== 'throne') this.furnish(f, roomKind, { x0, x1, z0: -d / 2 + 0.3, z1: d / 2 - 0.3, y: y0, doorX, h: colH - beamH, backDoor });
        this.registerRoom(f, {
          name: name ? (segs.length > 1 && map !== 'corridor' ? `${name}·${idx + 1}` : name) : null,
          kind: roomKind, x0, x1, z0: -d / 2, z1: d / 2, y: y0, h: colH - beamH,
          doors: [{ x: doorX, z: -d / 2 }, ...(backDoor ? [{ x: doorX, z: d / 2 }] : [])],
        });
      });
    }

    this.roof(f, {
      type: roof, width: w + 0.5, depth: d + 0.5, baseY: y0 + colH, layers, brackets,
      ...(roofH ? { height: roofH } : {}),
    });
    if (name && plaque) {
      const ph2 = THREE.MathUtils.clamp(colH * 0.3, 1.1, 2.2);
      this.plaque(f, name, 0, open ? y0 + colH - beamH - ph2 / 2 : y0 + doorH + (colH - beamH - doorH) / 2 + 0.1, -d / 2 - 0.3, ph2 * 0.6, ph2);
    }
    if (map) this.mapRect(f, map, name, PW, PD);
    return { f, PW, PD, top: y0 };
  }

  /** 庑房（廊房）：沿 x1→x2 或 z1→z2 的长条，正面朝 facing（'x+'|'x-'|'z+'|'z-'），每 3 间隔成一个可进入的房间 */
  corridor(x1, z1, x2, z2, facing, { depth = 4.2, colH = 3.6, name } = {}) {
    const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1);
    const len = alongX ? Math.abs(x2 - x1) : Math.abs(z2 - z1);
    if (len < 4) return;
    const rot = { 'z-': 0, 'z+': Math.PI, 'x+': -Math.PI / 2, 'x-': Math.PI / 2 }[facing];
    this.hall({
      x: (x1 + x2) / 2, z: (z1 + z2) / 2, rot, w: len - 1.0, d: depth, pad: 0.5, ph: 0.45, colH,
      roof: 'gable', brackets: false, enter: true, roomBays: 3, interior: 'room', plaque: false, name: name ?? '庑房',
      map: 'corridor', bays: Math.max(3, Math.round(len / 3.4) | 1),
    });
  }

  // ───────────────────────── 匾额（合并为一张图集） ─────────────────────────

  plaque(f, text, x, y, z, w, h) {
    const frame = this.mesh(f, new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.1), this.gold, x, y, z + 0.06);
    frame.castShadow = false;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateY(Math.PI);
    const m = this.mesh(f, geo, null, x, y, z);
    m.castShadow = false;
    this.plaques.push({ mesh: m, text });
  }

  buildPlaqueAtlas() {
    if (!this.plaques.length) return;
    const texts = [...new Set(this.plaques.map(p => p.text))];
    const CW = 96, CH = 256, cols = 21;
    const rows = Math.ceil(texts.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = THREE.MathUtils.ceilPowerOfTwo(Math.max(rows * CH, 256));
    const c = canvas.getContext('2d');
    const font = '"STKaiti","KaiTi","Kaiti SC","Songti SC","SimSun",serif';
    const cell = new Map();
    texts.forEach((t, i) => {
      const cx = (i % cols) * CW, cy = Math.floor(i / cols) * CH;
      c.fillStyle = '#c8a23c'; c.fillRect(cx, cy, CW, CH);
      c.fillStyle = '#1e3a6b'; c.fillRect(cx + 8, cy + 8, CW - 16, CH - 16);
      c.strokeStyle = '#e8c55a'; c.lineWidth = 3; c.strokeRect(cx + 13, cy + 13, CW - 26, CH - 26);
      c.fillStyle = '#ecc95c';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const chars = [...t];
      const step = (CH - 44) / chars.length;
      c.font = `bold ${Math.floor(Math.min(step * 0.86, CW * 0.62))}px ${font}`;
      chars.forEach((ch, k) => c.fillText(ch, cx + CW / 2, cy + 22 + step * (k + 0.5)));
      cell.set(t, [cx / canvas.width, 1 - (cy + CH) / canvas.height, CW / canvas.width, CH / canvas.height]);
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.15, name: 'kit_plaques' });
    this.owned.push(mat);
    this.ownedTextures = [tex];
    for (const { mesh, text } of this.plaques) {
      const [u0, v0, du, dv] = cell.get(text);
      const uv = mesh.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * du, v0 + uv.getY(i) * dv);
      mesh.material = mat;
    }
  }

  /** 合并几何并返回可加入场景的 Group */
  finish() {
    this.buildPlaqueAtlas();
    const merged = mergeByMaterial(this.root, { name: this.root.name });
    merged.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
    return merged;
  }

  dispose(group) {
    group?.traverse(o => o.geometry?.dispose());
    this.owned.forEach(m => m.dispose());
    this.ownedTextures?.forEach(t => t.dispose());
    this.colliders.length = 0;
    this.walkables.length = 0;
  }
}

/** 朝向：正面（局部 -Z）朝向给定世界方向时的 rot */
export const FACE = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 }; // 本场景东 = -X
void _v;
