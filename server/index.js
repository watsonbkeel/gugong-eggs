// 故宫金蛋 联机服务：单进程、全内存。http（健康检查、控制台、建房 API）+ ws（玩家与控制台）同一端口。
// 启动：npm start    环境变量见 server/README.md

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/**
 * 创建服务（不监听）。测试里用 port 0 自行 listen。
 * @param {object} [opt]  { spots, spotsPath, maxRunning, maxPlayers, publicGameUrl, allowCustomDuration, log }
 */
export function createGameServer(opt = {}) {
  const env = process.env;
  const spotsPath = opt.spotsPath || env.EGG_SPOTS_PATH || path.join(__dirname, '..', 'src', 'game', 'eggSpots.json');
  const spots = opt.spots || JSON.parse(fs.readFileSync(spotsPath, 'utf8'));
  const log = opt.log || ((line) => console.log(`${new Date().toISOString()} ${line}`));
  const publicGameUrl = opt.publicGameUrl || env.PUBLIC_GAME_URL || 'http://localhost:5173/';

  const mgr = new RoomManager({
    spots,
    maxRunning: opt.maxRunning ?? Number(env.MAX_RUNNING_ROOMS || 3),
    maxPlayers: opt.maxPlayers ?? Number(env.MAX_PLAYERS_PER_ROOM || 20),
    allowCustomDuration: opt.allowCustomDuration ?? env.ALLOW_CUSTOM_DURATION === '1',
    log,
  });

  const staticFiles = {
    '/': ['public/host.html', '.html'],
    '/vendor/qrcode.js': ['public/vendor/qrcode.js', '.js'],
    '/protocol.js': ['../shared/protocol.js', '.js'],
  };

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = url.pathname;

      if (p === '/health') return json(res, 200, mgr.health());

      if (req.method === 'POST' && (p === '/api/rooms' || p === '/host/api/rooms')) {
        const r = mgr.createRoom();
        if (r.error) return json(res, 503, { error: r.error });
        return json(res, 200, r);
      }

      if (p === '/host') { res.writeHead(302, { Location: '/host/' }); return res.end(); }
      if (p.startsWith('/host/')) {
        p = p.slice('/host'.length);
        if (p === '/config.json') return json(res, 200, { gameUrl: publicGameUrl, maxRunning: mgr.maxRunning, wsUrl: env.PUBLIC_WS_URL || '' });
        const f = staticFiles[p];
        if (f) {
          const file = path.join(__dirname, f[0]);
          fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404); return res.end('not found'); }
            // 控制台是手改的单文件，改完要能立刻生效：禁掉浏览器缓存
            res.writeHead(200, { 'Content-Type': MIME[f[1]], 'Cache-Control': 'no-store, must-revalidate' });
            res.end(buf);
          });
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end('error');
    }
  });

  // 任何路径的 WebSocket 升级都接受（Nginx 会把 /gugong-ws/ 与 /gugong-host/ 剥前缀后转发）
  const wss = new WebSocketServer({ server, maxPayload: 2048 });
  wss.on('connection', (ws) => {
    ws.ctx = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => mgr.handleMessage(ws, data.toString()));
    ws.on('close', () => mgr.handleClose(ws));
    ws.on('error', () => { /* 交给 close 处理 */ });
  });

  // 每秒给控制台推 room_state；每 30 秒 ping 一次踢死连接；每分钟回收空房
  const timers = [
    setInterval(() => mgr.tick(), 1000),
    setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, 30000),
    setInterval(() => mgr.cleanup(), 60000),
  ];
  for (const t of timers) t.unref?.();

  const close = () => new Promise((resolve) => {
    for (const t of timers) clearInterval(t);
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => server.close(() => resolve()));
  });

  return { server, wss, mgr, close };
}

// 直接运行：node index.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const app = createGameServer();
  app.server.listen(port, host, () => {
    console.log(`故宫金蛋服务已启动 http://${host}:${port}  藏蛋点 ${app.mgr.spots.length} 个  控制台 /host/`);
  });
  const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
