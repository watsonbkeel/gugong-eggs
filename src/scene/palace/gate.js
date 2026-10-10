import * as THREE from 'three';
import { applyBoxUV, applyBandUV, applyPlanarUV } from '../../utils/GeometryUV.js';
import { buildRoof } from '../RoofBuilder.js';
import { buildHallBody, buildSumeruBase, buildStuddedDoor } from '../HallKit.js';
import { mergeByMaterial } from '../../utils/MergeUtils.js';
import { worldBox } from './colliders.js';
import { buildGateAscent } from './gateAscent.js';

/**
 * 午门：中央城台（红墙，三个拱券门洞）+ 重檐城楼 + 两侧雁翅楼
 * 
 * 回归测试要求：
 * - (15, -150) 阻挡（侧墙实体）
 * - (40, -164) 不阻挡（翼楼之间空地）
 * - 中轴 x=0, z ∈ [-168, -132] 可通行（中门洞贯通）
 */
export function buildWumen(lib, data) {
  const { position: p, dimensions: d, features } = data;
  const group = new THREE.Group();
  group.name = 'wumen';
  const colliders = [];
  const ownedMaterials = [];

  // 中央城台尺寸：宽 78m（x ∈ [-39, 39]），深 30m，高 13m
  const platformW = 78;
  const platformD = d.depth;
  const platformH = 13;
  
  // 城台主体（红墙，底部 1m 高灰石须弥座腰线）
  const baseH = 1;
  const wallH = platformH - baseH;
  

  // 红墙主体（三个门洞：中门 x ∈ [-4.5, 4.5]，左右掖门 x ∈ ±[15, 20]）
  const gateOpenings = [
    { x: 0, w: 9 },      // 中门
    { x: -17.5, w: 5 },  // 左掖门
    { x: 17.5, w: 5 }    // 右掖门
  ];
  
  // 墙段：门洞之间和两端的实体墙
  const wallSegments = [];
  let prevRight = -platformW / 2;
  gateOpenings.sort((a, b) => a.x - b.x).forEach(opening => {
    const left = opening.x - opening.w / 2;
    if (left > prevRight + 0.5) {
      wallSegments.push({ x: (prevRight + left) / 2, w: left - prevRight });
    }
    prevRight = opening.x + opening.w / 2;
  });
  if (prevRight < platformW / 2 - 0.5) {
    wallSegments.push({ x: (prevRight + platformW / 2) / 2, w: platformW / 2 - prevRight });
  }

  wallSegments.forEach(seg => {
    const wall = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(seg.w, wallH, platformD), lib.tileSize('wall_red')),
      lib.material('wall_red')
    );
    wall.position.set(seg.x, baseH + wallH / 2, 0);
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
    const band = new THREE.Mesh(
      applyBandUV(new THREE.BoxGeometry(seg.w + 0.1, baseH, platformD + 0.2), lib.tileSize('sumeru_band')),
      lib.material('sumeru_band')
    );
    band.position.set(seg.x, baseH / 2, 0);
    band.receiveShadow = true;
    group.add(band);
    // 局部盒以 mesh 中心为原点：y 需减去中心高度，才能落在地面 0~3m（玩家身高范围）
    colliders.push(worldBox(wall, new THREE.Box3(
      new THREE.Vector3(-seg.w / 2, -wall.position.y, -platformD / 2),
      new THREE.Vector3(seg.w / 2, 3 - wall.position.y, platformD / 2)
    )));
  });

  // 门洞：与神武门同一做法 —— 洞壁就是两侧红墙的侧面，洞顶为砖砌顶板；
  // 门扇在距南面 2m 处向内打开，左右两扇分别平贴门洞东西两壁，不挡通道。
  gateOpenings.forEach(opening => {
    const tunnelH = opening.w >= 8 ? 8 : 6.5;
    const above = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(opening.w, platformH - tunnelH, platformD), lib.tileSize('wall_red')),
      lib.material('wall_red')
    );
    above.position.set(opening.x, tunnelH + (platformH - tunnelH) / 2, 0);
    group.add(above);
    const ceil = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(opening.w, 0.3, platformD - 0.2), lib.tileSize('wall_brick')),
      lib.material('wall_brick')
    );
    ceil.position.set(opening.x, tunnelH - 0.15, 0);
    group.add(ceil);
    const leafW = opening.w * 0.48;
    for (const s of [-1, 1]) {
      const door = buildStuddedDoor(lib, { width: leafW, height: tunnelH - 0.5 });
      door.position.set(opening.x + s * (opening.w / 2 - 0.15), 0, -platformD / 2 + 2 + leafW / 2);
      door.rotation.y = Math.PI / 2;
      group.add(door);
    }
  });

  // 登城马道：城台北面（宫内一侧）东西两端各一条，沿城台端头向外下行到太和门广场；
  // 城台顶四周汉白玉栏杆（带碰撞），在马道到达处开口。顶面可行走，可绕城楼一圈远眺。
  const ascent = buildGateAscent(lib, group, {
    W: platformW, D: platformD, topY: platformH,
    band: [platformD / 2 - 6, platformD / 2], edge: 'rail',
  });
  colliders.push(...ascent.colliders);
  const walkables = ascent.walkables;

  // 城楼（重檐庑殿，建在城台顶部中央）
  const towerW = 48;
  const towerD = 24;
  const towerBase = platformH;
  const hallBody = buildHallBody(lib, {
    width: towerW, depth: towerD, height: 12, bays: 9, facade: 'lattice'
  });
  hallBody.position.y = towerBase;
  group.add(hallBody);
  hallBody.userData.colliders?.forEach(box => {
    const wb = box.clone();
    wb.min.add(new THREE.Vector3(0, towerBase, 0));
    wb.max.add(new THREE.Vector3(0, towerBase, 0));
    colliders.push(wb);
  });

  const roof = buildRoof(lib, {
    type: 'wudian', width: towerW + 2, depth: towerD + 2,
    baseY: towerBase + hallBody.userData.topY, layers: 2, brackets: true
  });
  group.add(roof);
  if (roof.userData.ownedMaterials) ownedMaterials.push(...roof.userData.ownedMaterials);

  // 雁翅楼：两侧 L 形翼楼（城台 + 廊庑 + 端头阙亭）
  // 左翼：x ∈ [-39, -29], z ∈ [-195, -165]；右翼：x ∈ [29, 39], z ∈ [-195, -165]
  for (const side of [-1, 1]) {
    const wingX = side * 34;
    const wingZ = -30; // 相对 wumen position
    const wingW = 10;
    const wingL = 30;
    const wingH = 6;
    
    const wingPlatform = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(wingW, wingH, wingL), lib.tileSize('wall_red')),
      lib.material('wall_red')
    );
    wingPlatform.position.set(wingX, wingH / 2, wingZ);
    wingPlatform.castShadow = true;
    group.add(wingPlatform);
    colliders.push(worldBox(wingPlatform, new THREE.Box3(
      new THREE.Vector3(-wingW / 2, -wingH / 2, -wingL / 2),
      new THREE.Vector3(wingW / 2, 3 - wingH / 2, wingL / 2)
    )));
    
    // 翼楼廊庑（单檐歇山）
    const wingHall = buildHallBody(lib, { width: wingW - 2, depth: wingL - 4, height: 6, bays: 3, facade: 'open' });
    wingHall.position.set(wingX, wingH, wingZ);
    group.add(wingHall);
    
    const wingRoof = buildRoof(lib, {
      type: 'xieshan', width: wingW, depth: wingL - 2,
      // 屋顶整体已平移到 wingH，baseY 只需屋身高度（否则屋顶会悬空 wingH）
      baseY: wingHall.userData.topY, layers: 1, brackets: true, detail: 'low'
    });
    wingRoof.position.set(wingX, wingH, wingZ);
    group.add(wingRoof);
    if (wingRoof.userData.ownedMaterials) ownedMaterials.push(...wingRoof.userData.ownedMaterials);
  }

  group.position.set(p.x, p.y, p.z);
  group.updateMatrixWorld(true);

  return { group: mergeByMaterial(group), colliders, walkables, ownedMaterials };
}
