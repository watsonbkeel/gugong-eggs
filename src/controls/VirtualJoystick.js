/**
 * 虚拟方向盘（移动端）
 * 常驻显示在左下角的半透明圆盘：按住圆盘拖动即可前后左右移动，松手归零。
 * 只认领落在圆盘附近的那根手指，其余手指留给视角拖动。
 */

const SIZE = 120;          // 底座直径（px）
const KNOB = 54;           // 摇杆头直径（px）
const HIT_PADDING = 45;    // 圆盘外扩的可触发范围（px），手指没按准也能用

export class VirtualJoystick {
  constructor(container) {
    this.container = container;
    this.active = false;
    this.baseX = 0;
    this.baseY = 0;
    this.stickX = 0;
    this.stickY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.touchId = null;

    this.maxRadius = (SIZE - KNOB) / 2 + 10;

    this.createElements();
    this.bindEvents();
  }

  /**
   * 创建 DOM 元素（常驻显示）
   */
  createElements() {
    this.base = document.createElement('div');
    this.base.className = 'joystick-base';
    this.base.style.cssText = `
      position: fixed;
      left: calc(28px + env(safe-area-inset-left, 0px));
      bottom: calc(36px + env(safe-area-inset-bottom, 0px));
      width: ${SIZE}px;
      height: ${SIZE}px;
      background: radial-gradient(circle, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.22) 100%);
      border: 2px solid rgba(255, 255, 255, 0.45);
      border-radius: 50%;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
      z-index: 1000;
      pointer-events: none;
      transition: opacity 0.2s ease, background 0.2s ease;
      opacity: 0.75;
    `;

    // 上下左右方向箭头
    const arrows = [
      { ch: '▲', css: 'top: 6px; left: 50%; transform: translateX(-50%);' },
      { ch: '▼', css: 'bottom: 6px; left: 50%; transform: translateX(-50%);' },
      { ch: '◀', css: 'left: 8px; top: 50%; transform: translateY(-50%);' },
      { ch: '▶', css: 'right: 8px; top: 50%; transform: translateY(-50%);' },
    ];
    for (const a of arrows) {
      const el = document.createElement('span');
      el.textContent = a.ch;
      el.style.cssText = `position: absolute; ${a.css} font-size: 12px; line-height: 1; color: rgba(255,255,255,0.75); pointer-events: none;`;
      this.base.appendChild(el);
    }

    this.stick = document.createElement('div');
    this.stick.className = 'joystick-stick';
    this.stick.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      width: ${KNOB}px;
      height: ${KNOB}px;
      background: rgba(255, 255, 255, 0.55);
      border: 2px solid rgba(255, 255, 255, 0.85);
      border-radius: 50%;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      transform: translate(-50%, -50%);
      pointer-events: none;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #7a4a00;
      font-size: 16px;
      font-weight: bold;
    `;

    this.base.appendChild(this.stick);
    this.container.appendChild(this.base);
  }

  bindEvents() {
    this._onTouchStart = this.onTouchStart.bind(this);
    this._onTouchMove = this.onTouchMove.bind(this);
    this._onTouchEnd = this.onTouchEnd.bind(this);
    this.container.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.container.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.container.addEventListener('touchend', this._onTouchEnd, { passive: false });
    this.container.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
  }

  /**
   * 圆盘中心（屏幕坐标），每次按下时实时读取，兼容横竖屏切换
   */
  getCenter() {
    const r = this.base.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, radius: r.width / 2 };
  }

  /**
   * 某个触点是否落在方向盘可触发范围内
   */
  hitTest(x, y) {
    const c = this.getCenter();
    return Math.hypot(x - c.x, y - c.y) <= c.radius + HIT_PADDING;
  }

  onTouchStart(e) {
    if (this.active) return;
    const touch = Array.from(e.changedTouches).find(t =>
      !t.target?.closest?.('button, a, input, select, textarea, [role="button"]') &&
      this.hitTest(t.clientX, t.clientY)
    );
    if (!touch) return;
    e.preventDefault();
    this.touchId = touch.identifier;

    const c = this.getCenter();
    this.baseX = c.x;
    this.baseY = c.y;
    this.active = true;
    this.base.style.opacity = '1';
    this.base.style.background = 'radial-gradient(circle, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.32) 100%)';
    this.updateStick(touch.clientX, touch.clientY);
  }

  onTouchMove(e) {
    if (!this.active) return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === this.touchId);
    if (!touch) return;
    e.preventDefault();
    this.updateStick(touch.clientX, touch.clientY);
  }

  updateStick(x, y) {
    const dx = x - this.baseX;
    const dy = y - this.baseY;
    const distance = Math.hypot(dx, dy);
    if (distance > this.maxRadius) {
      this.stickX = (dx / distance) * this.maxRadius;
      this.stickY = (dy / distance) * this.maxRadius;
    } else {
      this.stickX = dx;
      this.stickY = dy;
    }
    this.stick.style.transform = `translate(calc(-50% + ${this.stickX}px), calc(-50% + ${this.stickY}px))`;

    // 归一化偏移（-1 ~ 1），中心留一点死区，防止手指微抖导致漂移
    let nx = this.stickX / this.maxRadius;
    let ny = this.stickY / this.maxRadius;
    if (Math.hypot(nx, ny) < 0.12) { nx = 0; ny = 0; }
    this.deltaX = nx;
    this.deltaY = ny;
  }

  onTouchEnd(e) {
    const touch = Array.from(e.changedTouches).find(t => t.identifier === this.touchId);
    if (!touch) return;
    this.reset();
  }

  reset() {
    this.active = false;
    this.touchId = null;
    this.stickX = 0;
    this.stickY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.stick.style.transform = 'translate(-50%, -50%)';
    if (this.base) {
      this.base.style.opacity = '0.75';
      this.base.style.background = 'radial-gradient(circle, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.22) 100%)';
    }
  }

  /**
   * 奔跑状态：圆盘边框变金色并显示"跑"字提示
   */
  setRunning(running) {
    this.running = !!running;
    if (!this.base) return;
    this.base.style.borderColor = running ? 'rgba(255, 200, 60, 0.95)' : 'rgba(255, 255, 255, 0.45)';
    this.base.style.boxShadow = running
      ? '0 0 16px rgba(255, 200, 60, 0.7)'
      : '0 2px 12px rgba(0, 0, 0, 0.25)';
    this.stick.textContent = running ? '跑' : '';
  }

  getDelta() {
    return { x: this.deltaX, y: this.deltaY };
  }

  isActive() {
    return this.active;
  }

  dispose() {
    this.container.removeEventListener('touchstart', this._onTouchStart);
    this.container.removeEventListener('touchmove', this._onTouchMove);
    this.container.removeEventListener('touchend', this._onTouchEnd);
    this.container.removeEventListener('touchcancel', this._onTouchEnd);
    this.reset();
    if (this.base && this.base.parentNode) {
      this.base.parentNode.removeChild(this.base);
    }
  }
}
