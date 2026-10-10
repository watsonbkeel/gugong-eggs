import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 把一个对象树内的所有 Mesh 按材质合并成少量 Mesh，减少绘制调用（draw call）。
 *
 * - 以 root 的局部坐标系为基准烘焙子网格的变换（root 自身的 position/rotation/scale 保留在返回的 Group 上）。
 * - 源几何体在合并后被 dispose；材质原样复用（材质归贴图库或调用方所有，这里不释放）。
 * - InstancedMesh、Points、Line、Sprite 以及 userData.noMerge === true 的对象不合并，原样保留在结果中。
 * - 各几何体属性不一致时（如有的缺 uv / normal），自动补齐 uv（全 0）或计算法线，保证可合并。
 *
 * @param {THREE.Object3D} root
 * @param {{ castShadow?: boolean, receiveShadow?: boolean, name?: string }} [options]
 * @returns {THREE.Group} 新的 Group（继承 root 的变换与 name）
 */
export function mergeByMaterial(root, { castShadow = true, receiveShadow = true, name } = {}) {
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map();
  const keep = [];
  const sources = new Set();

  root.traverse(child => {
    if (child === root) return;
    if (!child.isMesh || child.isInstancedMesh || child.userData.noMerge || Array.isArray(child.material)) {
      if ((child.isInstancedMesh || child.userData.noMerge || child.isPoints || child.isLine || child.isSprite) && child.parent) {
        keep.push(child);
      }
      return;
    }
    const matrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, child.matrixWorld);
    let geometry = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    geometry.applyMatrix4(matrix);
    // 镜像变换（行列式 < 0）会翻转三角形朝向，需要交换顶点顺序
    if (matrix.determinant() < 0) flipWinding(geometry);
    sources.add(child.geometry);
    const key = child.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { material: child.material, geometries: [], cast: false, receive: false });
    const bucket = buckets.get(key);
    bucket.geometries.push(geometry);
    bucket.cast ||= child.castShadow;
    bucket.receive ||= child.receiveShadow;
  });

  const group = new THREE.Group();
  group.name = name ?? root.name;
  group.position.copy(root.position);
  group.quaternion.copy(root.quaternion);
  group.scale.copy(root.scale);
  group.userData = { ...root.userData };

  for (const { material, geometries, cast, receive } of buckets.values()) {
    normalizeAttributes(geometries);
    const merged = mergeGeometries(geometries, false);
    geometries.forEach(g => g.dispose());
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = castShadow && cast;
    mesh.receiveShadow = receiveShadow && receive;
    mesh.name = `${group.name}_${material.name || 'merged'}`;
    group.add(mesh);
  }

  for (const child of keep) {
    // 保留对象：把相对 root 的变换写回到自身，然后挂到新 Group 上
    const matrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, child.matrixWorld);
    child.removeFromParent();
    matrix.decompose(child.position, child.quaternion, child.scale);
    group.add(child);
  }

  sources.forEach(g => g.dispose());
  return group;
}

function flipWinding(geometry) {
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.attributes[name];
    const size = attr.itemSize;
    const array = attr.array;
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < size; k++) {
        const a = (i + 1) * size + k;
        const b = (i + 2) * size + k;
        const tmp = array[a];
        array[a] = array[b];
        array[b] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

function normalizeAttributes(geometries) {
  const names = new Set();
  geometries.forEach(g => Object.keys(g.attributes).forEach(n => names.add(n)));
  for (const g of geometries) {
    if (names.has('normal') && !g.attributes.normal) g.computeVertexNormals();
    if (names.has('uv') && !g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const n of Object.keys(g.attributes)) {
      if (n !== 'position' && n !== 'normal' && n !== 'uv') g.deleteAttribute(n);
    }
    g.morphAttributes = {};
  }
  // 若有任意几何体缺失 normal/uv 且无法补齐，则全部删除该属性
  for (const n of ['normal', 'uv']) {
    if (!geometries.every(g => g.attributes[n])) geometries.forEach(g => g.deleteAttribute(n));
  }
}

/**
 * 把 Box3 从对象局部坐标转换到世界坐标（用于合并后的碰撞代理）。
 */
export function worldBox(object, localBox) {
  object.updateMatrixWorld(true);
  return localBox.clone().applyMatrix4(object.matrixWorld);
}
