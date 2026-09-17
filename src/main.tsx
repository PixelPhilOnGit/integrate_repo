import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './shell/AppShell';
import { MODULES } from './shell/registry';
import { configurePlatform } from './shared/platform';
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

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
