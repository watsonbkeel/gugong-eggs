import { LAYOUT } from '../config/constants.js';

/**
 * 故宫中轴线建筑布局数据
 * 包含每个建筑的位置、尺寸、类型等信息
 */

export const PALACE_LAYOUT = [
  // 护城河（筒子河）- 环绕整个紫禁城
  {
    name: '筒子河',
    type: 'moat',
    position: { x: 0, y: -0.5, z: 125 }, // 中心位置
    dimensions: {
      width: 460,  // 外围总宽（含河道）
      depth: 720,  // 外围总深（含河道）
      riverWidth: 52, // 河道宽度
      height: 0.8,
    },
  },
  
  // 外围城墙 - 紫禁城最外层
  {
    name: '外围城墙',
    type: 'outer_wall',
    position: { x: 0, y: 0, z: 125 },
    dimensions: {
      width: 380,  // 内侧总宽
      depth: 640,  // 内侧总深
      wallHeight: 10,
      wallThickness: 6,
    },
  },
  
  // 午门
  {
    name: '午门',
    type: 'gate',
    position: { x: 0, y: 0, z: LAYOUT.WUMEN_Z },
    dimensions: {
      width: 60,
      depth: 30,
      height: 25,
      wallThickness: 8,
    },
    features: {
      hasWings: true,      // 雁翅楼
      roofType: 'wudian',  // 庑殿顶
      roofLayers: 2,       // 重檐
    },
  },
  
  // 金水河和金水桥
  {
    name: '金水河',
    type: 'river',
    position: { x: 0, y: -0.3, z: LAYOUT.JINSHUI_RIVER_Z },
    dimensions: {
      width: 120,
      depth: 15,
      height: 0.5,
    },
  },
  
  // 太和门
  {
    name: '太和门',
    type: 'gate',
    position: { x: 0, y: 0, z: LAYOUT.TAIHE_GATE_Z },
    dimensions: {
      width: 40,
      depth: 20,
      height: 20,
    },
    features: {
      roofType: 'wudian',
      roofLayers: 1,
    },
  },
  
  // 太和殿
  {
    name: '太和殿',
    type: 'palace',
    position: { x: 0, y: 0, z: LAYOUT.TAIHE_Z },
    dimensions: {
      width: 63,
      depth: 37,
      height: 35,
      baseHeight: 8,
      baseLayers: 3,
    },
    features: {
      roofType: 'wudian',
      roofLayers: 2,
      hasBrackets: true,   // 斗拱
      hasRailings: true,   // 栏杆
      hasPassage: true,    // 前后门洞可通行
    },
  },
  
  // 中和殿
  {
    name: '中和殿',
    type: 'palace',
    position: { x: 0, y: 0, z: LAYOUT.ZHONGHE_Z },
    dimensions: {
      width: 25,
      depth: 25,
      height: 27,
      baseHeight: 6,
      baseLayers: 2,
    },
    features: {
      roofType: 'xieshan',  // 歇山顶
      roofLayers: 1,
      hasBrackets: true,
      hasRailings: true,
      hasPassage: true,    // 前后门洞可通行
    },
  },
  
  // 保和殿
  {
    name: '保和殿',
    type: 'palace',
    position: { x: 0, y: 0, z: LAYOUT.BAOHE_Z },
    dimensions: {
      width: 55,
      depth: 34,
      height: 29,
      baseHeight: 7,
      baseLayers: 2,
    },
    features: {
      roofType: 'wudian',
      roofLayers: 2,
      hasBrackets: true,
      hasRailings: true,
      hasPassage: true,    // 前后门洞可通行
    },
  },
  
  // 乾清门
  {
    name: '乾清门',
    type: 'gate',
    position: { x: 0, y: 0, z: LAYOUT.QIANQING_GATE_Z },
    dimensions: {
      width: 35,
      depth: 18,
      height: 18,
    },
    features: {
      roofType: 'wudian',
      roofLayers: 1,
    },
  },
  
  // 乾清宫
  {
    name: '乾清宫',
    type: 'palace',
    position: { x: 0, y: 0, z: LAYOUT.QIANQING_Z },
    dimensions: {
      width: 42,
      depth: 28,
      height: 26,
      baseHeight: 5,
      baseLayers: 1,
    },
    features: {
      roofType: 'wudian',
      roofLayers: 2,
      hasBrackets: true,
      hasRailings: true,
      hasPassage: true,    // 前后门洞可通行
    },
  },
  
  // 交泰殿
  {
    name: '交泰殿',
    type: 'palace',
    position: { x: 0, y: 0, z: LAYOUT.JIAOTAI_Z },
    dimensions: {
      width: 20,
      depth: 20,
      height: 22,
      baseHeight: 4,
      baseLayers: 1,
    },
    features: {
      roofType: 'xieshan',
      roofLayers: 1,
      hasBrackets: true,
      hasRailings: true,
      hasPassage: true,    // 前后门洞可通行
    },
  },
  
  // 坤宁宫
  {
    name: '坤宁宫',
    type: 'palace',
    position: { x: 0, y: 0, z: LAYOUT.KUNNING_Z },
    dimensions: {
      width: 42,
      depth: 28,
      height: 26,
      baseHeight: 5,
      baseLayers: 1,
    },
    features: {
      roofType: 'wudian',
      roofLayers: 2,
      hasBrackets: true,
      hasRailings: true,
      hasPassage: true,    // 前后门洞可通行
    },
  },
  
  // 御花园
  {
    name: '御花园',
    type: 'garden',
    position: { x: 0, y: 0, z: LAYOUT.IMPERIAL_GARDEN_Z },
    dimensions: {
      width: 130,
      depth: 90,
    },
    features: {
      hasTrees: true,
      hasRocks: true,
      hasPavilions: true,
    },
    elements: [
      // 钦安殿
      {
        name: '钦安殿',
        type: 'pavilion',
        position: { x: 0, y: 0, z: 0 },
        dimensions: {
          width: 15,
          depth: 15,
          height: 18,
        },
      },
      // 堆秀山
      {
        name: '堆秀山',
        type: 'rockery',
        position: { x: 30, y: 0, z: 20 },
        dimensions: {
          width: 10,
          depth: 10,
          height: 8,
        },
      },
    ],
  },
  
  // 神武门
  {
    name: '神武门',
    type: 'gate',
    position: { x: 0, y: 0, z: LAYOUT.SHENWU_Z },
    dimensions: {
      width: 50,
      depth: 20,
      height: 22,
    },
    features: {
      roofType: 'wudian',
      roofLayers: 2,
    },
  },
];

/**
 * 获取建筑数据
 */
export function getBuildingData(name) {
  return PALACE_LAYOUT.find(item => item.name === name);
}

/**
 * 获取所有建筑列表
 */
export function getAllBuildings() {
  return PALACE_LAYOUT.filter(item => item.type !== 'river');
}

/**
 * 获取所有宫殿（不含门）
 */
export function getAllPalaces() {
  return PALACE_LAYOUT.filter(item => item.type === 'palace');
}
