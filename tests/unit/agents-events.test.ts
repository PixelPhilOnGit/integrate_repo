/**
 * 事件文件的解析。
 *
 * 这个模块的输入**来自应用外面**（hook 脚本、notify 程序，以及用户往那个目录里
 * 扔的任何东西），所以按不可信输入处理：只认白名单里的形状，别的静静忽略。
 * 「静静忽略」是刻意的 —— 目录里多个文件不该弹一条错误条打断用户。
 */
import { describe, expect, it } from 'vitest';
import {
  EVENT_STATES,
  isEventState,
  parseEventName,
  signalOf,
  statusOfEvent,
} from '../../src/modules/agents/core/events';

describe('parseEventName', () => {
  it('正常的事件：状态在文件名里，mtime 当成发生时间', () => {
    expect(parseEventName('waiting.pane_k3f9x2a1', 1700)).toEqual({
      paneId: 'pane_k3f9x2a1',
      state: 'waiting',
      at: 1700,
    });
  });

  it('三个状态都认', () => {
    for (const state of EVENT_STATES) {
      expect(parseEventName(`${state}.s1`, 1)?.state, state).toBe(state);
    }
  });

  it('状态那一段不区分大小写（Windows 上文件名本来就不区分）', () => {
    expect(parseEventName('WAITING.s1', 1)?.state).toBe('waiting');
    expect(parseEventName('Done.s1', 1)?.state).toBe('done');
  });

  it('会话 id 区分大小写，原样保留', () => {
    expect(parseEventName('done.AbC_1', 1)?.paneId).toBe('AbC_1');
  });
});

describe('不是我们的事件 —— 一律静静忽略', () => {
  it('目录里的杂物：临时文件、编辑器残留、说明文件', () => {
    // 报错或者弹错误条才是错的：用户看到的会是一条莫名其妙的红条，
    // 而原因只是某个编辑器在目录里留了个 .swp
    for (const name of ['README.txt', 'waiting.s1.swp', '.gitignore', 'tmp', '', '.', 'waiting']) {
      expect(parseEventName(name, 1), name).toBeNull();
    }
  });

  it('状态不在白名单：exited / idle 这些脚本不该写的', () => {
    // exited 由 pty 自己报，比脚本可靠；idle 没有对应的 hook 事件。
    // 让脚本能写它们，只会多出一堆含义模糊的状态
    for (const name of ['exited.s1', 'idle.s1', 'running.s1', 'starting.s1']) {
      expect(parseEventName(name, 1), name).toBeNull();
    }
  });

  it('⚠️ 会话 id 里不能有路径分隔符 —— 这是防目录穿越的那一道', () => {
    // 文件名是我们拼出来的（`目录 + 名称`），名字里带上 `..` 或者 `/`
    // 就能指到目录外面去。虽然读它的只是我们自己，但拼接路径的代码
    // 不该有机会碰到工作目录之外的东西
    for (const name of [
      'waiting.../../etc/passwd',
      'waiting.a/b',
      'waiting.a\\b',
      'waiting..',
      'waiting...',
      'waiting.s1/',
    ]) {
      expect(parseEventName(name, 1), name).toBeNull();
    }
  });

  it('会话 id 太长或为空都不认', () => {
    expect(parseEventName(`waiting.${'x'.repeat(65)}`, 1)).toBeNull();
    expect(parseEventName('waiting.', 1)).toBeNull();
  });

  it('名字里有多个点就不认（不猜哪个点才是分隔符）', () => {
    expect(parseEventName('waiting.a.b', 1)).toBeNull();
  });

  it('状态那一段带数字或短横线也不认', () => {
    expect(parseEventName('wait-ing.s1', 1)).toBeNull();
    expect(parseEventName('9.s1', 1)).toBeNull();
  });
});

describe('signalOf', () => {
  it('三个状态各自映射到状态机的信号', () => {
    expect(signalOf({ paneId: 's1', state: 'working', at: 1 })).toEqual({
      kind: 'prompt-submitted',
    });
    expect(signalOf({ paneId: 's1', state: 'waiting', at: 1 })).toEqual({
      kind: 'needs-attention',
    });
    expect(signalOf({ paneId: 's1', state: 'done', at: 1 })).toEqual({ kind: 'turn-finished' });
  });
});

describe('isEventState / statusOfEvent', () => {
  it('白名单判断', () => {
    expect(isEventState('waiting')).toBe(true);
    expect(isEventState('exited')).toBe(false);
  });

  it('事件状态到会话状态的映射', () => {
    expect(statusOfEvent('working')).toBe('working');
    expect(statusOfEvent('waiting')).toBe('waiting');
    expect(statusOfEvent('done')).toBe('done');
  });
});
