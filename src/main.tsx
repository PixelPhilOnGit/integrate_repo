import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './shell/AppShell';
import { MODULES } from './shell/registry';
import { configurePlatform, platform } from './shared/platform';
import { setActiveScenario } from './shared/platform/scenario';
import './styles.css';

/**
 * 组合根：把各模块的平台配置汇总起来注入平台层。
 *
 * 平台层是共享的、不认识任何具体模块；模块也不该知道平台层怎么存文件。
 * 两边都在这里接起来 —— 这是唯一一处「同时认识外壳和模块」的地方。
 *
 * 必须在渲染之前调用：模块激活时会去列工作区目录。
 */
configurePlatform({
  // 目录树列出所有模块关心的文件类型
  listedExtensions: MODULES.flatMap((m) => m.platform.listedExtensions),
  // 默认后缀取第一个模块的。多模块之后这里要有更明确的策略
  // （新建文件时让用户选类型？），但现在只有顺序图一个，不值得提前设计
  defaultExtension: MODULES[0]?.platform.defaultExtension ?? '',
  // 浏览器版虚拟工作区的初始内容 = 各模块种子的拼接
  seed: () => MODULES.flatMap((m) => m.platform.seed?.() ?? []),
});

/**
 * 启动前先把**场景**就位，再渲染。
 *
 * ⚠️ 顺序是硬要求：各模块的 KV 在模块被 import/激活时按场景后缀拼存储名，
 * 场景晚一步设置的话，第一个激活的模块会读到**默认场景**的数据 ——
 * 那种错法静悄悄的（界面有数据，只是不是这个场景的）。
 *
 * 代价是首帧要等一次偏好读取（毫秒级；桌面端首次可能带上一次搬迁）。
 * 顺带把场景告诉 Rust 侧（任务库文件名、知识库根目录在那边拼）。
 */
void (async () => {
  let scenario = '';
  try {
    const prefs = await platform.getPrefs();
    scenario = prefs.scenario;
  } catch {
    // 偏好读不出来就用默认场景起步 —— 界面得能开，问题留给读取失败的那条路报
  }
  setActiveScenario(scenario);
  try {
    await platform.applyScenario(scenario);
  } catch {
    // 浏览器版是空操作；桌面端失败也只是场景没对齐，启动不该被它拦住
  }

  const container = document.getElementById('root');
  if (!container) throw new Error('找不到 #root 挂载点');

  createRoot(container).render(
    <StrictMode>
      <AppShell />
    </StrictMode>,
  );
})();
