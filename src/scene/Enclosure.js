import * as THREE from 'three';
import { buildRoof, buildWallCap, buildCornerTower } from './RoofBuilder.js';
import { buildHallBody } from './HallKit.js';
import { applyBoxUV } from '../utils/GeometryUV.js';
import { mergeByMaterial } from '../utils/MergeUtils.js';

/**
 * 宫城围合：外城墙与角楼、院落隔墙、两侧庑房、午门前朝房。
 *
 * - 构造：new Enclosure(scene, library)
 * - build()：创建全部几何并加入场景
 * - getColliders()：返回 THREE.Box3[]（世界坐标，覆盖每段实体墙/建筑的落地范围）
 * - update(dt)：预留（当前无动画）
 * - dispose()：移除自有对象并释放自有几何与 ownedMaterials；不得 dispose library 提供的材质/贴图
 */
export class Enclosure {
  constructor(scene, library) {
    this.scene = scene;
    this.library = library;
    this.group = new THREE.Group();
    this.group.name = 'enclosure';
    this.colliders = [];
    this.ownedMaterials = [];
  }

  build() {
    const tempGroup = new THREE.Group();
    tempGroup.name = 'enclosure_temp';
    
    // 1. 外城墙与角楼
    this.buildOuterWalls(tempGroup);
    this.buildCornerTowers(tempGroup);
    
    // 2. 午门外朝房（宫城内的院墙、庑房、各门由 SideCourts 统一建造）
    this.buildCorridorHalls(tempGroup);
    
    // 先把 tempGroup 加到场景以计算世界坐标（mergeByMaterial 需要）
    this.scene.add(tempGroup);
    
    // 合并减少 draw call
    const merged = mergeByMaterial(tempGroup, { castShadow: true, receiveShadow: true, name: 'enclosure' });
    
    // 移除临时组，用合并后的替换
    tempGroup.removeFromParent();
    this.group = merged;
    this.scene.add(this.group);
    
    return this;
  }

  /**
   * 建外城墙：矩形围合，南墙在午门处断开，北墙在神武门处断开
   */
  buildOuterWalls(parent) {
    const wallH = 10;
    const wallT = 8;
    const brickH = 1.5; // 下碱高度
    
    const redMat = this.library.material('wall_red');
    const brickMat = this.library.material('wall_brick');
    
    // 南墙：z=-150，从 x=60 到 155（东段）、x=-155 到 -60（西段）
    this.addWallSegment(parent, { x1: 60, x2: 155, z: -150, h: wallH, t: wallT, brickH }, redMat, brickMat);
    this.addWallSegment(parent, { x1: -155, x2: -60, z: -150, h: wallH, t: wallT, brickH }, redMat, brickMat);
    
    // 北墙：z=420，从 x=25 到 155（东段）、x=-155 到 -25（西段）
    this.addWallSegment(parent, { x1: 25, x2: 155, z: 420, h: wallH, t: wallT, brickH }, redMat, brickMat);
    this.addWallSegment(parent, { x1: -155, x2: -25, z: 420, h: wallH, t: wallT, brickH }, redMat, brickMat);
    
    // 东西墙：x=±155，z 从 -150 到 420；z=-115 处为东华门 / 西华门城台（由 SideCourts 建造），墙在此断开
    const gate0 = -130, gate1 = -100;
    for (const x of [155, -155]) {
      this.addWallSegmentZ(parent, { z1: -150, z2: gate0, x, h: wallH, t: wallT, brickH }, redMat, brickMat);
      this.addWallSegmentZ(parent, { z1: gate1, z2: 420, x, h: wallH, t: wallT, brickH }, redMat, brickMat);
    }
  }

  /**
   * 添加一段沿 X 方向的墙（x1 到 x2，固定 z）
   */
  addWallSegment(parent, { x1, x2, z, h, t, brickH }, redMat, brickMat) {
    const len = Math.abs(x2 - x1);
    const cx = (x1 + x2) / 2;
    
    // 下碱（灰砖）
    const base = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(len, brickH, t), this.library.tileSize('wall_brick')),
      brickMat
    );
    base.position.set(cx, brickH / 2, z);
    base.castShadow = base.receiveShadow = true;
    parent.add(base);
    
    // 墙身（红墙）
    const wallBody = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(len, h - brickH, t), this.library.tileSize('wall_red')),
      redMat
    );
    wallBody.position.set(cx, brickH + (h - brickH) / 2, z);
    wallBody.castShadow = wallBody.receiveShadow = true;
    parent.add(wallBody);
    
    // 墙帽（黄琉璃）
    const cap = buildWallCap(this.library, { length: len, thickness: t });
    cap.position.set(cx, h, z);
    parent.add(cap);
    
    // 垛口（外侧，简化为凸起的矩形块，间隔布置）
    const crenelH = 1.2;
    const crenelW = 1.5;
    const spacing = 3.5;
    const count = Math.floor(len / spacing);
    for (let i = 0; i < count; i++) {
      const crenel = new THREE.Mesh(
        new THREE.BoxGeometry(crenelW, crenelH, t * 0.4),
        redMat
      );
      crenel.position.set(x1 + (i + 0.5) * (len / count), h + crenelH / 2, z - t / 2 - t * 0.2);
      crenel.castShadow = true;
      parent.add(crenel);
    }
    
    // 碰撞体（只登记 y<3 的部分）
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(Math.min(x1, x2), 0, z - t / 2),
      new THREE.Vector3(Math.max(x1, x2), Math.min(h, 3), z + t / 2)
    ));
  }

  /**
   * 添加一段沿 Z 方向的墙（z1 到 z2，固定 x）
   */
  addWallSegmentZ(parent, { z1, z2, x, h, t, brickH }, redMat, brickMat) {
    const len = Math.abs(z2 - z1);
    const cz = (z1 + z2) / 2;
    
    // 下碱
    const base = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(t, brickH, len), this.library.tileSize('wall_brick')),
      brickMat
    );
    base.position.set(x, brickH / 2, cz);
    base.castShadow = base.receiveShadow = true;
    parent.add(base);
    
    // 墙身
    const wallBody = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(t, h - brickH, len), this.library.tileSize('wall_red')),
      redMat
    );
    wallBody.position.set(x, brickH + (h - brickH) / 2, cz);
    wallBody.castShadow = wallBody.receiveShadow = true;
    parent.add(wallBody);
    
    // 墙帽
    const cap = buildWallCap(this.library, { length: len, thickness: t });
    cap.position.set(x, h, cz);
    cap.rotation.y = Math.PI / 2;
    parent.add(cap);
    
    // 垛口
    const crenelH = 1.2;
    const crenelW = 1.5;
    const spacing = 3.5;
    const count = Math.floor(len / spacing);
    for (let i = 0; i < count; i++) {
      const crenel = new THREE.Mesh(
        new THREE.BoxGeometry(t * 0.4, crenelH, crenelW),
        redMat
      );
      const side = x > 0 ? 1 : -1;
      crenel.position.set(x + side * (t / 2 + t * 0.2), h + crenelH / 2, z1 + (i + 0.5) * (len / count));
      crenel.castShadow = true;
      parent.add(crenel);
    }
    
    // 碰撞体
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(x - t / 2, 0, Math.min(z1, z2)),
      new THREE.Vector3(x + t / 2, Math.min(h, 3), Math.max(z1, z2))
    ));
  }

  /**
   * 四个角楼
   */
  buildCornerTowers(parent) {
    const wallH = 10;
    const corners = [
      { x: 155, z: -150 },
      { x: -155, z: -150 },
      { x: 155, z: 420 },
      { x: -155, z: 420 },
    ];
    for (const pos of corners) {
      const tower = buildCornerTower(this.library, { size: 14 });
      tower.position.set(pos.x, wallH, pos.z);
      parent.add(tower);
    }
  }

  /**
   * 院落隔墙
   */
  buildCourtYardWalls(parent) {
    const h = 8;
    const t = 0.6;
    const redMat = this.library.material('wall_red');
    
    // 太和殿院落东墙：x=75，z 从 -70 到 135
    this.addCourtWall(parent, { x: 75, z1: -70, z2: 135, h, t }, redMat);
    
    // 太和殿院落西墙：x=-75
    this.addCourtWall(parent, { x: -75, z1: -70, z2: 135, h, t }, redMat);
    
    // 乾清门两侧隔墙：z=170，x 从 17.5 到 75（东）、-75 到 -17.5（西）
    this.addCourtWallX(parent, { z: 170, x1: 17.5, x2: 75, h, t }, redMat);
    this.addCourtWallX(parent, { z: 170, x1: -75, x2: -17.5, h, t }, redMat);
    
    // 内廷东墙：x=40，z 从 175 到 320
    this.addCourtWall(parent, { x: 40, z1: 175, z2: 320, h, t }, redMat);
    
    // 内廷西墙：x=-40
    this.addCourtWall(parent, { x: -40, z1: 175, z2: 320, h, t }, redMat);
    
    // 御花园四周墙：x=±67，z∈[305,395]
    this.addCourtWall(parent, { x: 67, z1: 305, z2: 395, h, t }, redMat);
    this.addCourtWall(parent, { x: -67, z1: 305, z2: 395, h, t }, redMat);
    
    // 御花园南墙：z=305，x 从 -67 到 -10（西段）、10 到 67（东段，中间留通道）
    this.addCourtWallX(parent, { z: 305, x1: -67, x2: -10, h, t }, redMat);
    this.addCourtWallX(parent, { z: 305, x1: 10, x2: 67, h, t }, redMat);
    
    // 御花园北墙：z=395，x 从 -67 到 -10、10 到 67
    this.addCourtWallX(parent, { z: 395, x1: -67, x2: -10, h, t }, redMat);
    this.addCourtWallX(parent, { z: 395, x1: 10, x2: 67, h, t }, redMat);
  }

  /**
   * 添加院落隔墙（沿 Z，固定 x）
   */
  addCourtWall(parent, { x, z1, z2, h, t }, redMat) {
    const len = Math.abs(z2 - z1);
    const cz = (z1 + z2) / 2;
    
    const wall = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(t, h, len), this.library.tileSize('wall_red')),
      redMat
    );
    wall.position.set(x, h / 2, cz);
    wall.castShadow = wall.receiveShadow = true;
    parent.add(wall);
    
    // 墙帽
    const cap = buildWallCap(this.library, { length: len, thickness: t });
    cap.position.set(x, h, cz);
    cap.rotation.y = Math.PI / 2;
    parent.add(cap);
    
    // 碰撞体
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(x - t / 2, 0, Math.min(z1, z2)),
      new THREE.Vector3(x + t / 2, Math.min(h, 3), Math.max(z1, z2))
    ));
  }

  /**
   * 添加院落隔墙（沿 X，固定 z）
   */
  addCourtWallX(parent, { z, x1, x2, h, t }, redMat) {
    const len = Math.abs(x2 - x1);
    const cx = (x1 + x2) / 2;
    
    const wall = new THREE.Mesh(
      applyBoxUV(new THREE.BoxGeometry(len, h, t), this.library.tileSize('wall_red')),
      redMat
    );
    wall.position.set(cx, h / 2, z);
    wall.castShadow = wall.receiveShadow = true;
    parent.add(wall);
    
    // 墙帽
    const cap = buildWallCap(this.library, { length: len, thickness: t });
    cap.position.set(cx, h, z);
    parent.add(cap);
    
    // 碰撞体
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(Math.min(x1, x2), 0, z - t / 2),
      new THREE.Vector3(Math.max(x1, x2), Math.min(h, 3), z + t / 2)
    ));
  }

  /**
   * 庑房（廊庑）
   */
  buildCorridorHalls(parent) {
    // 午门外朝房已改由 SideCourts 用 CourtKit.corridor 建造（可进入、带室内）。保留此方法供扩展。
  }

  /**
   * 添加一段庑房（长条形）
   */
  addCorridorSection(parent, { x, z1, z2, w, d, h }) {
    const len = Math.abs(z2 - z1);
    const cz = (z1 + z2) / 2;
    
    // 柱廊朝向内侧（x=0 方向），背面是墙
    const body = buildHallBody(this.library, {
      width: w,
      depth: len,
      height: h,
      bays: Math.max(3, Math.round(len / 6) | 1),
      facade: 'wall',
    });
    body.rotation.y = Math.PI / 2; // 旋转使进深沿 Z
    body.position.set(x, 0, cz);
    parent.add(body);
    
    // 屋顶（硬山）
    const roof = buildRoof(this.library, {
      type: 'gable',
      width: w,
      depth: len,
      baseY: h,
      brackets: false,
      detail: 'low',
    });
    roof.rotation.y = Math.PI / 2;
    roof.position.set(x, 0, cz);
    parent.add(roof);
    
    // 碰撞体（取body的局部碰撞体转世界坐标）
    if (body.userData.colliders) {
      body.updateMatrixWorld(true);
      for (const localBox of body.userData.colliders) {
        const worldBox = localBox.clone().applyMatrix4(body.matrixWorld);
        this.colliders.push(worldBox);
      }
    }
  }

  /**
   * 两层楼阁（体仁阁/弘义阁）
   */
  addPavilionHall(parent, { x, z, w, d, h }) {
    const body = buildHallBody(this.library, {
      width: w,
      depth: d,
      height: h * 0.6,
      bays: 5,
      facade: 'lattice',
    });
    body.position.set(x, 0, z);
    parent.add(body);
    
    const roof = buildRoof(this.library, {
      type: 'xieshan',
      width: w,
      depth: d,
      baseY: h * 0.6,
      layers: 2,
      brackets: true,
      detail: 'low',
    });
    roof.position.set(x, 0, z);
    parent.add(roof);
    
    if (body.userData.colliders) {
      body.updateMatrixWorld(true);
      for (const localBox of body.userData.colliders) {
        this.colliders.push(localBox.clone().applyMatrix4(body.matrixWorld));
      }
    }
  }

  /**
   * 小门楼（协和门/熙和门）
   */
  addGateHall(parent, { x, z, w, d, h }) {
    const body = buildHallBody(this.library, {
      width: w,
      depth: d,
      height: h * 0.6,
      bays: 3,
      facade: 'open',
    });
    body.position.set(x, 0, z);
    parent.add(body);
    
    const roof = buildRoof(this.library, {
      type: 'xieshan',
      width: w,
      depth: d,
      baseY: h * 0.6,
      layers: 1,
      brackets: false,
      detail: 'low',
    });
    roof.position.set(x, 0, z);
    parent.add(roof);
    
    if (body.userData.colliders) {
      body.updateMatrixWorld(true);
      for (const localBox of body.userData.colliders) {
        this.colliders.push(localBox.clone().applyMatrix4(body.matrixWorld));
      }
    }
  }

  getColliders() {
    return [...this.colliders];
  }

  update() {}

  dispose() {
    const geometries = new Set();
    this.group.traverse(child => {
      if (child.geometry) geometries.add(child.geometry);
      // 收集 RoofBuilder 返回的 ownedMaterials
      if (child.userData?.ownedMaterials) {
        this.ownedMaterials.push(...child.userData.ownedMaterials);
      }
    });
    geometries.forEach(g => g.dispose());
    this.ownedMaterials.forEach(m => {
      if (!this.library.owns(m)) m.dispose();
    });
    this.group.removeFromParent();
    this.group.clear();
    this.colliders.length = 0;
    this.ownedMaterials.length = 0;
  }
}
