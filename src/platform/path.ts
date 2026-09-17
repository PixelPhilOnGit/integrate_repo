/**
 * 工作区内相对路径的工具函数。
 *
 * 全部使用正斜杠。Windows 上的反斜杠由 Rust 侧在返回时转成正斜杠，
 * 这样前端只需要处理一种形式。
 */

export function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0 && s !== '.');
}

export function joinPath(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    for (const seg of splitPath(part)) out.push(seg);
  }
  return out.join('/');
}

export function basename(p: string): string {
  const parts = splitPath(p);
  return parts[parts.length - 1] ?? '';
}

export function dirname(p: string): string {
  const parts = splitPath(p);
  parts.pop();
  return parts.join('/');
}

/** 去掉扩展名，用于派生新文件名 */
export function stripExt(name: string): string {
  return name.replace(/\.seq\.json$/i, '').replace(/\.[^.]+$/, '');
}

/** 判断是否是本程序的图文件 */
export function isDiagramFile(name: string): boolean {
  return name.toLowerCase().endsWith('.seq.json');
}

/** 把任意输入净化成合法的文件名（去掉路径分隔符和 Windows 保留字符） */
export function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
}


/**
 * 在目录里找一个不冲突的名字。
 * 新建图时用：已有"未命名"就变成"未命名2"、"未命名3"…
 */
export function uniqueName(existing: readonly string[], desired: string, ext = ''): string {
  const lower = new Set(existing.map((n) => n.toLowerCase()));
  const full = desired + ext;
  if (!lower.has(full.toLowerCase())) return full;
  let i = 2;
  for (;;) {
    const candidate = `${desired}${i}${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
    i += 1;
  }
}
