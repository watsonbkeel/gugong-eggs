import * as THREE from 'three';
import { Environment } from './src/scene/Environment.js';
import { PalaceBuilder } from './src/scene/PalaceBuilder.js';
import { PALACE_LAYOUT } from './src/scene/Layout.js';
import { FirstPersonControls } from './src/controls/FirstPerson.js';
import { CollisionManager } from './src/utils/Collision.js';
import { PostProcessing } from './src/render/PostProcessing.js';
import { ShadowSetup } from './src/render/ShadowSetup.js';
import { TextureLibrary } from './src/utils/TextureLibrary.js';
import { Enclosure } from './src/scene/Enclosure.js';
import { GardenBuilder } from './src/scene/GardenBuilder.js';
import { SideCourts } from './src/scene/SideCourts.js';
import { Ambience } from './src/audio/Ambience.js';
import { Minimap } from './src/ui/Minimap.js';
import { SettingsMenu } from './src/ui/SettingsMenu.js';
import { LAYOUT, PERFORMANCE } from './src/config/constants.js';

/**
 * 故宫 3D 虚拟游览主程序
 */

class ForbiddenCityApp {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.postProcessing = null;
    this.collisionManager = null;
    
    this.currentQuality = 'high';
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    this.lastLocation = null;
    this.lastShadowUpdate = 0;
    this.shadowObjects = [];
    this.disposed = false;
    this._animate = this.animate.bind(this);
    this._onResize = this.onResize.bind(this);
    
    // 加载管理
    this.loadingManager = new THREE.LoadingManager();
    this.loadingManager.onProgress = (url, loaded, total) => {
      const progress = (loaded / total) * 100;
      this.updateLoadingProgress(progress, url);
    };
    this.loadingManager.onLoad = () => {
      this.onLoadComplete();
    };
  }
  
  /**
   * 初始化
   */
  async init() {
    // 显示加载界面
    this.showLoading();
    
    // 尺寸监听必须在加载前注册：之前放在加载完成后，手机在加载过程中转横屏，
    // 画布会停留在竖屏尺寸，横屏时只占左半边、右边黑屏。
    // 微信 / iOS 转屏时 resize 可能不触发或触发时尺寸还没更新，所以再加 orientationchange、
    // visualViewport 两路兜底，并在转屏后延迟复查；动画循环里也会每帧比对尺寸。
    this._onOrientationChange = () => {
      this.onResize();
      clearTimeout(this._resizeTimer1);
      clearTimeout(this._resizeTimer2);
      this._resizeTimer1 = setTimeout(this._onResize, 200);
      this._resizeTimer2 = setTimeout(this._onResize, 600);
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onOrientationChange);
    window.visualViewport?.addEventListener('resize', this._onResize);
    
    // 说明：本项目的纹理（Canvas）和几何体都是程序化同步生成的，不经过任何 Loader，
    // LoadingManager 不会自动收到进度，onLoad 也不会触发（之前加载界面卡在 0% 的根因）。
    // 这里把每个构建步骤手动登记到 LoadingManager：先全部 itemStart，每完成一步 itemEnd，
    // 这样 onProgress 能正常推进进度条，最后一步完成时 onLoad 自动触发并关闭加载界面。
    const quality = this.isMobile ? 'low' : 'high';
    const steps = [
      ['渲染器', () => {
        this.createScene();
        this.createCamera();
        this.createRenderer();
        this.shadowSetup = new ShadowSetup(this.renderer);
        this.shadowSetup.init(quality);
      }],
      ['材质贴图', async () => {
        // 手机用 512 档贴图，桌面用 1024 档；加载失败的贴图自动回退为程序化贴图
        const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
        this.library = new TextureLibrary({
          quality: this.isMobile ? 'sd' : 'hd',
          anisotropy: Math.min(maxAniso, this.isMobile ? 2 : 8),
        });
        const stepIndex = steps.findIndex(([name]) => name === '材质贴图');
        await this.library.load((done, total) => {
          const progress = ((stepIndex + done / Math.max(total, 1)) / steps.length) * 100;
          this.updateLoadingProgress(progress, `材质贴图 ${done}/${total}`);
        });
      }],
      ['天空与光照', () => {
        this.environment = new Environment(this.scene, this.renderer, this.library);
        this.environment.init();
        this.environment.setQuality(quality === 'high');
      }],
      ['宫殿建筑', () => {
        this.palaceBuilder = new PalaceBuilder(this.scene, this.library);
        this.palaceBuilder.buildAll(PALACE_LAYOUT);
      }],
      ['宫墙与庑房', () => {
        this.enclosure = new Enclosure(this.scene, this.library).build();
      }],
      ['东西六宫与两路宫殿', () => {
        this.sideCourts = new SideCourts(this.scene, this.library).build();
      }],
      ['御花园', () => {
        const garden = PALACE_LAYOUT.find(item => item.type === 'garden');
        this.garden = new GardenBuilder(this.scene, this.library).build(garden);
        this.scene.traverse(object => {
          if (object.isMesh) this.shadowObjects.push(object);
        });
      }],
      ['碰撞检测', () => {
        this.collisionManager = new CollisionManager();
        this.collisionManager.addColliders(this.palaceBuilder.getColliders());
        this.collisionManager.addWalkables(this.palaceBuilder.getWalkables());
        this.collisionManager.addColliders(this.enclosure.getColliders());
        this.collisionManager.addColliders(this.garden.getColliders());
        this.collisionManager.addWalkables(this.garden.getWalkables());
        this.collisionManager.addColliders(this.sideCourts.getColliders());
        this.collisionManager.addWalkables(this.sideCourts.getWalkables());
        this.collisionManager.setRegions(this.sideCourts.getRegions());
        // 所有可进入房间（世界坐标，含门/掩体/刷怪点），后续玩法从这里取
        this.rooms = this.sideCourts.getRooms();
      }],
      ['控制器', () => {
        this.controls = new FirstPersonControls(this.camera, document.body, this.collisionManager);
        const start = LAYOUT.START_POSITION;
        this.controls.setPosition(start.x, start.y, start.z);
        // 相机默认朝向 -Z（背对故宫），出生时转身面向北边的午门
        this.controls.lookAt(0, LAYOUT.WUMEN_Z);
        this.bindWelcomeOverlay();
      }],
      ['后期处理', () => {
        this.postProcessing = new PostProcessing(this.renderer, this.scene, this.camera);
        this.postProcessing.init(quality);
        this.currentQuality = quality;
      }],
      ['界面', () => {
        this.ambience = new Ambience();
        this.createUI();
        this.bindAudioStart();
      }],
    ];
    
    steps.forEach(([name]) => this.loadingManager.itemStart(name));
    
    try {
      for (const [name, run] of steps) {
        await run();
        this.loadingManager.itemEnd(name);
        // 让出一帧，让浏览器把进度条刷新到屏幕上
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (this.disposed) return;
      }
    } catch (err) {
      this.showLoadingError(err);
      throw err;
    }
    
    // 加载期间可能已经转过屏，进入渲染前按当前窗口尺寸校正一次
    this.onResize();
    
    // 开始动画循环
    this.animate();
    
    console.log('故宫 3D 初始化完成');
  }
  
  /**
   * 桌面端欢迎遮罩：加载完成后显示，点击锁定鼠标后隐藏，按 ESC 解锁后重新显示
   */
  bindWelcomeOverlay() {
    if (this.isMobile) return;
    const overlay = document.getElementById('welcome-overlay');
    if (!overlay) return;
    this._onLock = () => { overlay.style.display = 'none'; };
    this._onUnlock = () => { overlay.style.display = 'flex'; };
    this.controls.controls.addEventListener('lock', this._onLock);
    this.controls.controls.addEventListener('unlock', this._onUnlock);
  }
  
  /**
   * 初始化出错时，在加载界面上直接显示错误，避免一直卡在进度条
   */
  showLoadingError(err) {
    const progressText = document.getElementById('progress-text');
    if (progressText) {
      progressText.style.color = '#ff6b6b';
      progressText.textContent = `加载失败：${err && err.message ? err.message : err}（详情见控制台）`;
    }
  }
  
  /**
   * 创建场景
   */
  createScene() {
    this.scene = new THREE.Scene();
  }
  
  /**
   * 创建相机
   */
  createCamera() {
    // 70° 视场更接近人眼观感；远裁剪面 1200 米，容纳天际线远景环
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      1200
    );
  }
  
  /**
   * 创建渲染器
   */
  createRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isMobile,
      powerPreference: 'high-performance',
    });
    
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.getPixelRatio(this.isMobile ? 'low' : 'high'));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 电影感色调映射：高光不过曝、红墙黄瓦饱和度自然
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.7; // 降低曝光，避免天空过亮
    
    // 画布必须放进 #scene-container 里：
    // 之前直接 append 到 body 末尾，而 #scene-container 已占满 100% 视口，
    // 画布被挤到可视区域下方（body overflow:hidden），所以加载完是一片黑屏
    const canvas = this.renderer.domElement;
    canvas.id = 'scene-canvas';
    const container = document.getElementById('scene-container') || document.body;
    container.appendChild(canvas);
  }
  
  /**
   * 创建 UI
   */
  createUI() {
    // 位置信息面板
    this.locationPanel = document.createElement('div');
    this.locationPanel.id = 'location-panel';
    this.locationPanel.style.cssText = `
      position: fixed;
      top: 20px;
      left: 20px;
      padding: 15px 20px;
      background: rgba(0, 0, 0, 0.6);
      color: white;
      border-radius: 8px;
      font-size: 16px;
      z-index: 1000;
      font-family: Arial, sans-serif;
    `;
    document.body.appendChild(this.locationPanel);
    
    // 操作说明面板
    const helpPanel = document.createElement('div');
    helpPanel.id = 'help-panel';
    helpPanel.style.cssText = `
      position: fixed;
      top: 80px;
      left: 20px;
      padding: 15px 20px;
      background: rgba(0, 0, 0, 0.6);
      color: white;
      border-radius: 8px;
      font-size: 14px;
      z-index: 1000;
      font-family: Arial, sans-serif;
      line-height: 1.6;
    `;
    
    if (this.isMobile) {
      helpPanel.innerHTML = `
        <strong>操作说明</strong><br>
        左下角方向盘：前后左右移动<br>
        同一方向推住2秒：跑起来<br>
        手指拖动屏幕：调整视角<br>
        右下角"跳"：跳过矮墙栏杆<br>
        右上角地图：点开看全图<br>
        右下角按钮：锁定视角<br>
        午门/神武门两端有马道可登城楼
      `;
      // 手机屏幕小，说明面板 8 秒后自动淡出，避免遮挡画面
      helpPanel.style.transition = 'opacity 0.6s ease';
      setTimeout(() => { helpPanel.style.opacity = '0'; }, 8000);
    } else {
      helpPanel.innerHTML = `
        <strong>操作说明</strong><br>
        WASD / 方向键：移动<br>
        长按2秒：自动快走<br>
        鼠标：视角<br>
        空格：跳跃<br>
        M键：小地图<br>
        午门/神武门两端马道可登城楼<br>
        点击屏幕开始游览
      `;
    }
    document.body.appendChild(helpPanel);
    
    // 小地图（按 M 键显示/隐藏）
    // 移动端额外常驻右上角预览，点击展开全图
    this.minimap = new Minimap({ items: this.sideCourts.getMapItems(), preview: this.isMobile });
    
    // 设置菜单（按 ESC 显示）
    this.settingsMenu = new SettingsMenu(document.body);
    this.settingsMenu.init({
      initialQuality: this.currentQuality,
      initialSound: true,
      onResume: () => {
        // 继续游戏：重新锁定鼠标
        if (!this.isMobile && this.controls?.controls) {
          this.controls.controls.lock();
        }
      },
      onQualityChange: (quality) => {
        this.currentQuality = quality;
        this.toggleQuality();
      },
      onSoundToggle: (enabled) => {
        if (!enabled) {
          this.ambience.setMuted(true);
        } else {
          this.ambience.start();
          this.ambience.setMuted(false);
        }
      },
    });
    
    // 绑定 ESC 键打开设置菜单
    this._onKeyDown = (event) => {
      if (event.code === 'Escape') {
        event.preventDefault();
        if (this.controls?.controls?.isLocked) {
          this.controls.controls.unlock();
        }
        this.settingsMenu.toggle();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  /** 浏览器要求用户手势后才能启动音频：桌面锁定鼠标时、移动端首次触摸时启动 */
  bindAudioStart() {
    this._startAudio = () => this.ambience?.start();
    this.controls.controls.addEventListener('lock', this._startAudio);
    window.addEventListener('touchstart', this._startAudio, { passive: true });
    window.addEventListener('pointerdown', this._startAudio);
  }

  /** 是否位于某座门楼的门洞内（用于音效混响） */
  isInGatePassage(position) {
    return PALACE_LAYOUT.some(item => item.type === 'gate' &&
      Math.abs(position.x - item.position.x) < item.dimensions.width * 0.075 &&
      Math.abs(position.z - item.position.z) < item.dimensions.depth / 2);
  }
  
  /**
   * 切换画质
   */
  getPixelRatio(quality) {
    const cap = quality === 'low' ? 1 : (this.isMobile ? PERFORMANCE.MOBILE_MAX_PIXEL_RATIO : 2);
    return Math.min(window.devicePixelRatio || 1, cap);
  }

  toggleQuality() {
    // 按钮文字由 SettingsMenu 自己更新（旧的 qualityButton 已移除）
    this.currentQuality = this.currentQuality === 'high' ? 'low' : 'high';
    
    // 更新渲染设置
    this.renderer.setPixelRatio(this.getPixelRatio(this.currentQuality));
    this.postProcessing.setQuality(this.currentQuality);
    this.environment.setQuality(this.currentQuality === 'high');
    this.shadowSetup.setQuality(this.currentQuality);
    this.lastShadowUpdate = 0;
  }
  
  /**
   * 更新位置信息
   */
  updateLocationInfo() {
    const position = this.controls.getPosition();
    const location = this.collisionManager.getCurrentLocation(position);
    if (location === this.lastLocation) return;
    this.lastLocation = location;
    this.locationPanel.innerHTML = `
      <strong>当前位置</strong><br>
      ${location}
    `;
  }
  
  /**
   * 显示加载界面
   */
  showLoading() {
    const loading = document.getElementById('loading-screen');
    if (loading) {
      loading.style.display = 'flex';
    }
  }
  
  /**
   * 更新加载进度
   */
  updateLoadingProgress(progress, stepName = '') {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    
    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }
    if (progressText) {
      const suffix = stepName ? (stepName.includes('/') ? `（${stepName}）` : `（${stepName}已完成）`) : '';
      progressText.textContent = `加载中... ${Math.round(progress)}%${suffix}`;
    }
  }
  
  /**
   * 加载完成
   */
  onLoadComplete() {
    this.loadingTimeout = setTimeout(() => {
      if (this.disposed) return;
      const loading = document.getElementById('loading-screen');
      if (loading) {
        loading.style.display = 'none';
      }
      
      // 移动端自动开始，桌面端显示欢迎遮罩，点击后锁定鼠标开始游览
      if (this.isMobile) {
        console.log('移动端自动开始');
      } else {
        const overlay = document.getElementById('welcome-overlay');
        if (overlay && !this.controls.controls.isLocked) {
          overlay.style.display = 'flex';
        }
        console.log('点击屏幕开始游览');
      }
    }, 500);
  }
  
  /**
   * 窗口大小调整
   */
  getViewportSize() {
    // 以布局视口为准；部分安卓 WebView 转屏后 innerWidth 更新滞后，取 documentElement 兜底
    const width = Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth));
    const height = Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight));
    return { width, height };
  }
  
  onResize() {
    if (this.disposed || !this.camera || !this.renderer) return;
    const { width, height } = this.getViewportSize();
    this._lastSize = `${width}x${height}`;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setPixelRatio(this.getPixelRatio(this.currentQuality));
    this.renderer.setSize(width, height);
    this.postProcessing?.onResize(width, height);
  }
  
  /**
   * 动画循环
   */
  animate() {
    if (this.disposed) return;
    this.animationFrame = requestAnimationFrame(this._animate);
    
    const now = performance.now();
    const dt = Math.min((now - (this.lastFrameTime ?? now)) / 1000, 0.1);
    this.lastFrameTime = now;
    
    // 兜底：任何原因漏掉 resize 事件（微信/iOS 转屏）时，发现尺寸变了就立即校正
    const { width, height } = this.getViewportSize();
    if (this._lastSize !== `${width}x${height}`) this.onResize();

    // 更新控制器（含走路镜头起伏；motion = { speed, sprint, footstep }）
    this.controls.update();
    const motion = this.controls.motion ?? { speed: 0, sprint: false, footstep: false };
    
    // 更新位置信息
    this.updateLocationInfo();
    
    this.environment.update(this.camera, dt);
    this.palaceBuilder.update?.(dt);
    this.enclosure.update(dt);
    this.garden.update(dt);
    this.sideCourts.update(dt);
    this.ambience.update({
      dt,
      speed: motion.speed,
      sprint: motion.sprint,
      footstep: motion.footstep,
      inTunnel: this.isInGatePassage(this.camera.position),
    });
    this.minimap?.update(this.camera);
    if (now - this.lastShadowUpdate >= 250) {
      const distance = this.currentQuality === 'high' ? PERFORMANCE.LOD_DISTANCE_LOW : PERFORMANCE.LOD_DISTANCE_HIGH;
      this.shadowSetup.updateShadowLOD(this.camera, this.shadowObjects, distance);
      this.lastShadowUpdate = now;
    }
    this.postProcessing.render();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    clearTimeout(this.loadingTimeout);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onOrientationChange);
    window.visualViewport?.removeEventListener('resize', this._onResize);
    clearTimeout(this._resizeTimer1);
    clearTimeout(this._resizeTimer2);
    window.removeEventListener('touchstart', this._startAudio);
    window.removeEventListener('pointerdown', this._startAudio);
    if (this.controls) {
      this.controls.controls.removeEventListener('lock', this._onLock);
      this.controls.controls.removeEventListener('unlock', this._onUnlock);
      this.controls.controls.removeEventListener('lock', this._startAudio);
      this.controls.dispose();
    }
    this.ambience?.dispose();
    this.minimap?.dispose();
    this.postProcessing?.dispose();
    this.palaceBuilder?.dispose();
    this.enclosure?.dispose();
    this.garden?.dispose();
    this.sideCourts?.dispose();
    this.environment?.dispose();
    // 贴图库拥有共享材质与贴图，必须在所有使用方移除后最后释放
    this.library?.dispose();
    this.collisionManager?.clear();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    for (const id of ['location-panel', 'help-panel']) document.getElementById(id)?.remove();
    this.settingsMenu?.dispose();
    this.minimap?.dispose();
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    this.shadowObjects.length = 0;
  }
}

// 本地开发暴露实例用于回归测试；生产页面不增加调试入口。
const app = new ForbiddenCityApp();
if (import.meta.env?.DEV) window.__forbiddenCityApp = app;
app.init().catch(error => console.error('故宫 3D 初始化失败', error));
if (import.meta.hot) import.meta.hot.dispose(() => app.dispose());
