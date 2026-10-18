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

/** 毫秒 → m:ss */
function fmtMs(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

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
   * @param {object} [o.minimap]       需要有 setMarkers([{x,z}])
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
    this.eggCount = 1;       // 本局几个蛋
    this.eggs = [];          // [{x,y,z,hintLevel,found}, ...] 服务端下发的蛋坐标与状态
    this.eggHall = null;     // 局终后显示（单蛋模式遗留字段，多蛋时不用）
    this.hintLevel = -1;     // 最大提示等级（全局，供小地图判断）
    this.hints = [];         // 遗留字段（旧逻辑用的全局提示文本数组，多蛋时不用）
    this.players = new Map(); // id → {id,nick,online,foundCount,lastAt}
    this.selfFoundCount = 0; // 我找到几个
    this.selfFoundEggs = []; // 我找到的蛋 [{eggIndex,at}, ...]
    this.selfRank = 0;       // 遗留字段
    this.selfMs = 0;         // 遗留字段

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

    // 金蛋对象数组（场景中的 3D 物体）
    this.eggObjects = [];    // [{group,mesh,mat,beam}, ...]
    this.fx = [];            // 找到金蛋时的一次性特效

    this.hud = new HuntHUD({ isMobile });
    this.hud.onBoardRequest = () => this._openBoard(false);
    this._setupNickEntry();

    this._onVisibility = () => { if (!document.hidden) this._send({ type: C2S.SYNC }); };
    document.addEventListener('visibilitychange', this._onVisibility);

    // 开发模式下把实例挂到 window，方便在控制台调试（生产构建会被摇掉）
    if (import.meta.env?.DEV) window.__hunt = this;

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
        this._onHint(msg.eggIndex, msg.level, msg.text, true);
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
        foundCount: p.foundCount ?? 0,
        lastAt: p.lastAt ?? null,
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
    this.eggCount = s.eggCount || 1;
    this.hints = Array.isArray(s.hints) ? s.hints : [];

    // 玩家表（含找到几个、最后一个蛋的相对用时）
    const next = new Map();
    for (const p of s.players || []) {
      next.set(p.id, {
        id: p.id, nick: p.nick, online: p.online !== false,
        foundCount: p.foundCount ?? 0,
        lastAt: p.lastAt != null && this.startedAt ? Math.max(0, p.lastAt - this.startedAt) : null,
      });
    }
    this.players = next;
    const me = this.players.get(this.playerId);
    this.selfFoundCount = me?.foundCount ?? 0;
    // selfFoundEggs 从服务端 FOUND 消息累积，这里不覆盖

    // 新一局（第一次见到这一轮）：重置本地计数，传送到起点
    const newRound = s.phase === PHASE.RUNNING && s.round !== prevRound;
    if (newRound) {
      this.claimsUsed = 0;
      this.claimPendingUntil = 0;
      this.nextClaimAt = 0;
      this.endedBoardRound = -2;
      this.sawRunning = true;
      this.selfFoundCount = 0;
      this.selfFoundEggs = [];
      this._removeAllEggs(); // 新一局重建金蛋
      this.hud.hideBoard();
      this._teleportToStart();
    }
    this.round = s.round;

    if (s.phase === PHASE.WAITING) {
      this.claimsUsed = 0;
      this.hud.setCountdown(null);
      if (this.hud.boardVisible && this.hud.boardFinal) this.hud.hideBoard();
    }

    // 金蛋数组与提示
    this._syncEggs(s.eggs || []);

    // 局终：把每个蛋的殿名拼起来（服务端只在 ended 时下发 hall）
    if (s.phase === PHASE.ENDED) {
      const halls = this.eggs.map((e) => e.hall).filter(Boolean);
      this.eggHall = halls.length ? halls.join(' / ') : (s.eggHall || null);
    }

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

  _onHint(eggIndex, level, text, live) {
    if (typeof eggIndex !== 'number' || typeof level !== 'number') return;
    
    // HINT 消息可能在 STATE 之前到达，this.eggs 可能还没初始化
    // 先确保 eggs 数组足够长
    while (this.eggs.length <= eggIndex) {
      this.eggs.push({ x: 0, y: 0, z: 0, hintLevel: -1, hints: [], found: false });
    }
    
    const egg = this.eggs[eggIndex];
    egg.hintLevel = Math.max(egg.hintLevel ?? -1, level);
    
    // 保存提示文本到对应等级
    if (!egg.hints) egg.hints = [];
    if (text && level >= 0) {
      egg.hints[level] = text;
    }
    
    if (live && level >= 0) this.hud.flashHint();
    this._updateMinimapAndBeam();
  }

  _updateMinimapAndBeam() {
    // 小地图：标记所有未找到的、且提示等级达到 MINIMAP 的蛋
    const markers = [];
    for (let i = 0; i < this.eggs.length; i++) {
      const e = this.eggs[i];
      const obj = this.eggObjects[i];
      if (!e || e.found) continue;
      if ((e.hintLevel ?? -1) >= HINT_LEVELS.MINIMAP && this.phase === PHASE.RUNNING) {
        markers.push({ x: e.x, z: e.z });
      }
      // 光柱：提示等级 >= BEAM 且未找到
      if (obj && obj.beam) {
        obj.beam.visible = (e.hintLevel ?? -1) >= HINT_LEVELS.BEAM && this.phase === PHASE.RUNNING && !e.found;
      }
    }
    this.minimap?.setMarkers?.(markers);
  }

  // ───────────────────────── 找到 ─────────────────────────

  _onFound(m) {
    // FOUND 消息：{playerId, nick, eggIndex, foundCount, rank, elapsedMs}
    const p = this.players.get(m.playerId);
    if (p) {
      p.foundCount = m.foundCount ?? ((p.foundCount || 0) + 1);
      p.lastAt = m.elapsedMs ?? null;
    }
    
    const eggIdx = m.eggIndex ?? 0;
    if (this.eggs[eggIdx]) {
      this.eggs[eggIdx].found = true;
    }

    if (m.playerId === this.playerId) {
      this.selfFoundCount = m.foundCount ?? (this.selfFoundCount + 1);      this.selfFoundEggs.push({ eggIndex: eggIdx, at: m.elapsedMs });
      this.claimPendingUntil = 0;
      
      // 把找到的蛋变半透明
      const obj = this.eggObjects[eggIdx];
      if (obj && obj.mat) {
        obj.mat.transparent = true;
        obj.mat.opacity = 0.35;
        obj.mat.needsUpdate = true;
      }
      
      this.hud.goldFlash();
      this.hud.foundBanner('找到金蛋！', `第 ${this.selfFoundCount}/${this.eggCount} 个 · 用时 ${fmtMs(m.elapsedMs)}`);
      this._playDing();
      this._spawnFoundFx(eggIdx);
    } else {
      this.hud.toast(`${m.nick} 找到了第 ${m.foundCount} 个金蛋`);
    }
    
    this._updateMinimapAndBeam();
  }

  // ───────────────────────── 找到金蛋的三维特效 ─────────────────────────

  /** 在蛋的位置放一圈金色冲击波 + 一片溅射光点，约 1.1 秒后自动销毁 */
  _spawnFoundFx(eggIdx) {
    const e = this.eggs[eggIdx];
    if (!e) return;
    const group = new THREE.Group();
    group.position.set(e.x, e.y, e.z);

    // 两道水平光环，第二道错开扩散，做出层叠的冲击波
    const rings = [0, 0.18].map((delay) => {
      const geo = new THREE.RingGeometry(0.42, 0.6, 48);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd764, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      group.add(mesh);
      return { mesh, delay };
    });

    // 溅射光点：随机分布在球面上，靠整体放大做出向外飞散
    const N = 30;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.3 + Math.random() * 0.4;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = (Math.random() - 0.25) * 0.8;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pmat = new THREE.PointsMaterial({
      color: 0xffe9a0, size: 0.3, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      map: this._sparkTexture(),
    });
    const sparks = new THREE.Points(pgeo, pmat);
    group.add(sparks);

    this.scene.add(group);
    this.fx.push({ group, rings, sparks, t0: performance.now(), dur: 1100 });
  }

  /** 圆形光斑贴图（点精灵默认是方块，这里画一个径向渐变的圆点，只生成一次） */
  _sparkTexture() {
    if (this._sparkTex) return this._sparkTex;
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,236,170,0.9)');
    g.addColorStop(1, 'rgba(255,200,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    this._sparkTex = new THREE.CanvasTexture(cv);
    return this._sparkTex;
  }

  _updateFx(now) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      const p = (now - f.t0) / f.dur;
      if (p >= 1) {
        this.scene.remove(f.group);
        f.group.traverse((o) => {
          o.geometry?.dispose?.();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material?.dispose?.();
        });
        this.fx.splice(i, 1);
        continue;
      }
      for (const r of f.rings) {
        const q = Math.min(1, Math.max(0, (p - r.delay) / (1 - r.delay)));
        r.mesh.visible = q > 0;
        const s = 1 + q * 9;
        r.mesh.scale.set(s, s, 1);
        r.mesh.material.opacity = 0.95 * (1 - q);
      }
      const sp = Math.min(1, p / 0.75);
      f.sparks.scale.setScalar(0.5 + sp * 3.4);
      f.sparks.material.opacity = Math.max(0, 1 - sp);
      f.sparks.position.y = -p * 0.5;
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

  _syncEggs(eggs) {
    if (!Array.isArray(eggs) || eggs.length === 0) {
      this._removeAllEggs();
      this.eggs = [];
      return;
    }

    // 保存服务端下发的蛋坐标与状态
    this.eggs = eggs.map((e, i) => ({
      x: e.x, y: e.y, z: e.z,
      hall: e.hall || null,
      hintLevel: e.hintLevel ?? -1,
      hints: e.hints || [],
      found: this.selfFoundEggs.some(f => f.eggIndex === i), // 本地已找到记录
    }));

    // 重建所有金蛋对象
    this._removeAllEggs();
    for (let i = 0; i < this.eggs.length; i++) {
      const e = this.eggs[i];
      const group = new THREE.Group();
      group.position.set(e.x, e.y, e.z);  // 服务端下发的 y 已经包含 EGG_HOVER

      const geo = new THREE.SphereGeometry(0.35, 32, 24);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffc83c, metalness: 0.9, roughness: 0.25,
        emissive: 0xffc83c, emissiveIntensity: 0.6,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.y = 1.3;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);

      // 光柱：高 80 米，中心在地面 + 40，底部对齐地面
      const beamGeo = new THREE.CylinderGeometry(0.6, 0.6, 80, 24, 1, true);
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffc83c, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(e.x, e.y - EGG_HOVER + 40, e.z);  // e.y 是金蛋中心，减去悬浮高度，再加光柱半高
      beam.visible = false;

      // 已找到：半透明
      if (e.found) {
        mat.transparent = true;
        mat.opacity = 0.35;
      }

      this.eggObjects.push({ group, mesh, mat, beam });
      this.scene.add(group);
      this.scene.add(beam);
    }

    this._updateMinimapAndBeam();
  }

  _removeAllEggs() {
    for (const obj of this.eggObjects) {
      if (obj.group) {
        this.scene.remove(obj.group);
        obj.mesh?.geometry.dispose();
        obj.mat?.dispose();
      }
      if (obj.beam) {
        this.scene.remove(obj.beam);
        obj.beam.geometry.dispose();
        obj.beam.material.dispose();
      }
    }
    this.eggObjects = [];
    this.minimap?.setMarkers?.([]);
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
    for (const obj of this.eggObjects) {
      if (obj.mesh) {
        obj.mesh.rotation.y = t * 1.0;
        obj.mesh.position.y = Math.sin(t * 2.2) * 0.1;
      }
    }

    // 找到金蛋时的一次性特效
    if (this.fx.length) this._updateFx(now);

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
    
    // 提示：每个未找到的蛋各占一行，多行时轮流滚动显示（约 3.5 秒换一条）
    const lines = [];
    for (let i = 0; i < this.eggs.length; i++) {
      const e = this.eggs[i];
      if (e.found || (e.hintLevel ?? -1) < 0) continue;
      const txt = e.hints?.[e.hintLevel] || '';
      if (!txt) continue;
      lines.push(this.eggCount > 1 ? `第${i + 1}个蛋：${txt}` : txt);
    }
    let hint;
    if (lines.length === 1) {
      hint = lines[0];
    } else if (lines.length > 1) {
      const idx = Math.floor(Date.now() / 3500) % lines.length;
      hint = `${lines[idx]}　（${idx + 1}/${lines.length}）`;
    } else if (this.selfFoundCount >= this.eggCount) {
      hint = '任务完成，可以四处逛逛';
    } else if (this.eggs.length > 0) {
      hint = '提示马上出现…';
    } else {
      hint = '';
    }

    if (this.selfFoundCount > 0) {
      this.hud.setBar(`剩余 ${clock} · 我 ${this.selfFoundCount}/${this.eggCount}`, hint);
    } else {
      this.hud.setBar(`剩余 ${clock} · 我 0/${this.eggCount}`, hint);
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
    // 离任一未找到的蛋近时，加密位置上报（400 ms）
    if (this.phase === PHASE.RUNNING) {
      for (const e of this.eggs) {
        if (!e.found && Math.hypot(p.x - e.x, p.z - e.z) < NEAR_EGG_M) {
          interval = 400;
          break;
        }
      }
    }
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
    if (this.phase !== PHASE.RUNNING || this.selfFoundCount >= this.eggCount) return;
    if (sNow < this.startedAt || sNow > this.endsAt) return;
    // 每局允许多次提交：蛋越多留的余量越大（服务端最多受理 5 次）
    const maxClaims = Math.min(CLAIM.MAX_CLAIMS + 2, Math.max(CLAIM.MAX_CLAIMS, this.eggCount + 2));
    if (this.claimsUsed >= maxClaims) return;
    if (now < this.claimPendingUntil || now < this.nextClaimAt) return;
    
    const p = this.camera.position;
    // 检测是否靠近任一未找到的蛋
    let nearAny = false;
    for (const e of this.eggs) {
      if (e.found) continue;
      const h = Math.hypot(p.x - e.x, p.z - e.z);
      // e.y 是服务端下发的蛋心高度（已含悬浮量），与服务器判定保持一致
      const v = Math.abs(p.y - e.y);
      if (h < CLAIM.CLIENT_H && v < CLAIM.CLIENT_V) {
        nearAny = true;
        break;
      }
    }
    if (!nearAny) return;
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
      .map((p) => ({
        foundCount: p.foundCount || 0,
        lastAt: p.lastAt ?? 0,
        nick: p.nick,
        me: p.id === this.playerId,
      }))
      .sort((a, b) => {
        if (b.foundCount !== a.foundCount) return b.foundCount - a.foundCount;
        if (a.lastAt === 0 && b.lastAt === 0) return 0;
        if (a.lastAt === 0) return 1;
        if (b.lastAt === 0) return -1;
        return a.lastAt - b.lastAt;
      })
      .map((p, i) => ({
        rank: p.foundCount > 0 ? i + 1 : null,
        nick: p.nick,
        ms: p.lastAt ?? 0,
        foundCount: p.foundCount,
        me: p.me,
      }));
    this.hud.showBoard(rows, final ? (this.eggHall || null) : null, this.eggCount);
  }

  // ───────────────────────── 销毁 ─────────────────────────

  dispose() {
    this.alive = false;
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this._removeAllEggs();
    for (const f of this.fx) this.scene.remove(f.group);
    this.fx = [];
    this.hud?.dispose();
  }
}
