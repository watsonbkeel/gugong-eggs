import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RoomManager } from '../rooms.js';
import { C2S, S2C, ERR, PHASE, COUNTDOWN_MS, HINT_RATIOS } from '../../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'game', 'eggSpots.json'), 'utf8'));

/** 假时钟 + 假定时器：advance(ms) 按时间顺序触发到期回调 */
function makeClock() {
  let t = 1_000_000;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: t + ms, fn }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
    },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null; let nid = 0;
        for (const [id, e] of pending) if (e.at <= target && (!next || e.at < next.at)) { next = e; nid = id; }
        if (!next) break;
        pending.delete(nid); t = next.at; next.fn();
      }
      t = target;
    },
    get pendingCount() { return pending.size; },
  };
}

function fakeConn() {
  const c = { readyState: 1, sent: [], ctx: null, closed: false, send(s) { this.sent.push(JSON.parse(s)); }, close() { this.closed = true; this.readyState = 3; } };
  c.last = (type) => [...c.sent].reverse().find((m) => m.type === type);
  c.all = (type) => c.sent.filter((m) => m.type === type);
  return c;
}

function setup(opts = {}) {
  const clock = makeClock();
  let a = 0x9e3779b9; // mulberry32
  const rng = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const mgr = new RoomManager({
    spots: SPOTS, now: clock.now, timers: clock.timers, rng,
    allowCustomDuration: true, ...opts,
  });
  return { mgr, clock };
}

function join(mgr, code, nick, extra = {}) {
  const c = fakeConn();
  mgr.handleMessage(c, JSON.stringify({ type: C2S.JOIN, room: code, nick, ...extra }));
  return c;
}
const host = (mgr, c, type, room, extra = {}) =>
  mgr.handleMessage(c, JSON.stringify({ type, code: room.code, hostToken: room.hostToken, ...extra }));
const hostConn = () => fakeConn();

test('藏蛋点至少 20 个，否则拒绝启动', () => {
  assert.throws(() => new RoomManager({ spots: SPOTS.slice(0, 19) }), /至少 20/);
  assert.doesNotThrow(() => new RoomManager({ spots: SPOTS.slice(0, 20) }));
});

test('建房：4 位房间码 + 32 位口令；房间码不重复', () => {
  const { mgr } = setup();
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const r = mgr.createRoom();
    assert.match(r.code, /^\d{4}$/);
    assert.equal(r.hostToken.length, 32);
    assert.ok(!seen.has(r.code));
    seen.add(r.code);
  }
});

test('进房：房间不存在 / 昵称非法 / 昵称转义', () => {
  const { mgr } = setup();
  const room = mgr.createRoom();
  assert.equal(join(mgr, '9999', '小明同学').last(S2C.ERROR).code, ERR.ROOM_NOT_FOUND);
  assert.equal(join(mgr, room.code, '甲').last(S2C.ERROR).code, ERR.BAD_NICK);
  assert.equal(join(mgr, room.code, '一二三四五六七八九').last(S2C.ERROR).code, ERR.BAD_NICK);
  const c = join(mgr, room.code, '<b>小明</b>');
  assert.equal(c.last(S2C.WELCOME).state.players[0].nick, 'b小明/b'); // 尖括号被剔除，保留文字
  assert.ok(!JSON.stringify(c.last(S2C.WELCOME)).includes('<'));
});

test('人数上限：第 21 人回 room_full', () => {
  const { mgr } = setup();
  const room = mgr.createRoom();
  for (let i = 0; i < 20; i++) assert.ok(join(mgr, room.code, `玩家${i + 10}`).last(S2C.WELCOME));
  const c21 = join(mgr, room.code, '玩家99');
  assert.equal(c21.last(S2C.ERROR).code, ERR.ROOM_FULL);
  assert.equal(room.code && mgr.getRoom(room.code).players.size, 20);
});

test('开局上限：第 4 个房间 start 回 sessions_full，结束一个后可 start', () => {
  const { mgr } = setup();
  const rooms = [1, 2, 3, 4].map(() => mgr.createRoom());
  const hosts = rooms.map(() => hostConn());
  rooms.forEach((r, i) => join(mgr, r.code, `老师${i}`.padEnd(2, 'x'), {})); // 占位玩家，非必须
  for (let i = 0; i < 3; i++) {
    host(mgr, hosts[i], C2S.HOST_START, rooms[i], { durationMs: 300000 });
    assert.equal(mgr.getRoom(rooms[i].code).phase, PHASE.RUNNING);
  }
  assert.equal(mgr.runningCount(), 3);
  host(mgr, hosts[3], C2S.HOST_START, rooms[3], { durationMs: 300000 });
  assert.equal(hosts[3].last(S2C.ERROR).code, ERR.SESSIONS_FULL);
  assert.equal(mgr.getRoom(rooms[3].code).phase, PHASE.WAITING);

  host(mgr, hosts[0], C2S.HOST_END, rooms[0]);
  assert.equal(mgr.runningCount(), 2);
  host(mgr, hosts[3], C2S.HOST_START, rooms[3], { durationMs: 300000 });
  assert.equal(mgr.getRoom(rooms[3].code).phase, PHASE.RUNNING);
});

test('waiting 房间不占 running 名额', () => {
  const { mgr } = setup();
  for (let i = 0; i < 10; i++) mgr.createRoom();
  assert.equal(mgr.runningCount(), 0);
});

test('口令错误不能控制房间；时长非法被拒绝', () => {
  const { mgr } = setup();
  const room = mgr.createRoom();
  const h = hostConn();
  mgr.handleMessage(h, JSON.stringify({ type: C2S.HOST_START, code: room.code, hostToken: 'x'.repeat(32), durationMs: 300000 }));
  assert.equal(h.last(S2C.ERROR).code, ERR.BAD_TOKEN);
  host(mgr, h, C2S.HOST_START, room, { durationMs: 20 * 60000 });
  assert.equal(h.last(S2C.ERROR).code, ERR.BAD_REQUEST);
  const strict = setup({ allowCustomDuration: false });
  const r2 = strict.mgr.createRoom();
  host(strict.mgr, h, C2S.HOST_START, r2, { durationMs: 20000 });
  assert.equal(strict.mgr.getRoom(r2.code).phase, PHASE.WAITING);
});

function startRound(ctx, durationMs = 300000, nicks = ['小明同学', '小红同学', '小刚同学']) {
  const { mgr, clock } = ctx;
  const room = mgr.createRoom();
  const h = hostConn();
  mgr.handleMessage(h, JSON.stringify({ type: C2S.JOIN, room: room.code, role: 'host', token: room.hostToken }));
  const players = nicks.map((n) => join(mgr, room.code, n));
  host(mgr, h, C2S.HOST_START, room, { durationMs });
  const R = mgr.getRoom(room.code);
  return { room, R, h, players, clock };
}
const report = (mgr, c, x, y, z) => mgr.handleMessage(c, JSON.stringify({ type: C2S.POS, x, y, z }));

test('开局：蛋点只下发坐标，不下发殿名；倒数 3 秒后才开始计时', () => {
  const ctx = setup();
  const { R, players } = startRound(ctx);
  const st = players[0].last(S2C.STATE);
  assert.equal(st.phase, PHASE.RUNNING);
  assert.deepEqual(Object.keys(st.egg).sort(), ['x', 'y', 'z']);
  assert.equal(st.eggHall, null);
  assert.equal(st.hintLevel, 0);
  assert.equal(st.hints.length, 1);
  assert.equal(st.startedAt, R.startedAt);
  assert.equal(R.startedAt - (ctx.clock.now()), COUNTDOWN_MS);
});

test('claim：在蛋旁通过并排名；午门外伪造 claim 被拦截', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { R, players } = startRound(ctx);
  const [a, b, c] = players;
  clock.advance(COUNTDOWN_MS + 1000);
  const egg = R.egg;

  // C 在午门外伪造
  report(mgr, c, 0, 1.7, -200);
  mgr.handleMessage(c, JSON.stringify({ type: C2S.CLAIM }));
  assert.equal(c.last(S2C.ERROR).code, ERR.CLAIM_REJECTED);
  assert.equal(c.all(S2C.FOUND).length, 0);

  // C 没有位置信息
  const d = join(mgr, R.code, '小丁同学');
  mgr.handleMessage(d, JSON.stringify({ type: C2S.CLAIM }));
  assert.equal(d.last(S2C.ERROR).code, ERR.CLAIM_REJECTED);

  // A、B 先后到蛋旁
  report(mgr, a, egg.x + 0.5, egg.y + 1.7, egg.z);
  mgr.handleMessage(a, JSON.stringify({ type: C2S.CLAIM }));
  clock.advance(4000);
  report(mgr, b, egg.x, egg.y + 1.7, egg.z - 1);
  mgr.handleMessage(b, JSON.stringify({ type: C2S.CLAIM }));

  for (const p of [a, b, c]) {
    const f = p.all(S2C.FOUND);
    assert.equal(f.length, 2);
    assert.equal(f[0].rank, 1);
    assert.equal(f[1].rank, 2);
    assert.equal(f[0].elapsedMs, 1000);
    assert.equal(f[1].elapsedMs, 5000);
  }
  // 重复 claim 不会重复计分
  mgr.handleMessage(a, JSON.stringify({ type: C2S.CLAIM }));
  assert.equal(b.all(S2C.FOUND).length, 2);
});

test('claim 水平距离 2.0m 为界', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { R, players } = startRound(ctx);
  clock.advance(COUNTDOWN_MS + 500);
  const egg = R.egg;
  report(mgr, players[0], egg.x + 2.1, egg.y + 1.7, egg.z);
  mgr.handleMessage(players[0], JSON.stringify({ type: C2S.CLAIM }));
  assert.equal(players[0].all(S2C.FOUND).length, 0);
  clock.advance(600);
  report(mgr, players[0], egg.x + 1.9, egg.y + 1.7, egg.z);
  mgr.handleMessage(players[0], JSON.stringify({ type: C2S.CLAIM }));
  assert.equal(players[0].all(S2C.FOUND).length, 1);
});

test('防作弊：越界与超速 pos 被丢弃，连续 5 次后 claim 不再采信', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { R, players } = startRound(ctx);
  const [a] = players;
  clock.advance(COUNTDOWN_MS + 500);
  const egg = R.egg;
  // 越界：不更新 lastPos
  report(mgr, a, 999, 1.7, 0);
  assert.equal(R.players.get(a.ctx.playerId).lastPos, null);
  // 正常一次
  report(mgr, a, 0, 1.7, -200);
  clock.advance(500);
  // 连续 5 次瞬移（每次 500ms 内跑 100m）
  let x = 0;
  for (let i = 0; i < 5; i++) { x += 50; report(mgr, a, x > 170 ? x - 170 : x, 1.7, -200 + (x > 170 ? 100 : 0)); clock.advance(500); }
  const pl = R.players.get(a.ctx.playerId);
  assert.ok(pl.violations >= 5, `violations=${pl.violations}`);
  // 现在即使“上报”在蛋旁（先让一次合法位置通过？此时 violations 已满，claim 直接拒绝）
  pl.lastPos = { x: egg.x, y: egg.y + 1.7, z: egg.z, t: clock.now() };
  mgr.handleMessage(a, JSON.stringify({ type: C2S.CLAIM }));
  assert.equal(a.all(S2C.FOUND).length, 0);
  assert.equal(a.last(S2C.ERROR).code, ERR.CLAIM_REJECTED);
});

test('pos 超频（<350ms）被丢弃', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { R, players } = startRound(ctx);
  report(mgr, players[0], 0, 1.7, -200);
  clock.advance(100);
  report(mgr, players[0], 1, 1.7, -200);
  assert.equal(R.players.get(players[0].ctx.playerId).lastPos.x, 0);
});

test('提示按 0/20/40/60/80% 递进，到点自动结束', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { R, players } = startRound(ctx, 60000); // 1 分钟局：0/12/24/36/48 秒
  const [a] = players;
  const t0 = R.startedAt;
  assert.equal(a.all(S2C.HINT).length, 1);
  clock.advance(COUNTDOWN_MS + 11999);
  assert.equal(a.all(S2C.HINT).length, 1);
  clock.advance(2);
  assert.equal(a.all(S2C.HINT).length, 2);
  assert.equal(a.last(S2C.HINT).level, 1);
  clock.advance(12000); assert.equal(a.last(S2C.HINT).level, 2);
  clock.advance(12000); assert.equal(a.last(S2C.HINT).level, 3);
  clock.advance(12000); assert.equal(a.last(S2C.HINT).level, 4);
  assert.equal(R.phase, PHASE.RUNNING);
  clock.advance(12001);
  assert.equal(R.phase, PHASE.ENDED);
  const st = a.last(S2C.STATE);
  assert.equal(st.phase, PHASE.ENDED);
  assert.equal(st.hints.length, 5);
  assert.equal(st.eggHall, R.egg.hall);
  assert.equal(clock.pendingCount, 0, '结束后不应遗留定时器');
  assert.equal(HINT_RATIOS.length, 5);
  assert.ok(t0 > 0);
});

test('重连：带 playerId 回来，成绩与名次保留，旧连接被踢', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { R, players } = startRound(ctx);
  const [a] = players;
  clock.advance(COUNTDOWN_MS + 1000);
  const egg = R.egg;
  report(mgr, a, egg.x, egg.y + 1.7, egg.z);
  mgr.handleMessage(a, JSON.stringify({ type: C2S.CLAIM }));
  const pid = a.ctx.playerId;

  // 断线
  a.readyState = 3; mgr.handleClose(a);
  assert.equal(R.players.get(pid).conn, null);

  // 重连
  const a2 = join(mgr, R.code, '', { playerId: pid });
  const w = a2.last(S2C.WELCOME);
  assert.equal(w.playerId, pid);
  const me = w.state.players.find((p) => p.id === pid);
  assert.equal(me.rank, 1);
  assert.equal(w.state.egg.x, egg.x);
  assert.equal(R.players.size, 3);

  // 同一 playerId 在另一个连接上再 join：旧连接被关闭
  const a3 = join(mgr, R.code, '', { playerId: pid });
  assert.ok(a2.closed);
  assert.equal(R.players.get(pid).conn, a3);
});

test('再来一局：房间码与玩家保留，成绩清空，蛋点不与最近 3 局重复', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { room, R, h, players } = startRound(ctx);
  const ids = [R.egg.id];
  for (let i = 0; i < 6; i++) {
    host(mgr, h, C2S.HOST_END, room);
    host(mgr, h, C2S.HOST_RESET, room);
    assert.equal(R.phase, PHASE.WAITING);
    assert.equal(R.players.size, 3);
    assert.equal(players[0].last(S2C.STATE).egg, null);
    host(mgr, h, C2S.HOST_START, room, { durationMs: 180000 });
    assert.equal(R.phase, PHASE.RUNNING);
    const recent = ids.slice(-3);
    assert.ok(!recent.includes(R.egg.id), `第 ${i + 2} 局蛋点 ${R.egg.id} 与最近 3 局重复 ${recent}`);
    ids.push(R.egg.id);
  }
  assert.ok(clock.now() > 0);
});

test('上一局的定时器不会影响新一局', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { room, R, h } = startRound(ctx, 60000);
  clock.advance(COUNTDOWN_MS + 5000);
  host(mgr, h, C2S.HOST_END, room);
  host(mgr, h, C2S.HOST_RESET, room);
  host(mgr, h, C2S.HOST_START, room, { durationMs: 180000 });
  clock.advance(COUNTDOWN_MS + 70000); // 旧局本应已结束
  assert.equal(R.phase, PHASE.RUNNING);
});

test('开局后进入的玩家按当前状态参加', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const { R } = startRound(ctx);
  clock.advance(COUNTDOWN_MS + 90000);
  const late = join(mgr, R.code, '迟到同学');
  const st = late.last(S2C.WELCOME).state;
  assert.equal(st.phase, PHASE.RUNNING);
  assert.ok(st.egg);
  assert.equal(st.hintLevel, 1); // 开局 90 秒：已解锁第 1 级（宫殿）
  assert.equal(st.hints.length, 2);
});

test('控制台口令校验与 room_state 内容', () => {
  const ctx = setup();
  const { mgr } = ctx;
  const { room, R, h } = startRound(ctx);
  const bad = hostConn();
  mgr.handleMessage(bad, JSON.stringify({ type: C2S.JOIN, room: room.code, role: 'host', token: 'x'.repeat(32) }));
  assert.equal(bad.last(S2C.ERROR).code, ERR.BAD_TOKEN);
  mgr.tick();
  const rs = h.last(S2C.ROOM_STATE);
  assert.equal(rs.egg.hall, R.egg.hall);
  assert.equal(rs.global.running, 1);
  assert.equal(rs.players.length, 3);
});

test('60 分钟无连接的房间被销毁；有连接的保留', () => {
  const ctx = setup();
  const { mgr, clock } = ctx;
  const a = mgr.createRoom();
  const b = mgr.createRoom();
  const c = join(mgr, b.code, '小明同学');
  clock.advance(59 * 60000); mgr.cleanup();
  assert.ok(mgr.getRoom(a.code));
  clock.advance(2 * 60000); mgr.cleanup();
  assert.equal(mgr.getRoom(a.code), null);
  assert.ok(mgr.getRoom(b.code), '有人在线的房间不应被销毁');
  // 断线后 60 分钟再销毁
  c.readyState = 3; mgr.handleClose(c);
  clock.advance(59 * 60000); mgr.cleanup(); assert.ok(mgr.getRoom(b.code));
  clock.advance(2 * 60000); mgr.cleanup(); assert.equal(mgr.getRoom(b.code), null);
});

test('health 统计', () => {
  const { mgr } = setup();
  const r = mgr.createRoom();
  join(mgr, r.code, '小明同学');
  join(mgr, r.code, '小红同学');
  assert.deepEqual(mgr.health(), { ok: true, rooms: 1, running: 0, players: 2 });
});
