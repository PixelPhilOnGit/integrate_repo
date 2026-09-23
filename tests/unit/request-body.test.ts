/**
 * 响应体解码（`core/body.ts`）。
 *
 * 这一组里**最要紧的是分块解 UTF-8 那条**：真链路上一个汉字被切在两块之间是
 * 常态（HANDOFF 里 SSH 那轮踩过同一个坑），每块单独 decode 的话中文会变成
 * 一串替换字符 —— 而那看起来像「服务端返回了乱码」，不像「我们解错了」。
 */

import { describe, expect, it } from 'vitest';
import {
  BodyStream,
  fromBase64,
  hexDump,
  isJson,
  isTextual,
  prettyJson,
  textToBase64,
  toBase64,
} from '../../src/modules/request/core/body';
import { formatBytes } from '../../src/modules/request/core/format';

describe('base64 两头', () => {
  it('来回一趟字节不变', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0x0a]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('文本也来回一趟', () => {
    const text = '中文 and ASCII 🚀';
    const back = new TextDecoder().decode(fromBase64(textToBase64(text)));
    expect(back).toBe(text);
  });
});

describe('边收边解', () => {
  it('一个汉字被切成两块，解出来还是它', () => {
    const stream = new BodyStream();
    const bytes = new TextEncoder().encode('阿德');
    // 「阿」= E9 98 BF，这里故意在第一个字节之后就切
    stream.push(toBase64(bytes.subarray(0, 1)));
    stream.push(toBase64(bytes.subarray(1)));
    stream.finish();
    expect(stream.text).toBe('阿德');
    expect(stream.text).not.toContain('�');
  });

  it('一次一块、一次三块，结果一样', () => {
    const text = '第一块，切在汉字的中间：阿德和小北都在这里。';
    const bytes = new TextEncoder().encode(text);

    const all = new BodyStream();
    all.push(toBase64(bytes));
    all.finish();

    const split = new BodyStream();
    for (let i = 0; i < bytes.length; i += 3) {
      split.push(toBase64(bytes.subarray(i, i + 3)));
    }
    split.finish();

    expect(split.text).toBe(text);
    expect(all.text).toBe(text);
  });

  it('字节数数的是 raw（不是字符数）', () => {
    const stream = new BodyStream();
    stream.push(textToBase64('中文'));
    expect(stream.bytes).toBe(6);
    expect(stream.text.length).toBe(2);
  });

  it('⚠️ 正好断在半个字符上：finish 之后要看得见那个替换字符', () => {
    // 不 flush 的话那半个字符会**静静消失**，而「断在半个字符上」恰恰
    // 说明这条响应是被切断的 —— 那件事得让用户看见
    const bytes = new TextEncoder().encode('阿');
    const stream = new BodyStream();
    stream.push(toBase64(bytes.subarray(0, 2))); // 少了最后一个字节
    stream.finish();
    expect(stream.text).toBe('�');
  });

  it('前缀只留前 1 KiB（十六进制视图够用，不留整条响应）', () => {
    const stream = new BodyStream();
    stream.push(toBase64(new Uint8Array(2000).fill(0x41)));
    expect(stream.prefix.length).toBe(1024);
    expect(stream.bytes).toBe(2000);
  });
});

describe('content-type 怎么判', () => {
  it('文本类的都算文本', () => {
    for (const t of [
      'text/plain',
      'text/html; charset=utf-8',
      'application/json',
      'application/problem+json',
      'application/xml',
      'application/x-www-form-urlencoded',
      'application/x-ndjson',
    ]) {
      expect(isTextual(t)).toBe(true);
    }
  });

  it('二进制类的不算', () => {
    for (const t of ['image/png', 'application/octet-stream', 'application/gzip', 'audio/mpeg']) {
      expect(isTextual(t)).toBe(false);
    }
  });

  it('没说 content-type 时当文本试一下', () => {
    expect(isTextual(null)).toBe(true);
    expect(isTextual('')).toBe(true);
  });

  it('JSON 才美化', () => {
    expect(isJson('application/json')).toBe(true);
    expect(isJson('application/hal+json; charset=utf-8')).toBe(true);
    expect(isJson('text/plain')).toBe(false);
    expect(isJson(null)).toBe(false);
  });
});

describe('十六进制预览', () => {
  it('一行 16 字节，带偏移和 ASCII', () => {
    const dump = hexDump(new TextEncoder().encode('AB'), 16);
    // 偏移 + 十六进制（每字节两个字符、空格分隔）+ ASCII 三栏。对齐用的空格
    // 不写死在断言里（那属于排版，改了要连着改测试）；要钉的是**三栏都在**
    expect(dump).toMatch(/^000000 +41 42 +AB$/);
  });

  it('不可打印的字节在 ASCII 那一栏画点', () => {
    const dump = hexDump(new Uint8Array([0x00, 0x1f, 0x7f, 0xff]), 16);
    expect(dump).toContain('....');
  });

  it('超长的只画前面那一段', () => {
    const dump = hexDump(new Uint8Array(1000), 32);
    expect(dump.split('\n')).toHaveLength(2);
  });
});

describe('美化 JSON', () => {
  it('紧凑的 JSON 会被排开', () => {
    const pretty = prettyJson('{"a":1}');
    expect(pretty).toBe('{\n  "a": 1\n}');
  });

  it('不是 JSON 就返回 null（调用方据此不显示「格式化」）', () => {
    expect(prettyJson('<html>x</html>')).toBeNull();
    expect(prettyJson('')).toBeNull();
    expect(prettyJson('{坏 JSON')).toBeNull();
  });

  it('已经是排开的就返回 null —— 给一个点了没反应的开关比不给更糟', () => {
    const pretty = '{\n  "a": 1\n}';
    expect(prettyJson(pretty)).toBeNull();
  });

  it('流式响应那半截 JSON 解析不了，走的是 null 那条路（原文照样显示）', () => {
    expect(prettyJson('{"n":1}\n{"n":2}')).toBeNull();
  });
});

describe('体积格式', () => {
  it('B / KB / MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});
