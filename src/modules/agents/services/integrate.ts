/**
 * 写用户的配置文件：让 Claude Code / Codex 能把状态报给我们。
 *
 * # 为什么这件事在 Rust 侧做
 *
 * 要改的是**用户主目录**里的文件，在 Devtoolkit 的工作区沙箱之外 ——
 * 那是这个应用唯一的安全边界（见 README 的「安全模型」）。所以命令的形状是：
 * **前端只能传一个枚举值（`claude` / `codex`），具体写哪个文件完全由 Rust 算出来。**
 * 路径只要有机会从 JS 传进来，这里就变成了一个「任意文件写入」的口子。
 *
 * 合并逻辑（JSON 保留其它字段、TOML 的根键必须插在表头之前）也跟着在 Rust 侧 ——
 * 它得有真文件的读写才能测准，而前端这边只是把结果画出来。
 *
 * # 那浏览器版在测什么
 *
 * ⚠️ **只测「状态流转 + 界面反应」，不测合并逻辑本身。**
 * 合并逻辑的正确性由 Rust 那组测试盖（JSON 合并保留用户字段、TOML 插到
 * `[table]` 之前、幂等、备份、撤销、被用户改过）。浏览器里假装再实现一遍
 * 只会得到一份**和真实现不一样**的逻辑，那种测试比没有更糟。
 */

import { invoke } from '../../../shared/platform/invoke';
import type {
  IntegrationClient,
  IntegrationOutcome,
  IntegrationState,
  IntegrationStatus,
  IntegrationTarget,
} from './types';

/** 两个目标在界面上显示的名字和路径（前缀只是展示用，真实路径由 Rust 给） */
export const TARGET_LABEL: Record<IntegrationTarget, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export function createTauriIntegrationClient(): IntegrationClient {
  return {
    async status(target: IntegrationTarget): Promise<IntegrationStatus> {
      return invoke<IntegrationStatus>('agent_integration_status', { target });
    },
    async apply(target: IntegrationTarget): Promise<IntegrationOutcome> {
      return invoke<IntegrationOutcome>('agent_integration_apply', { target });
    },
    async revert(target: IntegrationTarget): Promise<IntegrationOutcome> {
      return invoke<IntegrationOutcome>('agent_integration_revert', { target });
    },
  };
}

/** 浏览器里的假路径。带个中括号，看一眼就知道它不是真的 */
const FAKE_PATH: Record<IntegrationTarget, string> = {
  claude: '[浏览器模式] ~/.claude/settings.json',
  codex: '[浏览器模式] ~/.codex/config.toml',
};

const PREVIEW: Record<IntegrationTarget, string> = {
  claude: [
    'hooks.UserPromptSubmit → 调包装脚本（状态变「正在工作」）',
    'hooks.Notification     → 调包装脚本（状态变「需要你」）',
    'hooks.Stop             → 调包装脚本（状态变「已完成」）',
  ].join('\n'),
  codex: 'notify = ["<包装脚本>", "done"]   # 回合结束时跑一次',
};

export function createWebIntegrationClient(): IntegrationClient {
  /**
   * 内存里的「配置文件」。
   *
   * `null` 表示文件不存在（初始状态是 `missing`）—— 这样界面上的
   * 「还没建过配置 → 启用 → 已启用 → 撤销 → 又没了」整条路都能在
   * 浏览器里被点一遍
   */
  const files: Record<IntegrationTarget, { exists: boolean; installed: boolean }> = {
    claude: { exists: false, installed: false },
    codex: { exists: false, installed: false },
  };

  const stateOf = (target: IntegrationTarget): IntegrationState => {
    const f = files[target];
    if (!f.exists) return 'missing';
    return f.installed ? 'installed' : 'absent';
  };

  return {
    async status(target: IntegrationTarget): Promise<IntegrationStatus> {
      const state = stateOf(target);
      return {
        target,
        path: FAKE_PATH[target],
        state,
        preview: state === 'missing' || state === 'absent' ? PREVIEW[target] : '（已启用）',
      };
    },

    async apply(target: IntegrationTarget): Promise<IntegrationOutcome> {
      const backupPath = files[target].exists ? `${FAKE_PATH[target]}.bak` : null;
      files[target] = { exists: true, installed: true };
      return { target, path: FAKE_PATH[target], backupPath, preview: PREVIEW[target] };
    },

    async revert(target: IntegrationTarget): Promise<IntegrationOutcome> {
      // 撤销之后文件仍然在（我们只是把条目摘掉）；原来就没有这个文件的话，
      // 真实现会把它恢复成不存在 —— 浏览器版简化成「文件还在，条目没了」
      files[target] = { exists: true, installed: false };
      return { target, path: FAKE_PATH[target], backupPath: null, preview: '（已撤销）' };
    },
  };
}
