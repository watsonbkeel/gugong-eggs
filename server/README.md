# 故宫金蛋 联机服务

单进程、全内存的 Node 服务（Node 18+，唯一依赖 `ws`）。同一端口提供：

| 路径 | 作用 |
|------|------|
| `GET /health` | 健康检查，返回房间数、运行中房间数、连接数 |
| `GET /host/` | 老师控制台（`host.html`），无需登录 |
| `POST /host/api/rooms` | 建房，返回 4 位房间号和 `hostToken` |
| WebSocket（任意路径） | 玩家与控制台共用，消息格式见 `../shared/protocol.js` |

重启服务会丢失所有房间（设计如此）。

## 本地运行

```bash
npm --prefix server install    # 首次
npm --prefix server start      # http://127.0.0.1:8787/host/
npm --prefix server test       # 单元测试
```

在项目根目录可以用 `npm run dev:all` 同时启动前端（5173）和本服务（8787）。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。放在 Nginx 后面时保持默认，不要对外暴露 |
| `PUBLIC_GAME_URL` | `http://localhost:5173/` | 游戏页面的公开地址，控制台生成二维码和链接时使用，线上填如 `https://example.com/gugong/` |
| `PUBLIC_WS_URL` | 空 | 控制台连接 WebSocket 的地址；留空时自动推断（直连用同端口，经 `/gugong-host/` 访问时用 `/gugong-ws/`） |
| `MAX_RUNNING_ROOMS` | `3` | 同时处于 `running` 的房间上限（`waiting` 不计） |
| `MAX_PLAYERS_PER_ROOM` | `20` | 每房间人数上限 |
| `EGG_SPOTS_PATH` | `../src/game/eggSpots.json` | 藏蛋点文件；少于 20 个点时拒绝启动 |
| `ALLOW_CUSTOM_DURATION` | 空 | 设为 `1` 允许 10 秒到 10 分钟的任意时长，只用于测试；线上不要开，正式时长只有 3 / 5 / 8 分钟 |

## Nginx 配置

放进已有站点的 `server { ... }` 里。游戏静态文件（`dist/`）部署在 `/gugong/` 下，不在本片段范围内。

```nginx
# 玩家与控制台的 WebSocket
location /gugong-ws/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

# 老师控制台页面与建房接口
location = /gugong-host { return 301 /gugong-host/; }
location /gugong-host/ {
    proxy_pass http://127.0.0.1:8787/host/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

要点：

- `proxy_pass` 末尾的 `/` 不能省，Nginx 靠它剥掉 `/gugong-ws/` 前缀。
- 必须是 HTTPS 站点：游戏页在 https 下会自动连 `wss://{host}/gugong-ws`。
- 前端构建时若 WebSocket 地址不是上面这个约定，用 `VITE_HUNT_WS=wss://你的域名/路径 npm run build` 覆盖。
- 控制台入口：`https://你的域名/gugong-host/`。

## 部署步骤

```bash
# 服务器上，进入仓库根目录（克隆下来的目录名即可）
npm --prefix server install --omit=dev
PUBLIC_GAME_URL=https://你的域名/gugong/ PORT=8787 node server/index.js
```

建议用 systemd 或 pm2 守护。服务读取 `src/game/eggSpots.json`，所以部署 `server/` 时要连同 `src/game/eggSpots.json` 和 `shared/` 一起放（或用 `EGG_SPOTS_PATH` 指向别处）。

## 防作弊与限制

- `pos` 超出场景边界的丢弃；速度超过 15 m/s 的丢弃并计数，连续 5 次后该玩家的 `claim` 不再被信任。
- `claim` 以服务端最近一次位置复核（水平距离 < 2.0 m 且高度差 < 3.0 m）。客户端每局最多主动提交 3 次，服务端每人每局最多受理 5 次，超过直接拒绝。
- 全局最多 200 个房间（`maxRooms`，代码内的保险丝，没有对应环境变量）。
- 房间无连接超过 60 分钟自动销毁。
