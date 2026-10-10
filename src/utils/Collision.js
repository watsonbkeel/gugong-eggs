import * as THREE from 'three';
import { LAYOUT, PLAYER } from '../config/constants.js';
import { PALACE_LAYOUT } from '../scene/Layout.js';

/** 玩家碰撞盒底部离脚面的抬升量：低于此高度的台阶/门槛直接跨过，不当成墙。 */
const STEP_CLEARANCE = 0.35;

/** 实体碰撞代理与河道通行检查；不把整个建筑的空区当成实心。 */
export class CollisionManager {
  constructor() {
    this.colliders = [];
    /**
     * 可行走面（台基顶面、楼梯斜坡、桥面）。
     * - { type: 'box', box: Box3 }：顶面高度 = box.max.y，XZ 范围取 box。
     * - { type: 'ramp', minX, maxX, minZ, maxZ, axis: 'x'|'z', a0, a1, y0, y1 }：
     *   沿 axis 从坐标 a0（高度 y0）到 a1（高度 y1）线性过渡。
     */
    this.walkables = [];
    this.playerBox = new THREE.Box3();
    this.playerSize = new THREE.Vector3();
    this.playerCenter = new THREE.Vector3();
    this.rivers = PALACE_LAYOUT.filter(item => item.type === 'river');
  }

  addCollider(object) {
    const box = object.isBox3 ? object.clone() : new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) this.colliders.push({ mesh: object, box });
  }

  addColliders(objects) {
    objects.forEach(object => this.addCollider(object));
  }

  addWalkable(walkable) {
    if (!walkable) return;
    if (walkable.type === 'box') {
      const box = walkable.box.isBox3 ? walkable.box.clone() : new THREE.Box3().setFromObject(walkable.box);
      // rescue: false —— 不做"钻进台基托回台面"（城台顶面下方有门洞，从门洞穿过时不能被托上城台）
      if (!box.isEmpty()) this.walkables.push({ type: 'box', box, rescue: walkable.rescue !== false });
      return;
    }
    if (walkable.type === 'ramp') {
      const r = walkable;
      this.walkables.push({
        type: 'ramp',
        minX: Math.min(r.minX, r.maxX), maxX: Math.max(r.minX, r.maxX),
        minZ: Math.min(r.minZ, r.maxZ), maxZ: Math.max(r.minZ, r.maxZ),
        axis: r.axis === 'x' ? 'x' : 'z', a0: r.a0, a1: r.a1, y0: r.y0, y1: r.y1,
      });
    }
  }

  addWalkables(list) {
    (list ?? []).forEach(item => this.addWalkable(item));
  }

  /**
   * 脚点 (x, z) 处的地面高度：取所有覆盖该点、且顶面不高于 feetY + stepUp 的可行走面中最高者；
   * 没有任何可行走面时为地面 0。
   */
  getGroundHeight(x, z, feetY = 0, stepUp = 0.6) {
    let ground = 0;
    let rescue = 0;
    const limit = feetY + stepUp;
    const m = 0.6; // 台基实体内缩量：玩家半径 + 余量
    for (const w of this.walkables) {
      let top;
      if (w.type === 'box') {
        const b = w.box;
        if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
        top = b.max.y;
        // 台基是实心的：脚点已深入台基投影内部却低于台面，说明从台阶口"钻"进了台基，直接托回台面，
        // 杜绝"走到楼梯顶掉到宫殿底下"。
        if (w.rescue && top > limit && x > b.min.x + m && x < b.max.x - m && z > b.min.z + m && z < b.max.z - m) {
          rescue = Math.max(rescue, top);
        }
      } else {
        if (x < w.minX || x > w.maxX || z < w.minZ || z > w.maxZ) continue;
        const a = w.axis === 'x' ? x : z;
        const t = w.a1 === w.a0 ? 1 : Math.min(1, Math.max(0, (a - w.a0) / (w.a1 - w.a0)));
        top = w.y0 + (w.y1 - w.y0) * t;
      }
      if (top > limit || top <= ground) continue;
      ground = top;
    }
    return Math.max(ground, rescue);
  }

  checkCollision(position, radius = 0.5) {
    if (!this.checkBoundary(position, radius) || !this.checkRiverCrossing(position, radius)) return true;
    // 视点是头部（脚面 + PLAYER.HEIGHT）；碰撞体从脚面上方 STEP_CLEARANCE 到头顶，矮台阶可直接跨过。
    const feetY = position.y - PLAYER.HEIGHT;
    const bottom = feetY + STEP_CLEARANCE;
    const top = position.y - 0.05;
    this.playerSize.set(radius * 2, top - bottom, radius * 2);
    this.playerCenter.set(position.x, (top + bottom) / 2, position.z);
    this.playerBox.setFromCenterAndSize(this.playerCenter, this.playerSize);
    return this.queryBox(this.playerBox).some(collider => this.playerBox.intersectsBox(collider.box));
  }

  /**
   * 空间网格（XZ 平面，CELL 米一格）：碰撞体多了以后只检查附近格子里的，射线/子弹检测也可复用。
   * 碰撞体增删后自动失效重建。
   */
  _buildGrid() {
    const CELL = 8;
    const grid = new Map();
    for (const c of this.colliders) {
      const b = c.box;
      const i0 = Math.floor(b.min.x / CELL), i1 = Math.floor(b.max.x / CELL);
      const k0 = Math.floor(b.min.z / CELL), k1 = Math.floor(b.max.z / CELL);
      for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
        const key = i * 100003 + k;
        let list = grid.get(key);
        if (!list) grid.set(key, list = []);
        list.push(c);
      }
    }
    this._grid = { CELL, grid, count: this.colliders.length };
  }

  /** 返回与 box 的 XZ 投影可能相交的碰撞体（去重） */
  queryBox(box) {
    if (!this._grid || this._grid.count !== this.colliders.length) this._buildGrid();
    const { CELL, grid } = this._grid;
    const i0 = Math.floor(box.min.x / CELL), i1 = Math.floor(box.max.x / CELL);
    const k0 = Math.floor(box.min.z / CELL), k1 = Math.floor(box.max.z / CELL);
    if (i0 === i1 && k0 === k1) return grid.get(i0 * 100003 + k0) ?? [];
    const out = new Set();
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) grid.get(i * 100003 + k)?.forEach(c => out.add(c));
    return [...out];
  }

  /**
   * 脚下碰撞体能提供的支撑高度：脚印（半径 r）范围内、顶面不高于 maxTop 的碰撞体顶面最大值。
   * 跳到栏杆、家具、矮墙上时用它当"地面"，避免从上方落进碰撞体里卡死。没有则返回 -Infinity。
   */
  supportHeight(x, z, maxTop, r = 0.3) {
    this._footBox ??= new THREE.Box3();
    this._footBox.min.set(x - r, -1e3, z - r);
    this._footBox.max.set(x + r, 1e3, z + r);
    let best = -Infinity;
    for (const c of this.queryBox(this._footBox)) {
      const b = c.box;
      if (b.max.y > maxTop || b.max.y <= best) continue;
      if (x + r < b.min.x || x - r > b.max.x || z + r < b.min.z || z - r > b.max.z) continue;
      best = b.max.y;
    }
    return best;
  }

  checkBoundary(position, radius = 0.5) {
    const { minX, maxX, minZ, maxZ } = LAYOUT.BOUNDARY;
    return position.x - radius >= minX && position.x + radius <= maxX &&
      position.z - radius >= minZ && position.z + radius <= maxZ;
  }

  checkRiverCrossing(position, radius) {
    for (const { position: p, dimensions: d } of this.rivers) {
      const insideX = position.x + radius > p.x - d.width / 2 && position.x - radius < p.x + d.width / 2;
      const insideZ = position.z + radius > p.z - d.depth / 2 && position.z - radius < p.z + d.depth / 2;
      if (!insideX || !insideZ) continue;
      // 与五座桥的中心与宽度保持一致；水域本身不是可行走地面。
      const onBridge = Array.from({ length: 5 }, (_, i) => p.x - d.width * 0.3 + i / 4 * d.width * 0.6)
        .some(x => Math.abs(position.x - x) + radius < 2.4);
      if (!onBridge) return false;
    }
    return true;
  }

  /**
   * 水平移动 + 碰撞修正（沿墙滑动）。
   * 传入 feetY 时，每个细分小步都重新贴合地面（台阶/坡道），并用该小步的地面高度做碰撞检测。
   * 这样低帧率或快走时一帧走 1m 以上，也不会因为"一帧抬升超过可迈高度"而判定上不去台阶、
   * 继续以地面高度从楼梯口钻进台基内部（表现为走到楼梯顶突然掉到台基下面）。
   * 结果的地面高度写入 this.lastGroundY。
   */
  getValidPosition(currentPosition, targetPosition, radius = 0.5, feetY = null, stepUp = PLAYER.STEP_UP ?? 0.6, airFeet = null) {
    // airFeet：空中（跳跃/下落）时的实际脚面高度。碰撞按身体真实高度判定（可越过矮栏杆），
    // 落脚面按真实脚面查询（跳到高于原地面的台面上也能落住）。
    const distance = Math.hypot(targetPosition.x - currentPosition.x, targetPosition.z - currentPosition.z);
    const steps = Math.max(1, Math.ceil(distance / Math.max(radius * 0.5, 0.05)));
    const dx = (targetPosition.x - currentPosition.x) / steps;
    const dz = (targetPosition.z - currentPosition.z) / steps;
    const valid = currentPosition.clone();
    const candidate = currentPosition.clone();
    const track = feetY !== null && feetY !== undefined;
    let ground = track ? feetY : 0;
    const air = track && airFeet !== null && airFeet !== undefined;
    const tryMove = (x, z) => {
      const g = track ? this.getGroundHeight(x, z, air ? Math.max(airFeet, ground) : ground, stepUp) : 0;
      const bodyFeet = air ? Math.max(g, airFeet) : g;
      candidate.set(x, track ? bodyFeet + PLAYER.HEIGHT : valid.y, z);
      if (this.checkCollision(candidate, radius)) return false;
      valid.copy(candidate);
      if (track) ground = g;
      return true;
    };
    for (let i = 0; i < steps; i++) {
      if (tryMove(valid.x + dx, valid.z + dz)) continue;
      tryMove(valid.x + dx, valid.z);
      tryMove(valid.x, valid.z + dz);
    }
    this.lastGroundY = ground;
    return valid;
  }

  updateCollider(object) {
    const collider = this.colliders.find(item => item.mesh === object);
    if (collider) {
      if (object.isBox3) collider.box.copy(object);
      else collider.box.setFromObject(object);
      this._grid = null;
    }
  }

  clear() {
    this.colliders.length = 0;
    this.walkables.length = 0;
    this._grid = null;
  }

  /** 两侧宫院的命名区域（世界坐标矩形），优先于中轴 z 分段判断 */
  setRegions(regions) {
    // 面积小的优先（院内的殿 > 整片街区）
    this.regions = [...(regions ?? [])].sort((a, b) =>
      (a.maxX - a.minX) * (a.maxZ - a.minZ) - (b.maxX - b.minX) * (b.maxZ - b.minZ));
  }

  getCurrentLocation(position) {
    const { x, z } = position;
    const hit = this.regions?.find(r => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ);
    if (hit) return hit.name;
    if (x < -159 || x > 159) return x < 0 ? '东华门外' : '西华门外';
    if (Math.abs(x) > 75 && z > -146 && z < 170) return x < 0 ? '东路·文华殿一带' : '西路·武英殿一带';
    if (Math.abs(x) > 40 && z >= 170 && z < 305) return x < 0 ? '东六宫' : '西六宫';
    if (Math.abs(x) > 67 && z >= 305) return x < 0 ? '东路·宁寿宫一带' : '西路·建福宫一带';
    if (z < LAYOUT.WUMEN_Z - 30) return '午门外广场';
    if (z < LAYOUT.TAIHE_GATE_Z - 20) return '午门';
    if (z < LAYOUT.TAIHE_Z - 30) return '太和门广场';
    if (z < LAYOUT.TAIHE_Z + 20) return '太和殿';
    if (z < LAYOUT.ZHONGHE_Z + 15) return '中和殿';
    if (z < LAYOUT.BAOHE_Z + 20) return '保和殿';
    if (z < LAYOUT.QIANQING_GATE_Z - 20) return '内廷广场';
    if (z < LAYOUT.QIANQING_Z + 15) return '乾清宫';
    if (z < LAYOUT.JIAOTAI_Z + 10) return '交泰殿';
    if (z < LAYOUT.KUNNING_Z + 15) return '坤宁宫';
    if (z < LAYOUT.IMPERIAL_GARDEN_Z + 30) return '御花园';
    if (z < LAYOUT.SHENWU_Z + 20) return '神武门';
    return '神武门外';
  }
}
