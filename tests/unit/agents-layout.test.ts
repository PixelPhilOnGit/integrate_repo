/**
 * 分屏布局的纯逻辑。
 *
 * 这块是整个模块里最容易写错、也最值得写厚的一层：切分和折叠是树操作
 * （写错了界面就是两块叠着画），矩形计算是几何（写错了会算出 NaN，
 * 整片主区白屏），而它们全都不碰 DOM，可以在这里被盖满。
 */
import { describe, expect, it } from 'vitest';
import {
  clampRatio,
  closePane,
  gridColsFor,
  gridLayout,
  hasPane,
  leafPane,
  MAX_RATIO,
  MIN_RATIO,
  neighborOf,
  panesOf,
  parseLayout,
  rectsOf,
  replacePane,
  replaceWith,
  setRatio,
  splitPane,
  type PaneLayout,
} from '../../src/modules/agents/core/layout';

/**
 * 三块：左边上下两块（A 上 B 下），右边一整块（C）。
 *
 * ⚠️ 顺序要紧，因为它模拟的是**用户真会怎么做**：`splitPane` 切的是**叶子**，
 * 不是容器（和 tmux 一样）。所以「左边一列两块 + 右边一整块」是
 * 「先把 A 向右切成 A|C，再把 A 向下切成 A/B」两步做出来的 ——
 * 反过来先上下再左右，得到的是「上面一整块 + 下面左右两块」。
 */
function threePanes(): PaneLayout {
  return splitPane(
    splitPane(leafPane('A'), 'A', 'row', 'C', false),
    'A',
    'col',
    'B',
    false,
  );
}

/** 四块，规规矩矩的 2×2 */
function fourPanes(): PaneLayout {
  const l = splitPane(leafPane('A'), 'A', 'row', 'C', false);
  const up = splitPane(l, 'A', 'col', 'B', false);
  return splitPane(up, 'C', 'col', 'D', false);
}

describe('splitPane', () => {
  it('把唯一的一块切成左右两块，各占一半', () => {
    const layout = splitPane(leafPane('A'), 'A', 'row', 'B', false);
    expect(layout).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: 'A' },
      b: { kind: 'leaf', sessionId: 'B' },
    });
  });

  it('before=true 时新的那块排在前面（界面上的「向左/向上分屏」）', () => {
    const layout = splitPane(leafPane('A'), 'A', 'row', 'B', true);
    expect(panesOf(layout)).toEqual(['B', 'A']);
  });

  it('切的是指定那一块，别的分支不动', () => {
    const layout = threePanes();
    const next = splitPane(layout, 'C', 'col', 'D', false);
    expect(panesOf(next)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('目标不存在时原样返回 —— 按钮是在某一帧渲染出来的，点下去时那块可能已经没了', () => {
    const layout = threePanes();
    expect(splitPane(layout, '不存在', 'row', 'X', false)).toBe(layout);
  });
});

describe('closePane', () => {
  it('关掉两块中的一块，兄弟节点顶上来（树塌缩成一块）', () => {
    const layout = splitPane(leafPane('A'), 'A', 'row', 'B', false);
    expect(closePane(layout, 'A')).toEqual({ kind: 'leaf', sessionId: 'B' });
    expect(closePane(layout, 'B')).toEqual({ kind: 'leaf', sessionId: 'A' });
  });

  it('关掉嵌套里的中间一块，那一层塌缩，另外两块都还在', () => {
    const layout = threePanes();
    const next = closePane(layout, 'A');
    expect(panesOf(next!)).toEqual(['B', 'C']);
    // B 应该占满整个左半边，而不是继续占着原来的上半部分
    const rects = rectsOf(next!);
    expect(rects['B']).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('关掉最后一块返回 null —— 调用方要处理空态，而不是留一棵没有 pane 的树', () => {
    expect(closePane(leafPane('A'), 'A')).toBeNull();
  });

  it('关一块不存在的，整棵树原样返回', () => {
    const layout = threePanes();
    expect(closePane(layout, '不存在')).toBe(layout);
  });
});

describe('rectsOf', () => {
  it('左右各半', () => {
    const rects = rectsOf(splitPane(leafPane('A'), 'A', 'row', 'B', false));
    expect(rects['A']).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(rects['B']).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('嵌套：左半边再上下分', () => {
    const rects = rectsOf(threePanes());
    expect(rects['A']).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rects['B']).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(rects['C']).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('⚠️ 不变量：任意两块不重叠、都落在 [0,1] 里、面积加起来是 1', () => {
    // 用一棵四层深的树把这些性质压出来：左右 → 上下 → 左右 → 上下
    let layout = leafPane('A');
    layout = splitPane(layout, 'A', 'row', 'B', false);
    layout = splitPane(layout, 'A', 'col', 'C', false);
    layout = splitPane(layout, 'C', 'row', 'D', false);
    layout = splitPane(layout, 'D', 'col', 'E', false);

    const rects = rectsOf(layout);
    const all = Object.entries(rects);
    expect(all).toHaveLength(5);

    let area = 0;
    for (const [id, r] of all) {
      expect(Number.isFinite(r.x) && Number.isFinite(r.y), `${id} 坐标是有限数`).toBe(true);
      expect(r.w, `${id} 宽度为正`).toBeGreaterThan(0);
      expect(r.h, `${id} 高度为正`).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
      area += r.w * r.h;
    }
    expect(area).toBeCloseTo(1, 9);

    for (const [idA, a] of all) {
      for (const [idB, b] of all) {
        if (idA === idB) continue;
        const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapW <= 1e-9 || overlapH <= 1e-9, `${idA} 和 ${idB} 不该重叠`).toBe(true);
      }
    }
  });

  it('⚠️ 回归：比例越界（手改过的文件、旧版本）也要算出能用的矩形', () => {
    // 越界的比例会让某一块算出负数宽度，界面上就是一块看不见的空白，
    // 而且它还在树里活着 —— 用户点不着、也关不掉
    const bad = {
      kind: 'split' as const,
      dir: 'row' as const,
      ratio: 1.8,
      a: leafPane('A'),
      b: leafPane('B'),
    };
    const rects = rectsOf(bad);
    expect(rects['A']!.w).toBeCloseTo(MAX_RATIO, 9);
    expect(rects['B']!.w).toBeCloseTo(1 - MAX_RATIO, 9);
    expect(rects['B']!.w).toBeGreaterThan(0);
  });

  it('比例是 NaN 时退回对半分，而不是算出 NaN 坐标', () => {
    const bad = {
      kind: 'split' as const,
      dir: 'col' as const,
      ratio: Number.NaN,
      a: leafPane('A'),
      b: leafPane('B'),
    };
    const rects = rectsOf(bad);
    expect(rects['A']).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(rects['B']).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
});

describe('clampRatio', () => {
  it('正常值原样通过', () => {
    expect(clampRatio(0.3)).toBe(0.3);
  });

  it('两边都夹住 —— 零像素的 pane 用户点不着也关不掉', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(-5)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(MAX_RATIO);
    expect(clampRatio(99)).toBe(MAX_RATIO);
  });

  it('NaN / Infinity 退回对半分', () => {
    expect(clampRatio(Number.NaN)).toBe(0.5);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe('setRatio', () => {
  it('改根那一层的比例', () => {
    const layout = splitPane(leafPane('A'), 'A', 'row', 'B', false);
    const rects = rectsOf(setRatio(layout, [], 0.3));
    expect(rects['A']!.w).toBeCloseTo(0.3, 9);
  });

  it('用路径改深层的那一层', () => {
    // 根是左右分，左半边再上下分：改左半边那一层的比例走 [0]
    const rects = rectsOf(setRatio(threePanes(), [0], 0.25));
    expect(rects['A']!.h).toBeCloseTo(0.25, 9);
    expect(rects['B']!.y).toBeCloseTo(0.25, 9);
    expect(rects['C']).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('拖动越界时夹住', () => {
    const layout = splitPane(leafPane('A'), 'A', 'row', 'B', false);
    expect(rectsOf(setRatio(layout, [], 10))['A']!.w).toBeCloseTo(MAX_RATIO, 9);
  });

  it('路径走到叶子上就原样返回（不抛）', () => {
    const layout = splitPane(leafPane('A'), 'A', 'row', 'B', false);
    expect(setRatio(layout, [0, 0], 0.3)).toBe(layout);
  });
});

describe('neighborOf', () => {
  it('左右两块：从左边按右键', () => {
    const rects = rectsOf(splitPane(leafPane('A'), 'A', 'row', 'B', false));
    expect(neighborOf(rects, 'A', 'right')).toBe('B');
    expect(neighborOf(rects, 'B', 'left')).toBe('A');
  });

  it('上下两块：从上边按下键', () => {
    const rects = rectsOf(splitPane(leafPane('A'), 'A', 'col', 'B', false));
    expect(neighborOf(rects, 'A', 'down')).toBe('B');
    expect(neighborOf(rects, 'B', 'up')).toBe('A');
  });

  it('左半上下分、右半一整块：从左上往下走到左下，往右走到右边那一整块', () => {
    const rects = rectsOf(threePanes());
    expect(neighborOf(rects, 'A', 'down')).toBe('B');
    expect(neighborOf(rects, 'A', 'right')).toBe('C');
    expect(neighborOf(rects, 'B', 'right')).toBe('C');
  });

  it('⚠️ 最右边按右键什么都不做 —— 不绕回另一头', () => {
    // 绕回去的代价是「想往右挪一下，结果跳到了最左边」，
    // 在四个 pane 之间切来切去的时候会让人彻底失去方位感
    const rects = rectsOf(threePanes());
    expect(neighborOf(rects, 'C', 'right')).toBeNull();
    expect(neighborOf(rects, 'A', 'up')).toBeNull();
  });

  it('⚠️ 只有角接触的不算邻居', () => {
    // 2×2：A 左上 / B 左下 / C 右上 / D 右下。
    // A 往下只能到 B（不能斜到 D），A 往右只能到 C（不能斜到 D）——
    // 判据是「在那条方向上真的有投影重叠」，不是「坐标比较像」
    const rects = rectsOf(fourPanes());
    expect(neighborOf(rects, 'A', 'down')).toBe('B');
    expect(neighborOf(rects, 'A', 'right')).toBe('C');
    expect(neighborOf(rects, 'B', 'right')).toBe('D');
    expect(neighborOf(rects, 'C', 'down')).toBe('D');
    expect(neighborOf(rects, 'D', 'up')).toBe('C');
    expect(neighborOf(rects, 'D', 'left')).toBe('B');
  });

  it('会话不在布局里就返回 null', () => {
    expect(neighborOf(rectsOf(leafPane('A')), '不存在', 'right')).toBeNull();
  });
});

describe('panesOf / hasPane / replacePane', () => {
  it('按从左到右、从上到下的顺序列出', () => {
    expect(panesOf(threePanes())).toEqual(['A', 'B', 'C']);
  });

  it('hasPane 认得深层的那一块', () => {
    const layout = threePanes();
    expect(hasPane(layout, 'B')).toBe(true);
    expect(hasPane(layout, '不存在')).toBe(false);
  });

  it('replacePane 把这一块换成显示另一个会话，位置不动', () => {
    const layout = threePanes();
    const next = replacePane(layout, 'A', 'X');
    const rects = rectsOf(next);
    expect(panesOf(next)).toEqual(['X', 'B', 'C']);
    expect(rects['X']).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });
});

describe('parseLayout', () => {
  it('往返：写出去再读回来是一样的', () => {
    const layout = threePanes();
    const round = parseLayout(JSON.parse(JSON.stringify(layout)));
    expect(round).toEqual(layout);
  });

  it('⚠️ 按不可信输入处理：形状不对一律返回 null，交给调用方退回空布局', () => {
    // 手改过的、旧版本的、被截断的文件都会走到这里。放一棵畸形的树进去，
    // 结果是渲染时算出 NaN 坐标，整片主区白屏 —— 那时候用户完全无从下手
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout('A')).toBeNull();
    expect(parseLayout(42)).toBeNull();
    expect(parseLayout({})).toBeNull();
    expect(parseLayout({ kind: 'leaf' })).toBeNull();
    expect(parseLayout({ kind: 'leaf', sessionId: '' })).toBeNull();
    expect(parseLayout({ kind: 'nope' })).toBeNull();
  });

  it('dir 不认就整份作废，不做「猜一个」', () => {
    const bad = { kind: 'split', dir: 'diagonal', ratio: 0.5, a: leafPane('A'), b: leafPane('B') };
    expect(parseLayout(bad)).toBeNull();
  });

  it('同一个会话出现在两块里就作废 —— 焦点和上屏的语义没法定义', () => {
    const dup = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: leafPane('A'),
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: leafPane('B'), b: leafPane('A') },
    };
    expect(parseLayout(dup)).toBeNull();
  });

  it('比例越界是**夹住**而不是作废（宽容，因为能救回来）', () => {
    const bad = { kind: 'split', dir: 'row', ratio: 5, a: leafPane('A'), b: leafPane('B') };
    const parsed = parseLayout(bad);
    expect(parsed).not.toBeNull();
    expect(rectsOf(parsed!)['A']!.w).toBeCloseTo(MAX_RATIO, 9);
  });

  it('嵌套过深直接作废 —— 损坏的文件不该让我们递归到爆栈', () => {
    let deep: unknown = leafPane('A');
    for (let i = 0; i < 40; i += 1) {
      deep = { kind: 'split', dir: 'row', ratio: 0.5, a: deep, b: leafPane(`B${i}`) };
    }
    expect(parseLayout(deep)).toBeNull();
  });
});

describe('gridLayout（一次新建一批会话时铺的网格）', () => {
  it('空列表没有网格', () => {
    expect(gridLayout([], 2)).toBeNull();
  });

  it('一个会话就是一格', () => {
    expect(gridLayout(['A'], 3)).toEqual(leafPane('A'));
  });

  it('顺序就是传进来的顺序（左到右、上到下）', () => {
    expect(panesOf(gridLayout(['A', 'B', 'C', 'D'], 2)!)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('2×2 四块一样大', () => {
    const rects = rectsOf(gridLayout(['A', 'B', 'C', 'D'], 2)!);
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(rects[id]!.w).toBeCloseTo(0.5, 9);
      expect(rects[id]!.h).toBeCloseTo(0.5, 9);
    }
    expect(rects['A']!.x).toBeCloseTo(0, 9);
    expect(rects['B']!.x).toBeCloseTo(0.5, 9);
    expect(rects['C']!.y).toBeCloseTo(0.5, 9);
  });

  it('一行三块是等分的 —— 不是越分越小', () => {
    // ⚠️ 这条是这块最容易写错的地方：二分递归写出来是 1/2、1/4、1/4，
    // 界面上第三格会窄得没法用
    const rects = rectsOf(gridLayout(['A', 'B', 'C'], 3)!);
    expect(rects['A']!.w).toBeCloseTo(1 / 3, 9);
    expect(rects['B']!.w).toBeCloseTo(1 / 3, 9);
    expect(rects['C']!.w).toBeCloseTo(1 / 3, 9);
  });

  it('列数超过数量时退化成一行', () => {
    const rects = rectsOf(gridLayout(['A', 'B'], 9)!);
    expect(rects['A']!.y).toBeCloseTo(0, 9);
    expect(rects['B']!.y).toBeCloseTo(0, 9);
    expect(rects['A']!.w).toBeCloseTo(0.5, 9);
  });

  it('列数是 0 或负数时当成一列（不抛、也不留空格子）', () => {
    expect(panesOf(gridLayout(['A', 'B'], 0)!)).toEqual(['A', 'B']);
    expect(panesOf(gridLayout(['A', 'B'], -3)!)).toEqual(['A', 'B']);
  });

  it('最后一行不满时那几块更宽 —— 已知的取舍，不是 bug', () => {
    // 叶子必须挂一个会话，造不出「空的格子」，所以 5 个 3 列是
    // 「上面三块各 1/3 + 下面两块各 1/2」，行高仍然是等分的
    const rects = rectsOf(gridLayout(['A', 'B', 'C', 'D', 'E'], 3)!);
    expect(rects['A']!.w).toBeCloseTo(1 / 3, 9);
    expect(rects['D']!.w).toBeCloseTo(0.5, 9);
    expect(rects['A']!.h).toBeCloseTo(0.5, 9);
    expect(rects['D']!.h).toBeCloseTo(0.5, 9);
  });

  it('网格同样守 rectsOf 的三条不变量（不重叠、都在 [0,1]、面积和为 1）', () => {
    for (const n of [1, 2, 3, 5, 7]) {
      const ids = Array.from({ length: n }, (_, i) => `P${i}`);
      const rects = rectsOf(gridLayout(ids, gridColsFor(n))!);

      let area = 0;
      for (const id of ids) {
        const r = rects[id]!;
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
        area += r.w * r.h;
      }
      expect(area).toBeCloseTo(1, 9);
    }
  });
});

describe('gridColsFor', () => {
  it('挑一个「看着像网格」的列数', () => {
    expect(gridColsFor(1)).toBe(1);
    expect(gridColsFor(2)).toBe(2);
    expect(gridColsFor(3)).toBe(2);
    expect(gridColsFor(4)).toBe(2);
    expect(gridColsFor(6)).toBe(3);
    expect(gridColsFor(9)).toBe(3);
  });
});

describe('replaceWith', () => {
  it('把一格整棵换掉（不是换成另一个会话，是换成一片）', () => {
    const root = splitPane(leafPane('A'), 'A', 'row', 'B', false);
    const next = replaceWith(root, 'B', gridLayout(['X', 'Y'], 2)!);
    expect(panesOf(next)).toEqual(['A', 'X', 'Y']);
  });

  it('找不到目标就原样返回（界面上的按钮可能来自上一帧）', () => {
    const root = leafPane('A');
    expect(replaceWith(root, 'Z', gridLayout(['X'], 1)!)).toBe(root);
  });
});
