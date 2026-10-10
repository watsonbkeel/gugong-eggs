import * as THREE from 'three';
import { COLORS } from '../config/constants.js';
import { PALACE_LAYOUT } from './Layout.js';
import { createSky, getSunPosition, updateSkyUniforms, generatePMREM } from './sky/SkySetup.js';
import { createSkylineRing } from './sky/Skyline.js';

/**
 * 环境设置：天空、地面、雾效、光照
 */

export class Environment {
  constructor(scene, renderer, library) {
    this.scene = scene;
    this.renderer = renderer;
    this.library = library;
    this.objects = [];
    this.shadowOffset = new THREE.Vector3(100, 200, 100);
    this.sunPosition = getSunPosition(145, 28); // 降低太阳仰角，避免直射视野
  }

  addObject(object) {
    this.objects.push(object);
    this.scene.add(object);
    return object;
  }
  
  /**
   * 初始化环境
   */
  init() {
    this.setupSky();
    this.setupSkyline();
    this.setupGround();
    this.setupFog();
    this.setupLights();
    this.setupIBL();
  }
  
  /**
   * 设置天空（Preetham 天空模型）
   */
  setupSky() {
    const sky = createSky();
    updateSkyUniforms(sky, this.sunPosition);
    sky.frustumCulled = false;
    this.sky = this.addObject(sky);
  }
  
  /**
   * 设置远山天际线环带
   */
  setupSkyline() {
    const ring = createSkylineRing(this.library);
    this.skylineRing = this.addObject(ring);
  }
  
  /**
   * 设置地面（ground_brick 贴图，带河道孔洞）+ 中轴御道（stone_slab）
   */
  setupGround() {
    // 主地面：XY 平面旋转到 XZ，河道用孔而非被完整地面遮住
    const shape = new THREE.Shape();
    shape.moveTo(-500, -500);
    shape.lineTo(500, -500);
    shape.lineTo(500, 500);
    shape.lineTo(-500, 500);
    shape.closePath();
    for (const river of PALACE_LAYOUT.filter(item => item.type === 'river')) {
      const { position: p, dimensions: d } = river;
      const hole = new THREE.Path();
      const left = p.x - d.width / 2;
      const right = p.x + d.width / 2;
      const bottom = -p.z - d.depth / 2;
      const top = -p.z + d.depth / 2;
      hole.moveTo(left, bottom);
      hole.lineTo(left, top);
      hole.lineTo(right, top);
      hole.lineTo(right, bottom);
      hole.closePath();
      shape.holes.push(hole);
    }
    
    const groundGeometry = new THREE.ShapeGeometry(shape);
    const tileSize = this.library.tileSize('ground_brick');
    const uv = groundGeometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) / tileSize, uv.getY(i) / tileSize);
    }
    
    const groundMaterial = this.library.material('ground_brick', { roughness: 0.88, metalness: 0 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    this.addObject(ground);
    
    // 中轴御道（stone_slab，沿 z 轴从午门到神武门）
    const roadWidth = 8;
    const roadGeometry = new THREE.PlaneGeometry(roadWidth, 600);
    const roadTileSize = this.library.tileSize('stone_slab');
    const roadUV = roadGeometry.attributes.uv;
    for (let i = 0; i < roadUV.count; i++) {
      roadUV.setXY(i, roadUV.getX(i) * roadWidth / roadTileSize, roadUV.getY(i) * 600 / roadTileSize);
    }
    const roadMaterial = this.library.material('stone_slab', { roughness: 0.75, metalness: 0 });
    const road = new THREE.Mesh(roadGeometry, roadMaterial);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.01, 0); // 略高于地面，避免 z-fighting
    road.receiveShadow = true;
    this.addObject(road);
  }
  
  /**
   * 设置雾效（暖色调，与天空呼应）
   */
  setupFog() {
    // 金黄偏暖的雾色，与下午阳光呼应
    this.scene.fog = new THREE.FogExp2(0xd4c4a8, 0.00065);
  }
  
  /**
   * 设置光照（暖色太阳 + 半球光 + 填充光）
   */
  setupLights() {
    // 半球光（环境光）
    const hemiLight = new THREE.HemisphereLight(
      0xfff4e6, // 天空色：暖白偏金
      0x8a8272, // 地面色：暖灰
      0.5
    );
    hemiLight.position.set(0, 50, 0);
    this.addObject(hemiLight);
    
    // 方向光（太阳）：金黄偏橙的暖色调
    const dirLight = new THREE.DirectionalLight(0xfff5e1, 1.4);
    dirLight.position.set(100, 200, 100);
    dirLight.castShadow = true;
    
    // 阴影配置
    dirLight.shadow.camera.left = -200;
    dirLight.shadow.camera.right = 200;
    dirLight.shadow.camera.top = 200;
    dirLight.shadow.camera.bottom = -200;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 500;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.bias = -0.0001;
    
    this.addObject(dirLight);
    this.addObject(dirLight.target);
    
    // 辅助光源（填充暗部，略带蓝调平衡暖色）
    const fillLight = new THREE.DirectionalLight(0xd8e8ff, 0.25);
    fillLight.position.set(-50, 50, -50);
    this.addObject(fillLight);
    
    this.dirLight = dirLight;
  }
  
  /**
   * 设置 IBL（PMREM 环境贴图）
   */
  setupIBL() {
    const envMap = generatePMREM(this.renderer, this.scene);
    this.scene.environment = envMap;
    this.scene.environmentIntensity = 0.6; // r162+ 支持
    this.envMap = envMap;
  }
  
  /**
   * 调整光照质量（移动端降低阴影分辨率）
   */
  setQuality(isHighQuality) {
    if (!this.dirLight) return;
    const size = isHighQuality ? 2048 : 512;
    if (this.dirLight.shadow.mapSize.width === size) return;
    
    if (isHighQuality) {
      this.dirLight.shadow.mapSize.width = 2048;
      this.dirLight.shadow.mapSize.height = 2048;
    } else {
      this.dirLight.shadow.mapSize.width = 512;
      this.dirLight.shadow.mapSize.height = 512;
    }
    
    // 需要重新创建阴影贴图
    if (this.dirLight.shadow.map) {
      this.dirLight.shadow.map.dispose();
      this.dirLight.shadow.map = null;
    }
    this.dirLight.shadow.needsUpdate = true;
  }

  update(camera, dt) {
    // 天空随观察者移动，光源与投影中心覆盖当前位置而非仅覆盖场景原点。
    this.sky.position.copy(camera.position);
    this.skylineRing.position.set(camera.position.x, this.skylineRing.position.y, camera.position.z);
    this.dirLight.target.position.set(camera.position.x, 0, camera.position.z);
    this.dirLight.position.copy(this.dirLight.target.position).add(this.shadowOffset);
  }

  dispose() {
    for (const object of this.objects) {
      object.removeFromParent();
      object.geometry?.dispose();
      object.material?.dispose();
      object.shadow?.dispose();
    }
    this.objects.length = 0;
    this.scene.fog = null;
    if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
    this.scene.environment = null;
  }
}
