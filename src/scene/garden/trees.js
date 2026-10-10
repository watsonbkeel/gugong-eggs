import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, noise3, fbm } from './noise.js';
import { tubeGeometry, unitBlob, faceTriplanarUV } from './shapes.js';

/**
 * 御花园树木变体：古柏（老干扭曲 / 丰满 / 高耸）与油松。
 * 每个变体返回一份树干几何（含主枝）与一份树冠几何（若干变形团簇合并，带顶点色与外扩法线），
 * 由 GardenBuilder 用 InstancedMesh 实例化。
 */
export const TREE_KINDS = {
  oldCypress: { height: [9, 11], radius: [0.6, 0.72], lean: [1.0, 2.0], branches: [4, 5], elev: [30, 55], len: [3.2, 5.2], flute: 0.16, clumpR: [1.5, 2.3], flat: 0.78, tint: [0.78, 0.88, 0.75] },
  cypress:    { height: [10, 12], radius: [0.5, 0.62], lean: [0.3, 0.9], branches: [5, 6], elev: [40, 62], len: [2.6, 4.2], flute: 0.12, clumpR: [1.6, 2.4], flat: 0.85, tint: [0.82, 0.92, 0.78] },
  tallCypress:{ height: [12, 14], radius: [0.48, 0.58], lean: [0.2, 0.6], branches: [6, 7], elev: [52, 70], len: [2.0, 3.2], flute: 0.1, clumpR: [1.3, 1.9], flat: 0.95, tint: [0.76, 0.86, 0.72] },
  pine:       { height: [8, 9.5], radius: [0.42, 0.52], lean: [1.4, 2.6], branches: [5, 6], elev: [6, 24], len: [3.4, 5.4], flute: 0.05, clumpR: [1.5, 2.0], flat: 0.42, tint: [0.92, 0.94, 0.78], pine: true },
};

const range = (rng, [a, b]) => a + (b - a) * rng();

export function buildTreeVariant(kindName, seed, barkTile = 1.5, foliageTile = 3) {
  const kind = TREE_KINDS[kindName];
  const rng = mulberry32(seed);
  const H = range(rng, kind.height);
  const r0 = range(rng, kind.radius);
  const leanAz = rng() * Math.PI * 2;
  const lean = range(rng, kind.lean);
  const phase = rng() * 10;

  // 主干：带倾斜与蛇形弯曲的中心线
  const trunkPts = [];
  let wx = 0, wz = 0;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    if (i > 1) { wx += (rng() - 0.5) * 0.8; wz += (rng() - 0.5) * 0.8; }
    const l = lean * Math.pow(t, 1.4);
    trunkPts.push(new THREE.Vector3(Math.cos(leanAz) * l + wx * t, -0.4 + t * (H + 0.4), Math.sin(leanAz) * l + wz * t));
  }
  const trunkRadius = (t, th, s) => {
    const taper = 1 - 0.72 * t;
    const flare = 1 + 0.9 * Math.exp(-s / 0.75);
    const flute = 1 + kind.flute * Math.sin(5 * th + s * 0.85 + phase) + kind.flute * 0.4 * Math.sin(11 * th - s * 1.6);
    const burl = 1 + 0.07 * noise3(Math.cos(th) * 1.5, s * 0.7, Math.sin(th) * 1.5, seed);
    return r0 * taper * flare * flute * burl;
  };
  const trunk = tubeGeometry(trunkPts, trunkRadius, { radial: 12, segments: 16, tile: barkTile, spiral: kind.pine ? 0.05 : 0.35 });
  const trunkCurve = trunk.userData.curve;
  const tubes = [trunk];

  // 主枝与团簇
  const clumps = [];
  const nBranch = Math.round(range(rng, kind.branches));
  const P = new THREE.Vector3();
  for (let i = 0; i < nBranch; i++) {
    const tb = (kind.pine ? 0.42 : 0.36) + (i / nBranch) * 0.5 + (rng() - 0.5) * 0.06;
    trunkCurve.getPointAt(Math.min(tb, 0.95), P);
    const az = i * 2.39996 + rng() * 0.6 + leanAz * 0.3;
    const elev = THREE.MathUtils.degToRad(range(rng, kind.elev));
    const L = range(rng, kind.len) * (1 - tb * 0.35);
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const up = new THREE.Vector3(0, 1, 0);
    const bend = (rng() - 0.5) * 0.8;
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(bend);
    const pts = [
      P.clone(),
      P.clone().addScaledVector(dir, L * 0.35).addScaledVector(side, 0.3),
      P.clone().addScaledVector(dir, L * 0.7).addScaledVector(up, kind.pine ? 0.1 : 0.35).addScaledVector(side, 0.7),
      P.clone().addScaledVector(dir, L).addScaledVector(up, kind.pine ? 0.25 : 0.8).addScaledVector(side, 1),
    ];
    const rb = r0 * (1 - 0.72 * tb) * 0.62;
    const branch = tubeGeometry(pts, (t, th) => rb * (1 - 0.65 * t) * (1 + 0.08 * Math.sin(4 * th + t * 6)), { radial: 7, segments: 7, tile: barkTile, spiral: 0.2 });
    tubes.push(branch);
    const bc = branch.userData.curve;
    const R = range(rng, kind.clumpR) * (1 - tb * 0.25);
    clumps.push({ c: bc.getPointAt(1).add(new THREE.Vector3(0, R * (kind.pine ? 0.15 : 0.35), 0)), R });
    if (rng() < 0.5) clumps.push({ c: bc.getPointAt(0.55).add(new THREE.Vector3(0, R * 0.4, 0)), R: R * 0.75 });
  }
  // 顶部团簇
  const topR = range(rng, kind.clumpR);
  clumps.push({ c: trunkCurve.getPointAt(1).add(new THREE.Vector3(0, topR * 0.3, 0)), R: topR * (kind.pine ? 1.1 : 0.9) });
  clumps.push({ c: trunkCurve.getPointAt(0.82).add(new THREE.Vector3(0, 0, 0)), R: topR });
  if (!kind.pine) clumps.push({ c: trunkCurve.getPointAt(1).add(new THREE.Vector3((rng() - 0.5), topR * 1.2, (rng() - 0.5))), R: topR * 0.62 });
  if (kindName === 'tallCypress') {
    clumps.push({ c: trunkCurve.getPointAt(0.6).clone(), R: topR * 1.1 });
    clumps.push({ c: trunkCurve.getPointAt(0.45).clone(), R: topR * 1.05 });
  }

  // 树冠：团簇几何
  const center = new THREE.Vector3();
  clumps.forEach(k => center.add(k.c));
  center.divideScalar(clumps.length);
  let minY = Infinity, maxY = -Infinity;
  clumps.forEach(k => { minY = Math.min(minY, k.c.y - k.R); maxY = Math.max(maxY, k.c.y + k.R); });
  const parts = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const out = new THREE.Vector3();
  clumps.forEach((k, ci) => {
    const blob = unitBlob(2);
    const pos = blob.attributes.position;
    const sx = k.R * (kind.pine ? 1.35 : 1) * (0.9 + rng() * 0.2);
    const sz = k.R * (kind.pine ? 1.35 : 1) * (0.9 + rng() * 0.2);
    const sy = k.R * kind.flat;
    const s = seed * 7 + ci * 13;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const d = 1 + 0.34 * fbm(v.x * 1.4, v.y * 1.4, v.z * 1.4, s, 3) + 0.14 * noise3(v.x * 4.5, v.y * 4.5, v.z * 4.5, s + 5);
      // 底部略收平，模拟团簇下缘
      const y = v.y < -0.3 ? v.y * 0.75 : v.y;
      pos.setXYZ(i, k.c.x + v.x * d * sx, k.c.y + y * d * sy, k.c.z + v.z * d * sz);
    }
    blob.computeVertexNormals();
    // 法线向树冠外侧偏转，光照更柔和；顶点色：下部与内侧更暗
    const nor = blob.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    const tintJ = 0.9 + rng() * 0.2;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nor, i);
      out.subVectors(v, center).normalize();
      const facing = n.dot(out);
      n.multiplyScalar(0.45).addScaledVector(out, 0.55).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
      const h = (v.y - minY) / Math.max(maxY - minY, 0.01);
      const ao = (0.48 + 0.36 * h + 0.26 * Math.max(facing, 0)) * tintJ * (1 + 0.12 * noise3(v.x * 2, v.y * 2, v.z * 2, s + 9));
      col[i * 3] = kind.tint[0] * ao;
      col[i * 3 + 1] = kind.tint[1] * ao;
      col[i * 3 + 2] = kind.tint[2] * ao;
    }
    blob.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const flat = blob.toNonIndexed();
    blob.dispose();
    parts.push(faceTriplanarUV(flat, foliageTile));
  });
  const crown = mergeGeometries(parts, false);
  parts.forEach(g => g.dispose());

  const flatTubes = tubes.map(g => { const f = g.toNonIndexed(); g.dispose(); return f; });
  const trunkGeo = mergeGeometries(flatTubes, false);
  flatTubes.forEach(g => g.dispose());
  trunkGeo.computeBoundingSphere();
  crown.computeBoundingSphere();
  return { trunk: trunkGeo, crown, trunkRadius: r0, height: maxY };
}

/**
 * 树冠风摆材质（自有材质，复用贴图库的贴图；调用方负责 dispose 材质本身）。
 * @param {{ value: number }} timeUniform
 */
export function createFoliageMaterial(lib, timeUniform) {
  const material = new THREE.MeshStandardMaterial({
    map: lib.color('foliage'),
    normalMap: lib.normal('foliage'),
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
  });
  if (material.normalMap) material.normalScale = new THREE.Vector2(0.8, 0.8);
  material.name = 'garden_foliage_wind';
  material.onBeforeCompile = shader => {
    shader.uniforms.uWindTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        float hgt = max(transformed.y - 3.0, 0.0);
        float ph = 0.0;
        #ifdef USE_INSTANCING
          ph = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.23;
        #endif
        transformed.x += sin(uWindTime * 1.1 + ph) * 0.011 * hgt + sin(uWindTime * 2.7 + transformed.y) * 0.02;
        transformed.z += cos(uWindTime * 0.9 + ph * 1.3) * 0.009 * hgt;
      }`);
  };
  material.customProgramCacheKey = () => 'garden_foliage_wind';
  return material;
}
