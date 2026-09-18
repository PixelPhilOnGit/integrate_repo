// 终端尺寸的兜底逻辑。抽到 shared 之后两个模块共用（SSH / 智能体会话），
// 所以这份测试也不属于任何单个模块。
import { describe, expect, it } from 'vitest';
import { clampSize, formatSize, hasLayout, sameSize } from '../../src/shared/terminal/fit';

describe('clampSize', () => {
  it('正常值原样通过', () => {
    expect(clampSize(80, 24)).toEqual({ cols: 80, rows: 24 });
  });

  it('小数向下取整', () => {
    expect(clampSize(80.9, 24.9)).toEqual({ cols: 80, rows: 24 });
  });

  it('⚠️ 不是数字就返回 null —— 容器没布局时 FitAddon 就是返回 undefined', () => {
    // 直接把这个值发出去的话，远端会按 0 列排版，终端整个废掉
    expect(clampSize(undefined, 24)).toBeNull();
    expect(clampSize(80, undefined)).toBeNull();
    expect(clampSize(null, null)).toBeNull();
    expect(clampSize('80', '24')).toBeNull();
  });

  it('NaN 和 Infinity 也返回 null', () => {
    expect(clampSize(Number.NaN, 24)).toBeNull();
    expect(clampSize(80, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('⚠️ 比下限还小就当「没量到」而不是「真的是个小终端」', () => {
    // 隐藏的标签页、还没挂上的节点会量出 0 或者个位数。
    // 真按 2 列报给远端的话，所有输出都会变成竖着的一列字，
    // 而且因为尺寸「没变」之后再也不会重排
    expect(clampSize(0, 0)).toBeNull();
    expect(clampSize(2, 24)).toBeNull();
    expect(clampSize(80, 3)).toBeNull();
  });

  it('刚好到下限是可以通过的', () => {
    expect(clampSize(20, 5)).toEqual({ cols: 20, rows: 5 });
  });

  it('超过上限是**夹住**而不是拒绝 —— 超大只是不常见，夹一下就好', () => {
    expect(clampSize(99999, 99999)).toEqual({ cols: 1000, rows: 500 });
  });
});

describe('hasLayout', () => {
  it('有宽高才算有布局', () => {
    expect(hasLayout({ clientWidth: 800, clientHeight: 600 } as HTMLElement)).toBe(true);
  });

  it('display:none 的元素宽高都是 0', () => {
    expect(hasLayout({ clientWidth: 0, clientHeight: 600 } as HTMLElement)).toBe(false);
    expect(hasLayout({ clientWidth: 800, clientHeight: 0 } as HTMLElement)).toBe(false);
  });

  it('null / undefined 当作没有', () => {
    expect(hasLayout(null)).toBe(false);
    expect(hasLayout(undefined)).toBe(false);
  });
});

describe('sameSize', () => {
  it('两个都一样才算一样', () => {
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(false);
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false);
  });

  it('和 null 比：两边都是 null 才算一样', () => {
    // 这条是给「这次没量到」用的：没量到就不该触发一次 resize
    expect(sameSize(null, null)).toBe(true);
    expect(sameSize({ cols: 80, rows: 24 }, null)).toBe(false);
    expect(sameSize(null, { cols: 80, rows: 24 })).toBe(false);
  });
});

describe('formatSize', () => {
  it('用乘号而不是字母 x', () => {
    expect(formatSize({ cols: 80, rows: 24 })).toBe('80×24');
  });
});
