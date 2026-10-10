import * as THREE from 'three';

/**
 * 碰撞辅助工具：把局部坐标 Box3 转换到世界坐标
 * @param {THREE.Object3D} object
 * @param {THREE.Box3} localBox
 * @returns {THREE.Box3}
 */
export function worldBox(object, localBox) {
  object.updateMatrixWorld(true);
  return localBox.clone().applyMatrix4(object.matrixWorld);
}

/**
 * 从 Mesh 提取世界坐标碰撞盒（仅 y < 3 的部分）
 */
export function colliderFromMesh(mesh, maxY = 3) {
  const local = new THREE.Box3().setFromObject(mesh);
  if (local.min.y >= maxY) return null;
  local.max.y = Math.min(local.max.y, maxY);
  return worldBox(mesh, local);
}

/**
 * 批量收集 group 内所有 Mesh 的碰撞盒（世界坐标，过滤 y >= 3）
 */
export function collectColliders(group, maxY = 3) {
  const colliders = [];
  group.traverse(child => {
    if (child.isMesh) {
      const box = colliderFromMesh(child, maxY);
      if (box) colliders.push(box);
    }
  });
  return colliders;
}
