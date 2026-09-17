/**
 * 用 Mermaid 官方的解析器验证导出结果。
 *
 * 前面 mermaid.test.ts 那些断言只能证明"我们输出了预期的字符串"，
 * 证明不了"这段文本真的能被渲染" —— 而后者才是导出功能的全部价值。
 * 这里直接把导出的文本喂给 mermaid.parse()，语法有问题就会失败。
 */

import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { toMermaid } from '../../src/core/mermaid';
import { addMessage, addNote, addParticipant, createDoc } from '../../src/core/commands';
import { createDemoDoc, createNewDoc } from '../../src/core/samples';
import { __resetIdsForTest } from '../../src/core/ids';
import { defaultTheme } from '../../src/core/theme';
import type { Doc, Participant } from '../../src/core/model';

/** 断言这段文本是合法的 Mermaid（解析失败会抛异常） */
async function expectValidMermaid(doc: Doc): Promise<void> {
  const text = toMermaid(doc);
  try {
    await mermaid.parse(text);
  } catch (e) {
    throw new Error(
      `导出的 Mermaid 无法解析：${(e as Error).message}\n--- 文本 ---\n${text}`,
    );
  }
}

function docWith(participants: Participant[]): Doc {
  return {
    schemaVersion: 1,
    title: 't',
    theme: defaultTheme(),
    participants,
    messages: [],
    activations: [],
    notes: [],
  };
}

const p = (id: string, name: string, alias?: string, x = 100): Participant => ({
  id,
  kind: 'object',
  name,
  ...(alias !== undefined ? { alias } : {}),
  x,
});

describe('导出结果能被 Mermaid 解析', () => {
  it('完整示例图', async () => {
    await expectValidMermaid(createDemoDoc());
  });

  it('空白新图（只有参与者、没有消息）', async () => {
    await expectValidMermaid(createNewDoc('空图'));
  });

  it('完全没有参与者', async () => {
    await expectValidMermaid(createDoc('空空如也', defaultTheme()));
  });
});

describe('刁钻的文字内容', () => {
  it('中文名称（自动退化成 P1/P2 标识符）', async () => {
    await expectValidMermaid(createDemoDoc());
  });

  it('标签里带分号', async () => {
    let doc = docWith([p('a', '甲'), p('b', '乙', undefined, 300)]);
    doc = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '先校验;再写入', y: 200 }).doc;
    await expectValidMermaid(doc);
  });

  it('标签里带换行', async () => {
    let doc = docWith([p('a', '甲'), p('b', '乙', undefined, 300)]);
    doc = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '第一行\n第二行', y: 200 }).doc;
    await expectValidMermaid(doc);
  });

  it('标签里带冒号和引号', async () => {
    let doc = docWith([p('a', '甲'), p('b', '乙', undefined, 300)]);
    doc = addMessage(doc, {
      kind: 'sync',
      from: 'a',
      to: 'b',
      label: '返回 "OK": 200',
      y: 200,
    }).doc;
    await expectValidMermaid(doc);
  });

  it('参与者的显示名里带方括号和斜杠', async () => {
    let doc = docWith([p('a', '订单服务 [v2]'), p('b', 'API/网关', undefined, 300)]);
    doc = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: 'x', y: 200 }).doc;
    await expectValidMermaid(doc);
  });
});

describe('标识符撞上 Mermaid 关键字', () => {
  // Mermaid 的 sequenceDiagram 里 end/loop/alt/opt/par/note/activate 等是关键字，
  // 用户把它们当别名时会破坏语法。这里逐个验证不会炸。
  const keywords = [
    'end',
    'loop',
    'alt',
    'else',
    'opt',
    'par',
    'and',
    'note',
    'activate',
    'deactivate',
    'participant',
    'actor',
    'autonumber',
    'sequenceDiagram',
    'over',
    'left',
    'right',
    'of',
  ];

  for (const kw of keywords) {
    it(`别名是 "${kw}" 时仍能解析`, async () => {
      let doc = docWith([p('a', kw, kw), p('b', '普通', undefined, 300)]);
      // 光声明还不够：别名必须真的出现在 X->>Y: 的位置上，
      // 那才是关键字最容易破坏语法的地方
      doc = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '请求', y: 200 }).doc;
      doc = addMessage(doc, { kind: 'return', from: 'b', to: 'a', label: '响应', y: 260 }).doc;
      await expectValidMermaid(doc);
    });
  }

  it('别名是关键字时会在消息里被安全处理', () => {
    let doc = docWith([p('a', '结束', 'end'), p('b', '普通', undefined, 300)]);
    doc = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '请求', y: 200 }).doc;
    const text = toMermaid(doc);
    // 不管最终是沿用别名还是换成 P1，都不允许出现会被当成关键字的裸用法
    expect(text).toMatch(/participant (end|P\d+) as 结束/);
    expect(text).toMatch(/^\s*(end|P\d+)->>/m);
  });
});

describe('激活条的完整性', () => {
  it('没有终点的激活条在结尾被关闭（否则 Mermaid 报未闭合）', async () => {
    let doc = docWith([p('a', '甲'), p('b', '乙', undefined, 300)]);
    doc = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '请求', y: 200 }).doc;
    // 不加返回消息，激活条会一直没有终点
    expect(doc.activations.length).toBe(1);
    expect(doc.activations[0]!.endMessageId).toBeUndefined();
    await expectValidMermaid(doc);
  });

  it('多个互相嵌套的激活条', async () => {
    let doc = docWith([p('a', '甲'), p('b', '乙', undefined, 300)]);
    doc = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '一', y: 200 }).doc;
    doc = addMessage(doc, { kind: 'self', from: 'b', to: 'b', label: '二', y: 260 }).doc;
    doc = addMessage(doc, { kind: 'return', from: 'b', to: 'a', label: '三', y: 320 }).doc;
    await expectValidMermaid(doc);
  });
});

describe('注释', () => {
  it('注释挂到参与者上能解析', async () => {
    let doc = docWith([p('a', '甲'), p('b', '乙', undefined, 300)]);
    doc = addNote(doc, { text: '这里有坑', x: 100, y: 100, attachTo: 'a' }).doc;
    await expectValidMermaid(doc);
  });

  it('注释文字里有换行和分号也能解析', async () => {
    let doc = docWith([p('a', '甲')]);
    doc = addNote(doc, { text: '第一行\n第二行;还有分号', x: 100, y: 100, attachTo: 'a' }).doc;
    await expectValidMermaid(doc);
  });

  it('自由注释（没有 attachTo）挂到最近的参与者', async () => {
    let doc = docWith([p('a', '甲', undefined, 100), p('b', '乙', undefined, 500)]);
    doc = addNote(doc, { text: '漂着的注释', x: 480, y: 100 }).doc;
    const text = toMermaid(doc);
    expect(text).toMatch(/Note over \S+: 漂着的注释/);
    await expectValidMermaid(doc);
  });
});

describe('规模', () => {
  it('十几个参与者、几十条消息也能解析', async () => {
    let doc = createDoc('大图', defaultTheme());
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const r = addParticipant(doc, { name: `服务${i}` });
      doc = r.doc;
      ids.push(r.id);
    }
    for (let i = 0; i < 40; i += 1) {
      const from = ids[i % ids.length]!;
      const to = ids[(i + 3) % ids.length]!;
      doc = addMessage(doc, {
        kind: i % 5 === 0 ? 'return' : i % 7 === 0 ? 'async' : 'sync',
        from,
        to,
        label: `消息 ${i}`,
        y: 200 + i * 40,
      }).doc;
    }
    await expectValidMermaid(doc);
  });
});

describe('序号开关', () => {
  it('关闭序号时不输出 autonumber，且仍能解析', async () => {
    const base = createDemoDoc();
    const doc = { ...base, theme: { ...base.theme, showSequenceNumbers: false } };
    const text = toMermaid(doc);
    expect(text).not.toContain('autonumber');
    await expectValidMermaid(doc);
  });
});

__resetIdsForTest();
