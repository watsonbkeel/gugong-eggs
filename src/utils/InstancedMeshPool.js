import * as THREE from 'three';

/**
 * InstancedMesh 对象池管理器
 * 用于批量渲染相同几何体，减少 Draw Call
 */

export class InstancedMeshPool {
  constructor() {
    this.pools = new Map();
  }
  
  /**
   * 创建或获取 InstancedMesh 池
   */
  createPool(name, geometry, material, count) {
    if (this.pools.has(name)) {
      return this.pools.get(name).mesh;
    }
    
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    
    this.pools.set(name, {
      mesh,
      currentIndex: 0,
      count,
    });
    
    return mesh;
  }
  
  /**
   * 添加实例到池中
   */
  addInstance(name, matrix) {
    const pool = this.pools.get(name);
    if (!pool) {
      console.error(`Pool ${name} not found`);
      return;
    }
    
    if (pool.currentIndex >= pool.count) {
      // 只提示一次，避免刷屏（之前单次加载会打出上万条警告）
      if (!pool.warned) {
        console.warn(`Pool ${name} is full (capacity ${pool.count})，多余实例已忽略`);
        pool.warned = true;
      }
      return;
    }
    
    pool.mesh.setMatrixAt(pool.currentIndex, matrix);
    pool.currentIndex++;
  }
  
  /**
   * 批量添加瓦片实例
   */
  addTiles(name, positions, rotation = { x: 0, y: 0, z: 0 }) {
    positions.forEach(pos => {
      const matrix = new THREE.Matrix4();
      matrix.makeRotationFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
      matrix.setPosition(pos.x, pos.y, pos.z);
      this.addInstance(name, matrix);
    });
  }
  
  /**
   * 更新所有实例
   */
  updateAll() {
    this.pools.forEach(pool => {
      // 只渲染实际写入的实例数量。
      // Three.js 会把未写入的实例初始化为单位矩阵，不截断的话
      // 剩余几万个瓦片会全部堆在原点 (0,0,0) 并白白消耗 GPU。
      pool.mesh.count = pool.currentIndex;
      pool.mesh.instanceMatrix.needsUpdate = true;
      // 按实际实例重新计算包围体，保证视锥剔除正确
      pool.mesh.computeBoundingBox();
      pool.mesh.computeBoundingSphere();
    });
  }
  
  /**
   * 获取池中的 mesh
   */
  getMesh(name) {
    const pool = this.pools.get(name);
    return pool ? pool.mesh : null;
  }
  
  /**
   * 获取所有 mesh
   */
  getAllMeshes() {
    return Array.from(this.pools.values()).map(pool => pool.mesh);
  }
  
  /**
   * 清空池
   */
  clear() {
    // 池只拥有实例网格；几何体、材质由调用方持有并统一释放。
    this.pools.forEach(pool => {
      pool.mesh.removeFromParent();
      pool.mesh.dispose();
    });
    this.pools.clear();
  }
}

/**
 * 创建屋顶瓦片实例位置
 */
export function generateTilePositions(width, depth, height, tilesPerRoof) {
  const positions = [];
  // 行列数取整，保证生成数量 rows * cols <= tilesPerRoof
  // （原实现用小数行列数做循环上限，实际生成数量会超过预期，导致池溢出）
  const rows = Math.max(1, Math.round(Math.sqrt(tilesPerRoof * (depth / width))));
  const cols = Math.max(1, Math.floor(tilesPerRoof / rows));
  
  const tileWidth = width / cols;
  const tileDepth = depth / rows;
  
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5 - cols / 2) * tileWidth;
      const z = (row + 0.5 - rows / 2) * tileDepth;
      
      // 屋顶坡度
      const y = height - Math.abs(x) * 0.15;
      
      positions.push({ x, y, z, cellWidth: tileWidth, cellDepth: tileDepth });
    }
  }
  
  return positions;
}

/**
 * 创建栏杆柱实例位置
 */
export function generateRailingPositions(width, depth, height, count) {
  const positions = [];
  const perimeter = (width + depth) * 2;
  const spacing = perimeter / count;
  
  let distance = 0;
  
  // 前边
  for (let i = 0; i < count / 4; i++) {
    positions.push({
      x: -width / 2 + (i / (count / 4)) * width,
      y: height,
      z: -depth / 2,
    });
  }
  
  // 右边
  for (let i = 0; i < count / 4; i++) {
    positions.push({
      x: width / 2,
      y: height,
      z: -depth / 2 + (i / (count / 4)) * depth,
    });
  }
  
  // 后边
  for (let i = 0; i < count / 4; i++) {
    positions.push({
      x: width / 2 - (i / (count / 4)) * width,
      y: height,
      z: depth / 2,
    });
  }
  
  // 左边
  for (let i = 0; i < count / 4; i++) {
    positions.push({
      x: -width / 2,
      y: height,
      z: depth / 2 - (i / (count / 4)) * depth,
    });
  }
  
  return positions;
}

/**
 * 创建树木实例位置
 */
export function generateTreePositions(centerX, centerZ, radius, count) {
  const positions = [];
  
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const r = radius * (0.5 + Math.random() * 0.5);
    
    positions.push({
      x: centerX + Math.cos(angle) * r,
      y: 0,
      z: centerZ + Math.sin(angle) * r,
    });
  }
  
  return positions;
}
