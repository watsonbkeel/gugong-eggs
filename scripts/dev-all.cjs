// 本地同时启动前端开发服务器（5173）和联机服务端（8787）。不依赖 concurrently。
// 用法：npm run dev:all    Ctrl+C 一起退出。
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const jobs = [
  ['web   ', ['run', 'dev']],
  ['server', ['--prefix', 'server', 'start']],
];
const children = jobs.map(([name, args]) => {
  const c = spawn(npm, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  c.stdout.on('data', tag);
  c.stderr.on('data', tag);
  c.on('exit', (code) => { console.log(`[${name}] 退出 code=${code}`); shutdown(); });
  return c;
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
