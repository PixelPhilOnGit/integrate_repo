/**
 * 终端转义序列里的通知扫描。
 *
 * 这条路径是**零配置**的那条（Codex 的「需要你」只能靠它），而它的输入是
 * 一条**没有边界的字节流** —— pty 上来的块怎么切完全不受我们控制。
 * 所以这里的重点不是「认得出一条完整序列」，而是「序列被切碎了也认得出」
 * 和「畸形的流不能把扫描器带崩」。
 */
import { describe, expect, it } from 'vitest';
import { createOscScanner, parsePayload } from '../../src/modules/agents/core/osc';

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);

const BEL = '\x07';
const ST = '\x1b\\';

describe('完整序列', () => {
  it('OSC 9 的正文就是通知文本', () => {
    const scanner = createOscScanner();
    expect(scanner.feed(bytes(`\x1b]9;需要你确认一下${BEL}`))).toEqual([
      { code: 9, text: '需要你确认一下' },
    ]);
  });

  it('OSC 777 的 notify 拼成「标题：正文」', () => {
    const scanner = createOscScanner();
    expect(scanner.feed(bytes(`\x1b]777;notify;Codex;回合完成${BEL}`))).toEqual([
      { code: 777, text: 'Codex：回合完成' },
    ]);
  });

  it('ST（`ESC \\`）结尾和 BEL 结尾一样认', () => {
    const scanner = createOscScanner();
    expect(scanner.feed(bytes(`\x1b]9;好了${ST}`))).toEqual([{ code: 9, text: '好了' }]);
  });

  it('一条块里有多条序列，全都认出来', () => {
    const scanner = createOscScanner();
    const notices = scanner.feed(bytes(`\x1b]9;第一条${BEL}中间还有字\x1b]9;第二条${BEL}`));
    expect(notices.map((n) => n.text)).toEqual(['第一条', '第二条']);
  });
});

describe('序列被切碎', () => {
  it('⚠️ 一半在一个块里、一半在下一个块里，照样认出来', () => {
    // pty 上来的块边界不受我们控制，这才是常态而不是边界情况
    const scanner = createOscScanner();
    expect(scanner.feed(bytes('\x1b]9;好'))).toEqual([]);
    expect(scanner.feed(bytes(`了${BEL}`))).toEqual([{ code: 9, text: '好了' }]);
  });

  it('⚠️ 断在 `ESC` 和 `]` 之间也认得出', () => {
    const scanner = createOscScanner();
    expect(scanner.feed(bytes('\x1b'))).toEqual([]);
    expect(scanner.feed(bytes(`]9;在的${BEL}`))).toEqual([{ code: 9, text: '在的' }]);
  });

  it('断在 ST 的 `ESC` 和 `\\` 之间也认得出', () => {
    const scanner = createOscScanner();
    expect(scanner.feed(bytes('\x1b]9;结尾分开了\x1b'))).toEqual([]);
    expect(scanner.feed(bytes('\\'))).toEqual([{ code: 9, text: '结尾分开了' }]);
  });

  it('一次喂一个字节，最终还是能认出来', () => {
    const scanner = createOscScanner();
    const raw = bytes(`\x1b]9;一个字节一个字节${BEL}`);
    let found: string[] = [];
    for (const b of raw) {
      found = found.concat(scanner.feed(new Uint8Array([b])).map((n) => n.text));
    }
    expect(found).toEqual(['一个字节一个字节']);
  });
});

describe('不该认的东西', () => {
  it('OSC 777 的 precmd / preexec 不是通知', () => {
    // 那是 shell 钩子在每条命令前后发的。认了它，侧栏就会刷屏
    // 「命令跑完了」，真正在等你的那条反而被淹掉
    const scanner = createOscScanner();
    expect(scanner.feed(bytes(`\x1b]777;precmd${BEL}`))).toEqual([]);
    expect(scanner.feed(bytes(`\x1b]777;preexec${BEL}`))).toEqual([]);
  });

  it('设置窗口标题（OSC 0 / 2）不是通知', () => {
    const scanner = createOscScanner();
    expect(scanner.feed(bytes(`\x1b]0;我的终端${BEL}`))).toEqual([]);
    expect(scanner.feed(bytes(`\x1b]2;我的终端${BEL}`))).toEqual([]);
  });

  it('CSI 序列（颜色、光标）完全不干扰', () => {
    const scanner = createOscScanner();
    expect(scanner.feed(bytes('\x1b[31m红字\x1b[0m'))).toEqual([]);
  });

  it('负载里没有分号的不认', () => {
    expect(parsePayload('9')).toBeNull();
    expect(parsePayload('')).toBeNull();
    // 分号在开头：编号是空的
    expect(parsePayload(';只有正文')).toBeNull();
  });
});

describe('畸形输入不能把扫描器带崩', () => {
  it('⚠️ 一直没有终止符：不无限攒字节，而且恢复之后还能认后面的', () => {
    const scanner = createOscScanner();
    // 灌一大段没有终止符的内容（比上限多）
    expect(scanner.feed(bytes(`\x1b]9;${'x'.repeat(8000)}`))).toEqual([]);
    // 关键：它得自己回到「找开头」的状态，后面正常的通知不能跟着瞎掉
    expect(scanner.feed(bytes(`\x1b]9;恢复了${BEL}`))).toEqual([{ code: 9, text: '恢复了' }]);
  });

  it('ST 里那个 ESC 后面跟的不是 `\\`：丢掉这一条，但后面的照认', () => {
    const scanner = createOscScanner();
    const notices = scanner.feed(bytes(`\x1b]9;坏的\x1bQ\x1b]9;好的${BEL}`));
    expect(notices.map((n) => n.text)).toEqual(['好的']);
  });

  it('正文里的控制字符会被抹掉（它会让界面上的文字错位）', () => {
    const scanner = createOscScanner();
    const notices = scanner.feed(bytes(`\x1b]9;前\x01\x02后${BEL}`));
    expect(notices[0]!.text).toBe('前后');
  });

  it('超长的正文会被截断（侧栏显示不下，也会把界面撑爆）', () => {
    const scanner = createOscScanner();
    const notices = scanner.feed(bytes(`\x1b]9;${'长'.repeat(400)}${BEL}`));
    expect(notices[0]!.text.length).toBe(201); // 200 个字符 + 省略号
    expect(notices[0]!.text.endsWith('…')).toBe(true);
  });

  it('畸形的 UTF-8 不会抛（替换成 U+FFFD 就算了）', () => {
    const scanner = createOscScanner();
    const raw = new Uint8Array([0x1b, 0x5d, 0x39, 0x3b, 0xff, 0xfe, 0x07]);
    expect(() => scanner.feed(raw)).not.toThrow();
  });
});
