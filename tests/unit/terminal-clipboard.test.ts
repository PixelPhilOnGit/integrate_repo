/**
 * 「这一下按键算不算复制」的矩阵。
 *
 * 这层的错都是**修饰键少判了一个**：漏判 Alt 的话 Windows 上 AltGr 打 `c`
 * 会变成复制（`c` 反而打不出来）；macOS 上多判一步就会把 `Ctrl+C`（唯一的中断
 * 手势）吃掉。两种都不用真按键盘，给字面量就能测出来。
 */
import { describe, expect, it } from 'vitest';
import { copyIntent, type KeyEventLike } from '../../src/shared/terminal/clipboard';

/** 一个什么都没按的 `C` */
function key(patch: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code: 'KeyC', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch };
}

const win = { isMac: false };
const mac = { isMac: true };

const copy = 'copy';
const pass = 'pass';

describe('Windows / Linux', () => {
  it('有选中时的裸 Ctrl+C 就是复制 —— 这条是用户要的手感', () => {
    expect(copyIntent(key({ ctrlKey: true }), { ...win, hasSelection: true })).toBe(copy);
  });

  it('⚠️ 没选中时 Ctrl+C 还是 SIGINT，一点不受影响', () => {
    // 终端里 Ctrl+C 是中断，是所有人肌肉记忆里最硬的一条
    expect(copyIntent(key({ ctrlKey: true }), { ...win, hasSelection: false })).toBe(pass);
  });

  it('Ctrl+Shift+C 不管有没有选中都拦（拦下来和复制到东西是两回事）', () => {
    expect(copyIntent(key({ ctrlKey: true, shiftKey: true }), { ...win, hasSelection: true })).toBe(
      copy,
    );
    expect(copyIntent(key({ ctrlKey: true, shiftKey: true }), { ...win, hasSelection: false })).toBe(
      copy,
    );
  });

  it('Win+C 之类不带 Ctrl 的不管', () => {
    expect(copyIntent(key({ metaKey: true }), { ...win, hasSelection: true })).toBe(pass);
    expect(copyIntent(key(), { ...win, hasSelection: true })).toBe(pass);
  });
});

describe('macOS', () => {
  it('Cmd+C 复制', () => {
    expect(copyIntent(key({ metaKey: true }), { ...mac, hasSelection: true })).toBe(copy);
    expect(copyIntent(key({ metaKey: true }), { ...mac, hasSelection: false })).toBe(copy);
  });

  it('⚠️ Ctrl+C 恒是中断 —— 有选中也一样', () => {
    // 那边复制是 Cmd+C，Ctrl+C 是唯一能停住刷屏程序的手势，不能被复制抢走
    expect(copyIntent(key({ ctrlKey: true }), { ...mac, hasSelection: true })).toBe(pass);
    expect(copyIntent(key({ ctrlKey: true }), { ...mac, hasSelection: false })).toBe(pass);
  });

  it('Ctrl+Shift+C 同样认（终端的通用手势，不分平台）', () => {
    expect(copyIntent(key({ ctrlKey: true, shiftKey: true }), { ...mac, hasSelection: true })).toBe(
      copy,
    );
  });
});

describe('⚠️ AltGr 与其它修饰键', () => {
  it('Ctrl+Alt+C 不认 —— Windows 上 AltGr 就是 Ctrl+Alt', () => {
    // 某些键盘布局（德语、波兰语…）打 c 要走 AltGr。认了它就成了
    // 「c 打不出来，反而复制了」，而且是在终端里打字时踩到
    expect(copyIntent(key({ ctrlKey: true, altKey: true }), { ...win, hasSelection: true })).toBe(
      pass,
    );
    expect(copyIntent(key({ ctrlKey: true, altKey: true }), { ...mac, hasSelection: true })).toBe(
      pass,
    );
  });

  it('Ctrl+Shift+Alt+C 也不认（Alt 优先级最高）', () => {
    expect(
      copyIntent(key({ ctrlKey: true, shiftKey: true, altKey: true }), {
        ...win,
        hasSelection: true,
      }),
    ).toBe(pass);
  });

  it('只按 Alt+C 不认', () => {
    expect(copyIntent(key({ altKey: true }), { ...win, hasSelection: true })).toBe(pass);
  });
});

describe('不认识的键一概不拦', () => {
  it('Ctrl+V 交给浏览器原生的粘贴那条路', () => {
    expect(copyIntent(key({ ctrlKey: true, code: 'KeyV' }), { ...win, hasSelection: true })).toBe(
      pass,
    );
  });

  it('终端里那些有自己含义的 Ctrl+字母 一个都不碰', () => {
    for (const code of ['KeyD', 'KeyW', 'KeyU', 'KeyL', 'KeyZ']) {
      expect(copyIntent(key({ ctrlKey: true, code }), { ...win, hasSelection: true }), code).toBe(
        pass,
      );
    }
  });
});
