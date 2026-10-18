// 故宫金蛋：客户端（浏览器）与服务端（Node）共用的协议常量。
// 纯 ES 模块，不依赖任何运行环境。改这里要同时留意 src/game/TreasureHunt.js、server/rooms.js、server/public/host.html。

/** 客户端 → 服务器 */
export const C2S = Object.freeze({
  JOIN: 'join',             // { room, nick, playerId?, role?: 'host', token? }
  POS: 'pos',               // { x, y, z, loc? }   最多 2 Hz
  CLAIM: 'claim',           // {}
  SYNC: 'sync',             // {}
  HOST_START: 'host_start', // { code, hostToken, durationMs, eggCount }
  HOST_END: 'host_end',     // { code, hostToken }
  HOST_RESET: 'host_reset', // { code, hostToken }
});

/** 服务器 → 客户端 */
export const S2C = Object.freeze({
  WELCOME: 'welcome',       // { playerId, state }      （host 角色没有 playerId，附带 room_state）
  STATE: 'state',           // 完整状态，见 buildState()。多蛋模式：eggs: [{id,x,y,z,spot}]
  PLAYERS: 'players',       // { count, list }
  HINT: 'hint',             // { eggIndex, level, text }  eggIndex 0-based
  FOUND: 'found',           // { playerId, nick, eggIndex, foundCount, total, elapsedMs }
  ERROR: 'error',           // { code, message }
  ROOM_STATE: 'room_state', // 仅发给控制台
});

export const ERR = Object.freeze({
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_FULL: 'room_full',
  SESSIONS_FULL: 'sessions_full',
  BAD_NICK: 'bad_nick',
  BAD_TOKEN: 'bad_token',
  BAD_REQUEST: 'bad_request',
  BAD_PHASE: 'bad_phase',
  TOO_MANY_ROOMS: 'too_many_rooms',
  CLAIM_REJECTED: 'claim_rejected', // 服务器复核未通过（客户端可在靠近后重试）
});

export const PHASE = Object.freeze({ WAITING: 'waiting', RUNNING: 'running', ENDED: 'ended' });

/** 提示级别：0 区域 1 宫殿 2 角落 3 小地图标记 4 光柱 */
export const HINT_LEVELS = Object.freeze({ AREA: 0, HALL: 1, CORNER: 2, MINIMAP: 3, BEAM: 4 });
/** 各级提示出现在局时长的哪个比例（5 分钟局正好每分钟一级） */
export const HINT_RATIOS = Object.freeze([0, 0.2, 0.4, 0.6, 0.8]);

/** 开局后给客户端的倒数时间：phase 立即进入 running，但计时从 startedAt（= 开局时刻 + 倒数）起算 */
export const COUNTDOWN_MS = 3000;

/** 判定阈值（米）。客户端先判，服务器用更宽的阈值复核。 */
export const CLAIM = Object.freeze({
  CLIENT_H: 1.5,    // 客户端：相机与蛋的水平距离
  CLIENT_V: 2.5,    // 客户端：高度差
  SERVER_H: 2.0,    // 服务器：lastPos 与蛋的水平距离（比客户端宽 0.5 m，容纳上报延迟）
  SERVER_V: 3.0,    // 服务器：高度差（比客户端略宽）
  MAX_CLAIMS: 3,    // 一局最多发几次 claim
});

/** 金蛋悬浮高度（相对 spot.y） */
export const EGG_HOVER = 0.9;

/** 昵称长度（按字符数）、房间人数、位置上报 */
export const NICK = Object.freeze({ MIN: 2, MAX: 8 });
export const POS_REPORT = Object.freeze({
  INTERVAL_MS: 500,        // 客户端上报间隔
  IDLE_STOP_MS: 2000,      // 静止超过这么久停发
  MIN_GAP_MS: 350,         // 服务器：低于此间隔视为超频，丢弃
  MAX_SPEED: 15,           // 服务器：水平速度超过 m/s 则丢弃并计违规（冲刺约 10 m/s，留余量）
  MAX_VIOLATIONS: 5,       // 连续违规达到此数，不再采信该玩家本局的 claim
});

/** 世界边界（与 src/config/constants.js 的 LAYOUT.BOUNDARY 保持一致；超出的 pos 丢弃） */
export const WORLD_BOUNDARY = Object.freeze({ minX: -175, maxX: 175, minZ: -220, maxZ: 450 });

/** 允许的局时长（分钟） */
export const DURATION_OPTIONS_MIN = Object.freeze([3, 5, 8]);
export const DEFAULT_DURATION_MIN = 5;

/** 提示文案。spot 是 eggSpots.json 的一项。 */
export function hintText(level, spot) {
  switch (level) {
    case HINT_LEVELS.AREA: return `金蛋在${spot.area}${/一带$/.test(spot.area) ? '' : '一带'}`;
    case HINT_LEVELS.HALL: return `金蛋在${spot.hall}里`;
    case HINT_LEVELS.CORNER: return spot.corner;
    case HINT_LEVELS.MINIMAP: return '小地图上出现了金色闪点';
    case HINT_LEVELS.BEAM: return '金色光柱升起来了，远处就能看到';
    default: return '';
  }
}

/** 当前时刻对应的已解锁最高提示级别（-1 = 还没开始） */
export function hintLevelAt(now, startedAt, durationMs) {
  let lv = -1;
  for (let i = 0; i < HINT_RATIOS.length; i++) {
    if (now >= startedAt + durationMs * HINT_RATIOS[i]) lv = i;
  }
  return lv;
}

/** 昵称清洗：去控制字符与会破坏 HTML 的字符，压缩空白。返回 null 表示不合法。 */
export function sanitizeNick(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const n = Array.from(s).length;
  if (n < NICK.MIN || n > NICK.MAX) return null;
  return s;
}

/** 位置字符串（建筑名）清洗，只用于控制台展示 */
export function sanitizeLoc(raw) {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\]/g, '').trim()).slice(0, 16).join('');
}
