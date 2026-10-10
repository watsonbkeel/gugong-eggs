import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * 按三角面法线选择投影轴的三向投影 UV（同一三角面的三个顶点用同一投影，避免面内拉扯）。
 * 几何体须为非索引几何体。UV 1 单位 = tile 米。
 */
export function faceTriplanarUV(geometry, tile = 1) {
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i + 2 < pos.count; i += 3) {
    _a.fromBufferAttribute(pos, i);
    _b.fromBufferAttribute(pos, i + 1);
    _c.fromBufferAttribute(pos, i + 2);
    _n.subVectors(_c, _b).cross(_a.clone().sub(_b));
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k), y = pos.getY(i + k), z = pos.getZ(i + k);
      let u, v;
      if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z; v = y; } else { u = x; v = y; }
      uv[(i + k) * 2] = u / tile;
      uv[(i + k) * 2 + 1] = v / tile;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** 顶点共享的单位球多面体（便于顶点扰动后得到平滑法线）。 */
export function unitBlob(detail = 2, kind = 'ico') {
  const src = kind === 'dodeca' ? new THREE.DodecahedronGeometry(1, detail) : new THREE.IcosahedronGeometry(1, detail);
  src.deleteAttribute('normal');
  src.deleteAttribute('uv');
  const geo = mergeVertices(src, 1e-4);
  src.dispose();
  return geo;
}

/** 顶点共享的圆环（用于太湖石孔洞）。 */
export function unitTorus(tubeRatio = 0.42, radial = 10, tubular = 20) {
  const src = new THREE.TorusGeometry(1, tubeRatio, radial, tubular);
  src.deleteAttribute('normal');
  src.deleteAttribute('uv');
  const geo = mergeVertices(src, 1e-4);
  src.dispose();
  return geo;
}

/**
 * 沿曲线生成管状几何（树干、枝条）。
 * @param {THREE.Vector3[]} points 控制点
 * @param {(t:number, theta:number, s:number) => number} radiusFn t∈[0,1]、theta 角度、s 弧长（米）
 * @param {{ radial?: number, segments?: number, tile?: number, spiral?: number }} opts
 *   spiral：树皮纹理每米横向偏移量（产生扭转纹理）
 * @returns {THREE.BufferGeometry} 带索引，含 position/normal/uv
 */
export function tubeGeometry(points, radiusFn, { radial = 10, segments = 12, tile = 1.5, spiral = 0 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const frames = curve.computeFrenetFrames(segments, false);
  const length = curve.getLength();
  const r0 = radiusFn(0.2, 0, length * 0.2);
  const uRepeat = Math.max(1, Math.round((Math.PI * 2 * r0) / tile));
  const pos = [];
  const uv = [];
  const idx = [];
  const P = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, P);
    const N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const r = radiusFn(t, th, t * length);
      const c = Math.cos(th), s = Math.sin(th);
      pos.push(P.x + r * (c * N.x + s * B.x), P.y + r * (c * N.y + s * B.y), P.z + r * (c * N.z + s * B.z));
      uv.push((j / radial) * uRepeat + (t * length * spiral) / tile, (t * length) / tile);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // 确认法线朝外：取中段一个顶点检查与径向方向的点积，反了则翻转索引
  const mid = Math.floor(segments / 2) * (radial + 1);
  curve.getPointAt(Math.floor(segments / 2) / segments, P);
  const radialDir = new THREE.Vector3().fromBufferAttribute(geo.attributes.position, mid).sub(P);
  const normal = new THREE.Vector3().fromBufferAttribute(geo.attributes.normal, mid);
  if (radialDir.dot(normal) < 0) {
    const index = geo.index.array;
    for (let k = 0; k < index.length; k += 3) { const tmp = index[k + 1]; index[k + 1] = index[k + 2]; index[k + 2] = tmp; }
    geo.index.needsUpdate = true;
    geo.computeVertexNormals();
  }
  // 缝合接缝处法线
  const nor = geo.attributes.normal;
  for (let i = 0; i <= segments; i++) {
    const a = i * (radial + 1), b = a + radial;
    const x = (nor.getX(a) + nor.getX(b)) / 2, y = (nor.getY(a) + nor.getY(b)) / 2, z = (nor.getZ(a) + nor.getZ(b)) / 2;
    const l = Math.hypot(x, y, z) || 1;
    nor.setXYZ(a, x / l, y / l, z / l);
    nor.setXYZ(b, x / l, y / l, z / l);
  }
  geo.userData.curve = curve;
  geo.userData.length = length;
  return geo;
}

/** 填充常量颜色属性 */
export function fillColor(geometry, r, g, b) {
  const count = geometry.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geometry;
}
