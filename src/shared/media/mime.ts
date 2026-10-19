/**
 * 图片扩展名 → MIME。
 *
 * ⚠️ 不按扩展名给 MIME 的话，`<img>` 很可能加载失败（WebView 对
 * `application/octet-stream` 的图片并不总是宽容）。这里只认知识库/附件里
 * 允许的那几种图片格式；认不出来给空串，让调用方自己决定怎么回落。
 */

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

export function imageMime(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return MIME[name.slice(dot + 1).toLowerCase()] ?? '';
}
