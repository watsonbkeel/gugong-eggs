import * as THREE from 'three';

/**
 * 阴影配置管理器
 */

export class ShadowSetup {
  constructor(renderer) {
    this.renderer = renderer;
    this.worldPosition = new THREE.Vector3();
    this.originalCastShadow = new WeakMap();
  }
  
  /**
   * 初始化阴影配置
   */
  init(quality = 'high') {
    // 启用阴影
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    
    this.setQuality(quality);
  }
  
  /**
   * 设置阴影质量
   */
  setQuality(quality) {
    this.quality = quality;
    
    if (quality === 'high') {
      this.renderer.shadowMap.enabled = true;
    } else if (quality === 'low') {
      // 低画质仍保留阴影，但降低分辨率（在 Environment.js 中控制）
      this.renderer.shadowMap.enabled = true;
    }
  }
  
  /**
   * 配置光源阴影
   */
  setupLightShadow(light, mapSize = 2048) {
    light.castShadow = true;
    light.shadow.mapSize.width = mapSize;
    light.shadow.mapSize.height = mapSize;
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = 500;
    light.shadow.bias = -0.0001;
    
    if (light.isDirectionalLight) {
      light.shadow.camera.left = -200;
      light.shadow.camera.right = 200;
      light.shadow.camera.top = 200;
      light.shadow.camera.bottom = -200;
    }
  }
  
  /**
   * 根据距离禁用远处物体的阴影
   */
  updateShadowLOD(camera, objects, farDistance = 150) {
    objects.forEach(obj => {
      if (!this.originalCastShadow.has(obj)) this.originalCastShadow.set(obj, obj.castShadow);
      if (!this.originalCastShadow.get(obj)) return;
      // 全局实例池横跨多座建筑，按其原点剔除会错删身旁实例的阴影。
      if (obj.isInstancedMesh) return;
      obj.getWorldPosition(this.worldPosition);
      obj.castShadow = camera.position.distanceTo(this.worldPosition) <= farDistance;
      // receiveShadow 不属于远距投影开销，保留原设置。
    });
  }
}
