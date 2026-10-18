import * as THREE from 'three';
import { PALACE_LAYOUT } from '../scene/Layout.js';

/**
 * 小地图：按 M 键显示/隐藏，显示当前位置和建筑名称
 */

export class Minimap {
  constructor({ items = [], preview = false } = {}) {
    this.visible = false;
    this.previewEnabled = preview; // 移动端：右上角常驻小地图预览，点击展开全图
    this.lastPreviewDraw = 0;
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.playerPosition = new THREE.Vector3();
    this.playerDir = new THREE.Vector3(0, 0, 1);
    this.items = items; // 两侧宫院：{ kind: 'hall'|'gate'|'corridor', name, x, z, w, d }
    
    // 地图范围：宫城 + 筒子河，竖长方形（与紫禁城南北长、东西窄的比例一致）
    this.worldBounds = { minX: -200, maxX: 200, minZ: -240, maxZ: 470 };
    this.mapSize = 800; // 宽（高清化：400→800）
    this.mapHeight = Math.round(this.mapSize * (710 / 400) * 0.82);
    this.scaleX = this.mapSize / 400;
    this.scaleZ = this.mapHeight / 710;
    
    this.init();
  }
  
  init() {
    // 创建小地图容器，高度优先适配避免被裁切
    this.container = document.createElement('div');
    this.container.id = 'minimap';
    this.container.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      max-width: min(${this.mapSize}px, 94vw);
      max-height: 90vh;
      background: rgba(20, 20, 20, 0.92);
      border: 3px solid rgba(255, 215, 100, 0.8);
      border-radius: 8px;
      padding: 16px;
      display: none;
      z-index: 1000;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
      overflow: hidden;
    `;
    
    // 标题
    const title = document.createElement('div');
    title.textContent = '故宫平面图';
    title.style.cssText = `
      color: #ffd764;
      font-size: 20px;
      font-weight: bold;
      text-align: center;
      margin-bottom: 12px;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.8);
    `;
    this.container.appendChild(title);
    
    // Canvas 地图，按容器高度自适应显示完整地图
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.mapSize;
    this.canvas.height = this.mapHeight;
    this.canvas.style.cssText = `
      display: block;
      max-width: 100%;
      max-height: calc(90vh - 120px);
      width: auto;
      height: auto;
      background: rgba(240, 235, 220, 0.95);
      border: 1px solid rgba(100, 80, 60, 0.4);
    `;
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    
    // 提示文字
    const hint = document.createElement('div');
    hint.textContent = this.previewEnabled ? '点击地图关闭' : '按 M 键关闭';
    hint.style.cssText = `
      color: #999;
      font-size: 14px;
      text-align: center;
      margin-top: 8px;
    `;
    this.container.appendChild(hint);
    
    document.body.appendChild(this.container);
    
    // 监听 M 键
    this._onKeyDown = (e) => {
      if (e.key === 'm' || e.key === 'M') {
        this.toggle();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
    
    // 底图只画一次到高分辨率离屏画布，全图和预览都从这里取，避免每帧重绘全部建筑
    this.baseScale = 6; // 高清化：3→6，配合 mapSize 翻倍达到 4800px 物理分辨率
    this.baseCanvas = document.createElement('canvas');
    this.baseCanvas.width = this.mapSize * this.baseScale;
    this.baseCanvas.height = this.mapHeight * this.baseScale;
    this.renderBase();
    
    if (this.previewEnabled) {
      this.createPreview();
      // 展开的全图点一下就关闭
      this.container.addEventListener('click', () => this.toggle());
    }
    
    // 初始绘制
    this.drawMap();
  }
  
  /**
   * 右上角常驻小地图预览（以玩家为中心，北朝上），点击展开全图
   */
  createPreview() {
    const SIZE = 118;
    this.previewSize = SIZE;
    this.previewView = 120; // 预览窗口覆盖的地图像素范围（约 120 米宽）
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    
    this.preview = document.createElement('div');
    this.preview.id = 'minimap-preview';
    this.preview.setAttribute('role', 'button');
    this.preview.style.cssText = `
      position: fixed;
      top: calc(16px + env(safe-area-inset-top, 0px));
      right: calc(16px + env(safe-area-inset-right, 0px));
      width: ${SIZE}px;
      height: ${SIZE}px;
      border-radius: 12px;
      overflow: hidden;
      border: 2px solid rgba(255, 215, 100, 0.85);
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
      background: #f0ebdc;
      opacity: 0.92;
      z-index: 1000;
      touch-action: manipulation;
    `;
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = SIZE * dpr;
    this.previewCanvas.height = SIZE * dpr;
    this.previewCanvas.style.cssText = `display: block; width: ${SIZE}px; height: ${SIZE}px; pointer-events: none;`;
    this.previewCtx = this.previewCanvas.getContext('2d');
    this.preview.appendChild(this.previewCanvas);
    
    const tag = document.createElement('div');
    tag.textContent = '点开全图';
    tag.style.cssText = `
      position: absolute; left: 0; right: 0; bottom: 0;
      padding: 2px 0; text-align: center; font-size: 10px;
      color: #fff; background: rgba(0, 0, 0, 0.45); pointer-events: none;
    `;
    this.preview.appendChild(tag);
    
    this._onPreviewClick = (e) => {
      e.stopPropagation();
      this.toggle();
    };
    this.preview.addEventListener('click', this._onPreviewClick);
    document.body.appendChild(this.preview);
    this.drawPreview();
  }
  
  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
    if (this.preview) this.preview.style.display = this.visible ? 'none' : 'block';
    document.body.classList.toggle('map-open', this.visible);
    if (this.visible) {
      this.drawMap();
    }
  }
  
  /**
   * 世界坐标转地图像素坐标
   */
  worldToMap(x, z) {
    const { minX, maxX, minZ, maxZ } = this.worldBounds;
    // 场景中 -X 是东：地图上北在上、东在右，所以 x 要翻转
    const u = (maxX - x) / (maxX - minX);
    const v = (z - minZ) / (maxZ - minZ);
    return {
      x: u * this.mapSize,
      y: (1 - v) * this.mapHeight,
    };
  }

  /** 世界轴对齐矩形 → 画布矩形（已处理 x 翻转） */
  rectOf(cx, cz, w, d) {
    const a = this.worldToMap(cx + w / 2, cz + d / 2);
    const b = this.worldToMap(cx - w / 2, cz - d / 2);
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)];
  }

  drawLabel(text, x, y, bold, size = 10) {
    const ctx = this.ctx;
    // 字号翻倍以配合高清地图
    const fontSize = size * 2;
    ctx.font = `${bold ? 'bold ' : ''}${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    // 白底更不透明，让文字更清晰
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(x - tw / 2 - 4, y - fontSize / 2 - 2, tw + 8, fontSize + 4);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillText(text, x, y);
  }

  drawSideItems() {
    const ctx = this.ctx;
    const style = {
      hall: ['rgba(180, 50, 50, 0.75)', 'rgba(120, 30, 30, 0.9)'],
      gate: ['rgba(215, 120, 60, 0.85)', 'rgba(140, 60, 30, 0.95)'],
      corridor: ['rgba(170, 110, 90, 0.45)', 'rgba(120, 70, 60, 0.6)'],
    };
    for (const it of this.items) {
      const [fill, stroke] = style[it.kind] ?? style.hall;
      const [x, y, w, h] = this.rectOf(it.x, it.z, it.w, it.d);
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, Math.max(w, 3), Math.max(h, 3)); // 高清地图下最小矩形翻倍
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2; // 两侧宫院边框线宽翻倍
      ctx.strokeRect(x, y, Math.max(w, 3), Math.max(h, 3));
    }
    // 只标有名字的主要殿宇与门，高清地图下防碰撞阈值翻倍
    const placed = [];
    for (const it of this.items) {
      if (!it.name || it.kind === 'corridor') continue;
      const [x, y, w, h] = this.rectOf(it.x, it.z, it.w, it.d);
      const cx = x + w / 2, cy = y + h / 2;
      if (placed.some(p => Math.abs(p.x - cx) < 44 && Math.abs(p.y - cy) < 18)) continue;
      placed.push({ x: cx, y: cy });
      this.drawLabel(it.name, cx, cy, it.kind === 'hall', it.kind === 'hall' ? 9 : 8);
    }
  }
  
  /**
   * 静态底图（建筑/河道/文字）绘制到高分辨率离屏画布，只执行一次
   */
  renderBase() {
    const mainCtx = this.ctx;
    const ctx = this.baseCanvas.getContext('2d');
    ctx.setTransform(this.baseScale, 0, 0, this.baseScale, 0, 0);
    this.ctx = ctx; // drawLabel / drawSideItems 复用 this.ctx
    try {
      this.drawStatic();
    } finally {
      this.ctx = mainCtx;
    }
  }

  /** 设置/清除额外标记（金蛋提示）：points = [{x, z}] 世界坐标数组，传 [] 清除。画成金色闪点。 */
  setMarkers(points) {
    this.markers = Array.isArray(points) ? points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z)) : [];
  }

  /** 画金色闪点；clamp = 预览窗口外时贴边显示 */
  drawMarker(ctx, p, radius) {
    const t = performance.now() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    ctx.save();
    ctx.fillStyle = `rgba(255, 200, 60, ${0.25 + 0.3 * pulse})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * (1.8 + 1.2 * pulse), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffc83c';
    ctx.strokeStyle = '#8a5a00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  drawMap() {
    const ctx = this.ctx;
    ctx.drawImage(this.baseCanvas, 0, 0, this.mapSize, this.mapHeight);
    if (this.markers && this.markers.length) {
      for (const m of this.markers) {
        this.drawMarker(ctx, this.worldToMap(m.x, m.z), 5);
      }
    }
    this.drawPlayer(ctx, this.worldToMap(this.playerPosition.x, this.playerPosition.z), 5, 14);
  }

  /**
   * 预览：以玩家为中心裁一块底图，北朝上
   */
  drawPreview() {
    if (!this.previewCtx) return;
    const ctx = this.previewCtx;
    const cw = this.previewCanvas.width;
    const ch = this.previewCanvas.height;
    const view = this.previewView;
    const pm = this.worldToMap(this.playerPosition.x, this.playerPosition.z);
    const s = this.baseScale;
    ctx.fillStyle = '#f0ebdc';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(this.baseCanvas, (pm.x - view / 2) * s, (pm.y - view / 2) * s, view * s, view * s, 0, 0, cw, ch);
    const k = cw / this.previewSize;
    ctx.save();
    ctx.scale(k, k);
    if (this.markers && this.markers.length) {
      for (const marker of this.markers) {
        // 标记相对玩家的偏移（地图像素），超出预览窗口就贴边，让人知道往哪个方向走
        const mm = this.worldToMap(marker.x, marker.z);
        const half = this.previewSize / 2 - 8;
        let ox = (mm.x - pm.x) * (this.previewSize / view);
        let oy = (mm.y - pm.y) * (this.previewSize / view);
        const m = Math.max(Math.abs(ox), Math.abs(oy));
        if (m > half) { ox *= half / m; oy *= half / m; }
        this.drawMarker(ctx, { x: this.previewSize / 2 + ox, y: this.previewSize / 2 + oy }, 5);
      }
    }
    this.drawPlayer(ctx, { x: this.previewSize / 2, y: this.previewSize / 2 }, 5, 16);
    ctx.fillStyle = 'rgba(120, 30, 30, 0.9)';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('北', this.previewSize / 2, 3);
    ctx.restore();
  }

  drawPlayer(ctx, pm, radius, arrowLen) {
    // 视线方向（世界）→ 地图：x 翻转、z 向上
    const len = Math.hypot(this.playerDir.x, this.playerDir.z) || 1;
    const dx = -this.playerDir.x / len;
    const dy = -this.playerDir.z / len;
    // 视野扇形
    const ang = Math.atan2(dy, dx);
    ctx.fillStyle = 'rgba(255, 60, 60, 0.18)';
    ctx.beginPath();
    ctx.moveTo(pm.x, pm.y);
    ctx.arc(pm.x, pm.y, arrowLen * 1.8, ang - 0.6, ang + 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pm.x, pm.y);
    ctx.lineTo(pm.x + dx * arrowLen, pm.y + dy * arrowLen);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 60, 60, 0.95)';
    ctx.beginPath();
    ctx.arc(pm.x, pm.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  drawStatic() {
    const ctx = this.ctx;
    const w = this.mapSize;
    const h = this.mapHeight;
    
    // 清空背景
    ctx.fillStyle = '#f0ebdc';
    ctx.fillRect(0, 0, w, h);
    
    // 绘制网格，高清地图下线宽翻倍
    ctx.strokeStyle = 'rgba(150, 140, 120, 0.2)';
    ctx.lineWidth = 1;
    const gridSize = w / 10;
    for (let i = 0; i <= 10; i++) {
      ctx.beginPath();
      ctx.moveTo(i * gridSize, 0);
      ctx.lineTo(i * gridSize, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * gridSize);
      ctx.lineTo(w, i * gridSize);
      ctx.stroke();
    }
    
    // 绘制中轴建筑（PALACE_LAYOUT）
    for (const item of PALACE_LAYOUT) {
      const { type, position: p, dimensions: d, name } = item;

      if (type === 'moat') {
        const [ox, oy, ow, oh] = this.rectOf(p.x, p.z, d.width, d.depth);
        const [ix, iy, iw, ih] = this.rectOf(p.x, p.z, d.width - d.riverWidth * 2, d.depth - d.riverWidth * 2);
        ctx.fillStyle = 'rgba(80, 140, 200, 0.5)';
        ctx.fillRect(ox, oy, ow, oh);
        ctx.fillStyle = '#f0ebdc';
        ctx.fillRect(ix, iy, iw, ih);
      ctx.strokeStyle = 'rgba(60, 110, 170, 0.8)';
      ctx.lineWidth = 3; // 高清地图下线宽翻倍
      ctx.strokeRect(ox, oy, ow, oh);
      ctx.strokeRect(ix, iy, iw, ih);
        continue;
      }
      if (type === 'outer_wall') {
        const [x, y, rw, rh] = this.rectOf(p.x, p.z, d.width, d.depth);
        ctx.strokeStyle = 'rgba(140, 60, 60, 0.8)';
        ctx.lineWidth = 8; // 外城墙线宽翻倍
        ctx.strokeRect(x, y, rw, rh);
        continue;
      }

      const [x, y, mapW, mapH] = this.rectOf(p.x, p.z, d.width, d.depth);
      let fillColor, strokeColor, showLabel = false;
      if (type === 'palace') {
        fillColor = 'rgba(180, 50, 50, 0.8)'; strokeColor = 'rgba(120, 30, 30, 0.95)'; showLabel = true;
      } else if (type === 'gate') {
        fillColor = 'rgba(200, 80, 80, 0.75)'; strokeColor = 'rgba(140, 50, 50, 0.9)'; showLabel = true;
      } else if (type === 'wall') {
        fillColor = 'rgba(160, 60, 60, 0.5)'; strokeColor = 'rgba(120, 50, 50, 0.7)';
      } else if (type === 'river') {
        fillColor = 'rgba(100, 150, 200, 0.6)'; strokeColor = 'rgba(70, 120, 170, 0.8)';
      } else if (type === 'garden') {
        fillColor = 'rgba(120, 180, 120, 0.6)'; strokeColor = 'rgba(80, 140, 80, 0.8)'; showLabel = true;
      } else {
        fillColor = 'rgba(140, 140, 140, 0.4)'; strokeColor = 'rgba(100, 100, 100, 0.6)';
      }
      ctx.fillStyle = fillColor;
      ctx.fillRect(x, y, mapW, mapH);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.4; // 建筑边框线宽翻倍
      ctx.strokeRect(x, y, mapW, mapH);
      if (name && showLabel) this.drawLabel(name, x + mapW / 2, y + mapH / 2, type === 'palace', type === 'palace' ? 11 : 10);
    }

    // 两侧宫院
    this.drawSideItems();

    // 方位标识字号放大
    ctx.fillStyle = 'rgba(100, 40, 40, 0.85)';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('北', w / 2, 20);
    ctx.fillText('南', w / 2, h - 20);
    ctx.fillText('东', w - 20, h / 2);
    ctx.fillText('西', 20, h / 2);
  }
  
  update(camera) {
    this.playerPosition.copy(camera.position);
    camera.getWorldDirection(this.playerDir);
    
    if (this.visible) {
      this.drawMap();
    } else if (this.preview) {
      // 预览约 15 fps 刷新就够，省手机性能
      const now = performance.now();
      if (now - this.lastPreviewDraw >= 66) {
        this.lastPreviewDraw = now;
        this.drawPreview();
      }
    }
  }
  
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this.preview?.removeEventListener('click', this._onPreviewClick);
    this.preview?.remove();
    this.container?.remove();
  }
}
