import { beforeEach, describe, expect, it } from 'vitest';
import { toMermaid } from '../../src/core/mermaid';
import { addMessage, createDoc } from '../../src/core/commands';
import { __resetIdsForTest } from '../../src/core/ids';
import { createDemoDoc } from '../../src/core/samples';
import { defaultTheme } from '../../src/core/theme';
import type { Doc } from '../../src/core/model';

beforeEach(() => __resetIdsForTest());

describe('结构', () => {
  it('以 sequenceDiagram 开头', () => {
    expect(toMermaid(createDemoDoc()).startsWith('sequenceDiagram')).toBe(true);
  });

  it('把参与者声明成 participant / actor', () => {
    const out = toMermaid(createDemoDoc());
    expect(out).toMatch(/^\s*actor \S+ as 用户$/m);
    expect(out).toMatch(/^\s*participant \S+ as 客户端$/m);
    expect(out).toMatch(/^\s*participant \S+ as 用户库$/m);
  });

  it('参与者声明顺序与图的左右顺序一致', () => {
    const doc = createDemoDoc();
    const out = toMermaid(doc);
    const declared = out
      .split('\n')
      .filter((l) => /^\s*(participant|actor)\s/.test(l))
      .map((l) => l.split(' as ')[1]);
    expect(declared).toEqual(doc.participants.map((p) => p.name));
  });
});

describe('消息运算符', () => {
  function msgDoc(kind: 'sync' | 'async' | 'return' | 'self'): Doc {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: 'a', kind: 'object', name: 'A', x: 100 },
        { id: 'b', kind: 'object', name: 'B', x: 300 },
      ],
    };
    doc = addMessage(doc, { kind, from: 'a', to: 'b', label: 'L', y: 200 }).doc;
    return doc;
  }

  it('同步用 ->>', () => {
    expect(toMermaid(msgDoc('sync'))).toContain('->>');
  });

  it('异步用 -)', () => {
    expect(toMermaid(msgDoc('async'))).toContain('-)');
  });

  it('返回用虚线箭头 -->>', () => {
    expect(toMermaid(msgDoc('return'))).toContain('-->>');
  });

  it('自调用两端是同一个参与者', () => {
    const out = toMermaid(msgDoc('self'));
    const line = out.split('\n').find((l) => l.includes(': L'))!.trim();
    // 自调用是 sync 类型，运算符一定是 ->>；两端必须完全相同
    const m = line.match(/^(\S+)->>(\S+):/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
  });
});

describe('激活条', () => {
  it('每条 activate 都有配对的 deactivate', () => {
    const out = toMermaid(createDemoDoc());
    const activates = out.split('\n').filter((l) => l.trim().startsWith('activate '));
    const deactivates = out.split('\n').filter((l) => l.trim().startsWith('deactivate '));
    expect(activates.length).toBeGreaterThan(0);
    expect(deactivates.length).toBe(activates.length);
  });

  it('activate 出现在触发它的消息之后', () => {
    const out = toMermaid(createDemoDoc());
    const lines = out.split('\n').map((l) => l.trim());
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]!.startsWith('activate ')) continue;
      const pid = lines[i]!.slice('activate '.length);
      // 往上找最近的一条发给该参与者的消息
      let found = false;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (lines[j]!.includes(`${pid}: `)) {
          found = true;
          break;
        }
        if (lines[j]!.startsWith('activate ') || lines[j]!.startsWith('deactivate ')) continue;
      }
      expect(found).toBe(true);
    }
  });

  it('没有终点的激活条在结尾收尾，不会漏掉 deactivate', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: 'a', kind: 'object', name: 'A', x: 100 },
        { id: 'b', kind: 'object', name: 'B', x: 300 },
      ],
    };
    const r = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: 'L', y: 200 });
    const out = toMermaid(r.doc);
    const last = out.trim().split('\n').pop()!;
    expect(last.trim().startsWith('deactivate')).toBe(true);
  });
});

describe('标识符与转义', () => {
  it('中文别名不能用，退化成安全的 P1/P2', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: 'a', kind: 'object', name: '认证服务', alias: '认证服务', x: 100 },
        { id: 'b', kind: 'object', name: '数据库', x: 300 },
      ],
    };
    const out = toMermaid(doc);
    expect(out).toContain('as 认证服务');
    // 别名没有拿去当标识符
    expect(out).not.toMatch(/participant 认证服务 as/);
    expect(out).toMatch(/participant P1 as 认证服务/);
  });

  it('合法的 ASCII 别名会被沿用，可读性更好', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: 'a', kind: 'object', name: '认证服务', alias: 'AuthSvc', x: 100 },
        { id: 'b', kind: 'object', name: '数据库', alias: 'DB', x: 300 },
      ],
    };
    const out = toMermaid(doc);
    expect(out).toContain('participant AuthSvc as 认证服务');
    expect(out).toContain('participant DB as 数据库');
  });

  it('标签里的分号被替换掉（分号会截断 Mermaid 语句）', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: 'a', kind: 'object', name: 'A', x: 100 },
        { id: 'b', kind: 'object', name: 'B', x: 300 },
      ],
    };
    const r = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '先校验;再写入', y: 200 });
    const out = toMermaid(r.doc);
    expect(out).not.toContain(';');
    expect(out).toContain('先校验；再写入');
  });

  it('标签里的换行转成 <br/>', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: 'a', kind: 'object', name: 'A', x: 100 },
        { id: 'b', kind: 'object', name: 'B', x: 300 },
      ],
    };
    const r = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '第一行\n第二行', y: 200 });
    const out = toMermaid(r.doc);
    expect(out).toContain('第一行<br/>第二行');
    // 不能真的在消息中间插一个裸换行，那会截断语句
    const lines = out.split('\n').filter((l) => l.includes('第一行'));
    expect(lines).toHaveLength(1);
  });
});

describe('序号', () => {
  it('开启序号时输出 autonumber', () => {
    expect(toMermaid(createDemoDoc())).toContain('autonumber');
  });

  it('关闭序号时不输出 autonumber', () => {
    const doc = createDemoDoc();
    const themed = { ...doc, theme: { ...doc.theme, showSequenceNumbers: false } };
    expect(toMermaid(themed)).not.toContain('autonumber');
  });
});

describe('注释', () => {
  it('注释挂到最近的参与者上', () => {
    const doc: Doc = {
      ...createDemoDoc(),
      notes: [{ id: 'n1', text: '这里有坑', x: 100, y: 300 }],
    };
    const out = toMermaid(doc);
    expect(out).toMatch(/Note over \S+: 这里有坑/);
  });
});

describe('提示信息', () => {
  it('默认带上"会丢失版面信息"的说明', () => {
    expect(toMermaid(createDemoDoc())).toContain('%%');
  });

  it('可以关掉说明以获得干净输出', () => {
    expect(toMermaid(createDemoDoc(), { comment: false })).not.toContain('%%');
  });
});
