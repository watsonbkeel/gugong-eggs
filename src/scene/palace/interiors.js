import * as THREE from 'three';

/**
 * 可复用的室内陈设预设（简化几何，按材质合并后几乎不增加绘制调用）。
 *
 * 每个预设只依赖"房间矩形 + 门的位置"，任何殿座 / 庑房都能套用：
 *   room = { x0, x1, z0, z1, y, h, doorX }   —— 局部坐标，z0 为门所在的前檐，z1 为后檐
 * 约定：门口 1.6m 纵深、门两侧各 0.9m 内不放东西，保证进得去。
 *
 * 返回 { cover: [{x,z}], spawns: [{x,z}] }（局部坐标），供后续玩法（掩体、刷怪点、巡逻点）使用。
 *
 * 新增房型：在 PRESETS 里加一个函数即可，签名 (put, room, rng) => void。
 *   put(w, d, h, xc, zc, mat, { y, cover }) 放一个盒子家具：自动登记碰撞，h ≥ 0.9 的自动登记为掩体。
 */

export const INTERIOR_KINDS = ['hall', 'room', 'storage', 'empty'];

const PRESETS = {
  /** 大殿（无宝座）：后檐正中长案 + 两把椅子，两侧立柜，两侧条凳 */
  hall(put, r) {
    const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2;
    const tw = Math.min(2.4, W * 0.3);
    put(tw, 0.8, 0.85, cx, r.z1 - 1.0, 'wood');                     // 长案
    put(tw * 0.9, 0.06, 0.06, cx, r.z1 - 0.62, 'gold', { y: 0.86, cover: false });
    for (const s of [-1, 1]) put(0.6, 0.6, 1.1, cx + s * tw * 0.3, r.z1 - 1.9, 'lacquer', { cover: false }); // 椅
    if (W > 7) {
      for (const s of [-1, 1]) {
        put(1.2, 0.55, 2.1, s < 0 ? r.x0 + 0.8 : r.x1 - 0.8, r.z1 - 0.4, 'wood');    // 立柜
        if (D > 5) put(0.5, Math.min(2.4, D * 0.35), 0.48, s < 0 ? r.x0 + 0.4 : r.x1 - 0.4, (r.z0 + r.z1) / 2, 'lacquer'); // 条凳
      }
    }
  },
  /** 居室：后檐一侧炕床，另一侧方桌 + 两凳，角落立柜 */
  room(put, r) {
    const W = r.x1 - r.x0, D = r.z1 - r.z0;
    const right = r.doorX <= (r.x0 + r.x1) / 2; // 炕放在离门远的一侧
    const kw = Math.min(2.6, W * 0.42), kd = Math.min(1.7, D * 0.42);
    const kx = right ? r.x1 - kw / 2 - 0.05 : r.x0 + kw / 2 + 0.05;
    put(kw, kd, 0.62, kx, r.z1 - kd / 2 - 0.05, 'wood');               // 炕
    put(kw * 0.9, kd * 0.85, 0.08, kx, r.z1 - kd / 2 - 0.05, 'cloth', { y: 0.62, cover: false });
    const ox = right ? r.x0 + Math.min(1.1, W * 0.2) : r.x1 - Math.min(1.1, W * 0.2);
    if (W > 4.5) {
      put(0.9, 0.9, 0.8, ox, r.z1 - 1.3, 'wood', { cover: false });   // 方桌
      for (const s of [-1, 1]) put(0.4, 0.4, 0.45, ox + s * 0.75, r.z1 - 1.3, 'lacquer', { cover: false });
    }
    put(1.0, 0.5, 1.9, ox, r.z1 - 0.3, 'wood');                        // 立柜
  },
  /** 库房：沿后墙、侧墙堆放木箱，中间留通道（适合做掩体） */
  storage(put, r, rng) {
    const W = r.x1 - r.x0;
    const n = Math.max(2, Math.floor(W / 1.3));
    for (let i = 0; i < n; i++) {
      const xc = r.x0 + 0.6 + i * ((W - 1.2) / Math.max(1, n - 1));
      if (Math.abs(xc - r.doorX) < 0.9 && r.z1 - r.z0 < 3.2) continue;
      const tall = rng() > 0.45;
      put(1.0, 1.0, 1.0, xc, r.z1 - 0.55, 'crate', { cover: !tall });
      if (tall) put(0.9, 0.9, 0.9, xc + (rng() - 0.5) * 0.1, r.z1 - 0.55, 'crate', { y: 1.0 });
    }
    // 侧墙两只单箱
    for (const s of [-1, 1]) {
      const xc = s < 0 ? r.x0 + 0.55 : r.x1 - 0.55;
      if (Math.abs(xc - r.doorX) > 1.4) put(0.9, 0.9, 0.9, xc, (r.z0 + r.z1) / 2 - 0.2, 'crate');
    }
  },
  empty() {},
};

/**
 * 在 frame f 的局部坐标里布置一个房间。
 * @param kit  CourtKit（提供 mesh / col 与共享材质）
 */
export function furnishRoom(kit, f, kind, room, seed = 1) {
  const preset = PRESETS[kind] ?? PRESETS.empty;
  const cover = [];
  let s = seed >>> 0 || 1;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mats = kit.interiorMaterials();
  const put = (w, d, h, xc, zc, mat, { y = 0, cover: isCover } = {}) => {
    // 保证不越出房间、不堵门口
    w = Math.min(w, room.x1 - room.x0 - 0.1);
    d = Math.min(d, room.z1 - room.z0 - 0.1);
    xc = THREE.MathUtils.clamp(xc, room.x0 + w / 2, room.x1 - w / 2);
    zc = THREE.MathUtils.clamp(zc, room.z0 + d / 2, room.z1 - d / 2);
    const nearDoorX = Math.abs(xc - room.doorX) < w / 2 + 0.9;
    if (nearDoorX && zc - d / 2 < room.z0 + 1.6) return;
    if (nearDoorX && room.backDoor && zc + d / 2 > room.z1 - 1.6) return;
    kit.mesh(f, new THREE.BoxGeometry(w, h, d), mats[mat] ?? mats.wood, xc, room.y + y + h / 2, zc);
    if (y + h > 0.36) kit.col(f, xc - w / 2, room.y + y, zc - d / 2, xc + w / 2, room.y + Math.min(y + h, 3), zc + d / 2);
    if (isCover ?? (y + h >= 0.9)) cover.push({ x: xc, z: zc - d / 2 - 0.6 });
  };
  preset(put, room, rng);
  const spawns = [
    { x: (room.x0 + room.x1) / 2, z: (room.z0 + room.z1) / 2 },
    { x: room.doorX, z: room.z0 + 1.0 },
  ];
  return { cover, spawns };
}
