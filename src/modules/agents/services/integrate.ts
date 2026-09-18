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

function unusablePreview(state: IntegrationState, target: IntegrationTarget): string {
  if (state === 'unusable') {
    return `${FAKE_PATH[target]} 不是合法的 JSON（第 3 行少了逗号），我们不打算猜它的结构。`;
  }
  return state === 'missing' || state === 'absent' ? PREVIEW[target] : '（已启用）';
}

/**
 * 向导里显示给用户的「会改成什么样」。
 *
 * ⚠️ 这三行**要和 Rust 侧真正写下去的东西一字不差地对上**，否则用户是照着
 * 一份假清单点「启用」的 —— 而这个弹窗存在的全部意义就是「别藏着掖着」。
 * 真实现见 `devtoolkit-agents/src/integration.rs`。
 */
const PREVIEW: Record<IntegrationTarget, string> = {
  claude: [
    'hooks.UserPromptSubmit → 包装脚本 working（开始干活了）',
    'hooks.PermissionRequest → 包装脚本 waiting（**在等你授权**，弹窗一出现就报）',
    'hooks.Notification      → 包装脚本 waiting（兜底：闲了 60 秒）',
    'hooks.Stop              → 包装脚本 done（这一回合干完了）',
  ].join('\n'),
  codex: [
    '[hooks] UserPromptSubmit / PermissionRequest / Stop → 同一个包装脚本',
    '（Codex 的 notify 只有「回合完成」一个事件，拿不到「在等你授权」，所以走它的 hooks）',
  ].join('\n'),
};

/**
 * 浏览器里假装「配置文件读不了」。
 *
 * 真实现里这是个真实分支：用户的 `settings.json` 有语法错误、或者被别的工具
 * 改成了不是 JSON 的东西。这时候我们**必须拒绝写入**（而不是把人家配置搞坏），
 * 界面上要显示原因、并且不给「启用」按钮。
 *
 * 没有这个开关的话，那段界面在浏览器里永远走不到 —— 也就是**没被测过的死代码**，
 * 而它恰恰是「出事的时候用户唯一能看到的东西」。
 */
let pretendUnusable = false;

export function __setPretendUnusable(value: boolean): void {
  pretendUnusable = value;
}

export function createWebIntegrationClient(): IntegrationClient {
  /**
   * 内存里的「配置文件」。
   *
   * `exists` 为 false 表示文件不存在（初始状态是 `missing`）—— 这样界面上的
   * 「还没建过配置 → 启用 → 已启用 → 撤销 → 又没了」整条路都能在
   * 浏览器里被点一遍
   */
  const files: Record<IntegrationTarget, { exists: boolean; installed: boolean }> = {
    claude: { exists: false, installed: false },
    codex: { exists: false, installed: false },
  };

  const stateOf = (target: IntegrationTarget): IntegrationState => {
    if (pretendUnusable) return 'unusable';
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
        preview: unusablePreview(state, target),
      };
    },

    async apply(target: IntegrationTarget): Promise<IntegrationOutcome> {
      // 读不了就拒绝写 —— 和真实现同一条规矩（别把用户的配置搞坏）
      if (pretendUnusable) throw new Error('配置文件不是合法的 JSON，没有动它');

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

/**
 * 给 Playwright 用的钩子（只在开发构建里挂）。
 *
 * 键名故意长得刺眼：它是**测试开关**，不是运行时配置 ——
 * 生产产物里没有这个东西。
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __pretendIntegrationUnusable?: (v: boolean) => void })
    .__pretendIntegrationUnusable = __setPretendUnusable;
}
