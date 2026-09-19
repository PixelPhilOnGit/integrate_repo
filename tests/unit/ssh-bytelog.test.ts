/**
 * 字节日志：折叠时重放用的原料。
 *
 * 它唯一的职责是「把字节按块分好、能原样取回来」，所以断言全在**分段边界**上：
 * 哪一段归哪一块、溢出之后还剩什么。边界错一个字节，重放出来的画面就和折叠前
 * 对不上，而且是静默地对不上。
 */
import { describe, expect, it } from 'vitest';
import { createByteLog } from '../../src/modules/ssh/core/byteLog';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('字节日志：分段', () => {
  it('还没提交命令时，字节落在开头那段', () => {
    const log = createByteLog();
    log.append(bytes('横幅'), 1);
    log.append(bytes('提示符'), 2);

    expect(text(log.preamble())).toBe('横幅提示符');
  });

  it('startBlock 之后的字节归那一块', () => {
    const log = createByteLog();
    log.append(bytes('开头'), 1);

    log.startBlock(7);
    log.append(bytes('第 7 块的输出'), 2);

    log.startBlock(8);
    log.append(bytes('第 8 块的'), 3);
    log.append(bytes('两段字节'), 4);

    expect(text(log.preamble())).toBe('开头');
    expect(text(log.block(7))).toBe('第 7 块的输出');
    expect(text(log.block(8))).toBe('第 8 块的两段字节');
  });

  it('⚠️ 命令回显落在**上一段** —— 它是在提交之前到的', () => {
    // 这正是「分段点是提交、不是回显」那条：用户敲 `ls` 时远端就把 `ls`
    // 回显回来了，那时候还没提交。它属于上一段的末尾（也就是色条上
    // 「下一条命令那一行」的位置），两边必须对得上
    const log = createByteLog();
    log.startBlock(1);
    log.append(bytes('ls'), 100); // 回显先到
    log.startBlock(2); // 然后才提交
    log.append(bytes('\r\n输出'), 200);

    expect(text(log.block(1))).toBe('ls');
    expect(text(log.block(2))).toBe('\r\n输出');
  });

  it('没有的块返回空（不是 null、也不抛）', () => {
    const log = createByteLog();
    expect(log.block(99)).toHaveLength(0);
  });

  it('拼回来的是**原样**的字节，一段不多一段不少', () => {
    const log = createByteLog();
    const raw = bytes('带颜色的输出：\x1b[31m红\x1b[0m\r\n');
    log.append(raw, 1);
    expect(log.preamble()).toEqual(raw);
  });
});

describe('字节日志：上限', () => {
  it('超上限就不再攒，并把已经攒的丢掉（留着也是白占内存）', () => {
    const log = createByteLog(10);
    log.append(bytes('0123456789abc'), 1); // 13 > 10

    expect(log.overflowed()).toBe(true);
    expect(log.preamble()).toHaveLength(0);

    log.append(bytes('后来的'), 2);
    expect(log.preamble()).toHaveLength(0);
  });

  it('溢出之后 lastOutputAt 照常更新（「输出停了没有」不能跟着停）', () => {
    const log = createByteLog(4);
    log.append(bytes('12345'), 100);
    log.append(bytes('x'), 200);

    expect(log.overflowed()).toBe(true);
    expect(log.lastOutputAt()).toBe(200);
  });

  it('没超的时候看得到最后一段字节的时刻', () => {
    const log = createByteLog();
    expect(log.lastOutputAt()).toBeNull();

    log.append(bytes('a'), 100);
    log.append(bytes('b'), 200);
    expect(log.lastOutputAt()).toBe(200);
  });
});
