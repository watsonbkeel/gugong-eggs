import * as THREE from 'three';
import { mulberry32, noise3, fbm, smoothstep } from './noise.js';
import { unitBlob, unitTorus, faceTriplanarUV } from './shapes.js';

/**
 * 太湖石：变形多面体 + 凹坑（脊状噪声挖洞） + 少量环形体造穿透孔洞。
 * 返回非索引几何（position/normal/uv/color），局部坐标，已应用 matrix。
 */
export function makeRockGeometry({ size = [1, 1, 1], seed = 1, detail = 3, pits = 1, torus = false, matrix, tile = 3 }) {
  const geo = torus ? unitTorus(0.38 + mulberry32(seed)() * 0.12, 9, 18) : unitBlob(detail, seed % 2 ? 'ico' : 'dodeca');
  const pos = geo.attributes.position;
  const shade = new Float32Array(pos.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const p = v.clone().multiplyScalar(1.3);
    let d = 1 + 0.3 * fbm(p.x, p.y, p.z, seed, 3);
    // 太湖石溶蚀凹坑：阈值化噪声向内挖
    const pit1 = smoothstep(0.22, 0.6, noise3(v.x * 2.3 + 7, v.y * 2.3, v.z * 2.3, seed + 3));
    const pit2 = smoothstep(0.3, 0.7, noise3(v.x * 4.8, v.y * 4.8 + 3, v.z * 4.8, seed + 11));
    d -= pits * (0.42 * pit1 + 0.18 * pit2);
    // 水平层理
    d += 0.04 * Math.sin(v.y * 9 + noise3(v.x * 2, v.y, v.z * 2, seed) * 3);
    d = Math.max(d, 0.35);
    shade[i] = THREE.MathUtils.clamp(0.95 - pits * (0.55 * pit1 + 0.25 * pit2) + 0.1 * noise3(v.x * 6, v.y * 6, v.z * 6, seed + 21), 0.3, 1.05);
    if (torus) {
      pos.setXYZ(i, v.x * size[0] * (1 + 0.25 * (d - 1)), v.y * size[1] * (1 + 0.25 * (d - 1)), v.z * size[2] * d);
    } else {
      pos.setXYZ(i, v.x * d * size[0], v.y * d * size[1], v.z * d * size[2]);
    }
  }
  geo.computeVertexNormals();
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = shade[i];
    col[i * 3] = s * 1.0; col[i * 3 + 1] = s * 0.99; col[i * 3 + 2] = s * 0.95;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (matrix) geo.applyMatrix4(matrix);
  const flat = geo.toNonIndexed();
  geo.dispose();
  return faceTriplanarUV(flat, tile);
}

/**
 * 堆秀山：以 center 为底面中心，叠石成山，顶部平台高度 topY。
 * @returns {{ geometries: THREE.BufferGeometry[], colliders: THREE.Box3[], topY: number }}
 */
export function buildRockery({ center, radiusX = 6.5, radiusZ = 5.5, topY = 8, seed = 77, tile = 3 }) {
  const rng = mulberry32(seed);
  const geometries = [];
  const colliders = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const add = (x, y, z, sx, sy, sz, opts = {}) => {
    e.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5);
    if (opts.euler) e.copy(opts.euler);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(center.x + x, center.y + y, center.z + z), q, new THREE.Vector3(1, 1, 1));
    const geo = makeRockGeometry({ size: [sx, sy, sz], seed: Math.floor(rng() * 1e6), detail: opts.detail ?? 3, pits: opts.pits ?? 1, torus: opts.torus, matrix: m, tile });
    geometries.push(geo);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (bb.min.y < center.y + 0.6 && !opts.noCollide) {
      const box = bb.clone();
      // 外缘石块的包围盒略收缩，贴近可见表面
      const shrink = 0.15;
      box.min.x += sx * shrink; box.max.x -= sx * shrink;
      box.min.z += sz * shrink; box.max.z -= sz * shrink;
      box.min.y = center.y; box.max.y = Math.min(box.max.y, center.y + 3);
      colliders.push(box);
    }
    return geo;
  };

  // 山体核心（被外层石块包裹，保证无意外透空）
  add(0, topY * 0.32, 0, radiusX * 0.72, topY * 0.42, radiusZ * 0.72, { detail: 2, pits: 0.5 });
  add(0, topY * 0.68, 0, radiusX * 0.48, topY * 0.32, radiusZ * 0.48, { detail: 2, pits: 0.6 });

  // 底层：围一圈大块落地石
  const layers = [
    { n: 11, r: 1.0, y: 0.9, s: 1.9 },
    { n: 9, r: 0.8, y: topY * 0.3, s: 1.7 },
    { n: 7, r: 0.6, y: topY * 0.55, s: 1.5 },
    { n: 6, r: 0.42, y: topY * 0.78, s: 1.25 },
  ];
  layers.forEach((L, li) => {
    for (let i = 0; i < L.n; i++) {
      const a = (i / L.n) * Math.PI * 2 + rng() * 0.4 + li * 0.5;
      const rr = L.r * (0.9 + rng() * 0.15);
      const s = L.s * (0.8 + rng() * 0.45);
      add(Math.cos(a) * radiusX * rr, L.y + (rng() - 0.3) * 0.6, Math.sin(a) * radiusZ * rr,
        s * (1 + rng() * 0.4), s * (0.75 + rng() * 0.5), s * (1 + rng() * 0.3), { detail: li === 0 ? 3 : 2 });
    }
  });

  // 穿透孔洞：竖立的环形石（太湖石"透""漏"）
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.7;
    const rr = i % 2 ? 0.95 : 0.72;
    const y = i % 2 ? 1.7 : topY * 0.45;
    const s = 1.2 + rng() * 0.5;
    add(Math.cos(a) * radiusX * rr, y, Math.sin(a) * radiusZ * rr, s, s * 1.3, s * 0.9, {
      torus: true, pits: 0.4,
      euler: new THREE.Euler((rng() - 0.5) * 0.4, -a + Math.PI / 2, (rng() - 0.5) * 0.6),
      noCollide: y > 1,
    });
  }

  // 石笋：围绕顶部平台的竖峰
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng() * 0.5;
    const h = 1.4 + rng() * 1.3;
    add(Math.cos(a) * radiusX * 0.5, topY - 0.2 + h * 0.4, Math.sin(a) * radiusZ * 0.5, 0.55 + rng() * 0.3, h, 0.55 + rng() * 0.3, { detail: 2, pits: 0.8 });
  }

  // 山体整体碰撞（核心）
  colliders.push(new THREE.Box3(
    new THREE.Vector3(center.x - radiusX * 0.75, center.y, center.z - radiusZ * 0.75),
    new THREE.Vector3(center.x + radiusX * 0.75, center.y + 3, center.z + radiusZ * 0.75)));
  return { geometries, colliders, topY };
}
