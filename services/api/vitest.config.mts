import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 测试直接跑源码，不要求先 build 工作区包
      '@rm/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@rm/ai-adapter': fileURLToPath(
        new URL('../../packages/ai-adapter/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
});
