/**
 * 几何体 UV 工具：让共享贴图（repeat=1）按真实尺寸平铺。
 *
 * 约定：UV 1 个单位 = tileSize 米。几何体须按真实尺寸创建（不要靠 mesh.scale 拉伸），
 * 否则平铺密度会随缩放变化。
 */

function toNonIndexedOwned(geometry) {
  if (!geometry.index) return geometry;
  const geo = geometry.toNonIndexed();
  geometry.dispose();
  return geo;
}

/**
 * 按面法线做三向投影（box mapping）。适用于 BoxGeometry、ExtrudeGeometry 等以平面为主的几何体。
 * @param {THREE.BufferGeometry} geometry
 * @param {number} tileSize 一张贴图对应的米数
 * @param {{ offsetU?: number, offsetV?: number }} [options]
 */
export function applyBoxUV(geometry, tileSize = 1, { offsetU = 0, offsetV = 0 } = {}) {
  // 注意：带索引的几何体会被转换为新对象并释放原对象，调用方必须使用返回值
  const geo = toNonIndexedOwned(geometry);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) {
      u = x; v = z;
    } else if (ax >= az) {
      u = z * Math.sign(nor.getX(i) || 1); v = y;
    } else {
      u = x * Math.sign(nor.getZ(i) || 1); v = y;
    }
    uv[i * 2] = u / tileSize + offsetU;
    uv[i * 2 + 1] = v / tileSize + offsetV;
  }
  geo.setAttribute('uv', new geo.attributes.position.constructor(uv, 2));
  return geo;
}

/**
 * 单轴平面投影：axis 'y' 用 (x, z)，'z' 用 (x, y)，'x' 用 (z, y)。
 */
export function applyPlanarUV(geometry, axis = 'y', tileSize = 1) {
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const [u, v] = axis === 'y' ? [x, z] : axis === 'z' ? [x, y] : [z, y];
    uv[i * 2] = u / tileSize;
    uv[i * 2 + 1] = v / tileSize;
  }
  geometry.setAttribute('uv', new pos.constructor(uv, 2));
  return geometry;
}

/**
 * 横向带状贴图（彩画、须弥座、栏板、斗拱、隔扇）：
 * 侧面 U 沿周长按 bandWidth 米平铺一次，V 在 [0,1] 覆盖整个高度；顶/底面给 v=0.5 附近的极窄条带以免拉伸花纹。
 * @param {THREE.BufferGeometry} geometry 通常为 BoxGeometry
 * @param {number} bandWidth 贴图横向重复一次对应的米数
 */
export function applyBandUV(geometry, bandWidth = 4) {
  const geo = toNonIndexedOwned(geometry);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox;
  const h = Math.max(max.y - min.y, 1e-6);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u, v;
    if (ay > ax && ay > az) {
      u = x / bandWidth; v = 0.5;
    } else if (ax > az) {
      u = z / bandWidth; v = (y - min.y) / h;
    } else {
      u = x / bandWidth; v = (y - min.y) / h;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new pos.constructor(uv, 2));
  return geo;
}

/**
 * 圆柱侧面：U 绕一圈 = 周长 / tileSize，V = 高度 / tileSize。CylinderGeometry 自带 UV，这里只做缩放。
 */
export function scaleCylinderUV(geometry, radius, height, tileSize = 1) {
  const uv = geometry.attributes.uv;
  const su = Math.max(1, Math.round((Math.PI * 2 * radius) / tileSize));
  const sv = height / tileSize;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geometry;
}
