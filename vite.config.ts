import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tauri CLI 的输出不要被 Vite 清屏冲掉
  clearScreen: false,
  server: {
    port: 5173,
    // 端口被占就直接失败，不要让 Tauri 连到一个不存在的地址上
    strictPort: true,
    watch: {
      // Rust 侧改动由 cargo 自己监听，Vite 盯着只会白白触发整页刷新
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 用的 WebView 都是新版本，不需要为老浏览器降级
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
  },
});
