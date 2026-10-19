/**
 * 图片扩展名 → MIME。
 *
 * ⚠️ 这个映射不是小事：给错 MIME（或者给 `application/octet-stream`）时
 * `<img>` 在 WebView 里可能直接不加载 —— 用户看到的是「图片坏了」。
 */

import { describe, expect, it } from 'vitest';
import { imageMime } from '../../src/shared/media/mime';

describe('imageMime', () => {
  it('常见图片格式', () => {
    expect(imageMime('a.png')).toBe('image/png');
    expect(imageMime('a.jpg')).toBe('image/jpeg');
    expect(imageMime('a.JPEG')).toBe('image/jpeg');
    expect(imageMime('a.gif')).toBe('image/gif');
    expect(imageMime('a.webp')).toBe('image/webp');
    expect(imageMime('a.bmp')).toBe('image/bmp');
  });

  it('认不出来给空串（调用方自己决定回落）', () => {
    expect(imageMime('a.svg')).toBe('');
    expect(imageMime('a.txt')).toBe('');
    expect(imageMime('没有扩展名')).toBe('');
  });
});
