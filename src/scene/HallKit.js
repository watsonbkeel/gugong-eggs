import * as THREE from 'three';
import { applyBoxUV, applyBandUV } from '../utils/GeometryUV.js';

/**
 * 古建通用构件（接口契约，当前为简化实现，后续由建筑模块负责升级，签名保持不变）。
 *
 * 通用约定：
 * - lib：TextureLibrary；材质只能通过 lib.material() 获取，本模块不 dispose 材质/贴图。
 * - 返回的 Group 以底面中心为原点（y=0 为构件底面），面宽沿 X，进深沿 Z，正面朝 -Z（南）。
 * - 碰撞：返回 group.userData.colliders = THREE.Box3[]（group 局部坐标）。调用方把 group 放好后，
 *   用 box.clone().applyMatrix4(group.matrixWorld) 转成世界坐标再注册。只登记玩家身高范围内（y < 3）的实体。
 * - 自有几何体由调用方随 group 一起释放（遍历 child.geometry.dispose()）。
 */

/**
 * 殿身：檐柱、槛墙/隔扇门窗、额枋彩画带。
 * @param {object} o
 * @param {number} o.width 面宽（柱中到柱中，米）
 * @param {number} o.depth 进深
 * @param {number} o.height 柱高（地面到额枋顶）
 * @param {number} [o.bays] 面宽间数（奇数），默认按 width/6 取奇数
 * @param {'lattice'|'wall'|'open'} [o.facade='lattice'] 正背面：隔扇门窗 / 红墙 / 敞开（仅柱子）
 * @param {number[]} [o.openBays=[]] facade 为 lattice 时，哪些间敞开可通行（0 为最左间，中间间 = (bays-1)/2）
 * @returns {THREE.Group} userData = { topY, colliders }
 */
export function buildHallBody(lib, o) {
  const { width, depth, height } = o;
  const bays = o.bays ?? Math.max(3, Math.round(width / 6) | 1);
  const group = new THREE.Group();
  const colliders = [];
  const beamH = THREE.MathUtils.clamp(height * 0.12, 0.6, 2);
  const wallH = height - beamH;
  const inset = Math.min(0.8, depth * 0.08);
  const body = new THREE.Mesh(
    applyBoxUV(new THREE.BoxGeometry(width - inset * 2, wallH, depth - inset * 2), lib.tileSize('wall_red')),
    lib.material('wall_red'));
  body.position.y = wallH / 2;
  body.castShadow = body.receiveShadow = true;
  group.add(body);
  colliders.push(new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(0, Math.min(wallH, 3) / 2, 0), new THREE.Vector3(width - inset * 2, Math.min(wallH, 3), depth - inset * 2)));
  if (o.facade !== 'wall') {
    const front = new THREE.Mesh(
      applyBandUV(new THREE.BoxGeometry(width - inset * 2 + 0.02, wallH * 0.9, 0.2), lib.tileSize('lattice_doors')),
      lib.material('lattice_doors'));
    front.position.set(0, wallH * 0.45, -(depth / 2 - inset) - 0.1);
    group.add(front);
    const back = front.clone();
    back.position.z *= -1;
    back.rotation.y = Math.PI;
    group.add(back);
  }
  const r = THREE.MathUtils.clamp(width / bays * 0.06, 0.25, 0.6);
  const colGeo = new THREE.CylinderGeometry(r, r * 1.05, wallH, 12);
  const colMat = lib.material('wood_column');
  for (let i = 0; i <= bays; i++) {
    const x = -width / 2 + (i / bays) * width;
    for (const z of [-depth / 2, depth / 2]) {
      const col = new THREE.Mesh(colGeo, colMat);
      col.position.set(x, wallH / 2, z);
      col.castShadow = true;
      group.add(col);
      colliders.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, 1.5, z), new THREE.Vector3(r * 2, 3, r * 2)));
    }
  }
  const beam = new THREE.Mesh(applyBandUV(new THREE.BoxGeometry(width + 0.4, beamH, depth + 0.4), lib.tileSize('caihua_beam')),
    lib.material('caihua_beam'));
  beam.position.y = wallH + beamH / 2;
  group.add(beam);
  group.userData = { topY: height, colliders };
  return group;
}

/**
 * 须弥座台基（可多层），可带汉白玉栏杆、台阶与御路。
 * @param {object} o
 * @param {number} o.width 顶层台面宽
 * @param {number} o.depth 顶层台面深
 * @param {number} o.height 总高
 * @param {number} [o.layers=1]
 * @param {boolean} [o.balustrade=true]
 * @param {Array<{ side: 'south'|'north', width: number, yulu?: boolean }>} [o.stairs=[]]
 * @returns {THREE.Group} userData = { topY, colliders }
 */
export function buildSumeruBase(lib, o) {
  const { width, depth, height, layers = 1 } = o;
  const group = new THREE.Group();
  const colliders = [];
  const lh = height / layers;
  for (let i = 0; i < layers; i++) {
    const w = width + (layers - 1 - i) * 3;
    const d = depth + (layers - 1 - i) * 3;
    const layer = new THREE.Mesh(applyBandUV(new THREE.BoxGeometry(w, lh, d), lib.tileSize('sumeru_band')),
      lib.material('sumeru_band'));
    layer.position.y = i * lh + lh / 2;
    layer.castShadow = layer.receiveShadow = true;
    group.add(layer);
    colliders.push(new THREE.Box3().setFromCenterAndSize(layer.position.clone(), new THREE.Vector3(w, lh, d)));
    if (o.balustrade !== false) {
      for (const [sx, sz, len, rot] of [[0, -d / 2, w, 0], [0, d / 2, w, Math.PI], [-w / 2, 0, d, Math.PI / 2], [w / 2, 0, d, -Math.PI / 2]]) {
        const rail = buildBalustrade(lib, { length: len });
        rail.position.set(sx, (i + 1) * lh, sz);
        rail.rotation.y = rot;
        group.add(rail);
      }
    }
  }
  for (const s of o.stairs ?? []) {
    const dir = s.side === 'north' ? 1 : -1;
    const run = height * 1.6;
    const outer = depth / 2 + (layers - 1) * 1.5;
    const stair = new THREE.Mesh(applyBoxUV(new THREE.BoxGeometry(s.width, height, run), lib.tileSize('marble')),
      lib.material('marble'));
    stair.position.set(0, height / 2, dir * (outer + run / 2));
    group.add(stair);
    colliders.push(new THREE.Box3().setFromCenterAndSize(stair.position.clone(), new THREE.Vector3(s.width, height, run)));
  }
  group.userData = { topY: height, colliders };
  return group;
}

/**
 * 汉白玉栏杆一段，沿局部 X 轴从 -length/2 到 length/2，底面 y=0，面朝 -Z。
 * @param {object} o
 * @param {number} o.length
 * @param {number} [o.height=1.1]
 * @returns {THREE.Group} userData = { colliders }
 */
export function buildBalustrade(lib, { length, height = 1.1 }) {
  const group = new THREE.Group();
  const panel = new THREE.Mesh(applyBandUV(new THREE.BoxGeometry(length, height, 0.18), lib.tileSize('balustrade') * (height / 1.1)),
    lib.material('balustrade', { alphaTest: 0.5, side: THREE.DoubleSide }));
  panel.position.y = height / 2;
  panel.castShadow = true;
  group.add(panel);
  group.userData = {
    colliders: [new THREE.Box3(new THREE.Vector3(-length / 2, 0, -0.12), new THREE.Vector3(length / 2, height, 0.12))],
  };
  return group;
}

/**
 * 门钉大门（单扇），底面中心在原点，门面朝 -Z。
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @returns {THREE.Mesh}
 */
export function buildStuddedDoor(lib, { width, height }) {
  // 几何体底面平移到原点，调用方 position.set(x, 0, z) 时门扇正好落地（不会被埋掉一半）
  const geo = new THREE.BoxGeometry(width, height, 0.25);
  geo.translate(0, height / 2, 0);
  const door = new THREE.Mesh(geo, lib.material('door_studded'));
  door.castShadow = true;
  return door;
}
