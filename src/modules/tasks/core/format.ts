/**
 * 时间的显示格式。
 *
 * 单独一个文件是为了**两处共用**（详情卡片里的进度时间线、检查器里的时间）——
 * 在各自的组件里各写一份的话，同一条记录在两处显示成不同的样子只是时间问题。
 *
 * ⚠️ 刻意用**绝对时间**而不是「N 分钟前」：那个函数住在 agents 模块里
 * （跨模块 import 违反分层），而且「这条任务是什么时候干的」问的是确切时刻，
 * 相对时间反而要用户自己换算。
 */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
