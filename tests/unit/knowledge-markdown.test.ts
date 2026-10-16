/**
 * 卡片 markdown 解析器（块 + 行内）。
 *
 * 最要紧的两条：**解析永不失败**（用户手编的花样再多，卡片也画得出来）、
 * **危险的链接连匹配都匹配不上**（`javascript:` 走不到 link 节点）。
 */

import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../../src/modules/knowledge/core/markdown';

describe('parseMarkdown 块级', () => {
  it('标题 / 段落 / 列表 / 分隔线', () => {
    const blocks = parseMarkdown('# 大标题\n\n正文一\n正文二\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n---\n');
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'hr',
    ]);
    const p = blocks[1];
    expect(p).toEqual({ kind: 'paragraph', text: '正文一 正文二' }); // 单换行并成空格
    expect(blocks[2]).toEqual({ kind: 'list', ordered: false, items: ['甲', '乙'] });
    expect(blocks[3]).toEqual({ kind: 'list', ordered: true, items: ['一', '二'] });
  });

  it('seq 围栏单独成节点_普通围栏是 code', () => {
    const blocks = parseMarkdown('```seq\n{"a":1}\n```\n\n```js\nlet x=1;\n```\n');
    expect(blocks[0]).toEqual({ kind: 'seq', json: '{"a":1}' });
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'js', text: 'let x=1;' });
  });

  it('没闭合的围栏吃到尾_不炸', () => {
    const blocks = parseMarkdown('```seq\n{"a":1}\n没有收尾');
    expect(blocks[0]?.kind).toBe('seq');
  });

  it('引用合并连续行', () => {
    const blocks = parseMarkdown('> 第一行\n> 第二行\n\n正文');
    expect(blocks[0]).toEqual({ kind: 'quote', text: '第一行 第二行' });
  });

  it('不认识的行当段落_解析永不失败', () => {
    const weird = '| 表格 | 不支持 |\n<span>原样</span>\n';
    const blocks = parseMarkdown(weird);
    expect(blocks[0]?.kind).toBe('paragraph');
    // HTML 原样是**文本**（渲染层映射成 React 文本节点，没有 innerHTML 这回事）
    expect((blocks[0] as { text: string }).text).toContain('<span>原样</span>');
  });
});

describe('parseInline 行内', () => {
  it('粗体/斜体/行内代码', () => {
    expect(parseInline('a **b** c *d* `e`')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'italic', text: 'd' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'e' },
    ]);
  });

  it('wikilink 带别名_图片别被吃掉()', () => {
    expect(parseInline('[[登录流程|流程]]')).toEqual([
      { kind: 'wikilink', target: '登录流程', alias: '流程' },
    ]);
    expect(parseInline('[[登录流程]]')).toEqual([
      { kind: 'wikilink', target: '登录流程', alias: '登录流程' },
    ]);
    expect(parseInline('![[架构图.png]]')).toEqual([
      { kind: 'image', target: '架构图.png' },
    ]);
  });

  it('只放行 http/https 的链接_javascript_原样当文本', () => {
    expect(parseInline('[文档](https://example.com/a)')).toEqual([
      { kind: 'link', text: '文档', url: 'https://example.com/a' },
    ]);
    const evil = parseInline('[点我](javascript:alert(1))');
    expect(evil.every((n) => n.kind === 'text')).toBe(true);
    expect((evil[0] as { text: string }).text).toBe('[点我](javascript:alert(1))');
  });

  it('行内代码里不解释格式', () => {
    expect(parseInline('`**不是粗体**`')).toEqual([
      { kind: 'code', text: '**不是粗体**' },
    ]);
  });
});
