import * as THREE from 'three';
import { applyBoxUV, applyPlanarUV } from '../../utils/GeometryUV.js';
import { buildBalustrade } from '../HallKit.js';
import { mergeByMaterial } from '../../utils/MergeUtils.js';
import { worldBox } from './colliders.js';

/**
 * 金水河：河道石沿、水面、五座金水桥、两岸汉白玉栏杆
 * 
 * @param {TextureLibrary} lib
 * @param {object} riverData Layout 中 type='river' 的数据
 * @param {MeshStandardMaterial} waterMaterial 调用方提供的 materials.water
 * @returns {{ group: THREE.Group, colliders: THREE.Box3[], waterMesh: THREE.Mesh }}
 */
export function buildRiver(lib, riverData, waterMaterial) {
  const { position: p, dimensions: d } = riverData;
  const group = new THREE.Group();
  group.name = 'jinshui_river';
  const colliders = [];

  // 河道尺寸：x ∈ [-60, 60], z ∈ [-107.5, -92.5]，水面 y = -0.5
  const riverW = d.width;
  const riverD = d.depth;
  const waterY = p.y;
  const revetH = 0.8; // 驳岸高度（从地面 0 到水面 -0.5 + 岸沿突出 0.3）
  const revetT = 0.6;  // 岸沿厚度

  // 两侧驳岸石沿（汉白玉/石板，竖面从地面下到水面）
  for (const side of [-1, 1]) {
    const zPos = p.z + side * riverD / 2;
    const revetment = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(riverW, revetH, revetT), lib.tileSize('marble')),
      lib.material('marble')
    );
    revetment.position.set(p.x, waterY + revetH / 2 - 0.3, zPos);
    revetment.castShadow = true;
    revetment.receiveShadow = true;
    group.add(revetment);
    // 岸沿碰撞：阻挡玩家进入河道
    colliders.push(worldBox(revetment, new THREE.Box3(
      new THREE.Vector3(-riverW / 2, 0, -revetT / 2),
      new THREE.Vector3(riverW / 2, Math.min(revetH, 3), revetT / 2)
    )));
  }

  // 水面（PlaneGeometry，按 tileSize 平铺，保留 userdata 供射线测试识别）
  const waterGeo = new THREE.PlaneGeometry(riverW, riverD);
  applyPlanarUV(waterGeo, 'y', lib.tileSize('water'));
  const water = new THREE.Mesh(waterGeo, waterMaterial);
  water.rotation.x = -Math.PI / 2;
  water.position.set(p.x, waterY, p.z);
  water.receiveShadow = true;
  water.userData.isWater = true;
  group.add(water);

  // 两岸汉白玉栏杆（沿河岸，阻挡玩家横向掉入河道）
  for (const side of [-1, 1]) {
    const zPos = p.z + side * (riverD / 2 + revetT / 2 + 0.15);
    const rail = buildBalustrade(lib, { length: riverW, height: 1.1 });
    rail.position.set(p.x, 0, zPos);
    rail.rotation.y = side > 0 ? Math.PI : 0;
    group.add(rail);
    // 栏杆碰撞（世界坐标）
    rail.userData.colliders.forEach(box => {
      const wb = box.clone();
      wb.min.add(rail.position);
      wb.max.add(rail.position);
      colliders.push(wb);
    });
  }

  // 五座金水桥：汉白玉拱桥造型（桥面微拱视觉，碰撞为平面）
  const bridgePositions = Array.from({ length: 5 }, (_, i) => p.x - riverW * 0.3 + i / 4 * riverW * 0.6);
  bridgePositions.forEach((bx, idx) => {
    const bridge = buildBridge(lib, bx, p.z, riverD);
    group.add(bridge.group);
    colliders.push(...bridge.colliders);
  });

  return { group, colliders, waterMesh: water };
}

/**
 * 单座金水桥：拱形桥面（视觉微拱）+ 两侧桥栏（碰撞阻挡）
 */
function buildBridge(lib, x, z, riverDepth) {
  const group = new THREE.Group();
  const bridgeW = 5;
  const bridgeL = 20;
  const archH = 0.3; // 视觉拱高（保持低于 0.4 避免穿模）
  const colliders = [];

  // 桥面：用弧形拼接模拟拱桥视觉（CylinderGeometry 侧面朝上）
  const segments = 12;
  const radius = (bridgeL * bridgeL / 4 + archH * archH) / (2 * archH); // 圆弧半径
  const angle = 2 * Math.asin(bridgeL / 2 / radius);
  const deckGeo = new THREE.CylinderGeometry(radius, radius, bridgeW, segments, 1, true, Math.PI / 2 - angle / 2, angle);
  applyBoxUV(deckGeo, lib.tileSize('stone_slab'));
  const deck = new THREE.Mesh(deckGeo, lib.material('stone_slab'));
  deck.rotation.z = Math.PI / 2;
  deck.position.set(x, radius - archH + 0.05, z);
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);

  // 桥面碰撞：玩家行走高度仍为平地（不阻挡），实际穿过桥面
  // （桥视觉拱高很小，玩家直接按 y=0 平面行走不会明显悬空）

  // 两侧桥栏（汉白玉栏板，碰撞阻挡横向穿过）
  for (const side of [-1, 1]) {
    const xRail = x + side * (bridgeW / 2 - 0.1);
    const rail = buildBalustrade(lib, { length: bridgeL, height: 1.0 });
    rail.position.set(xRail, 0, z);
    rail.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(rail);
    // 栏杆碰撞（世界坐标 Box3）
    rail.userData.colliders.forEach(box => {
      const wb = new THREE.Box3();
      wb.min.set(xRail + box.min.x, box.min.y, z + box.min.z);
      wb.max.set(xRail + box.max.x, box.max.y, z + box.max.z);
      colliders.push(wb);
    });
  }

  return { group, colliders };
}
