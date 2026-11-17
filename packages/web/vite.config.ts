import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    /**
     * 显式绑 IPv4 环回。
     *
     * 不写 `host` 时 Vite 绑的是 `localhost`，在 Windows 上那会被解析成 `::1`
     * ——端口在监听，但 `http://127.0.0.1:5173` 连不上，只能改用 `localhost`
     * 打开。一个本地开发服务让人记两种地址是没必要的，而 `127.0.0.1` 才是
     * 代理、健康检查、以及本仓库其它文档里统一在用的那个。
     *
     * `strictPort`：5173 被占时直接失败，而不是悄悄换到 5174。换端口会让
     * 「打开 5173」变成打开一个空页面，那种失败比报错更难查。
     */
    host: '127.0.0.1',
    strictPort: true,
    // 编辑器写入会用临时目录，Windows 上 watcher 撞到被占用的临时文件会直接崩进程。
    watch: {
      ignored: ['**/.*.tmpdir/**', '**/*.tmp'],
    },
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/events': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
