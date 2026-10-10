import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { POST_PROCESSING } from '../config/constants.js';

/**
 * 后期处理管线
 * 包含 SSAO、Bloom、FXAA 等效果
 */

export class PostProcessing {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    
    this.composer = null;
    this.ssaoPass = null;
    this.bloomPass = null;
    this.fxaaPass = null;
  }
  
  /**
   * 初始化后期处理
   */
  init(quality = 'high') {
    const size = this.renderer.getSize(new THREE.Vector2());
    
    // 创建 Composer
    this.composer = new EffectComposer(this.renderer);
    this.pixelRatio = this.renderer.getPixelRatio();
    
    // 基础渲染 Pass
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);
    
    // SSAO Pass
    if (quality === 'high') {
      this.ssaoPass = new SSAOPass(this.scene, this.camera, size.x, size.y);
      this.ssaoPass.kernelRadius = POST_PROCESSING.SSAO.kernelRadius;
      this.ssaoPass.minDistance = POST_PROCESSING.SSAO.minDistance;
      this.ssaoPass.maxDistance = POST_PROCESSING.SSAO.maxDistance;
      this.ssaoPass.output = POST_PROCESSING.SSAO.output;
      this.composer.addPass(this.ssaoPass);
    }
    
    // Bloom Pass
    if (quality === 'high') {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        POST_PROCESSING.BLOOM.strength,
        POST_PROCESSING.BLOOM.radius,
        POST_PROCESSING.BLOOM.threshold
      );
      this.composer.addPass(this.bloomPass);
    }
    
    // 输出 Pass：r152+ 使用 EffectComposer 时必须加，负责线性空间 → sRGB 转换，
    // 否则画面会整体偏暗、发灰
    this.composer.addPass(new OutputPass());
    
    // FXAA 抗锯齿（放在 OutputPass 之后，在 sRGB 空间做抗锯齿效果最好）
    this.fxaaPass = new ShaderPass(FXAAShader);
    this.fxaaPass.material.uniforms['resolution'].value.x = 1 / (size.x * this.renderer.getPixelRatio());
    this.fxaaPass.material.uniforms['resolution'].value.y = 1 / (size.y * this.renderer.getPixelRatio());
    this.composer.addPass(this.fxaaPass);
    
    this.quality = quality;
  }
  
  /**
   * 渲染
   */
  render() {
    if (this.enabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
  
  /**
   * 窗口大小改变时更新
   */
  onResize(width, height) {
    if (!this.composer) return;
    
    // Composer 统一传递物理像素尺寸，不能再用 CSS 尺寸覆盖各 Pass。
    const pixelRatio = this.renderer.getPixelRatio();
    if (this.pixelRatio !== pixelRatio) {
      this.composer.setPixelRatio(pixelRatio);
      this.pixelRatio = pixelRatio;
    }
    this.composer.setSize(width, height);
    
    // 更新 FXAA
    if (this.fxaaPass) {
      const pixelRatio = this.renderer.getPixelRatio();
      this.fxaaPass.material.uniforms['resolution'].value.x = 1 / (width * pixelRatio);
      this.fxaaPass.material.uniforms['resolution'].value.y = 1 / (height * pixelRatio);
    }
  }
  
  /**
   * 切换画质
   */
  setQuality(quality) {
    if (this.quality === quality) return;
    
    // 重新初始化
    this.dispose();
    this.init(quality);
    
    // 需要重新设置渲染器尺寸
    const size = this.renderer.getSize(new THREE.Vector2());
    this.onResize(size.x, size.y);
  }
  
  /**
   * 启用/禁用后期处理
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }
  
  /**
   * 调整 SSAO 参数
   */
  setSSAOParams(params) {
    if (!this.ssaoPass) return;
    
    if (params.kernelRadius !== undefined) {
      this.ssaoPass.kernelRadius = params.kernelRadius;
    }
    if (params.minDistance !== undefined) {
      this.ssaoPass.minDistance = params.minDistance;
    }
    if (params.maxDistance !== undefined) {
      this.ssaoPass.maxDistance = params.maxDistance;
    }
  }
  
  /**
   * 调整 Bloom 参数
   */
  setBloomParams(params) {
    if (!this.bloomPass) return;
    
    if (params.strength !== undefined) {
      this.bloomPass.strength = params.strength;
    }
    if (params.radius !== undefined) {
      this.bloomPass.radius = params.radius;
    }
    if (params.threshold !== undefined) {
      this.bloomPass.threshold = params.threshold;
    }
  }
  
  /**
   * 清理资源
   */
  dispose() {
    if (this.composer) {
      this.composer.passes.forEach(pass => {
        // r162 SSAOPass.dispose 漏掉噪声纹理和 SSAO 材质，需由管线补全。
        if (pass === this.ssaoPass) {
          pass.noiseTexture?.dispose();
          pass.ssaoMaterial?.dispose();
        }
        if (pass.dispose) pass.dispose();
      });
      this.composer.dispose();
    }
    this.composer = null;
    this.ssaoPass = null;
    this.bloomPass = null;
    this.fxaaPass = null;
    this.quality = null;
  }
}
