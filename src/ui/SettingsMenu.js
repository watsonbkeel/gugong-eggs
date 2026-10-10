import * as THREE from 'three';

/**
 * ESC 设置菜单：声音开关、画质切换、继续游戏
 */
export class SettingsMenu {
  constructor(container) {
    this.container = container;
    this.overlay = null;
    this.panel = null;
    this.visible = false;
    this.onResume = null;
    this.onQualityChange = null;
    this.onSoundToggle = null;
    
    this.currentQuality = 'high';
    this.soundEnabled = true;
  }
  
  init({ onResume, onQualityChange, onSoundToggle, initialQuality = 'high', initialSound = true }) {
    this.onResume = onResume;
    this.onQualityChange = onQualityChange;
    this.onSoundToggle = onSoundToggle;
    this.currentQuality = initialQuality;
    this.soundEnabled = initialSound;
    
    // 创建半透明遮罩
    this.overlay = document.createElement('div');
    this.overlay.id = 'settings-overlay';
    Object.assign(this.overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'none',
      zIndex: '999',
      backdropFilter: 'blur(8px)',
    });
    
    // 创建设置面板
    this.panel = document.createElement('div');
    this.panel.id = 'settings-panel';
    Object.assign(this.panel.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      border: '2px solid rgba(200, 150, 80, 0.8)',
      borderRadius: '12px',
      padding: '32px 40px',
      minWidth: '400px',
      color: '#fff',
      fontFamily: 'sans-serif',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
    });
    
    this.panel.innerHTML = `
      <h2 style="margin: 0 0 24px 0; text-align: center; color: #e8d4a0; font-size: 24px;">游览设置</h2>
      
      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 8px; font-size: 16px; color: #ddd;">音效</label>
        <button id="sound-toggle-btn" style="
          width: 100%;
          padding: 12px;
          font-size: 16px;
          background: rgba(100, 150, 100, 0.3);
          border: 1px solid rgba(150, 200, 150, 0.5);
          color: #fff;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
        ">🔊 音效已开启</button>
      </div>
      
      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 8px; font-size: 16px; color: #ddd;">画质</label>
        <button id="quality-toggle-btn" style="
          width: 100%;
          padding: 12px;
          font-size: 16px;
          background: rgba(80, 120, 180, 0.3);
          border: 1px solid rgba(120, 160, 220, 0.5);
          color: #fff;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
        ">高画质</button>
      </div>
      
      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 8px; font-size: 16px; color: #ddd;">小地图</label>
        <div style="color: #aaa; font-size: 14px; padding: 8px; background: rgba(255, 255, 255, 0.05); border-radius: 4px;">
          按 <strong style="color: #e8d4a0;">M</strong> 键显示/隐藏小地图
        </div>
      </div>
      
      <button id="resume-btn" style="
        width: 100%;
        padding: 14px;
        margin-top: 16px;
        font-size: 18px;
        background: linear-gradient(135deg, rgba(200, 150, 80, 0.8), rgba(180, 130, 60, 0.8));
        border: none;
        color: #fff;
        border-radius: 8px;
        cursor: pointer;
        font-weight: bold;
        transition: all 0.2s;
      ">继续游览</button>
      
      <div style="margin-top: 16px; text-align: center; color: #888; font-size: 13px;">
        再次按 <strong>ESC</strong> 可快速返回
      </div>
    `;
    
    this.overlay.appendChild(this.panel);
    this.container.appendChild(this.overlay);
    
    // 绑定事件
    this.bindEvents();
  }
  
  bindEvents() {
    const soundBtn = this.panel.querySelector('#sound-toggle-btn');
    const qualityBtn = this.panel.querySelector('#quality-toggle-btn');
    const resumeBtn = this.panel.querySelector('#resume-btn');
    
    soundBtn.addEventListener('click', () => {
      this.soundEnabled = !this.soundEnabled;
      this.updateSoundButton();
      if (this.onSoundToggle) this.onSoundToggle(this.soundEnabled);
    });
    
    qualityBtn.addEventListener('click', () => {
      this.currentQuality = this.currentQuality === 'high' ? 'low' : 'high';
      this.updateQualityButton();
      if (this.onQualityChange) this.onQualityChange(this.currentQuality);
    });
    
    resumeBtn.addEventListener('click', () => {
      this.hide();
    });
    
    // 点击遮罩也可以关闭
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    
    // hover 效果
    [soundBtn, qualityBtn, resumeBtn].forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'scale(1.02)';
        btn.style.filter = 'brightness(1.2)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'scale(1)';
        btn.style.filter = 'brightness(1)';
      });
    });
  }
  
  updateSoundButton() {
    const btn = this.panel.querySelector('#sound-toggle-btn');
    if (this.soundEnabled) {
      btn.textContent = '🔊 音效已开启';
      btn.style.background = 'rgba(100, 150, 100, 0.3)';
      btn.style.borderColor = 'rgba(150, 200, 150, 0.5)';
    } else {
      btn.textContent = '🔇 音效已关闭';
      btn.style.background = 'rgba(150, 100, 100, 0.3)';
      btn.style.borderColor = 'rgba(200, 150, 150, 0.5)';
    }
  }
  
  updateQualityButton() {
    const btn = this.panel.querySelector('#quality-toggle-btn');
    btn.textContent = this.currentQuality === 'high' ? '高画质' : '低画质';
  }
  
  show() {
    this.visible = true;
    this.overlay.style.display = 'block';
    this.updateSoundButton();
    this.updateQualityButton();
  }
  
  hide() {
    this.visible = false;
    this.overlay.style.display = 'none';
    if (this.onResume) this.onResume();
  }
  
  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }
  
  dispose() {
    this.overlay?.remove();
    this.overlay = null;
    this.panel = null;
  }
}
