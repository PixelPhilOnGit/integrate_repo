/**
 * 「场景」：业务数据的命名空间（今天在团队 1、明天在团队 2）。
 *
 * # 规则一句话
 *
 * **场景 = 业务数据的卷；外壳偏好（外观/宽度/当前场景）是机器的。**
 * 连接档案、工作目录、任务、知识库、接口调试历史都按场景分卷；
 * 助手配置（那是"软件本身"的设置）和外观保持全局。
 *
 * # 怎么分卷
 *
 * 只做一层**后缀**：KV 的模块名 `redis` → `redis@团队1`（SQLite 表结构不动）、
 * 浏览器版 localStorage 键、任务库文件名 `tasks@团队1.db`、知识库根目录
 * `knowledge/@团队1/`。**默认场景（空串）不加后缀** —— 老数据的路径原样，
 * 零迁移。
 *
 * # 时序约束（重要）
 *
 * `setActiveScenario` 必须在**任何 store 读 KV 之前**跑一次 —— 组合根
 * （`main.tsx`）在读回偏好之后、渲染之前调用。之后这一层就是个只读的
 * 进程级变量，各处的 `scenarioSuffix()` 随取随用。
 */

let active = '';

/** 换场景（只动内存；持久化/重载是外壳的事——`shell/store.ts` 的 switchScenario） */
export function setActiveScenario(name: string): void {
  active = name;
}

/** 当前场景（'' = 默认场景） */
export function activeScenario(): string {
  return active;
}

/**
 * 场景名 → 存储后缀（默认场景返回空串，见文件头「零迁移」）。
 *
 * '@' 是分隔符：场景名**不允许**含 '@'（校验在 [`validateScenarioName`]）。
 */
export function scenarioSuffix(): string {
  return active === '' ? '' : `@${active}`;
}

/**
 * 场景名的校验。规则和 Rust 侧（`scenario_commands.rs`）**必须一字不差** ——
 * 这个名字会进文件路径和存储键，两边判定漂移 = 一边能建一边打不开。
 *
 * 允许：中文/字母/数字/`-`/`_`/空格，1..=30 个字符；
 * 拒绝：`@`（分隔符）、点（挡住 `..`）、路径分隔符、前后空白、空串。
 */
export function validateScenarioName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return '名字不能为空';
  if (trimmed !== name) return '名字两头不能有空白';
  if (trimmed.length > 30) return '名字太长了（最多 30 个字）';
  for (const ch of trimmed) {
    // \p{L}/\p{N}：字母/数字（含中文）；再加 - _ 空格
    if (!/[\p{L}\p{N}_\- ]/u.test(ch)) {
      return `名字里有不能用的字符：${ch}（只允许中英文、数字、- _ 和空格）`;
    }
  }
  return null;
}
