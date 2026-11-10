/**
 * 知识库用的小格式化函数。
 *
 * 不跨模块 import（tasks 里有一份同样的 `formatBytes`）：分层规矩比少写
 * 十行重要，见 HANDOFF「全仓不再有跨模块 import」。
 */

/** 文件大小（B / KB / MB / GB）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * 追加备注用的本地时间戳：`2026-11-09 14:32`。
 *
 * 为什么由前端给：Rust 侧只有 UTC（没引日期库），而备注里的时间给人看，
 * 本地时间才对得上「我刚才写的」。
 */
export function localStampNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
