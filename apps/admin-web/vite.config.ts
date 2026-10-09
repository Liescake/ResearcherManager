import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 管理端构建配置。
 * - envDir 指向仓库根目录：统一使用根 .env（VITE_* 变量），避免多处配置漂移。
 * - @rm/shared 别名直接指向源码：开发与构建都不需要先执行 packages 的 build。
 * - /api 代理到本地 API：未配置 VITE_API_BASE_URL 时也能直接联调（默认回落到同源 /api/v1）。
 */
const devApiTarget = process.env['VITE_DEV_API_TARGET'] ?? 'http://127.0.0.1:3000';

const apiProxy = {
  '/api': {
    target: devApiTarget,
    changeOrigin: true,
  },
} as const;

export default defineConfig({
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@rm/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
  },
});
