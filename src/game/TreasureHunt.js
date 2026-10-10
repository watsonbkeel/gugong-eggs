import * as THREE from 'three';
import {
  C2S, S2C, ERR, PHASE, HINT_LEVELS, CLAIM, EGG_HOVER, POS_REPORT, NICK,
} from '../../shared/protocol.js';
import { LAYOUT } from '../config/constants.js';
import { HuntHUD } from '../ui/HuntHUD.js';

/**
 * 联机找金蛋（客户端）。
 *
 * 只有网址带 ?room=1234 才会创建；没有 room 参数时 main.js 不会 new 它，也不会有任何网络连接。
 * 整个类对外只有三个入口：static roomFromUrl()、update(dt)、dispose()。
 * 所有联机代码都包在 try/catch 里：服务器不可用时 HUD 显示“联机不可用”，自由游览不受影响。
 *
 * 判定权在服务器：本地走到金蛋 1.5 m 内只是“发出 claim”，成功与否以服务器的 found 消息为准。
 */

const LS_NICK = 'gugong-hunt-nick';
const lsPid = (code) => `gugong-hunt-pid-${code}`;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];
const NEAR_EGG_M = 10;          // 离金蛋这么近时加密位置上报，保证 claim 前服务器位置是新的
const POS_MIN_BEFORE_CLAIM = 450; // claim 前如需补发一条位置，距上一条至少隔这么久（服务器 350 ms 限频，留抖动余量）
const CLAIM_RETRY_MS = 1200;
const CLAIM_PENDING_TIMEOUT_MS = 2500;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式等 */ } }

export class TreasureHunt {
  /** 从网址取房间号；没有或不合法返回 null */
  static roomFromUrl(search = (typeof location !== 'undefined' ? location.search : '')) {
    try {
      const v = new URLSearchParams(search).get('room');
      return v && /^\d{4}$/.test(v) ? v : null;
    } catch { return null; }
  }

  static wsUrl() {
    const env = import.meta.env?.VITE_HUNT_WS;
    if (env) return env;
    const { protocol, host, hostname } = window.location;
    return protocol === 'https:' ? `wss://${host}/gugong-ws` : `ws://${hostname}:8787`;
  }

  /**
   * @param {object} o
   * @param {string} o.room            4 位房间号
   * @param {THREE.Scene} o.scene
   * @param {THREE.Camera} o.camera
   * @param {object} o.controls        FirstPersonControls
   * @param {object} [o.minimap]       需要有 setMarker({x,z}|null)
   * @param {object} [o.ambience]      需要有 ctx / muted / start()
   * @param {(pos:THREE.Vector3)=>string} [o.getLocation]
   * @param {boolean} [o.isMobile]
   */
  constructor({ room, scene, camera, controls, minimap, ambience, getLocation, isMobile = false }) {
    this.room = room;
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.minimap = minimap;
    this.ambience = ambience;
    this.getLocation = getLocation;
    this.isMobile = isMobile;

    this.alive = true;       // 出现无法恢复的内部错误时置 false，停止所有联机逻辑
    this.ws = null;
    this.wsState = 'idle';   // idle | connecting | open | down
    this.joined = false;     // 收到 welcome
    this.closing = false;
    this.fatal = null;       // 不再重连的致命原因（房间不存在 / 已满）
    this.attempt = 0;
    this.everOpened = false;
    this.reconnectTimer = 0;
    this.nick = null;
    this.playerId = lsGet(lsPid(room));

    // 服务器状态镜像
    this.offset = 0;         // serverTime - Date.now()
    this.phase = PHASE.WAITING;
    this.round = -1;
    this.startedAt = 0;
    this.endsAt = 0;
    this.durationMs = 0;
    this.egg = null;         // {x,y,z}
    this.eggHall = null;
    this.hintLevel = -1;
    this.hints = [];
    this.players = new Map(); // id → {id,nick,online,rank,ms}
    this.selfFound = false;
    this.selfRank = 0;
    this.selfMs = 0;

    // 本地拾取与上报
    this.claimsUsed = 0;
    this.claimPendingUntil = 0;
    this.nextClaimAt = 0;
    this.lastPosSentAt = 0;
    this.lastSentPos = null;
    this.lastMoveAt = 0;
    this.lastFramePos = new THREE.Vector3(1e9, 0, 0);
    this.endedBoardRound = -2;
    this.sawRunning = false;

    // 金蛋与光柱
    this.eggGroup = null;
    this.eggMesh = null;
    this.beam = null;
    this.eggMat = null;

    this.hud = new HuntHUD({ isMobile });
    this.hud.onBoardRequest = () => this._openBoard(false);
    this._setupNickEntry();

    this._onVisibility = () => { if (!document.hidden) this._send({ type: C2S.SYNC }); };
    document.addEventListener('visibilitychange', this._onVisibility);

    // 已经进过这个房间且昵称合法：刷新页面后自动回房，不再让人重填
    const stored = lsGet(LS_NICK);
    if (this.playerId && stored && this._validNick(stored)) {
      this._beginJoin(stored);
    }
  }

  // ───────────────────────── 昵称与进房 ─────────────────────────

  _validNick(s) {
    const n = Array.from(String(s).trim()).length;
    return n >= NICK.MIN && n <= NICK.MAX;
  }

  _setupNickEntry() {
    const saved = lsGet(LS_NICK);
    const def = saved && this._validNick(saved) ? saved : `玩家${1 + Math.floor(Math.random() * 99)}`;
    this.nickUI = this.hud.mountNickEntry({
      code: this.room,
      defaultNick: def,
      onSubmit: (raw) => {
        const nick = String(raw).trim();
        if (!this._validNick(nick)) return `昵称需要 ${NICK.MIN}~${NICK.MAX} 个字`;
        this._beginJoin(nick);
        return null;
      },
    });
  }

  _beginJoin(nick) {
    this.nick = nick;
    lsSet(LS_NICK, nick);
    this.fatal = null;
    this.closing = false;
    this.attempt = 0;
    this.nickUI.setMessage('正在进入房间…');
    this.hud.setBar(`房间 ${this.room}`, '正在连接…');
    this._connect();
  }

  // ───────────────────────── 连接与重连 ─────────────────────────

  _connect() {
    if (this.closing || !this.alive) return;
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.wsState = 'connecting';
    let ws;
    try {
      ws = new WebSocket(TreasureHunt.wsUrl());
    } catch (err) {
      console.warn('[hunt] WebSocket 创建失败', err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsState = 'open';
      this.everOpened = true;
      this._send({ type: C2S.JOIN, room: this.room, nick: this.nick, playerId: this.playerId || undefined });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        this._onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.warn('[hunt] 处理消息出错', err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsState = 'down';
      this._scheduleReconnect();
    };
    ws.onerror = () => { /* 随后会触发 onclose */ };
  }

  _scheduleReconnect() {
    if (this.closing || !this.alive || this.fatal) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    // 第一次进房就连不上：3 次后让人知道“联机不可用”，输入框恢复可点
    if (!this.joined && this.attempt >= 3) this.nickUI.unlock();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), wait);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    return false;
  }

  // ───────────────────────── 收消息 ─────────────────────────

  _onMessage(msg) {
    switch (msg.type) {
      case S2C.WELCOME:
        if (msg.role === 'host') return;
        this.attempt = 0;
        this.playerId = msg.playerId;
        lsSet(lsPid(this.room), this.playerId);
        this.joined = true;
        this.nickUI.markJoined(`已加入，昵称：${this.nick}`);
        this._applyState(msg.state);
        break;
      case S2C.STATE:
        this._applyState(msg);
        break;
      case S2C.PLAYERS:
        this._mergePlayers(msg.list);
        break;
      case S2C.HINT:
        this._onHint(msg.level, msg.text, true);
        break;
      case S2C.FOUND:
        this._onFound(msg);
        break;
      case S2C.ERROR:
        this._onError(msg);
        break;
      default:
        break;
    }
  }

  _onError(msg) {
    switch (msg.code) {
      case ERR.CLAIM_REJECTED:
        this.claimPendingUntil = 0;
        this.nextClaimAt = performance.now() + CLAIM_RETRY_MS;
        this.hud.toast(msg.message || '再靠近一点试试');
        break;
      case ERR.ROOM_NOT_FOUND:
        this._fatal('房间不存在，请向老师确认房间号');
        break;
      case ERR.ROOM_FULL:
        this._fatal(msg.message || '房间已满');
        break;
      case ERR.BAD_NICK:
        // 本地存的玩家身份在服务器上已不存在，且昵称又不合规：回到输入昵称
        this.playerId = null;
        this.fatal = null;
        this.nickUI.unlock();
        this.nickUI.setMessage(msg.message || '昵称不合规，请换一个', true);
        break;
      default:
        this.hud.toast(msg.message || '出了点问题');
    }
  }

  _fatal(text) {
    this.fatal = text;
    this.closing = true; // 不再重连
    try { this.ws?.close(); } catch { /* ignore */ }
    this.nickUI.unlock();
    this.nickUI.setMessage(text, true);
    this.hud.setBar(`房间 ${this.room}`, text, { bad: true });
  }

  _mergePlayers(list) {
    if (!Array.isArray(list)) return;
    const next = new Map();
    for (const p of list) {
      const old = this.players.get(p.id);
      next.set(p.id, {
        id: p.id, nick: p.nick, online: p.online !== false,
        rank: old?.rank ?? p.rank ?? null, ms: old?.ms ?? null,
      });
    }
    this.players = next;
  }

  _applyState(s) {
    if (!s) return;
    this.offset = (s.serverTime ?? Date.now()) - Date.now();
    const prevRound = this.round;

    this.phase = s.phase;
    this.durationMs = s.durationMs || 0;
    this.startedAt = s.startedAt || 0;
    this.endsAt = s.endsAt || 0;
    this.eggHall = s.eggHall || null;
    this.hints = Array.isArray(s.hints) ? s.hints : [];

    // 玩家表（含名次与用时）
    const next = new Map();
    for (const p of s.players || []) {
      next.set(p.id, {
        id: p.id, nick: p.nick, online: p.online !== false,
        rank: p.rank ?? null, ms: p.foundAt != null ? Math.max(0, p.foundAt - this.startedAt) : null,
      });
    }
    this.players = next;
    const me = this.players.get(this.playerId);
    this.selfFound = !!(me && me.rank);
    this.selfRank = me?.rank || 0;
    this.selfMs = me?.ms || 0;

    // 新一局（第一次见到这一轮）：重置本地计数，传送到起点
    const newRound = s.phase === PHASE.RUNNING && s.round !== prevRound;
    if (newRound) {
      this.claimsUsed = 0;
      this.claimPendingUntil = 0;
      this.nextClaimAt = 0;
      this.endedBoardRound = -2;
      this.sawRunning = true;
      this._removeEgg(); // 新一局重建金蛋（清掉上一局“已找到”的半透明状态）
      this.hud.hideBoard();
      this._teleportToStart();
    }
    this.round = s.round;

    if (s.phase === PHASE.WAITING) {
      this.claimsUsed = 0;
      this.hud.setCountdown(null);
      if (this.hud.boardVisible && this.hud.boardFinal) this.hud.hideBoard();
    }

    // 金蛋与提示
    this._syncEgg(s.egg);
    this._setHintLevel(s.hintLevel ?? -1, false);

    // 局终：出榜单，并交还鼠标（桌面端锁定状态下点不到按钮）
    if (s.phase === PHASE.ENDED && this.endedBoardRound !== s.round) {
      this.endedBoardRound = s.round;
      this.hud.setCountdown(null);
      this._openBoard(true);
      this._releasePointer();
    }
  }

  _teleportToStart() {
    try {
      const st = LAYOUT.START_POSITION;
      this.controls.stop();
      this.controls.setPosition(st.x, st.y, st.z);
      this.controls.lookAt(0, LAYOUT.WUMEN_Z);
      this.lastMoveAt = performance.now();
      this.lastFramePos.set(1e9, 0, 0);
    } catch (err) {
      console.warn('[hunt] 传送失败', err);
    }
  }

  _releasePointer() {
    try {
      const c = this.controls?.controls;
      if (c?.isLocked) c.unlock();
    } catch { /* ignore */ }
  }

  // ───────────────────────── 提示 ─────────────────────────

  _onHint(level, text, live) {
    if (typeof level !== 'number') return;
    this.hints[level] = text;
    this._setHintLevel(Math.max(this.hintLevel, level), live);
  }

  _setHintLevel(level, live) {
    const grew = level > this.hintLevel;
    this.hintLevel = level;
    if (level >= HINT_LEVELS.MINIMAP && this.egg && this.phase === PHASE.RUNNING) {
      this.minimap?.setMarker?.({ x: this.egg.x, z: this.egg.z });
    } else {
      this.minimap?.setMarker?.(null);
    }
    if (this.beam) this.beam.visible = level >= HINT_LEVELS.BEAM && this.phase === PHASE.RUNNING;
    if (grew && live && level >= 0) this.hud.flashHint();
  }

  // ───────────────────────── 找到 ─────────────────────────

  _onFound(m) {
    const p = this.players.get(m.playerId);
    if (p) { p.rank = m.rank; p.ms = m.elapsedMs; }
    if (m.playerId === this.playerId) {
      this.selfFound = true;
      this.selfRank = m.rank;
      this.selfMs = m.elapsedMs;
      this.claimPendingUntil = 0;
      if (this.eggMat) { this.eggMat.transparent = true; this.eggMat.opacity = 0.35; this.eggMat.needsUpdate = true; }
      this.hud.goldFlash();
      this._playDing();
    } else {
      this.hud.toast(`${m.nick} 找到了金蛋，第 ${m.rank} 名`);
    }
  }

  _playDing() {
    try {
      const amb = this.ambience;
      if (!amb || amb.muted) return;
      if (!amb.ctx) amb.start?.();
      const ctx = amb.ctx;
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t0 = ctx.currentTime + 0.02;
      // 叮（G5）→ 咚（C6），音调上行
      [[784, 0], [1047, 0.22]].forEach(([freq, dt]) => {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.7);
        g.connect(ctx.destination);
        const o1 = ctx.createOscillator();
        o1.type = 'sine';
        o1.frequency.value = freq;
        const o2 = ctx.createOscillator(); // 泛音，让声音更亮一点
        o2.type = 'triangle';
        o2.frequency.value = freq * 2;
        const g2 = ctx.createGain();
        g2.gain.value = 0.25;
        o1.connect(g);
        o2.connect(g2).connect(g);
        o1.start(t0 + dt); o2.start(t0 + dt);
        o1.stop(t0 + dt + 0.75); o2.stop(t0 + dt + 0.75);
        o1.onended = () => { try { g.disconnect(); g2.disconnect(); } catch { /* ignore */ } };
      });
    } catch (err) {
      console.warn('[hunt] 音效失败', err);
    }
  }

  // ───────────────────────── 金蛋与光柱 ─────────────────────────

  _syncEgg(egg) {
    if (!egg) { this._removeEgg(); return; }
    if (this.egg && this.egg.x === egg.x && this.egg.y === egg.y && this.egg.z === egg.z && this.eggGroup) return;
    this._removeEgg();
    this.egg = { x: egg.x, y: egg.y, z: egg.z };

    const group = new THREE.Group();
    group.position.set(egg.x, egg.y + EGG_HOVER, egg.z);

    const geo = new THREE.SphereGeometry(0.35, 32, 24);
    this.eggMat = new THREE.MeshStandardMaterial({
      color: 0xffc83c, metalness: 0.9, roughness: 0.25,
      emissive: 0xffc83c, emissiveIntensity: 0.6,
    });
    this.eggMesh = new THREE.Mesh(geo, this.eggMat);
    this.eggMesh.scale.y = 1.3;
    this.eggMesh.castShadow = false;
    this.eggMesh.receiveShadow = false;
    group.add(this.eggMesh);

    // 光柱：底部落在地面，高 80 米；不随蛋转动
    const beamGeo = new THREE.CylinderGeometry(0.6, 0.6, 80, 24, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffc83c, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.position.set(egg.x, egg.y + 40, egg.z);
    this.beam.visible = false;

    // 已经找到过（例如断线重连后重建）：保持半透明
    if (this.selfFound) { this.eggMat.transparent = true; this.eggMat.opacity = 0.35; }

    this.eggGroup = group;
    this.scene.add(group);
    this.scene.add(this.beam);
  }

  _removeEgg() {
    if (this.eggGroup) {
      this.scene.remove(this.eggGroup);
      this.eggMesh?.geometry.dispose();
      this.eggMat?.dispose();
    }
    if (this.beam) {
      this.scene.remove(this.beam);
      this.beam.geometry.dispose();
      this.beam.material.dispose();
    }
    this.eggGroup = this.eggMesh = this.eggMat = this.beam = null;
    this.egg = null;
    this.minimap?.setMarker?.(null);
  }

  // ───────────────────────── 每帧 ─────────────────────────

  update(dt) {
    if (!this.alive) return;
    try {
      this._update(dt);
    } catch (err) {
      console.error('[hunt] 联机逻辑出错，已停用，自由游览不受影响', err);
      this.alive = false;
      try { this.hud.setBar('联机不可用', '可以继续自由游览', { bad: true }); } catch { /* ignore */ }
    }
  }

  _update() {
    const now = performance.now();
    const t = now / 1000;

    // 金蛋动画：绕 Y 轴 1 rad/s，上下浮动 ±0.1 m
    if (this.eggMesh) {
      this.eggMesh.rotation.y = t * 1.0;
      this.eggMesh.position.y = Math.sin(t * 2.2) * 0.1;
    }

    if (this.fatal) return;
    if (!this.joined) {
      if (this.nick && this.wsState !== 'open') {
        if (this.attempt >= 3) this.hud.setBar('联机不可用', '可以先自由游览，系统会继续尝试重连', { bad: true });
      }
      return;
    }

    if (this.wsState !== 'open') {
      this.hud.setBar('联机中断，正在重连…', '游览不受影响', { bad: true });
    } else {
      this._renderHud();
    }

    const sNow = Date.now() + this.offset;
    const running = this.phase === PHASE.RUNNING;

    // 倒数：全屏 3-2-1，期间禁止移动
    if (running && sNow < this.startedAt) {
      this.controls.stop();
      this.hud.setCountdown(String(Math.max(1, Math.ceil((this.startedAt - sNow) / 1000))));
    } else if (running && sNow - this.startedAt < 900 && this.sawRunning) {
      this.hud.setCountdown('开始找！');
    } else {
      this.hud.setCountdown(null);
    }

    this._reportPos(now);
    this._checkClaim(now, sNow);
  }

  _renderHud() {
    const sNow = Date.now() + this.offset;
    const total = this.players.size;
    const found = [...this.players.values()].filter((p) => p.rank).length;
    const online = [...this.players.values()].filter((p) => p.online).length;

    if (this.phase === PHASE.WAITING) {
      this.hud.setBar(`房间 ${this.room} · 已进 ${online} 人 · 等待老师开局`, '开局后会倒数 3 秒，先熟悉一下操作');
      return;
    }
    if (this.phase === PHASE.ENDED) {
      this.hud.setBar(`本局已结束 · 找到 ${found}/${total}`, this.eggHall ? `金蛋在：${this.eggHall}` : '等待老师再来一局');
      return;
    }
    // running
    const left = sNow < this.startedAt ? this.durationMs : Math.max(0, this.endsAt - sNow);
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    const clock = `${m}:${String(s).padStart(2, '0')}`;
    const latest = this.hints.length ? this.hints[this.hints.length - 1] : '';
    const hint = latest || '提示马上出现…';
    if (this.selfFound) {
      const ms = this.selfMs;
      const fm = Math.floor(ms / 60000);
      const fs = Math.floor((ms % 60000) / 1000);
      this.hud.setBar(`第 ${this.selfRank} 名 · ${fm}:${String(fs).padStart(2, '0')}`, `剩余 ${clock} · 已找到 ${found}/${total} · 可以继续逛`);
    } else {
      this.hud.setBar(`剩余 ${clock} · 已找到 ${found}/${total}`, hint);
    }
  }

  _reportPos(now) {
    const p = this.camera.position;
    if (p.distanceToSquared(this.lastFramePos) > 0.02 * 0.02) {
      this.lastMoveAt = now;
      this.lastFramePos.copy(p);
    }
    if (this.wsState !== 'open') return;
    const idle = now - this.lastMoveAt > POS_REPORT.IDLE_STOP_MS;
    if (idle && this.lastPosSentAt > this.lastMoveAt) return; // 站定超过 2 秒，且最终位置已报过
    let interval = POS_REPORT.INTERVAL_MS;
    if (this.egg && this.phase === PHASE.RUNNING && Math.hypot(p.x - this.egg.x, p.z - this.egg.z) < NEAR_EGG_M) interval = 400;
    if (now - this.lastPosSentAt >= interval) this._sendPos(now);
  }

  _sendPos(now) {
    const p = this.camera.position;
    let loc = '';
    try { loc = this.getLocation ? String(this.getLocation(p) || '') : ''; } catch { /* ignore */ }
    if (this._send({ type: C2S.POS, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), loc })) {
      this.lastPosSentAt = now;
      this.lastSentPos = { x: p.x, z: p.z };
    }
  }

  _checkClaim(now, sNow) {
    if (this.phase !== PHASE.RUNNING || this.selfFound || !this.egg) return;
    if (sNow < this.startedAt || sNow > this.endsAt) return;
    if (this.claimsUsed >= CLAIM.MAX_CLAIMS) return;
    if (now < this.claimPendingUntil || now < this.nextClaimAt) return;
    const p = this.camera.position;
    const h = Math.hypot(p.x - this.egg.x, p.z - this.egg.z);
    const v = Math.abs(p.y - (this.egg.y + EGG_HOVER));
    if (h >= CLAIM.CLIENT_H || v >= CLAIM.CLIENT_V) return;
    if (this.wsState !== 'open') return;
    // 先保证服务器手里的位置足够新：刚报过且几乎没挪动就直接用；否则补发一条（服务器限频 350 ms，所以要隔开）
    const age = now - this.lastPosSentAt;
    const drift = this.lastSentPos ? Math.hypot(p.x - this.lastSentPos.x, p.z - this.lastSentPos.z) : Infinity;
    if (!(age < 1000 && drift < 0.4)) {
      if (age < POS_MIN_BEFORE_CLAIM) return;
      this._sendPos(now);
    }
    if (this._send({ type: C2S.CLAIM })) {
      this.claimsUsed++;
      this.claimPendingUntil = now + CLAIM_PENDING_TIMEOUT_MS;
      this.nextClaimAt = now + CLAIM_RETRY_MS;
    }
  }

  // ───────────────────────── 排行榜 ─────────────────────────

  _openBoard(final) {
    const rows = [...this.players.values()]
      .map((p) => ({ rank: p.rank || 0, nick: p.nick, ms: p.ms ?? 0, me: p.id === this.playerId }))
      .sort((a, b) => {
        if (a.rank && b.rank) return a.rank - b.rank;
        if (a.rank) return -1;
        if (b.rank) return 1;
        return a.nick.localeCompare(b.nick, 'zh');
      });
    this.hud.showBoard(rows, { final, eggHall: this.eggHall });
  }

  // ───────────────────────── 销毁 ─────────────────────────

  dispose() {
    this.alive = false;
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this._removeEgg();
    this.hud?.dispose();
  }
}
