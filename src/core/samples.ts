/**
 * 文档工厂。
 *
 * createNewDoc 刻意不是"完全空白"：顺序图的起点永远是"有哪些参与者"，
 * 所以新建时先放一个用户和一个系统，用户可以立刻开始画第一条消息。
 * 完全空白反而每次都要先加两个框。
 */

import type { Doc, Theme } from './model';
import { addMessage, addParticipant, createDoc } from './commands';
import { defaultTheme } from './theme';

export function createNewDoc(title: string, theme: Theme = defaultTheme()): Doc {
  let doc = createDoc(title, theme);
  doc = addParticipant(doc, { kind: 'actor', name: '用户' }).doc;
  doc = addParticipant(doc, { kind: 'object', name: '系统' }).doc;
  return doc;
}

/** 演示用示例：一个典型的登录流程，用来展示各种消息类型和激活条 */
export function createDemoDoc(theme: Theme = defaultTheme()): Doc {
  let doc = createDoc('登录流程', theme);

  const user = addParticipant(doc, { kind: 'actor', name: '用户', index: 0 });
  doc = user.doc;
  const ui = addParticipant(doc, { kind: 'boundary', name: '客户端' });
  doc = ui.doc;
  const api = addParticipant(doc, { kind: 'control', name: '认证服务' });
  doc = api.doc;
  const db = addParticipant(doc, { kind: 'database', name: '用户库' });
  doc = db.doc;

  const spacing = theme.messageSpacing;
  let y = 200;

  const m1 = addMessage(doc, {
    kind: 'sync',
    from: user.id,
    to: ui.id,
    label: '输入账号密码',
    y,
  });
  doc = m1.doc;

  y += spacing;
  const m2 = addMessage(doc, {
    kind: 'sync',
    from: ui.id,
    to: api.id,
    label: 'POST /login',
    y,
  });
  doc = m2.doc;

  y += spacing;
  const m3 = addMessage(doc, {
    kind: 'sync',
    from: api.id,
    to: db.id,
    label: '查询用户',
    y,
  });
  doc = m3.doc;

  y += spacing;
  const m4 = addMessage(doc, {
    kind: 'return',
    from: db.id,
    to: api.id,
    label: '用户记录',
    y,
  });
  doc = m4.doc;

  y += spacing;
  const m5 = addMessage(doc, {
    kind: 'self',
    from: api.id,
    to: api.id,
    label: '校验密码哈希',
    y,
  });
  doc = m5.doc;

  y += spacing;
  const m6 = addMessage(doc, {
    kind: 'return',
    from: api.id,
    to: ui.id,
    label: '令牌 + 用户信息',
    y,
  });
  doc = m6.doc;

  y += spacing;
  const m7 = addMessage(doc, {
    kind: 'async',
    from: api.id,
    to: db.id,
    label: '写入登录日志',
    y,
  });
  doc = m7.doc;

  return doc;
}
