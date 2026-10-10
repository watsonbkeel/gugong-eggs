import * as THREE from 'three';

/**
 * 远山天际线环带（skyline 贴图，带 alpha 镂空天空部分）
 * 
 * 用法：在 Sky 之后、在地面之前加入场景，让远山在天空与地面之间。
 * 贴图已做 alpha 处理（天空区域透明、山体不透明），需要 transparent + alphaTest。
 */

export function createSkylineRing(library) {
  const texture = library.color('skyline');
  const radius = 900; // 略小于天空球，避免 z-fighting
  const height = texture.image?.height ?? 301; // hd manifest 记录为 301
  const width = texture.image?.width ?? 1211;
  const aspect = width / height;
  const bandHeight = 50; // 视觉高度（米），控制远山在地平线上下的跨度
  
  // CylinderGeometry：上下半径相同 = 直筒，不加盖
  const geometry = new THREE.CylinderGeometry(radius, radius, bandHeight, 64, 1, true);
  
  // UV：横向环绕一周（U 0→1），纵向覆盖带高（V 0→1）
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    // CylinderGeometry 自带 UV，横向已经 0→1 环绕；纵向默认也是 0→1
    // 由于 skyline wrap 是 band（横向 repeat、纵向 clamp），保持原样即可
  }
  
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.5, // 丢弃 alpha < 0.5 的片段（天空部分）
    side: THREE.DoubleSide,
    depthWrite: false, // 避免透明部分遮挡后面的物体
    fog: true,
  });
  
  const ring = new THREE.Mesh(geometry, material);
  ring.position.y = bandHeight * 0.3; // 抬升一点，让山体底部在地平线附近
  ring.rotation.y = Math.PI * 0.25; // 旋转让贴图的视觉中心对准合适的方向
  
  return ring;
}
