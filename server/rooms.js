// 故宫金蛋：房间与对局逻辑（纯内存，不依赖 ws / http，方便单测）。
// 连接对象 conn 只需要： { readyState, send(str), close(), ctx }，真实 ws 连接和测试用假连接都满足。

import crypto from 'node:crypto';
import {
  C2S, S2C, ERR, PHASE, HINT_RATIOS, COUNTDOWN_MS, CLAIM, EGG_HOVER,
  POS_REPORT, WORLD_BOUNDARY, DURATION_OPTIONS_MIN, DEFAULT_DURATION_MIN,
  hintText, hintLevelAt, sanitizeNick, sanitizeLoc,
} from '../shared/protocol.js';

const ROOM_IDLE_DESTROY_MS = 60 * 60 * 1000;
const OFFLINE_EVICT_MS = 30 * 1000;

const randHex = (n) => crypto.randomBytes(n).toString('hex');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export class RoomManager {
  /**
   * @param {object} o
   * @param {Array}  o.spots            eggSpots.json 的内容
   * @param {number} [o.maxRunning=3]   全局最多同时 running 的房间数
   * @param {number} [o.maxPlayers=20]  每房最多人数
   * @param {number} [o.maxRooms=200]   全局房间总数保险丝
   * @param {boolean}[o.allowCustomDuration=false] 测试用：允许 10 秒~10 分钟的任意时长
   * @param {function} [o.now]          时钟（毫秒）
   * @param {function} [o.rng]          随机数 [0,1)
   * @param {function} [o.log]          日志输出（一行一事件）
   * @param {object}   [o.timers]       { setTimeout, clearTimeout }，测试可替换
   */
  constructor(o) {
    if (!Array.isArray(o.spots) || o.spots.length < 20) {
      throw new Error(`藏蛋点不足：需要至少 20 个，当前 ${o.spots ? o.spots.length : 0} 个`);
    }
    this.spots = o.spots;
    this.maxRunning = o.maxRunning ?? 3;
    this.maxPlayers = o.maxPlayers ?? 20;
    this.maxRooms = o.maxRooms ?? 200;
    this.allowCustomDuration = !!o.allowCustomDuration;
    this.now = o.now || Date.now;
    this.rng = o.rng || Math.random;
    this.log = o.log || (() => {});
    this.timers = o.timers || { setTimeout, clearTimeout };
    /** @type {Map<string, object>} */
    this.rooms = new Map();
  }

  // ───────────────────────── 房间 ─────────────────────────

  createRoom() {
    if (this.rooms.size >= this.maxRooms) return { error: ERR.TOO_MANY_ROOMS };
    let code;
    for (let i = 0; i < 200; i++) {
      code = String(1000 + Math.floor(this.rng() * 9000));
      if (!this.rooms.has(code)) break;
      code = null;
    }
    if (!code) return { error: ERR.TOO_MANY_ROOMS };
    const t = this.now();
    const room = {
      code,
      hostToken: randHex(16),
      phase: PHASE.WAITING,
      durationMs: DEFAULT_DURATION_MIN * 60000,
      startedAt: 0,
      endsAt: 0,
      egg: null,
      lastEggIds: [],
      players: new Map(),
      hosts: new Set(),
      hintLevel: -1,
      timers: [],
      createdAt: t,
      lastActiveAt: t,
      round: 0,
    };
    this.rooms.set(code, room);
    this.log(`room_create code=${code}`);
    return { code, hostToken: room.hostToken };
  }

  getRoom(code) { return this.rooms.get(String(code)) || null; }

  runningCount() {
    let n = 0;
    for (const r of this.rooms.values()) if (r.phase === PHASE.RUNNING) n++;
    return n;
  }

  health() {
    let players = 0;
    for (const r of this.rooms.values()) for (const p of r.players.values()) if (p.conn) players++;
    return { ok: true, rooms: this.rooms.size, running: this.runningCount(), players };
  }

  /** 每分钟调用：销毁 60 分钟无任何连接的房间 */
  cleanup() {
    const t = this.now();
    for (const [code, r] of this.rooms) {
      if (this._connCount(r) > 0) { r.lastActiveAt = t; continue; }
      if (t - r.lastActiveAt >= ROOM_IDLE_DESTROY_MS) this._destroy(r);
    }
  }

  _destroy(room) {
    this._clearTimers(room);
    this.rooms.delete(room.code);
    this.log(`room_destroy code=${room.code}`);
  }

  _connCount(room) {
    let n = room.hosts.size;
    for (const p of room.players.values()) if (p.conn) n++;
    return n;
  }

  // ───────────────────────── 消息入口 ─────────────────────────

  handleMessage(conn, raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case C2S.JOIN: return this._onJoin(conn, msg);
        case C2S.POS: return this._onPos(conn, msg);
        case C2S.CLAIM: return this._onClaim(conn);
        case C2S.SYNC: return this._onSync(conn);
        case C2S.HOST_START: return this._onHostStart(conn, msg);
        case C2S.HOST_END: return this._onHostEnd(conn, msg);
        case C2S.HOST_RESET: return this._onHostReset(conn, msg);
        default: return;
      }
    } catch (e) {
      this.log(`error handling ${msg.type}: ${e && e.stack || e}`);
    }
  }

  handleClose(conn) {
    const ctx = conn.ctx;
    if (!ctx) return;
    conn.ctx = null;
    const room = this.getRoom(ctx.code);
    if (!room) return;
    room.lastActiveAt = this.now();
    if (ctx.role === 'host') { room.hosts.delete(conn); return; }
    const p = room.players.get(ctx.playerId);
    if (p && p.conn === conn) {
      p.conn = null;
      p.offlineAt = this.now();
      this._broadcastPlayers(room);
      this._pushRoomState(room);
    }
  }

  // ───────────────────────── 进房 ─────────────────────────

  _onJoin(conn, msg) {
    if (conn.ctx) this.handleClose(conn); // 同一连接重新 join：先脱离旧身份
    const room = this.getRoom(msg.room);
    if (!room) return this._sendError(conn, ERR.ROOM_NOT_FOUND, '房间不存在');
    room.lastActiveAt = this.now();

    if (msg.role === 'host') {
      if (!this._tokenOk(room, msg.token)) return this._sendError(conn, ERR.BAD_TOKEN, '房主口令不正确');
      room.hosts.add(conn);
      conn.ctx = { code: room.code, role: 'host' };
      this._send(conn, { type: S2C.WELCOME, role: 'host', state: this.buildRoomState(room) });
      return;
    }

    // 玩家：先看是不是重连
    let player = typeof msg.playerId === 'string' ? room.players.get(msg.playerId) : null;
    if (player) {
      if (player.conn && player.conn !== conn) {
        const old = player.conn;
        old.ctx = null;
        try { old.close(); } catch { /* ignore */ }
      }
      player.conn = conn;
      player.offlineAt = 0;
    } else {
      const nick = sanitizeNick(msg.nick);
      if (!nick) return this._sendError(conn, ERR.BAD_NICK, '昵称需要 2~8 个字');
      if (room.players.size >= this.maxPlayers && !this._evictOffline(room)) {
        return this._sendError(conn, ERR.ROOM_FULL, `房间已满（最多 ${this.maxPlayers} 人）`);
      }
      player = {
        id: randHex(8), nick, conn, offlineAt: 0,
        lastPos: null, lastRaw: null, loc: '',
        foundAt: null, rank: null, claims: 0, violations: 0,
      };
      room.players.set(player.id, player);
      this.log(`join code=${room.code} nick=${nick} players=${room.players.size}`);
    }
    conn.ctx = { code: room.code, role: 'player', playerId: player.id };
    this._send(conn, { type: S2C.WELCOME, playerId: player.id, state: this.buildState(room) });
    this._broadcastPlayers(room);
    this._pushRoomState(room);
  }

  /** 房间满员时，踢掉离线超过 30 秒的人腾位置 */
  _evictOffline(room) {
    let victim = null;
    for (const p of room.players.values()) {
      if (!p.conn && p.offlineAt && this.now() - p.offlineAt >= OFFLINE_EVICT_MS) {
        if (!victim || p.offlineAt < victim.offlineAt) victim = p;
      }
    }
    if (!victim) return false;
    room.players.delete(victim.id);
    return true;
  }

  _tokenOk(room, token) {
    if (typeof token !== 'string' || token.length !== room.hostToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(room.hostToken));
  }

  // ───────────────────────── 位置与拾取 ─────────────────────────

  _ctxPlayer(conn) {
    const ctx = conn.ctx;
    if (!ctx || ctx.role !== 'player') return {};
    const room = this.getRoom(ctx.code);
    const player = room && room.players.get(ctx.playerId);
    return { room, player };
  }

  _onPos(conn, msg) {
    const { room, player } = this._ctxPlayer(conn);
    if (!player || player.conn !== conn) return;
    const { x, y, z } = msg;
    if (!isNum(x) || !isNum(y) || !isNum(z)) return;
    const t = this.now();
    room.lastActiveAt = t;

    // 超频：丢弃，不计违规
    if (player.lastRaw && t - player.lastRaw.t < POS_REPORT.MIN_GAP_MS) return;
    // 越界：丢弃
    const B = WORLD_BOUNDARY;
    if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ || y < -20 || y > 100) return;

    const cur = { x, y, z, t };
    const prev = player.lastRaw;
    player.lastRaw = cur;
    if (typeof msg.loc === 'string') player.loc = sanitizeLoc(msg.loc);

    if (prev) {
      const dt = Math.max((t - prev.t) / 1000, 0.05);
      const speed = Math.hypot(x - prev.x, z - prev.z) / dt;
      if (speed > POS_REPORT.MAX_SPEED) {
        // 丢弃本次（lastPos 不更新），连续违规计数
        player.violations++;
        return;
      }
    }
    player.violations = 0;
    player.lastPos = cur;
  }

  _onClaim(conn) {
    const { room, player } = this._ctxPlayer(conn);
    if (!player || player.conn !== conn) return;
    const t = this.now();
    room.lastActiveAt = t;
    if (room.phase !== PHASE.RUNNING || t > room.endsAt) return this._reject(conn, '本局不在进行中');
    if (t < room.startedAt) return this._reject(conn, '还在倒数');
    if (player.foundAt != null) return; // 已找到：静默忽略
    player.claims++;
    if (player.claims > CLAIM.MAX_CLAIMS + 2) return this._reject(conn, '尝试次数过多');
    if (player.violations >= POS_REPORT.MAX_VIOLATIONS) return this._reject(conn, '位置异常');
    const p = player.lastPos;
    if (!p) return this._reject(conn, '没有位置信息');
    const egg = room.egg;
    const h = Math.hypot(p.x - egg.x, p.z - egg.z);
    const v = Math.abs(p.y - (egg.y + EGG_HOVER));
    if (h >= CLAIM.SERVER_H || v >= CLAIM.SERVER_V) {
      this.log(`claim_reject code=${room.code} nick=${player.nick} h=${h.toFixed(2)} v=${v.toFixed(2)}`);
      return this._reject(conn, '离金蛋还有点距离');
    }

    // 通过
    let rank = 1;
    for (const q of room.players.values()) if (q.foundAt != null) rank++;
    player.foundAt = t;
    player.rank = rank;
    const elapsedMs = Math.max(0, t - room.startedAt);
    this.log(`found code=${room.code} egg=${egg.id} nick=${player.nick} rank=${rank} elapsed=${elapsedMs}`);
    this._broadcast(room, { type: S2C.FOUND, playerId: player.id, nick: player.nick, rank, elapsedMs });
    this._pushRoomState(room);
  }

  _reject(conn, message) {
    this._sendError(conn, ERR.CLAIM_REJECTED, message);
  }

  _onSync(conn) {
    const ctx = conn.ctx;
    if (!ctx) return;
    const room = this.getRoom(ctx.code);
    if (!room) return;
    room.lastActiveAt = this.now();
    if (ctx.role === 'host') this._send(conn, { type: S2C.ROOM_STATE, ...this.buildRoomState(room) });
    else this._send(conn, { type: S2C.STATE, ...this.buildState(room) });
  }

  // ───────────────────────── 老师操作 ─────────────────────────

  _hostRoom(conn, msg) {
    const room = this.getRoom(msg.code);
    if (!room) { this._sendError(conn, ERR.ROOM_NOT_FOUND, '房间不存在'); return null; }
    if (!this._tokenOk(room, msg.hostToken)) { this._sendError(conn, ERR.BAD_TOKEN, '房主口令不正确'); return null; }
    room.lastActiveAt = this.now();
    return room;
  }

  _normDuration(durationMs) {
    if (isNum(durationMs)) {
      const min = durationMs / 60000;
      if (DURATION_OPTIONS_MIN.includes(min)) return durationMs;
      if (this.allowCustomDuration && durationMs >= 10000 && durationMs <= 600000) return durationMs;
    }
    return null;
  }

  _onHostStart(conn, msg) {
    const room = this._hostRoom(conn, msg);
    if (!room) return;
    if (room.phase === PHASE.RUNNING) return this._sendError(conn, ERR.BAD_PHASE, '本局已经在进行');
    if (room.phase === PHASE.ENDED) return this._sendError(conn, ERR.BAD_PHASE, '请先点“再来一局”');
    const dur = msg.durationMs == null ? DEFAULT_DURATION_MIN * 60000 : this._normDuration(msg.durationMs);
    if (dur == null) return this._sendError(conn, ERR.BAD_REQUEST, '时长只能是 3 / 5 / 8 分钟');
    if (this.runningCount() >= this.maxRunning) {
      return this._sendError(conn, ERR.SESSIONS_FULL, '当前场次已满，稍后再试');
    }
    this.startRoom(room, dur);
  }

  startRoom(room, durationMs) {
    const t = this.now();
    const egg = this._pickEgg(room);
    room.round++;
    room.phase = PHASE.RUNNING;
    room.durationMs = durationMs;
    room.startedAt = t + COUNTDOWN_MS;
    room.endsAt = room.startedAt + durationMs;
    room.egg = egg;
    room.lastEggIds.push(egg.id);
    if (room.lastEggIds.length > 3) room.lastEggIds.shift();
    room.hintLevel = 0;
    for (const p of room.players.values()) {
      p.foundAt = null; p.rank = null; p.claims = 0; p.violations = 0;
      p.lastPos = null; p.lastRaw = null; // 传送会造成位置跳变，清掉旧位置
    }
    this._scheduleRound(room);
    this.log(`start code=${room.code} egg=${egg.id} hall=${egg.hall} dur=${durationMs} players=${room.players.size}`);
    this._broadcast(room, { type: S2C.STATE, ...this.buildState(room) });
    this._broadcast(room, { type: S2C.HINT, level: 0, text: hintText(0, egg) });
    this._pushRoomState(room);
  }

  _pickEgg(room) {
    let pool = this.spots.filter((s) => !room.lastEggIds.includes(s.id));
    if (pool.length === 0) pool = this.spots;
    return pool[Math.floor(this.rng() * pool.length) % pool.length];
  }

  _scheduleRound(room) {
    this._clearTimers(room);
    const t = this.now();
    const round = room.round;
    // 第 1~4 级提示（第 0 级开局即发）
    for (let lv = 1; lv < HINT_RATIOS.length; lv++) {
      const at = room.startedAt + room.durationMs * HINT_RATIOS[lv];
      room.timers.push(this.timers.setTimeout(() => this._fireHint(room, round, lv), Math.max(0, at - t)));
    }
    room.timers.push(this.timers.setTimeout(() => this._endRoom(room, round, 'timeout'), Math.max(0, room.endsAt - t)));
  }

  _fireHint(room, round, lv) {
    if (room.round !== round || room.phase !== PHASE.RUNNING) return;
    room.hintLevel = lv;
    this._broadcast(room, { type: S2C.HINT, level: lv, text: hintText(lv, room.egg) });
    this._pushRoomState(room);
  }

  _endRoom(room, round, reason) {
    if (room.round !== round || room.phase !== PHASE.RUNNING) return;
    this._clearTimers(room);
    room.phase = PHASE.ENDED;
    const found = [...room.players.values()].filter((p) => p.foundAt != null).length;
    this.log(`end code=${room.code} egg=${room.egg.id} reason=${reason} found=${found}/${room.players.size}`);
    this._broadcast(room, { type: S2C.STATE, ...this.buildState(room) });
    this._pushRoomState(room);
  }

  _onHostEnd(conn, msg) {
    const room = this._hostRoom(conn, msg);
    if (!room) return;
    if (room.phase !== PHASE.RUNNING) return this._sendError(conn, ERR.BAD_PHASE, '当前没有进行中的一局');
    this._endRoom(room, room.round, 'host');
  }

  _onHostReset(conn, msg) {
    const room = this._hostRoom(conn, msg);
    if (!room) return;
    if (room.phase === PHASE.RUNNING) this._endRoom(room, room.round, 'host_reset');
    this._clearTimers(room);
    room.phase = PHASE.WAITING;
    room.egg = null;
    room.startedAt = 0;
    room.endsAt = 0;
    room.hintLevel = -1;
    for (const p of room.players.values()) {
      p.foundAt = null; p.rank = null; p.claims = 0; p.violations = 0; p.lastPos = null; p.lastRaw = null;
    }
    this.log(`reset code=${room.code}`);
    this._broadcast(room, { type: S2C.STATE, ...this.buildState(room) });
    this._pushRoomState(room);
  }

  _clearTimers(room) {
    for (const h of room.timers) this.timers.clearTimeout(h);
    room.timers = [];
  }

  // ───────────────────────── 状态与广播 ─────────────────────────

  buildState(room) {
    const t = this.now();
    const running = room.phase === PHASE.RUNNING;
    const ended = room.phase === PHASE.ENDED;
    const level = (running || ended) ? Math.max(0, Math.min(room.hintLevel, HINT_RATIOS.length - 1)) : -1;
    const hints = [];
    for (let i = 0; i <= level; i++) hints.push(hintText(i, room.egg));
    return {
      phase: room.phase,
      code: room.code,
      players: [...room.players.values()].map((p) => ({
        id: p.id, nick: p.nick, foundAt: p.foundAt, rank: p.rank, online: !!p.conn,
      })),
      durationMs: room.durationMs,
      startedAt: room.startedAt,
      endsAt: room.endsAt,
      round: room.round,
      egg: (running || ended) && room.egg ? { x: room.egg.x, y: room.egg.y, z: room.egg.z } : null,
      eggHall: ended && room.egg ? room.egg.hall : null,
      hintLevel: level,
      hints,
      serverTime: t,
    };
  }

  buildRoomState(room) {
    const state = this.buildState(room);
    const t = this.now();
    state.players = [...room.players.values()].map((p) => ({
      id: p.id, nick: p.nick, foundAt: p.foundAt, rank: p.rank, online: !!p.conn,
      loc: p.loc, lastPos: p.lastPos ? { x: p.lastPos.x, y: p.lastPos.y, z: p.lastPos.z, ageMs: t - p.lastPos.t } : null,
      violations: p.violations,
    }));
    state.egg = room.egg ? { x: room.egg.x, y: room.egg.y, z: room.egg.z, id: room.egg.id, area: room.egg.area, hall: room.egg.hall, corner: room.egg.corner } : null;
    state.global = {
      running: this.runningCount(),
      maxRunning: this.maxRunning,
      maxPlayers: this.maxPlayers,
      rooms: [...this.rooms.values()].map((r) => ({
        code: r.code, phase: r.phase, count: r.players.size, online: [...r.players.values()].filter((p) => p.conn).length,
      })),
    };
    return state;
  }

  _broadcastPlayers(room) {
    const list = [...room.players.values()].map((p) => ({ id: p.id, nick: p.nick, online: !!p.conn }));
    this._broadcast(room, { type: S2C.PLAYERS, count: list.filter((p) => p.online).length, list });
  }

  /** 发给房间里所有玩家（和控制台能看到的同一条消息，控制台不收 hint 以外的玩家态消息时也无妨） */
  _broadcast(room, obj) {
    const s = JSON.stringify(obj);
    for (const p of room.players.values()) this._raw(p.conn, s);
    for (const h of room.hosts) this._raw(h, s);
  }

  _pushRoomState(room) {
    if (room.hosts.size === 0) return;
    const s = JSON.stringify({ type: S2C.ROOM_STATE, ...this.buildRoomState(room) });
    for (const h of room.hosts) this._raw(h, s);
  }

  /** 每秒调用：给有控制台的房间推一次 room_state（带倒计时、位置） */
  tick() {
    for (const r of this.rooms.values()) this._pushRoomState(r);
  }

  _send(conn, obj) { this._raw(conn, JSON.stringify(obj)); }
  _raw(conn, s) {
    if (!conn || conn.readyState !== 1) return;
    try { conn.send(s); } catch { /* 连接已坏，等 close 事件清理 */ }
  }
  _sendError(conn, code, message) { this._send(conn, { type: S2C.ERROR, code, message }); }
}
