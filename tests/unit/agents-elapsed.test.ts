import { describe, expect, it } from 'vitest';
import { clock, elapsed } from '../../src/modules/agents/core/elapsed';

const NOW = 1_700_000_000_000;

describe('elapsed', () => {
  it('刚发生的事说「刚刚」，不报秒数', () => {
    // 「0 秒」看着像个坏掉的计数器，「刚刚」才像人话
    expect(elapsed(NOW, NOW)).toBe('刚刚');
    expect(elapsed(NOW - 1_000, NOW)).toBe('刚刚');
    expect(elapsed(NOW - 4_999, NOW)).toBe('刚刚');
  });

  it('秒、分钟、小时、天各一档', () => {
    expect(elapsed(NOW - 12_000, NOW)).toBe('12 秒');
    expect(elapsed(NOW - 59_000, NOW)).toBe('59 秒');
    expect(elapsed(NOW - 60_000, NOW)).toBe('1 分钟');
    expect(elapsed(NOW - 90_000, NOW)).toBe('1 分钟');
    expect(elapsed(NOW - 3_600_000, NOW)).toBe('1 小时');
    expect(elapsed(NOW - 86_400_000, NOW)).toBe('1 天');
  });

  it('⚠️ 时间戳落在未来时说「刚刚」，不出现负数', () => {
    // `from` 有一部分来自事件文件的 mtime —— 那是外部程序（甚至在另一台机器上）
    // 写的，时钟偏一点就可能落在未来。那时候「-3 秒」比「刚刚」让人困惑得多
    expect(elapsed(NOW + 60_000, NOW)).toBe('刚刚');
    expect(elapsed(Number.NaN, NOW)).toBe('刚刚');
  });
});

describe('clock', () => {
  it('补零到 HH:MM:SS', () => {
    const at = new Date(2026, 0, 2, 9, 5, 3).getTime();
    expect(clock(at)).toBe('09:05:03');
  });

  it('坏时间戳给一个占位符，不抛', () => {
    expect(clock(Number.NaN)).toBe('--:--:--');
  });
});
