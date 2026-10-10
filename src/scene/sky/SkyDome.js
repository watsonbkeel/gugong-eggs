import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/**
 * 物理大气散射天空（Preetham，基于 three Sky.js）。
 * 在原着色器上增加：整体亮度系数、太阳圆盘开关、地平线向雾色过渡（保证天空与雾无缝衔接）。
 */
export function createSkyMaterial({ sunDirection, turbidity, rayleigh, mieCoefficient, mieDirectionalG, intensity, horizonColor, horizonBlend, sunDisk = 1 }) {
  const shader = Sky.SkyShader;
  const fragmentShader = shader.fragmentShader
    .replace('uniform vec3 up;', 'uniform vec3 up;\nuniform float skyIntensity;\nuniform float sunDiskScale;\nuniform vec3 horizonColor;\nuniform float horizonBlend;')
    .replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk * sunDiskScale;')
    .replace('gl_FragColor = vec4( retColor, 1.0 );', `retColor *= skyIntensity;
			float haze = 1.0 - smoothstep( -0.02, horizonBlend, direction.y );
			retColor = mix( retColor, horizonColor, haze * haze * ( 3.0 - 2.0 * haze ) );
			gl_FragColor = vec4( retColor, 1.0 );`);
  const uniforms = THREE.UniformsUtils.clone(shader.uniforms);
  uniforms.turbidity.value = turbidity;
  uniforms.rayleigh.value = rayleigh;
  uniforms.mieCoefficient.value = mieCoefficient;
  uniforms.mieDirectionalG.value = mieDirectionalG;
  uniforms.sunPosition.value.copy(sunDirection);
  uniforms.skyIntensity = { value: intensity };
  uniforms.sunDiskScale = { value: sunDisk };
  uniforms.horizonColor = { value: horizonColor };
  uniforms.horizonBlend = { value: horizonBlend };
  return new THREE.ShaderMaterial({
    name: 'PalaceSky',
    uniforms,
    vertexShader: shader.vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
  });
}

/** 天空盒网格：着色器把深度压到远裁剪面，盒子尺寸只需落在相机远近裁剪面之间。 */
export function createSkyMesh(material, size = 1000) {
  const sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  sky.scale.setScalar(size);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.userData.noSSAO = true;
  return sky;
}

/** 柔和高空薄云贴图（横向拉长的卷云团），canvas 生成，白色 + alpha。 */
export function createCloudTexture(seed = 1) {
  const w = 512, h = 160;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 70; i++) {
    const t = rand();
    const x = w * (0.12 + 0.76 * t);
    const y = h * (0.5 + (rand() - 0.5) * 0.35 * Math.sin(t * Math.PI));
    const rx = w * (0.05 + rand() * 0.12) * Math.sin(0.25 + t * Math.PI * 0.9);
    const ry = rx * (0.22 + rand() * 0.2);
    const a = 0.05 + rand() * 0.08;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.6, `rgba(255,255,255,${a * 0.5})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 可平铺的平滑值噪声贴图（线性数据），用于地面大尺度明暗/脏污变化，消除贴图重复感。 */
export function createNoiseTexture(size = 256) {
  const grid = (n, seed) => {
    const g = new Float32Array(n * n);
    let s = seed;
    for (let i = 0; i < g.length; i++) { s = (s * 16807) % 2147483647; g[i] = s / 2147483647; }
    return (x, y) => g[((y % n + n) % n) * n + ((x % n + n) % n)];
  };
  const octaves = [[4, 0.5, 11], [8, 0.28, 23], [16, 0.14, 37], [32, 0.08, 51]].map(([n, amp, seed]) => ({ n, amp, at: grid(n, seed) }));
  const smooth = t => t * t * (3 - 2 * t);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const channels = [0, 0];
      octaves.forEach(({ n, amp, at }, index) => {
        const fx = (x / size) * n, fy = (y / size) * n;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = smooth(fx - ix), ty = smooth(fy - iy);
        const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
        const v = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
        // R：低频（大块明暗）；G：高频（细碎脏污）
        if (index < 2) channels[0] += v * amp / 0.78; else channels[1] += v * amp / 0.22;
      });
      const i = (y * size + x) * 4;
      data[i] = Math.round(channels[0] * 255);
      data[i + 1] = Math.round(channels[1] * 255);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
