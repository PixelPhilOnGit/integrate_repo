/**
 * 资料在界面上要用的两个小格式化：文件大小、图片判定。
 *
 * `formatBytes` 的那条边界（1 KB 以下不带小数、往上一位小数）是显示的约定，
 * 改文案的时候先看这里；`isImageName` 决定文件条目画缩略图还是图标 ——
 * **只按扩展名认**，认错了顶多是退回图标，不会出事故。
 */
import { describe, expect, it } from 'vitest';
import { formatBytes, isImageName } from '../../src/modules/tasks/core/format';

describe('formatBytes', () => {
  it('各档的单位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

describe('isImageName', () => {
  it('认得出的图片扩展名（大小写不敏感）', () => {
    expect(isImageName('截图.png')).toBe(true);
    expect(isImageName('photo.JPG')).toBe(true);
    expect(isImageName('a.webp')).toBe(true);
    expect(isImageName('icon.svg')).toBe(true);
  });

  it('别的都不是', () => {
    expect(isImageName('需求文档.pdf')).toBe(false);
    expect(isImageName('没有扩展名')).toBe(false);
    expect(isImageName('奇怪.png.txt')).toBe(false);
  });
});
