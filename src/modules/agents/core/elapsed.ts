/**
 * 「多久之前」的文案。
 *
 * 侧栏上那句「正在工作 12 秒」是用户判断「它是不是卡住了」的唯一线索 ——
 * 没有它，一个转了十分钟的会话和一个刚转起来的看起来一模一样。
 *
 * 做成纯函数是因为这类格式化最容易出边界问题（负数、NaN、刚好 60 秒），
 * 而在组件里它永远测不到。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 从 `from` 到现在有多久。
 *
 * ⚠️ **未来时间返回「刚刚」**：`from` 有一部分来自事件文件的 mtime，
 * 而那是外部程序（甚至另一台机器）写的 —— 时钟偏一点就可能落在未来。
 * 那时候显示「-3 秒」或者「0 秒前」都比「刚刚」更让人困惑。
 */
export function elapsed(from: number, now: number): string {
  const ms = now - from;
  if (!Number.isFinite(ms) || ms < 5_000) return '刚刚';

  if (ms < MINUTE) return `${Math.floor(ms / 1000)} 秒`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} 分钟`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} 小时`;
  return `${Math.floor(ms / DAY)} 天`;
}

/** 时钟。检查器的状态历史里用它（「14:32:05 已完成」） */
export function clock(at: number): string {
  if (!Number.isFinite(at)) return '--:--:--';
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
