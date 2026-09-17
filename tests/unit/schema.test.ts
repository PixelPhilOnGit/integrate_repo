import { beforeEach, describe, expect, it } from 'vitest';
import {
  DocParseError,
  parseDoc,
  serializeDoc,
  titleFromFileName,
} from '../../src/modules/diagram/core/schema';
import { addMessage } from '../../src/modules/diagram/core/commands';
import { __resetIdsForTest } from '../../src/shared/ids';
import { createDemoDoc } from '../../src/modules/diagram/core/samples';
import { DARK_THEME, LIGHT_THEME, MONO_THEME, THEMES, themeToCss } from '../../src/modules/diagram/core/theme';

beforeEach(() => __resetIdsForTest());

describe('往返', () => {
  it('序列化再解析得到的文档与原文档等价', () => {
    const doc = createDemoDoc();
    const back = parseDoc(serializeDoc(doc));
    expect(back).toEqual(doc);
  });

  it('写出的 JSON 是可读的缩进格式，且带 schemaVersion', () => {
    const text = serializeDoc(createDemoDoc());
    expect(text).toContain('\n  ');
    expect(JSON.parse(text).schemaVersion).toBe(1);
  });
});

describe('坏输入', () => {
  it('非 JSON 抛出带说明的错误', () => {
    expect(() => parseDoc('{ 这不是 json')).toThrow(DocParseError);
  });

  it('JSON 是数组而不是对象时抛错', () => {
    expect(() => parseDoc('[]')).toThrow(DocParseError);
  });

  it('空对象能解析出一个可用的空文档，而不是崩溃', () => {
    const doc = parseDoc('{}');
    expect(doc.participants).toEqual([]);
    expect(doc.messages).toEqual([]);
    expect(doc.title).toBe('未命名');
    expect(doc.theme.fontSize).toBeGreaterThan(0);
  });
});

describe('悬空引用清理', () => {
  it('丢弃指向不存在参与者的消息（否则布局会算出 NaN）', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [{ id: 'a', kind: 'object', name: 'A', x: 100 }],
        messages: [
          { id: 'm1', kind: 'sync', from: 'a', to: '幽灵', label: 'x', y: 200 },
          { id: 'm2', kind: 'sync', from: 'a', to: 'a', label: 'ok', y: 240 },
        ],
      }),
    );
    expect(doc.messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('丢弃锚定在不存在消息上的激活条', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [{ id: 'a', kind: 'object', name: 'A', x: 100 }],
        messages: [],
        activations: [{ id: 'act', participant: 'a', startMessageId: '幽灵' }],
      }),
    );
    expect(doc.activations).toHaveLength(0);
  });

  it('激活条的终点消息没了，退化成自动延伸而不是整条丢掉', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [{ id: 'a', kind: 'object', name: 'A', x: 100 }],
        messages: [{ id: 'm1', kind: 'sync', from: 'a', to: 'a', label: 'x', y: 200 }],
        activations: [{ id: 'act', participant: 'a', startMessageId: 'm1', endMessageId: '幽灵' }],
      }),
    );
    expect(doc.activations).toHaveLength(1);
    expect(doc.activations[0]!.endMessageId).toBeUndefined();
  });

  it('注释的 attachTo 悬空时退化成自由注释', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [],
        notes: [{ id: 'n', text: 't', x: 1, y: 2, attachTo: '幽灵' }],
      }),
    );
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0]!.attachTo).toBeUndefined();
  });

  it('参与者 id 重复时只保留第一个', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [
          { id: 'dup', kind: 'object', name: '一', x: 100 },
          { id: 'dup', kind: 'object', name: '二', x: 300 },
        ],
      }),
    );
    expect(doc.participants).toHaveLength(1);
    expect(doc.participants[0]!.name).toBe('一');
  });
});

describe('缺字段补默认值', () => {
  it('参与者缺 kind / x 时给出可用值', () => {
    const doc = parseDoc(
      JSON.stringify({ schemaVersion: 1, participants: [{ id: 'a', name: 'A' }] }),
    );
    const p = doc.participants[0]!;
    expect(p.kind).toBe('object');
    expect(p.x).toBe(0);
  });

  it('非法 kind 落到 object', () => {
    const doc = parseDoc(
      JSON.stringify({ schemaVersion: 1, participants: [{ id: 'a', kind: '火星人', name: 'A', x: 1 }] }),
    );
    expect(doc.participants[0]!.kind).toBe('object');
  });

  it('坐标是 NaN/Infinity 时归零', () => {
    const raw = '{"schemaVersion":1,"participants":[{"id":"a","kind":"object","name":"A","x":null}]}';
    expect(parseDoc(raw).participants[0]!.x).toBe(0);
  });

  it('缺 schemaVersion 的老文件按 v1 处理', () => {
    const doc = parseDoc(JSON.stringify({ title: '老文件', participants: [] }));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.title).toBe('老文件');
  });

  it('非对象数组字段被容错成空数组', () => {
    const doc = parseDoc(
      JSON.stringify({ schemaVersion: 1, participants: '不是数组', messages: 42, notes: null }),
    );
    expect(doc.participants).toEqual([]);
    expect(doc.messages).toEqual([]);
    expect(doc.notes).toEqual([]);
  });

  it('数组里混入垃圾元素时逐个跳过，不影响其余元素', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [
          null,
          '垃圾',
          { id: 'ok', kind: 'actor', name: '好的', x: 10 },
          { name: '没有 id' },
        ],
      }),
    );
    expect(doc.participants).toHaveLength(1);
    expect(doc.participants[0]!.id).toBe('ok');
  });
});

describe('主题', () => {
  it('完整主题被原样保留', () => {
    const doc = createDemoDoc(DARK_THEME);
    expect(parseDoc(serializeDoc(doc)).theme).toEqual(DARK_THEME);
  });

  it('只写了 themeId 时按内置主题解析', () => {
    const doc = parseDoc(JSON.stringify({ schemaVersion: 1, theme: { id: 'blueprint' } }));
    expect(doc.theme.id).toBe('blueprint');
    expect(doc.theme.mode).toBe('dark');
  });

  it('主题字段缺失时用浅色主题兜底', () => {
    const doc = parseDoc(JSON.stringify({ schemaVersion: 1 }));
    expect(doc.theme.participantFill).toBe(LIGHT_THEME.participantFill);
  });

  it('暗色主题缺字段时用暗色兜底，而不是浅色', () => {
    const doc = parseDoc(JSON.stringify({ schemaVersion: 1, theme: { mode: 'dark' } }));
    expect(doc.theme.mode).toBe('dark');
    expect(doc.theme.background).toBe(DARK_THEME.background);
  });
});

describe('文件名与标题', () => {
  it('从文件名推导标题', () => {
    expect(titleFromFileName('登录流程.seq.json')).toBe('登录流程');
    expect(titleFromFileName('a.json')).toBe('a');
    expect(titleFromFileName('随便')).toBe('随便');
  });

  it('解析时用文件名兜底缺失的标题', () => {
    const doc = parseDoc('{"schemaVersion":1}', '来自文件名');
    expect(doc.title).toBe('来自文件名');
  });
});

describe('真实往返压力测试', () => {
  it('带激活条和自调用的图，序列化再解析后布局结果不变', () => {
    let doc = createDemoDoc();
    const [a, b] = doc.participants;
    doc = addMessage(doc, { kind: 'self', from: a!.id, to: a!.id, label: '自', y: 700 }).doc;
    doc = addMessage(doc, { kind: 'return', from: b!.id, to: a!.id, label: '回', y: 760 }).doc;

    const back = parseDoc(serializeDoc(doc));
    expect(back).toEqual(doc);
    expect(back.activations).toHaveLength(doc.activations.length);
  });
});

// ---------------------------------------------------------------------------
// 消息类型配色（后加的字段，重点是老文件的兼容性和"真的区分得开"）
// ---------------------------------------------------------------------------

describe('消息类型配色', () => {
  it('内置主题都定义了三种消息颜色', () => {
    for (const t of THEMES) {
      expect(t.syncMessageColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.asyncMessageColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.returnMessageColor).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('同步和异步的颜色确实不同 —— 否则这个功能没有意义', () => {
    for (const t of THEMES) {
      // 打印主题是刻意的例外：纸面上只靠箭头形状区分
      if (t.id === 'mono') continue;
      expect(t.syncMessageColor.toLowerCase()).not.toBe(t.asyncMessageColor.toLowerCase());
    }
  });

  it('黑白打印主题三种消息同色，导出去印不引入灰度', () => {
    expect(MONO_THEME.syncMessageColor).toBe(MONO_THEME.asyncMessageColor);
    expect(MONO_THEME.asyncMessageColor).toBe(MONO_THEME.returnMessageColor);
  });

  it('老文件里没有这三个字段时，回落到内置主题的默认值而不是空字符串', () => {
    const old = JSON.stringify({
      schemaVersion: 1,
      theme: { id: 'x', name: '旧主题', mode: 'light', background: '#fff' },
    });
    const t = parseDoc(old).theme;
    expect(t.syncMessageColor).toBe(LIGHT_THEME.syncMessageColor);
    expect(t.asyncMessageColor).toBe(LIGHT_THEME.asyncMessageColor);
    expect(t.returnMessageColor).toBe(LIGHT_THEME.returnMessageColor);
  });

  it('暗色主题缺这三个字段时回落到暗色的默认值，而不是浅色', () => {
    const t = parseDoc(JSON.stringify({ schemaVersion: 1, theme: { mode: 'dark' } })).theme;
    expect(t.asyncMessageColor).toBe(DARK_THEME.asyncMessageColor);
  });

  it('自定义的颜色能存下来、读回来', () => {
    const doc = createDemoDoc();
    const custom = { ...doc, theme: { ...doc.theme, asyncMessageColor: '#ff00aa' } };
    expect(parseDoc(serializeDoc(custom)).theme.asyncMessageColor).toBe('#ff00aa');
  });

  it('导出的 CSS 里带上了这三个变量和按类型着色的规则', () => {
    const css = themeToCss(LIGHT_THEME);
    expect(css).toContain('--rd-sync:');
    expect(css).toContain('--rd-async:');
    expect(css).toContain('--rd-return:');
    // 三种消息各自的线条颜色规则
    expect(css).toContain('.rd-message-line--sync');
    expect(css).toContain('.rd-message-line--async');
    expect(css).toContain('.rd-message-line--return');
    expect(css).toContain('.rd-arrow-head--async');
  });
});

describe('激活条的嵌套关系', () => {
  it('parentId 能存下来、读回来', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [{ id: 'a', kind: 'object', name: 'A', x: 100 }],
        messages: [
          { id: 'm1', kind: 'sync', from: 'a', to: 'a', label: '一', y: 200 },
          { id: 'm2', kind: 'sync', from: 'a', to: 'a', label: '二', y: 260 },
        ],
        activations: [
          { id: 'outer', participant: 'a', startMessageId: 'm1' },
          { id: 'inner', participant: 'a', startMessageId: 'm2', parentId: 'outer' },
        ],
      }),
    );
    expect(doc.activations.find((x) => x.id === 'inner')!.parentId).toBe('outer');
  });

  it('父激活条不存在时清掉 parentId，不留悬空指针', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [{ id: 'a', kind: 'object', name: 'A', x: 100 }],
        messages: [{ id: 'm1', kind: 'sync', from: 'a', to: 'a', label: '一', y: 200 }],
        activations: [{ id: 'x', participant: 'a', startMessageId: 'm1', parentId: '幽灵' }],
      }),
    );
    expect(doc.activations).toHaveLength(1);
    expect(doc.activations[0]!.parentId).toBeUndefined();
  });

  it('带嵌套的图序列化往返后结构不变', () => {
    const doc = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        participants: [{ id: 'a', kind: 'object', name: 'A', x: 100 }],
        messages: [
          { id: 'm1', kind: 'sync', from: 'a', to: 'a', label: '一', y: 200 },
          { id: 'm2', kind: 'sync', from: 'a', to: 'a', label: '二', y: 260 },
        ],
        activations: [
          { id: 'outer', participant: 'a', startMessageId: 'm1' },
          { id: 'inner', participant: 'a', startMessageId: 'm2', parentId: 'outer' },
        ],
      }),
    );
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });
});
