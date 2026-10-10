import * as THREE from 'three';

/**
 * 天空与 IBL 设置：简单渐变蓝天 + PMREM 环境光反射
 */

export function createSky() {
  // 简单的渐变蓝天球（从天顶深蓝到地平线浅蓝）
  const skyGeometry = new THREE.SphereGeometry(1000, 32, 32);
  const skyMaterial = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;
      
      void main() {
        float h = normalize(vWorldPosition).y;
        // 天顶到地平线的渐变，地平线以下保持浅色
        float t = max(h, 0.0);
        gl_FragColor = vec4(mix(bottomColor, topColor, t * t), 1.0);
      }
    `,
    uniforms: {
      topColor: { value: new THREE.Color(0x4a7ba7) },    // 天顶：深蓝
      bottomColor: { value: new THREE.Color(0xb8d4e8) }, // 地平线：浅蓝
    },
    side: THREE.BackSide,
  });
  
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.frustumCulled = false;
  return sky;
}

/**
 * 计算太阳位置（方位角 azimuth、仰角 elevation，单位度）
 */
export function getSunPosition(azimuth = 145, elevation = 28) {
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  ).multiplyScalar(450000);
}

/**
 * 更新天空 uniform（现在不需要了，保留接口兼容）
 */
export function updateSkyUniforms(sky, sunPosition) {
  // 简单渐变天空不需要太阳位置
}

/**
 * 生成 PMREM 环境贴图（用于 IBL）
 */
export function generatePMREM(renderer, scene) {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  const renderTarget = pmremGenerator.fromScene(scene, 0, 0.1, 1000);
  const envMap = renderTarget.texture;
  pmremGenerator.dispose();
  return envMap;
}
