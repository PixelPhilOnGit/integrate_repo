import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端测试跑在**普通 Chromium** 里，而不是 Tauri 窗口。
 *
 * 这是刻意的：headless 环境启动不了原生窗口，而前端通过 platform 适配层
 * 可以在纯浏览器里完整运行（虚拟工作区）。所以编辑器的全部交互逻辑
 * —— 拖拽、内联编辑、撤销、导出 —— 都能在这里被真实驱动和断言。
 *
 * Tauri 外壳本身用 xvfb-run 单独验证（见 README）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  // 这些用例都操作同一份 localStorage 工作区，并行会互相踩
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 90_000,
  },
  // 视口必须写在 project 里：project 级的 use 会整体覆盖顶层的 use，
  // 写在顶层会被 devices['Desktop Chrome'] 的 1280x720 覆盖掉
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
