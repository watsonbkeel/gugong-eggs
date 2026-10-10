import * as THREE from 'three';

/**
 * Canvas 程序化纹理生成器
 * 用于生成砖墙、瓦片、木纹等纹理，避免加载外部图片
 */

export class TextureGenerator {
  /**
   * 生成砖墙纹理
   */
  static createBrickTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // 填充基础红色
    ctx.fillStyle = '#8B0000';
    ctx.fillRect(0, 0, 512, 512);
    
    // 绘制砖块线条
    ctx.strokeStyle = '#660000';
    ctx.lineWidth = 2;
    
    const brickWidth = 128;
    const brickHeight = 64;
    
    for (let y = 0; y < 512; y += brickHeight) {
      for (let x = 0; x < 512; x += brickWidth) {
        const offset = (y / brickHeight) % 2 === 0 ? 0 : brickWidth / 2;
        ctx.strokeRect(x + offset, y, brickWidth, brickHeight);
      }
    }
    
    // 添加噪点
    const imageData = ctx.getImageData(0, 0, 512, 512);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 20;
      data[i] += noise;
      data[i + 1] += noise;
      data[i + 2] += noise;
    }
    ctx.putImageData(imageData, 0, 0);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }
  
  /**
   * 生成瓦片纹理
   */
  static createTileTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // 黄色琉璃瓦基础色
    ctx.fillStyle = '#DAA520';
    ctx.fillRect(0, 0, 512, 512);
    
    // 绘制瓦片纹理
    const tileWidth = 64;
    const tileHeight = 32;
    
    ctx.strokeStyle = '#B8860B';
    ctx.lineWidth = 1;
    
    for (let y = 0; y < 512; y += tileHeight) {
      for (let x = 0; x < 512; x += tileWidth) {
        // 绘制椭圆形瓦片
        ctx.beginPath();
        ctx.ellipse(x + tileWidth / 2, y + tileHeight / 2, tileWidth / 2, tileHeight / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    
    // 添加高光和阴影
    const gradient = ctx.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, 'rgba(255, 255, 200, 0.2)');
    gradient.addColorStop(0.5, 'rgba(255, 255, 200, 0)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.1)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }
  
  /**
   * 生成木纹纹理
   */
  static createWoodTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // 深色木头基础色
    ctx.fillStyle = '#2F1B14';
    ctx.fillRect(0, 0, 512, 512);
    
    // 绘制木纹线条
    ctx.strokeStyle = '#1A0F0A';
    ctx.lineWidth = 2;
    
    for (let i = 0; i < 512; i += 20) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      
      let x = 0;
      while (x < 512) {
        x += 10;
        const y = i + Math.sin(x * 0.1) * 5;
        ctx.lineTo(x, y);
      }
      
      ctx.stroke();
    }
    
    // 添加纹理细节
    const imageData = ctx.getImageData(0, 0, 512, 512);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 15;
      data[i] += noise;
      data[i + 1] += noise * 0.8;
      data[i + 2] += noise * 0.6;
    }
    ctx.putImageData(imageData, 0, 0);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }
  
  /**
   * 生成汉白玉纹理
   */
  static createMarbleTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // 白色基础
    ctx.fillStyle = '#F5F5DC';
    ctx.fillRect(0, 0, 512, 512);
    
    // 添加大理石纹理
    for (let i = 0; i < 50; i++) {
      ctx.strokeStyle = `rgba(220, 220, 200, ${Math.random() * 0.3})`;
      ctx.lineWidth = Math.random() * 3 + 1;
      
      ctx.beginPath();
      const startX = Math.random() * 512;
      const startY = Math.random() * 512;
      ctx.moveTo(startX, startY);
      
      for (let j = 0; j < 10; j++) {
        const x = startX + (Math.random() - 0.5) * 100;
        const y = startY + j * 50 + (Math.random() - 0.5) * 20;
        ctx.lineTo(x, y);
      }
      
      ctx.stroke();
    }
    
    // 添加细微噪点
    const imageData = ctx.getImageData(0, 0, 512, 512);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 10;
      data[i] += noise;
      data[i + 1] += noise;
      data[i + 2] += noise;
    }
    ctx.putImageData(imageData, 0, 0);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }
  
  /**
   * 生成地面纹理
   */
  static createGroundTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // 灰色地面
    ctx.fillStyle = '#696969';
    ctx.fillRect(0, 0, 512, 512);
    
    // 绘制地砖接缝
    ctx.strokeStyle = '#505050';
    ctx.lineWidth = 2;
    
    const tileSize = 128;
    for (let y = 0; y <= 512; y += tileSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();
    }
    
    for (let x = 0; x <= 512; x += tileSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 512);
      ctx.stroke();
    }
    
    // 添加风化效果
    const imageData = ctx.getImageData(0, 0, 512, 512);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 25;
      data[i] += noise;
      data[i + 1] += noise;
      data[i + 2] += noise;
    }
    ctx.putImageData(imageData, 0, 0);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(20, 20);
    return texture;
  }
}
