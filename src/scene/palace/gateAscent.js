import * as THREE from 'three';
import { applyBoxUV } from '../../utils/GeometryUV.js';

/**
 * 城台登城马道（踏道）：参考午门 / 神武门实物，在城台内侧（宫内一侧）两端设斜坡踏道，
 * 从地面沿城台端头外侧上到城台顶面。城台顶面四周有宇墙 / 栏杆，在马道到达处开口。
 *
 * 坐标约定（城台局部坐标）：原点为城台底面中心，城台占 x ∈ [-W/2, W/2]、z ∈ [-D/2, D/2]，
 * 顶面高度 topY。马道沿 ±X 方向从端头 x = side·W/2（高 topY）向外下行 run 米到地面。
 * 马道横向占 z ∈ band。
 *
 * 返回的碰撞体 / 可行走面都是局部坐标，调用方用 toWorld(matrix) 转成世界坐标。
 *
 * 碰撞做法：马道实体按 0.5m 切片，每片碰撞盒顶 = 该片最低点高度 - 0.05。
 * 站在马道上的人身体底部（脚面 + 0.35）总高于脚下及相邻切片的顶，不受阻挡；
 * 在地面上从侧面走过来会被挡住，只能从马道下端口进入。坡度需 ≤ 0.5（约 27°）。
 */
export function buildGateAscent(lib, parent, {
  W, D, topY,
  sides = [-1, 1],          // 哪一端设马道
  band,                     // [z0, z1] 马道横向范围（局部 z）
  run,                      // 水平长度；默认 topY / 0.5
  parapetH = 1.1,           // 马道两侧宇墙高
  edge = 'rail',            // 城台顶四周：'rail' 汉白玉栏杆 | 'wall' 红色宇墙 | null（已有，不再建）
  edgeInset = 0.3,
}) {
  const colliders = [];
  const walkables = [];
  const L = run ?? topY / 0.5;
  const [bz0, bz1] = band;
  const bw = bz1 - bz0;
  const bzc = (bz0 + bz1) / 2;
  const slope = topY / L;

  const brick = lib.material('wall_brick');
  const brickT = lib.tileSize('wall_brick');
  const red = lib.material('wall_red');
  const redT = lib.tileSize('wall_red');
  const stone = lib.material('stone_slab');
  const stoneT = lib.tileSize('stone_slab');

  const add = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const col = (x0, y0, z0, x1, y1, z1) => colliders.push(new THREE.Box3(
    new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
    new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
  ));

  /** 楔形体：沿 X 的长条，底面 y=yb(x)，顶面 y=yt(x)（线性），横向 z ∈ [z0, z1] */
  const wedge = (xa, xb, z0, z1, yb, yt, mat, tile) => {
    const geo = new THREE.BoxGeometry(Math.abs(xb - xa), 1, z1 - z0);
    const pos = geo.attributes.position;
    const xmin = Math.min(xa, xb);
    const len = Math.abs(xb - xa);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + xmin + len / 2;
      pos.setX(i, x);
      pos.setY(i, pos.getY(i) > 0 ? yt(x) : yb(x));
      pos.setZ(i, pos.getZ(i) + (z0 + z1) / 2);
    }
    geo.computeVertexNormals();
    return add(applyBoxUV(geo, tile), mat);
  };

  for (const side of sides) {
    const xTop = side * W / 2;
    const xBot = side * (W / 2 + L);
    const h = x => THREE.MathUtils.clamp(topY * (1 - Math.abs(x - xTop) / L), 0, topY);

    // 马道墩身（灰砖楔形）
    wedge(xTop, xBot, bz0, bz1, () => 0, x => h(x) - 0.12, brick, brickT);
    // 踏步：逐级石条（只做面层，墩身已实心）
    const n = Math.max(4, Math.round(topY / 0.18));
    const sr = L / n;
    for (let k = 0; k < n; k++) {
      const xa = xBot - side * k * sr;
      const xb = xa - side * sr;
      const top = topY * (k + 1) / n;
      const geo = applyBoxUV(new THREE.BoxGeometry(sr, 0.22, bw - 0.1), stoneT);
      const m = add(geo, stone);
      m.position.set((xa + xb) / 2, top - 0.11, bzc);
    }
    // 两侧宇墙（红墙随坡）
    for (const zEdge of [bz0, bz1]) {
      const zi = zEdge === bz0 ? zEdge : zEdge - 0.45;
      wedge(xTop, xBot, zi, zi + 0.45, x => Math.max(0, h(x) - 0.3), x => h(x) + parapetH, red, redT);
    }
    // 下端口两侧墩柱（入口标识）
    for (const zEdge of [bz0, bz1]) {
      const g = applyBoxUV(new THREE.BoxGeometry(0.7, parapetH + 0.6, 0.7), redT);
      const m = add(g, red);
      m.position.set(xBot - side * 0.35, (parapetH + 0.6) / 2, zEdge === bz0 ? bz0 + 0.2 : bz1 - 0.2);
    }

    // 行走面：沿 X 的坡道（下端 y=0 → 上端 y=topY），上端再延伸 0.6m 平台接城台
    walkables.push({ type: 'ramp', axis: 'x', minX: Math.min(xTop, xBot), maxX: Math.max(xTop, xBot),
      minZ: bz0 + 0.45, maxZ: bz1 - 0.45, a0: xBot, a1: xTop, y0: 0, y1: topY });

    // 碰撞：墩身切片 + 两侧宇墙切片
    const SEG = 0.5;
    const segs = Math.ceil(L / SEG);
    for (let j = 0; j < segs; j++) {
      const xa = xBot - side * j * SEG;
      const xb = xBot - side * Math.min(L, (j + 1) * SEG);
      const lo = Math.min(h(xa), h(xb));
      const hi = Math.max(h(xa), h(xb));
      if (lo - 0.05 > 0.3) col(xa, 0, bz0, xb, lo - 0.05, bz1);
      // 宇墙碰撞比视觉高 1.5m：防止在马道上起跳翻出去摔下城台
      col(xa, 0, bz0, xb, hi + parapetH + 1.5, bz0 + 0.45);
      col(xa, 0, bz1 - 0.45, xb, hi + parapetH + 1.5, bz1);
    }
    // 墩身最低几片是矮坡，直接迈上；入口墩柱
    col(xBot - side * 0.7, 0, bz0, xBot, parapetH + 0.6, bz0 + 0.45);
    col(xBot - side * 0.7, 0, bz1 - 0.45, xBot, parapetH + 0.6, bz1);
  }

  // 城台顶面：可行走，但不"托起"（下方有门洞，穿门洞时不能被托上城台）
  walkables.push({ type: 'box', rescue: false,
    box: new THREE.Box3(new THREE.Vector3(-W / 2, topY, -D / 2), new THREE.Vector3(W / 2, topY, D / 2)) });

  // 城台顶四周栏杆 / 宇墙：两端在马道到达处开口
  const ex = W / 2 - edgeInset;
  const ez = D / 2 - edgeInset;
  const railMat = edge === 'rail' ? lib.material('balustrade', { alphaTest: 0.5, side: THREE.DoubleSide }) : red;
  const railTile = edge === 'rail' ? lib.tileSize('balustrade') : redT;
  const edgeH = edge === 'rail' ? 1.2 : 1.2;
  const edgeT = edge === 'rail' ? 0.2 : 0.6;
  const seg = (x0, z0, x1, z1) => {
    const lx = Math.abs(x1 - x0), lz = Math.abs(z1 - z0);
    if (Math.max(lx, lz) < 0.3) return;
    if (edge) {
      const g = applyBoxUV(new THREE.BoxGeometry(Math.max(lx, edgeT), edgeH, Math.max(lz, edgeT)), railTile);
      const m = add(g, railMat);
      m.position.set((x0 + x1) / 2, topY + edgeH / 2, (z0 + z1) / 2);
    }
    // 城台顶是观景平台：护栏碰撞做高（不可跳出），避免从十几米高处跳下
    col(Math.min(x0, x1) - edgeT / 2, topY + 0.2, Math.min(z0, z1) - edgeT / 2,
      Math.max(x0, x1) + edgeT / 2, topY + edgeH + 3, Math.max(z0, z1) + edgeT / 2);
  };
  seg(-ex, -ez, ex, -ez);
  seg(-ex, ez, ex, ez);
  for (const s of [-1, 1]) {
    const x = s * ex;
    if (sides.includes(s)) {
      const g0 = Math.max(-ez, bz0), g1 = Math.min(ez, bz1);
      seg(x, -ez, x, g0);
      seg(x, g1, x, ez);
    } else {
      seg(x, -ez, x, ez);
    }
  }

  return { colliders, walkables };
}

/** 局部碰撞体 / 可行走面 → 世界坐标（支持绕 Y 旋转 90° 的倍数） */
export function toWorld({ colliders, walkables }, matrix) {
  const p = (x, z) => new THREE.Vector3(x, 0, z).applyMatrix4(matrix);
  const wc = colliders.map(b => b.clone().applyMatrix4(matrix));
  const ww = walkables.map(w => {
    if (w.type === 'box') return { type: 'box', rescue: w.rescue, box: w.box.clone().applyMatrix4(matrix) };
    // 坡道：局部沿 x，从 a0 → a1
    const a = p(w.minX, w.minZ), b = p(w.maxX, w.maxZ);
    const s = p(w.a0, (w.minZ + w.maxZ) / 2), e = p(w.a1, (w.minZ + w.maxZ) / 2);
    const alongX = Math.abs(e.x - s.x) >= Math.abs(e.z - s.z);
    return {
      type: 'ramp',
      minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
      axis: alongX ? 'x' : 'z',
      a0: alongX ? s.x : s.z, a1: alongX ? e.x : e.z,
      y0: w.y0, y1: w.y1,
    };
  });
  return { colliders: wc, walkables: ww };
}
