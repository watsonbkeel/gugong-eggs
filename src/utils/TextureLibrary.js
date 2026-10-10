import * as THREE from 'three';
import { TextureGenerator } from './TextureGenerator.js';

/**
 * 写实材质贴图库
 *
 * - 贴图来自 public/textures/{hd|sd}/，由 assets-src/process_textures.py 从 AI 原图处理得到。
 * - 颜色贴图 sRGB，法线贴图线性；全部共享、repeat=1。
 *   平铺密度由几何体 UV 决定（见 GeometryUV.js：UV 单位 = 米 / tileSize），不要克隆贴图改 repeat。
 * - 任一贴图缺失或加载失败时回退为程序化贴图，调用方永远拿到可用对象。
 */

// tileSize：一张贴图对应的真实尺寸（米）。wrap：repeat 双向平铺；band 横向平铺、纵向夹紧；clamp 单张不平铺。
export const TEXTURE_SPECS = {
  wall_red:      { tileSize: 4,   wrap: 'repeat', fallback: '#9b2a1f' },
  wall_brick:    { tileSize: 2,   wrap: 'repeat', fallback: '#6f6a64' },
  roof_tile:     { tileSize: 3,   wrap: 'repeat', fallback: '#d4a020' },
  ground_brick:  { tileSize: 4,   wrap: 'repeat', fallback: '#8a8580' },
  stone_slab:    { tileSize: 6,   wrap: 'repeat', fallback: '#a9a49b' },
  marble:        { tileSize: 2,   wrap: 'repeat', fallback: '#e8e4dc' },
  sumeru_band:   { tileSize: 3,   wrap: 'band',   fallback: '#ddd8cc' },
  wood_column:   { tileSize: 1.5, wrap: 'repeat', fallback: '#8e1c14' },
  door_studded:  { tileSize: 1,   wrap: 'clamp',  fallback: '#9a1f16' },
  lattice_doors: { tileSize: 6,   wrap: 'band',   fallback: '#7a2a18' },
  caihua_beam:   { tileSize: 4,   wrap: 'band',   fallback: '#2f5f6e' },
  dougong_band:  { tileSize: 4,   wrap: 'band',   fallback: '#3a5d58' },
  rafters:       { tileSize: 3,   wrap: 'repeat', fallback: '#35564f' },
  balustrade:    { tileSize: 3,   wrap: 'band',   fallback: '#e5e1d8' },
  yulu:          { tileSize: 1,   wrap: 'clamp',  fallback: '#e2ddd2' },
  pebble_path:   { tileSize: 3,   wrap: 'repeat', fallback: '#8d8576' },
  bark:          { tileSize: 1.5, wrap: 'repeat', fallback: '#5b4a3a' },
  foliage:       { tileSize: 3,   wrap: 'repeat', fallback: '#2f4a2a' },
  rock:          { tileSize: 3,   wrap: 'repeat', fallback: '#8a8a84' },
  grass:         { tileSize: 4,   wrap: 'repeat', fallback: '#5b6e3a' },
  water:         { tileSize: 8,   wrap: 'repeat', fallback: '#2e5550' },
  skyline:       { tileSize: 1,   wrap: 'band',   fallback: '#c9ccc8' },
};

const PROCEDURAL_FALLBACK = {
  wall_red: () => TextureGenerator.createBrickTexture(),
  roof_tile: () => TextureGenerator.createTileTexture(),
  wood_column: () => TextureGenerator.createWoodTexture(),
  marble: () => TextureGenerator.createMarbleTexture(),
  ground_brick: () => TextureGenerator.createGroundTexture(),
};

function solidTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 64);
  const image = ctx.getImageData(0, 0, 64, 64);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    image.data[i] += n; image.data[i + 1] += n; image.data[i + 2] += n;
  }
  ctx.putImageData(image, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

export class TextureLibrary {
  /**
   * @param {{ quality?: 'hd'|'sd', anisotropy?: number, baseUrl?: string, manager?: THREE.LoadingManager }} options
   */
  constructor({ quality = 'hd', anisotropy = 4, baseUrl, manager } = {}) {
    this.quality = quality;
    this.anisotropy = anisotropy;
    this.baseUrl = baseUrl ?? `${import.meta.env?.BASE_URL ?? '/'}textures/${quality}/`;
    this.loader = new THREE.TextureLoader(manager);
    this.colors = new Map();
    this.normals = new Map();
    this.materials = new Map();
    this.loadedFromFile = new Set();
    this.manifest = null;
  }

  /** 加载全部贴图；onProgress(done, total)。失败不抛出，缺失项使用回退贴图。 */
  async load(onProgress) {
    try {
      const res = await fetch(`${this.baseUrl}manifest.json`, { cache: 'no-cache' });
      this.manifest = res.ok ? await res.json() : null;
    } catch {
      this.manifest = null;
    }
    const entries = this.manifest?.textures ?? {};
    const jobs = [];
    for (const name of Object.keys(TEXTURE_SPECS)) {
      const info = entries[name];
      if (info?.color) jobs.push([name, 'color', info.color]);
      if (info?.normal) jobs.push([name, 'normal', info.normal]);
    }
    let done = 0;
    const total = jobs.length;
    await Promise.all(jobs.map(async ([name, kind, file]) => {
      try {
        const texture = await this.loader.loadAsync(this.baseUrl + file);
        this.configure(texture, name, kind);
        (kind === 'color' ? this.colors : this.normals).set(name, texture);
        if (kind === 'color') this.loadedFromFile.add(name);
      } catch (err) {
        console.warn(`[TextureLibrary] ${file} 加载失败，使用回退贴图`, err);
      }
      done++;
      onProgress?.(done, total);
    }));
    for (const name of Object.keys(TEXTURE_SPECS)) {
      if (!this.colors.has(name)) this.colors.set(name, this.createFallback(name));
    }
    return this;
  }

  configure(texture, name, kind) {
    const spec = TEXTURE_SPECS[name];
    texture.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = spec.wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    texture.wrapT = spec.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.anisotropy = this.anisotropy;
    texture.name = `${name}_${kind}`;
    texture.needsUpdate = true;
    return texture;
  }

  createFallback(name) {
    const spec = TEXTURE_SPECS[name];
    const texture = PROCEDURAL_FALLBACK[name]?.() ?? solidTexture(spec.fallback);
    return this.configure(texture, name, 'color');
  }

  has(name) {
    return this.loadedFromFile.has(name);
  }

  tileSize(name) {
    return this.manifest?.textures?.[name]?.tileSize ?? TEXTURE_SPECS[name]?.tileSize ?? 1;
  }

  /** 颜色贴图的宽高比（宽/高），band/clamp 类贴图映射 UV 时使用 */
  aspect(name) {
    const image = this.colors.get(name)?.image;
    return image?.width && image?.height ? image.width / image.height : 1;
  }

  color(name) {
    if (!TEXTURE_SPECS[name]) throw new Error(`未知贴图 ${name}`);
    if (!this.colors.has(name)) this.colors.set(name, this.createFallback(name));
    return this.colors.get(name);
  }

  normal(name) {
    return this.normals.get(name) ?? null;
  }

  /**
   * 获取（缓存的）标准材质。同名同参数返回同一实例，以减少着色器切换。
   * @param {string} name 贴图名
   * @param {object} params MeshStandardMaterial 其余参数（roughness、normalScale 数组等）
   */
  material(name, params = {}) {
    const key = `${name}|${JSON.stringify(params)}`;
    if (this.materials.has(key)) return this.materials.get(key);
    const { normalScale, ...rest } = params;
    const normalMap = this.normal(name);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.color(name),
      normalMap,
      roughness: 0.85,
      metalness: 0,
      ...rest,
    });
    if (normalMap) {
      const s = normalScale ?? 1;
      material.normalScale = Array.isArray(s) ? new THREE.Vector2(s[0], s[1]) : new THREE.Vector2(s, s);
    }
    material.name = `${name}_material`;
    this.materials.set(key, material);
    return material;
  }

  allTextures() {
    return [...this.colors.values(), ...this.normals.values()];
  }

  /** 资源是否归贴图库所有（其他模块 dispose 时必须跳过，统一由 main 调用 library.dispose()） */
  owns(resource) {
    if (!resource) return false;
    if (resource.isTexture) return this.allTextures().includes(resource);
    if (resource.isMaterial) return [...this.materials.values()].includes(resource);
    return false;
  }

  dispose() {
    this.materials.forEach(material => material.dispose());
    this.allTextures().forEach(texture => texture.dispose());
    this.materials.clear();
    this.colors.clear();
    this.normals.clear();
  }
}
