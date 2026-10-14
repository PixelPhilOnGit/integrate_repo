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

/**
 * 文件大小的显示格式（B / KB / MB / GB）。
 *
 * 和 request 模块那份**不共用**：那份只到 MB（那边的量级是响应体），而资料里
 * 可能有视频、镜像（GB 级）；跨模块 import 也违反分层。重复一份小函数，
 * 比引一根模块之间的线便宜。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 认得出的图片扩展名（决定文件条目的展示：缩略图还是图标） */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'];

/**
 * 这个文件名是不是图片。**只按扩展名认** —— 内容是不是真图片不归这一层管；
 * 真是坏图，渲染不出来就退回图标（组件那边兜底）。
 */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTS.includes(name.slice(dot + 1).toLowerCase());
}
