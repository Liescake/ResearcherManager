import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@rm/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // 纯逻辑测试跑 node 环境；组件测试用 react-dom/server 静态渲染，
    // 因此不引入 jsdom / Testing Library（依赖准入与许可证评估完成前不扩依赖）。
    // 注意：本沙箱下 vitest 默认的 forks 池会因管道 stdio EPERM 失败，
    // 需以 `--pool=threads` 运行（见 README「验证命令」）。
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    reporters: ['default'],
  },
});
