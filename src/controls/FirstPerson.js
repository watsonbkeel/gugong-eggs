import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { PLAYER } from '../config/constants.js';
import { VirtualJoystick } from './VirtualJoystick.js';

/**
 * 第一人称控制器
 * 支持桌面端（WASD + 鼠标）和移动端（虚拟摇杆 + 右半屏拖动视角）
 *
 * 说明（three r162）：PointerLockControls.getObject() 直接返回相机本身，
 * 移动使用 moveForward / moveRight，保证只在水平面（XZ）上移动，不受俯仰角影响。
 */

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _right = new THREE.Vector3();

// 走路镜头起伏参数：步频（步/秒）在参考速度下取值，随实际速度按平方根缩放
const HEAD_BOB = {
  WALK_AMPLITUDE: 0.035,        // 走路上下振幅（米）
  SPRINT_AMPLITUDE: 0.055,      // 冲刺上下振幅（米）
  SWAY_AMPLITUDE: 0.012,        // 左右横摆振幅（米），频率为上下的一半
  WALK_STEP_RATE: 1.8,          // 走路步频（步/秒，对应 PLAYER.MOVE_SPEED）
  SPRINT_STEP_RATE: 2.4,        // 冲刺步频（步/秒，对应 PLAYER.SPRINT_SPEED）
  MIN_STEP_SPEED: 0.5,          // 低于此速度不计脚步
  SMOOTHING: 8,                 // 振幅平滑系数（起步/停步回落）
};

export class FirstPersonControls {
  constructor(camera, domElement, collisionManager) {
    this.camera = camera;
    this.domElement = domElement;
    this.collisionManager = collisionManager;
    
    // 移动状态
    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.canSprint = false;
    this.pressedKeys = new Set();
    this.keyPressTimes = new Map(); // 记录每个方向键的按下时间
    this.lookLocked = false;
    this.lookTouchId = null;
    this.lookLockButton = null;
    // 移动端奔跑判定：记录当前推的方向和开始时间
    this.runDirAngle = null;
    this.runStartTime = 0;
    this.mobileRunning = false;
    
    // 当前速度（x = 右移速度，z = 前进速度，单位：米/秒）
    this.velocity = new THREE.Vector3();
    // 脚面高度与竖直速度：相机 y = feetY + PLAYER.HEIGHT；上台阶平滑跟随，下落按重力
    this.feetY = 0;
    this.verticalVelocity = 0;
    // 空中状态（跳跃或从高处走下）：空中按真实脚面做碰撞，可越过矮栏杆；落地后恢复贴地
    this.airborne = false;
    this.jumpQueued = false;
    this.jumpButton = null;
    this._landed = false;
    
    // 镜头起伏：bobOffset 是上一帧叠加在相机上的偏移，下一帧开始时先扣除，碰撞只用无偏移的位置
    this.headBobEnabled = true;
    this.bobOffset = new THREE.Vector3();
    this.bobPhase = 0;          // 步频相位（单位：步），每跨过一个整数落一次脚
    this.bobAmplitude = 0;      // 平滑后的当前振幅
    // 每帧输出给音效：水平实际速度（米/秒）、是否冲刺、本帧是否落脚
    this.motion = { speed: 0, sprint: false, footstep: false };
    
    // 检测设备类型
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    
    // 指针锁定控制
    this.controls = new PointerLockControls(camera, domElement);
    
    // 虚拟摇杆（移动端）
    this.joystick = null;
    if (this.isMobile) {
      this.joystick = new VirtualJoystick(domElement);
    }
    
    this.prevTime = performance.now();
    
    // 绑定 this，便于 dispose 时移除监听
    this._onKeyDown = this.onKeyDown.bind(this);
    this._onKeyUp = this.onKeyUp.bind(this);
    this._onStop = this.stop.bind(this);
    
    this.setupEventListeners();
  }
  
  /**
   * 设置事件监听
   */
  setupEventListeners() {
    window.addEventListener('blur', this._onStop);
    if (!this.isMobile) {
      // 点击启动指针锁定（桌面端）；点在按钮上不触发
      this._onClick = (e) => {
        if (e.target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
        if (!this.controls.isLocked) {
          this.controls.lock();
        }
      };
      this.domElement.addEventListener('click', this._onClick);
      
      // 键盘事件
      document.addEventListener('keydown', this._onKeyDown);
      document.addEventListener('keyup', this._onKeyUp);
      
      // 解锁时立即清空输入和速度
      this.controls.addEventListener('unlock', this._onStop);
    } else {
      // 移动端：视角锁定按钮 + 右半屏拖动视角 + 跳跃按钮
      this.createLookLockButton();
      this.createJumpButton();
    }
  }

  /** 请求起跳（PC 空格 / 移动端"跳"按钮），在下一帧 update 里执行 */
  jump() {
    this.jumpQueued = true;
  }

  /** 移动端右下角圆形"跳"按钮（在锁定视角按钮上方） */
  createJumpButton() {
    const btn = document.createElement('button');
    btn.className = 'jump-button';
    btn.textContent = '跳';
    btn.setAttribute('aria-label', '跳跃');
    btn.style.cssText = `
      position: fixed;
      right: calc(28px + env(safe-area-inset-right, 0px));
      bottom: calc(108px + env(safe-area-inset-bottom, 0px));
      width: 72px; height: 72px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.22);
      border: 2px solid rgba(255, 255, 255, 0.6);
      color: #fff; font-size: 22px; font-weight: bold;
      z-index: 1000;
      touch-action: none;
      -webkit-user-select: none; user-select: none;
      -webkit-tap-highlight-color: transparent;
    `;
    // touchstart 立即起跳（不等 click 的 300ms 延迟）；阻止冒泡，避免同时被当成"拖视角"
    this._onJumpTouch = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.jump();
      btn.style.background = 'rgba(255, 215, 120, 0.45)';
      clearTimeout(this._jumpFlash);
      this._jumpFlash = setTimeout(() => { btn.style.background = 'rgba(255, 255, 255, 0.22)'; }, 160);
    };
    btn.addEventListener('touchstart', this._onJumpTouch, { passive: false });
    btn.addEventListener('click', () => this.jump());
    this.jumpButton = btn;
    this.domElement.appendChild(btn);
  }
  
  /**
   * 创建视角锁定按钮（移动端），并实现右半屏拖动视角
   */
  createLookLockButton() {
    const button = document.createElement('button');
    button.className = 'look-lock-button';
    button.textContent = '锁定视角';
    button.style.cssText = `
      position: fixed;
      bottom: calc(40px + env(safe-area-inset-bottom, 0px));
      right: calc(24px + env(safe-area-inset-right, 0px));
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.3);
      border: 2px solid rgba(255, 255, 255, 0.5);
      border-radius: 10px;
      color: white;
      font-size: 14px;
      z-index: 1000;
      cursor: pointer;
    `;
    
    this.lookLockButton = button;
    this._onLookLockClick = () => {
      this.lookLocked = !this.lookLocked;
      this.lookTouchId = null;
      button.textContent = this.lookLocked ? '解锁视角' : '锁定视角';
    };
    button.addEventListener('click', this._onLookLockClick);
    this.domElement.appendChild(button);
    
    // 用 touch.identifier 跟踪"看"的那根手指，避免和左侧摇杆手指互相干扰
    let lastX = 0;
    let lastY = 0;
    
    // 全屏任意位置拖动都可转视角，只排除：方向盘认领的手指、方向盘区域、按钮和浮层面板
    this._onLookTouchStart = (e) => {
      if (this.lookLocked || this.lookTouchId !== null) return;
      for (const touch of e.changedTouches) {
        if (this.joystick && (touch.identifier === this.joystick.touchId ||
            this.joystick.hitTest(touch.clientX, touch.clientY))) continue;
        if (!touch.target?.closest?.('button, a, input, select, textarea, [role="button"], #minimap, #minimap-preview, #settings-overlay, #settings-panel')) {
          this.lookTouchId = touch.identifier;
          lastX = touch.clientX;
          lastY = touch.clientY;
          break;
        }
      }
    };
    this.domElement.addEventListener('touchstart', this._onLookTouchStart, { passive: true });
    
    this._onLookTouchMove = (e) => {
      if (this.lookLocked || this.lookTouchId === null) return;
      for (const touch of e.changedTouches) {
        if (touch.identifier !== this.lookTouchId) continue;
        const deltaX = touch.clientX - lastX;
        const deltaY = touch.clientY - lastY;
        lastX = touch.clientX;
        lastY = touch.clientY;
        
        // 从相机当前朝向出发累加，避免第一次拖动时视角跳变
        _euler.setFromQuaternion(this.camera.quaternion);
        _euler.y -= deltaX * 0.005;
        _euler.x -= deltaY * 0.005;
        _euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, _euler.x));
        this.camera.quaternion.setFromEuler(_euler);
      }
    };
    this.domElement.addEventListener('touchmove', this._onLookTouchMove, { passive: true });
    
    this._onLookTouchEnd = (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === this.lookTouchId) {
          this.lookTouchId = null;
        }
      }
    };
    this.domElement.addEventListener('touchend', this._onLookTouchEnd);
    this.domElement.addEventListener('touchcancel', this._onLookTouchEnd);
  }
  
  /**
   * 键盘按下
   */
  onKeyDown(event) {
    if (!this.controls.isLocked) return;
    const code = event.code;
    if (code === 'Space') {
      event.preventDefault();
      if (!event.repeat) this.jump();
      return;
    }
    // 记录方向键按下时间
    if (!this.pressedKeys.has(code) && this.isMovementKey(code)) {
      this.keyPressTimes.set(code, performance.now());
    }
    this.pressedKeys.add(code);
    this.updateKeyState();
  }
  
  /**
   * 键盘抬起
   */
  onKeyUp(event) {
    const code = event.code;
    this.pressedKeys.delete(code);
    this.keyPressTimes.delete(code);
    this.updateKeyState();
  }

  isMovementKey(code) {
    return code === 'KeyW' || code === 'KeyS' || code === 'KeyA' || code === 'KeyD' ||
           code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight';
  }

  updateKeyState() {
    const keys = this.pressedKeys;
    this.moveForward = keys.has('KeyW') || keys.has('ArrowUp');
    this.moveBackward = keys.has('KeyS') || keys.has('ArrowDown');
    this.moveLeft = keys.has('KeyA') || keys.has('ArrowLeft');
    this.moveRight = keys.has('KeyD') || keys.has('ArrowRight');
    // Shift 键仍然可以手动触发冲刺
    this.canSprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  }

  stop() {
    this.pressedKeys.clear();
    this.keyPressTimes.clear();
    this.updateKeyState();
    this.velocity.set(0, 0, 0);
    this.lookTouchId = null;
    if (this.joystick) this.joystick.reset();
  }
  
  /**
   * 每帧更新：计算目标速度 → 平滑插值 → 水平移动 → 碰撞修正
   */
  update() {
    const time = performance.now();
    // 限制最大步长，防止切后台回来时一帧"瞬移"穿墙
    const delta = Math.min((time - this.prevTime) / 1000, 0.1);
    this.prevTime = time;
    
    // 目标速度（前进 / 右移）
    let targetForward = 0;
    let targetRight = 0;
    
    // 桌面端：WASD
    if (!this.isMobile && this.controls.isLocked) {
      let f = Number(this.moveForward) - Number(this.moveBackward);
      let r = Number(this.moveRight) - Number(this.moveLeft);
      const len = Math.hypot(f, r);
      if (len > 0) {
        f /= len;
        r /= len;
      }
      // 检查是否有方向键持续按下超过 2 秒，自动启用冲刺
      let autoSprint = false;
      const now = time;
      for (const [code, pressTime] of this.keyPressTimes) {
        if (now - pressTime >= 2000) { // 2 秒
          autoSprint = true;
          break;
        }
      }
      const sprint = this.canSprint || autoSprint;
      const speed = sprint ? PLAYER.SPRINT_SPEED : PLAYER.MOVE_SPEED;
      targetForward = f * speed;
      targetRight = r * speed;
    }
    
    // 移动端：摇杆（向上推 = 前进，屏幕坐标 y 向下为正，所以取反）
    // 持续朝同一方向推满 2 秒以上 → 奔跑；换方向、松手或推得太轻都会回到走路
    let mobileRunning = false;
    if (this.isMobile && this.joystick && this.joystick.isActive()) {
      const d = this.joystick.getDelta();
      const mag = Math.hypot(d.x, d.y);
      if (mag > 0.5) {
        const angle = Math.atan2(d.x, -d.y);
        let diff = 0;
        if (this.runDirAngle !== null) {
          diff = Math.abs(angle - this.runDirAngle);
          if (diff > Math.PI) diff = 2 * Math.PI - diff;
        }
        if (this.runDirAngle === null || diff > (PLAYER.JOYSTICK_RUN_ANGLE ?? 0.6)) {
          this.runDirAngle = angle;
          this.runStartTime = time;
        }
        mobileRunning = time - this.runStartTime >= (PLAYER.JOYSTICK_RUN_DELAY ?? 2000);
      } else {
        this.runDirAngle = null;
      }
      if (mobileRunning) {
        // 奔跑时按满速，方向取当前推的方向
        targetForward = (-d.y / mag) * PLAYER.JOYSTICK_RUN_SPEED;
        targetRight = (d.x / mag) * PLAYER.JOYSTICK_RUN_SPEED;
      } else {
        targetForward = -d.y * PLAYER.JOYSTICK_SPEED;
        targetRight = d.x * PLAYER.JOYSTICK_SPEED;
      }
    } else {
      this.runDirAngle = null;
    }
    if (this.joystick && this.mobileRunning !== mobileRunning) this.joystick.setRunning(mobileRunning);
    this.mobileRunning = mobileRunning;
    
    // 速度平滑（指数插值，起步/停步更自然）
    const smoothing = 1 - Math.exp(-10 * delta);
    this.velocity.z += (targetForward - this.velocity.z) * smoothing;
    this.velocity.x += (targetRight - this.velocity.x) * smoothing;
    
    // 先去掉上一帧的镜头起伏偏移，碰撞只用无偏移的位置，避免累积漂移
    this.camera.position.sub(this.bobOffset);
    this.bobOffset.set(0, 0, 0);
    
    // 起跳：只有站在地面上才能跳（空中不能二段跳）
    this._landed = false;
    if (this.jumpQueued) {
      this.jumpQueued = false;
      const onGround = !this.airborne && this.feetY >= (this.groundY ?? 0) - 0.08;
      if (onGround) {
        this.airborne = true;
        this.verticalVelocity = PLAYER.JUMP_VELOCITY ?? 6.7;
        this.groundY = this.feetY;
      }
    }
    const air = this.airborne;
    
    let speed = 0;
    // 空中：碰撞按真实脚面（可越过矮栏杆）；地面：按逻辑地面（上楼梯不滞后）
    const baseFeet = air ? this.feetY : Math.max(this.feetY, this.groundY ?? 0);
    const eyeY = baseFeet + PLAYER.HEIGHT;
    this._trackedGround = null;
    // 速度很小时直接归零，避免无意义的碰撞计算
    if (Math.abs(this.velocity.z) < 0.01 && Math.abs(this.velocity.x) < 0.01) {
      this.velocity.set(0, 0, 0);
    } else {
      const currentPosition = this.camera.position.clone();
      currentPosition.y = eyeY;
      
      // 只在水平面移动
      this.controls.moveForward(this.velocity.z * delta);
      this.controls.moveRight(this.velocity.x * delta);
      
      // 碰撞检测（带沿墙滑动），用当前脚面高度对应的视点高度
      const newPosition = this.camera.position.clone();
      newPosition.y = eyeY;
      // 逐小步贴合地面（传入脚面），低帧率/快走一帧跨度大时也能正常上下台阶
      const validPosition = this.collisionManager.getValidPosition(
        currentPosition,
        newPosition,
        0.5,
        air ? (this.groundY ?? 0) : baseFeet,
        PLAYER.STEP_UP ?? 0.6,
        (air || this.onSupport) ? this.feetY : null
      );
      this._trackedGround = this.collisionManager.lastGroundY ?? null;
      
      this.camera.position.copy(validPosition);
      
      // 碰撞修正后的实际水平速度
      if (delta > 0) {
        speed = Math.hypot(validPosition.x - currentPosition.x, validPosition.z - currentPosition.z) / delta;
      }
    }
    
    this.updateGround(delta);
    this.camera.position.y = this.feetY + PLAYER.HEIGHT;
    
    const sprint = this.isMobile
      ? mobileRunning && speed > PLAYER.MOVE_SPEED * 0.5
      : this.canSprint && speed > PLAYER.MOVE_SPEED * 0.5;
    // 空中不计脚步、不晃镜头；落地那一帧补一声脚步
    const footstep = this.updateHeadBob(delta, this.airborne ? 0 : speed) || this._landed;
    this.motion.speed = speed;
    this.motion.sprint = sprint;
    this.motion.footstep = footstep;
  }
  
  /**
   * 脚面高度跟随地面：上台阶/上坡平滑抬升；地面降低时按重力下落（走下台阶、从台基边缘下来）
   */
  updateGround(delta) {
    // 以"逻辑地面"（上一帧所站的面）为基准查询，避免上长楼梯时镜头平滑滞后超过可迈高度而误判掉落
    const base = Math.max(this.feetY, this.groundY ?? 0);
    // 本帧移动过：用移动过程中逐小步追踪得到的地面；否则在原地查询
    const walkY = this._trackedGround ?? this.collisionManager.getGroundHeight(
      this.camera.position.x, this.camera.position.z, this.airborne ? this.feetY : base, PLAYER.STEP_UP ?? 0.6
    );
    // 栏杆 / 家具 / 矮墙顶面也能站（只认脚下方的，不会"走上"高物体）
    const sup = this.collisionManager.supportHeight?.(
      this.camera.position.x, this.camera.position.z, this.feetY + 0.05
    ) ?? -Infinity;
    const groundY = Math.max(walkY, sup);
    this.onSupport = sup > walkY + 0.01;
    this.groundY = groundY;
    // 地面骤降（从台基边缘、栏杆上走下去）转入空中状态：按真实身体高度判碰撞，不会卡进栏杆
    if (!this.airborne && groundY < this.feetY - (PLAYER.STEP_UP ?? 0.6)) {
      this.airborne = true;
      this.verticalVelocity = 0;
    }
    if (this.airborne) {
      // 跳到略高于脚面的台面上：脚面抬到台面，不陷进去
      if (this.feetY < groundY) {
        this.feetY = groundY;
        if (this.verticalVelocity <= 0) {
          this.verticalVelocity = 0;
          this.airborne = false;
          this._landed = true;
          return;
        }
      }
      // 跳跃中：竖直速度受重力，下落到脚下地面即落地
      const g = PLAYER.GRAVITY ?? 14;
      this.verticalVelocity = Math.max(this.verticalVelocity - g * delta, -(PLAYER.MAX_FALL_SPEED ?? 30));
      this.feetY += this.verticalVelocity * delta;
      if (this.verticalVelocity <= 0 && this.feetY <= groundY) {
        this.feetY = groundY;
        this.verticalVelocity = 0;
        this.airborne = false;
        this._landed = true;
      }
      return;
    }
    if (groundY >= this.feetY - 0.02) {
      // 上行或贴地：快速平滑跟随，避免台阶处抖动
      this.verticalVelocity = 0;
      const follow = 1 - Math.exp(-14 * delta);
      this.feetY += (groundY - this.feetY) * follow;
      if (Math.abs(groundY - this.feetY) < 0.005) this.feetY = groundY;
    } else {
      // 下落：重力加速，落到地面即停
      this.verticalVelocity = Math.max(this.verticalVelocity - 9.8 * delta, -12);
      this.feetY += this.verticalVelocity * delta;
      if (this.feetY <= groundY) {
        this.feetY = groundY;
        this.verticalVelocity = 0;
      }
    }
  }
  
  /**
   * 推进步频相位并把起伏偏移叠加到相机上；返回本帧是否落脚
   */
  updateHeadBob(delta, speed) {
    const walking = speed >= HEAD_BOB.MIN_STEP_SPEED;
    
    // 步频：0~走路速度按平方根缩放，走路~冲刺速度之间线性过渡，超出部分再按平方根缩放
    let stepRate = 0;
    if (walking) {
      if (speed <= PLAYER.MOVE_SPEED) {
        stepRate = HEAD_BOB.WALK_STEP_RATE * Math.sqrt(speed / PLAYER.MOVE_SPEED);
      } else if (speed <= PLAYER.SPRINT_SPEED) {
        const t = (speed - PLAYER.MOVE_SPEED) / (PLAYER.SPRINT_SPEED - PLAYER.MOVE_SPEED);
        stepRate = HEAD_BOB.WALK_STEP_RATE + (HEAD_BOB.SPRINT_STEP_RATE - HEAD_BOB.WALK_STEP_RATE) * t;
      } else {
        stepRate = HEAD_BOB.SPRINT_STEP_RATE * Math.sqrt(speed / PLAYER.SPRINT_SPEED);
      }
    }
    
    const prevPhase = this.bobPhase;
    this.bobPhase += stepRate * delta;
    const footstep = walking && Math.floor(this.bobPhase) > Math.floor(prevPhase);
    // 相位只关心小数部分与左右脚奇偶，定期回绕避免浮点精度损失
    if (this.bobPhase > 1000) this.bobPhase -= 1000;
    
    if (!this.headBobEnabled) {
      this.bobAmplitude = 0;
      return footstep;
    }
    
    // 目标振幅：慢走按速度比例减小，走路→冲刺之间插值；停下时平滑回落到 0
    let targetAmplitude = 0;
    if (walking) {
      const sprintMix = Math.min(Math.max((speed - PLAYER.MOVE_SPEED) / (PLAYER.SPRINT_SPEED - PLAYER.MOVE_SPEED), 0), 1);
      const base = HEAD_BOB.WALK_AMPLITUDE + (HEAD_BOB.SPRINT_AMPLITUDE - HEAD_BOB.WALK_AMPLITUDE) * sprintMix;
      targetAmplitude = base * Math.min(1, speed / PLAYER.MOVE_SPEED);
    }
    this.bobAmplitude += (targetAmplitude - this.bobAmplitude) * (1 - Math.exp(-HEAD_BOB.SMOOTHING * delta));
    if (targetAmplitude === 0 && this.bobAmplitude < 1e-4) this.bobAmplitude = 0;
    if (this.bobAmplitude === 0) return footstep;
    
    // 上下：每步一个周期，落脚（相位为整数）时处于最低点；左右：频率减半，沿相机水平右向量
    const k = this.bobAmplitude / HEAD_BOB.WALK_AMPLITUDE;
    const vertical = -this.bobAmplitude * Math.cos(2 * Math.PI * this.bobPhase);
    const sway = HEAD_BOB.SWAY_AMPLITUDE * Math.min(k, 1) * Math.cos(Math.PI * this.bobPhase);
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _right.y = 0;
    if (_right.lengthSq() > 1e-8) _right.normalize();
    this.bobOffset.set(_right.x * sway, vertical, _right.z * sway);
    this.camera.position.add(this.bobOffset);
    return footstep;
  }
  
  /**
   * 开关镜头起伏（关闭时立即回到无偏移位置）
   */
  setHeadBob(enabled) {
    this.headBobEnabled = !!enabled;
    if (!this.headBobEnabled) {
      this.camera.position.sub(this.bobOffset);
      this.bobOffset.set(0, 0, 0);
      this.bobAmplitude = 0;
    }
  }
  
  /**
   * 获取控制器对象（即相机）
   */
  getObject() {
    return this.camera;
  }
  
  /**
   * 获取当前位置
   */
  getPosition() {
    return this.camera.position;
  }
  
  /**
   * 设置位置
   */
  setPosition(x, y, z) {
    this.camera.position.set(x, y, z);
    this.bobOffset.set(0, 0, 0);
    this.bobAmplitude = 0;
    // 传入的 y 视为视点高度；脚面取其下 PLAYER.HEIGHT，再贴合该处地面
    this.feetY = Math.max(0, y - PLAYER.HEIGHT);
    this.verticalVelocity = 0;
    this.airborne = false;
    this.onSupport = false;
    this.jumpQueued = false;
    if (this.collisionManager?.getGroundHeight) {
      this.feetY = this.collisionManager.getGroundHeight(x, z, this.feetY, PLAYER.STEP_UP ?? 0.6);
      this.camera.position.y = this.feetY + PLAYER.HEIGHT;
    }
    this.groundY = this.feetY;
  }
  
  /**
   * 当前脚面高度（米）
   */
  getFeetY() {
    return this.feetY;
  }
  
  /**
   * 让视线朝向某个点（只取水平方向，保持平视）
   */
  lookAt(x, z) {
    this.camera.lookAt(x, this.camera.position.y, z);
  }
  
  /**
   * 锁定指针
   */
  lock() {
    if (!this.isMobile) {
      this.controls.lock();
    }
  }
  
  /**
   * 解锁指针
   */
  unlock() {
    this.stop();
    if (!this.isMobile) {
      this.controls.unlock();
    }
  }
  
  /**
   * 检查是否锁定
   */
  isLocked() {
    return this.isMobile || this.controls.isLocked;
  }
  
  /**
   * 销毁
   */
  dispose() {
    this.stop();
    window.removeEventListener('blur', this._onStop);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    this.controls.removeEventListener('unlock', this._onStop);
    if (this._onClick) {
      this.domElement.removeEventListener('click', this._onClick);
    }
    if (this.lookLockButton) {
      this.domElement.removeEventListener('touchstart', this._onLookTouchStart);
      this.domElement.removeEventListener('touchmove', this._onLookTouchMove);
      this.domElement.removeEventListener('touchend', this._onLookTouchEnd);
      this.domElement.removeEventListener('touchcancel', this._onLookTouchEnd);
      this.lookLockButton.removeEventListener('click', this._onLookLockClick);
      this.lookLockButton.remove();
      this.lookLockButton = null;
    }
    if (this.jumpButton) {
      this.jumpButton.removeEventListener('touchstart', this._onJumpTouch);
      this.jumpButton.remove();
      this.jumpButton = null;
    }
    if (this.joystick) {
      this.joystick.dispose();
    }
    if (this.controls.isLocked) this.controls.unlock();
    this.controls.dispose();
  }
}
