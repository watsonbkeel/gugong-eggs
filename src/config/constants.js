/**
 * 故宫 3D 场景常量配置
 * 包含颜色、尺寸、布局参数等
 */

// 颜色常量
export const COLORS = {
  // 建筑颜色
  WALL_RED: 0x8B0000,           // 朱红色墙体
  ROOF_YELLOW: 0xDAA520,        // 黄色琉璃瓦
  BASE_WHITE: 0xF5F5DC,         // 汉白玉白色
  GROUND_GRAY: 0x696969,        // 青砖灰色
  WOOD_DARK: 0x2F1B14,          // 深色木框
  
  // 环境颜色
  SKY_TOP: 0x87CEEB,            // 天空顶部
  SKY_BOTTOM: 0xE0F7FF,         // 天空底部
  FOG_COLOR: 0xE8DCC8,          // 雾效颜色
  HEMI_SKY: 0x87CEEB,           // 半球光天空色
  HEMI_GROUND: 0x8B7D6B,        // 半球光地面色
  
  // 水体颜色
  WATER_BLUE: 0x4A90E2,         // 金水河颜色
};

// 建筑尺寸参数（单位：米，适度压缩比例）
export const DIMENSIONS = {
  // 午门
  WUMEN: {
    width: 60,
    depth: 30,
    height: 25,
    wallThickness: 8,
  },
  
  // 太和殿
  TAIHE: {
    width: 63,
    depth: 37,
    height: 35,
    baseHeight: 8,
    baseLayers: 3,
  },
  
  // 中和殿
  ZHONGHE: {
    width: 25,
    depth: 25,
    height: 27,
    baseHeight: 6,
    baseLayers: 2,
  },
  
  // 保和殿
  BAOHE: {
    width: 55,
    depth: 34,
    height: 29,
    baseHeight: 7,
    baseLayers: 2,
  },
  
  // 乾清宫
  QIANQING: {
    width: 42,
    depth: 28,
    height: 26,
    baseHeight: 5,
  },
  
  // 交泰殿
  JIAOTAI: {
    width: 20,
    depth: 20,
    height: 22,
    baseHeight: 4,
  },
  
  // 坤宁宫
  KUNNING: {
    width: 42,
    depth: 28,
    height: 26,
    baseHeight: 5,
  },
  
  // 神武门
  SHENWU: {
    width: 50,
    depth: 20,
    height: 22,
  },
};

// 中轴线布局（Z轴坐标）
export const LAYOUT = {
  START_POSITION: { x: 0, y: 1.7, z: -200 },  // 玩家出生位置
  
  WUMEN_Z: -150,              // 午门
  TAIHE_GATE_Z: -80,          // 太和门
  JINSHUI_RIVER_Z: -100,      // 金水河
  TAIHE_Z: 0,                 // 太和殿
  ZHONGHE_Z: 60,              // 中和殿
  BAOHE_Z: 110,               // 保和殿
  QIANQING_GATE_Z: 170,       // 乾清门
  QIANQING_Z: 210,            // 乾清宫
  JIAOTAI_Z: 250,             // 交泰殿
  KUNNING_Z: 285,             // 坤宁宫
  IMPERIAL_GARDEN_Z: 350,     // 御花园
  SHENWU_Z: 420,              // 神武门
  
  // 场景边界
  BOUNDARY: {
    minX: -175,   // 东华门 / 西华门外留出一段街面
    maxX: 175,
    minZ: -220,
    maxZ: 450,
  },
};

// 性能配置
export const PERFORMANCE = {
  // LOD 距离阈值
  LOD_DISTANCE_HIGH: 80,
  LOD_DISTANCE_LOW: 150,
  
  // 阴影配置
  SHADOW_MAP_SIZE: 2048,
  SHADOW_MAP_SIZE_MOBILE: 1024,
  
  // InstancedMesh 数量
  TILES_PER_ROOF: 2000,         // 每个屋顶的瓦片数（增加以支持多建筑）
  RAILINGS_PER_BASE: 100,       // 每个台基的栏杆柱数
  TREES_IN_GARDEN: 50,          // 御花园树木数
  
  // 移动端性能限制
  MOBILE_MAX_PIXEL_RATIO: 2,
};

// 玩家控制参数
export const PLAYER = {
  HEIGHT: 1.7,                  // 视线高度（米）
  MOVE_SPEED: 5.0,              // 移动速度（米/秒）
  SPRINT_SPEED: 10.0,           // 冲刺速度
  MOUSE_SENSITIVITY: 0.002,     // 鼠标灵敏度
  JOYSTICK_SPEED: 3.0,          // 虚拟摇杆速度（走）
  JOYSTICK_RUN_SPEED: 7.5,      // 方向盘持续推同一方向后的奔跑速度
  JOYSTICK_RUN_DELAY: 2000,     // 持续同一方向多久后开始跑（毫秒）
  JOYSTICK_RUN_ANGLE: 0.6,      // 判定"同一方向"的允许偏差（弧度，约 35°）
  STEP_UP: 0.6,                 // 单帧可直接踏上的最大台阶高度（米）
  JUMP_VELOCITY: 7.2,           // 起跳竖直速度（米/秒）：配合 GRAVITY 跳高约 1.85m，走路速度也能越过 1.1m 汉白玉栏杆
  GRAVITY: 14,                  // 重力加速度（米/秒²，略大于 9.8，手感更利落）
  MAX_FALL_SPEED: 30,           // 最大下落速度（米/秒）
};

// 后处理参数
export const POST_PROCESSING = {
  // SSAO
  SSAO: {
    kernelRadius: 0.5,
    minDistance: 0.001,
    maxDistance: 0.1,
    output: 0, // 0 = Default
  },
  
  // Bloom
  BLOOM: {
    threshold: 0.85,
    strength: 0.6,
    radius: 0.4,
  },
  
  // 雾效
  FOG: {
    density: 0.008,
  },
};

// 质量设置
export const QUALITY_PRESETS = {
  HIGH: {
    shadowMapSize: 2048,
    enableSSAO: true,
    enableBloom: true,
    antialias: true,
  },
  LOW: {
    shadowMapSize: 512,
    enableSSAO: false,
    enableBloom: false,
    antialias: false,
  },
};
