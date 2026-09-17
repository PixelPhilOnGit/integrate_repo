import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core/ 是纯 TypeScript，不依赖 DOM，所以跑在 node 环境即可 —— 启动快得多
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
