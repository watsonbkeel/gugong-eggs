import { defineConfig } from 'vite';

/**
 * 构建配置。
 * - 开发（npm run dev）：base 为 '/'，与此前没有配置文件时一致，测试脚本不受影响。
 * - 构建（npm run build）：线上部署在 https://tour.bkeel.com/gugong/，所以默认 base 为 '/gugong/'；
 *   换部署路径时用环境变量覆盖：VITE_BASE=/other/ npm run build
 * - 联机地址：构建时用 VITE_HUNT_WS 注入，例如 VITE_HUNT_WS=wss://tour.bkeel.com/gugong-ws；
 *   不注入则运行时按页面地址推导（https → wss://{host}/gugong-ws，http → ws://{hostname}:8787）。
 */
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE || (command === 'build' ? '/gugong/' : '/'),
}));
