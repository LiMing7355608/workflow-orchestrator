import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 编辑器写入会用临时目录，Windows 上 watcher 撞到被占用的临时文件会直接崩进程。
    watch: {
      ignored: ['**/.*.tmpdir/**', '**/*.tmp'],
    },
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/events': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
