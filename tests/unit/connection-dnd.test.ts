/**
 * 拖拽的纯逻辑：载荷编解码 + 「能不能落在这儿」。
 *
 * 这三条被三个侧栏共用，而且「不能把目录拖进自己的子树」必须和 `moveGroupIn`
 * 的守卫**同口径**（UI 那边拦一道只是为了不亮高亮，权威守卫在纯函数里）——
 * 两边的判断漂了，界面就会亮着一个落下去其实 no-op 的目标。
 */

import { describe, expect, it } from 'vitest';
import {
  canDropInto,
  encodeDragPayload,
  parseDragPayload,
} from '../../src/shared/connections/dnd';
import type { ConnectionGroup } from '../../src/shared/connections/types';

const groups: ConnectionGroup[] = [
  { id: 'g1', name: '生产' },
  { id: 'g2', name: '项目A', parentId: 'g1' },
  { id: 'g3', name: '更深', parentId: 'g2' },
  { id: 'g4', name: '测试' },
];

describe('载荷编解码', () => {
  it('编出来再解回来是同一条', () => {
    const payload = { kind: 'profile' as const, id: 'p1' };
    expect(parseDragPayload(encodeDragPayload(payload))).toEqual(payload);
  });

  it('外面拖进来/坏掉的东西一律给 null，不猜', () => {
    expect(parseDragPayload('')).toBeNull();
    expect(parseDragPayload('随便一段文字')).toBeNull();
    expect(parseDragPayload('{"kind":"evil","id":"x"}')).toBeNull();
    expect(parseDragPayload('{"kind":"profile"}')).toBeNull();
    expect(parseDragPayload('{"kind":"group","id":""}')).toBeNull();
    expect(parseDragPayload('null')).toBeNull();
  });
});

describe('canDropInto', () => {
  it('没在拖（外面来的东西）什么都不收', () => {
    expect(canDropInto(null, groups, 'g1')).toBe(false);
    expect(canDropInto(null, groups, null)).toBe(false);
  });

  it('连接落哪儿都行（包括空白 = 未分组）', () => {
    const payload = { kind: 'profile' as const, id: 'p1' };
    expect(canDropInto(payload, groups, 'g1')).toBe(true);
    expect(canDropInto(payload, groups, 'g3')).toBe(true);
    expect(canDropInto(payload, groups, null)).toBe(true);
  });

  it('目录能落到别的目录和顶层，但**不能落进自己或自己的子树**', () => {
    const payload = { kind: 'group' as const, id: 'g1' };
    expect(canDropInto(payload, groups, 'g4')).toBe(true); // 平级邻居
    expect(canDropInto(payload, groups, null)).toBe(true); // 顶层
    expect(canDropInto(payload, groups, 'g1')).toBe(false); // 自己
    expect(canDropInto(payload, groups, 'g2')).toBe(false); // 子
    expect(canDropInto(payload, groups, 'g3')).toBe(false); // 孙
  });
});
