import { describe, expect, it } from 'vitest';
import { formatArgs, tokenize } from '../../src/modules/redis/core/tokenize';

function tokens(input: string): string[] {
  const result = tokenize(input);
  if (!result.ok) throw new Error(`期望能分词成功，实际失败了：${result.reason}`);
  return result.tokens;
}

describe('命令行分词', () => {
  it('按空白切分，连续空白和首尾空白都忽略', () => {
    expect(tokens('SET a b')).toEqual(['SET', 'a', 'b']);
    expect(tokens('  SET   a    b  ')).toEqual(['SET', 'a', 'b']);
    expect(tokens('GET\t k')).toEqual(['GET', 'k']);
  });

  it('空输入和纯空白不产生 token', () => {
    expect(tokens('')).toEqual([]);
    expect(tokens('   \t \n ')).toEqual([]);
  });

  it('双引号里的空白算 token 的一部分', () => {
    expect(tokens('SET k "hello world"')).toEqual(['SET', 'k', 'hello world']);
    expect(tokens('SET k ""')).toEqual(['SET', 'k', '']);
  });

  it('单引号里的空白也算 token 的一部分', () => {
    expect(tokens("SET k 'hello world'")).toEqual(['SET', 'k', 'hello world']);
  });

  it('未加引号的 token 里反斜杠是普通字符', () => {
    // 这点和很多人的直觉相反，但 redis-cli 就是这样（sdssplitargs）
    expect(tokens('SET k a\\b')).toEqual(['SET', 'k', 'a\\b']);
    expect(tokens('SET k a\\nb')).toEqual(['SET', 'k', 'a\\nb']);
  });

  it('双引号里支持 \\xHH 十六进制转义', () => {
    expect(tokens('SET k "\\x41\\x42"')).toEqual(['SET', 'k', 'AB']);
    // 小写十六进制也认
    expect(tokens('SET k "\\x6a"')).toEqual(['SET', 'k', 'j']);
  });

  it('双引号里支持 \\n \\r \\t \\b \\a', () => {
    expect(tokens('SET k "a\\nb"')).toEqual(['SET', 'k', 'a\nb']);
    expect(tokens('SET k "a\\rb"')).toEqual(['SET', 'k', 'a\rb']);
    expect(tokens('SET k "a\\tb"')).toEqual(['SET', 'k', 'a\tb']);
    expect(tokens('SET k "\\b"')).toEqual(['SET', 'k', '\b']);
    expect(tokens('SET k "\\a"')).toEqual(['SET', 'k', '\x07']);
  });

  it('双引号里其它 \\c 一律还原成 c', () => {
    expect(tokens('SET k "a\\qb"')).toEqual(['SET', 'k', 'aqb']);
    expect(tokens('SET k "\\\""')).toEqual(['SET', 'k', '"']);
    // \x 后面不是两位十六进制时，按普通字符处理（和 sdssplitargs 的 default 分支一致）
    expect(tokens('SET k "\\xZZ"')).toEqual(['SET', 'k', 'xZZ']);
    expect(tokens('SET k "\\x4"')).toEqual(['SET', 'k', 'x4']);
  });

  it('单引号里只认 \\\' 这一种转义，其余反斜杠原样保留', () => {
    expect(tokens("SET k 'a\\'b'")).toEqual(['SET', 'k', "a'b"]);
    // 单引号里的 \n 不是换行，是反斜杠加 n
    expect(tokens("SET k 'a\\nb'")).toEqual(['SET', 'k', 'a\\nb']);
  });

  it('结束引号后面必须是空白或结束', () => {
    const result = tokenize('SET k "a"b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('结束引号后面必须是空白');
  });

  it('引号没闭合会报错，而不是把剩下的都吞掉', () => {
    for (const input of ['SET k "abc', "SET k 'abc", 'SET k "']) {
      const result = tokenize(input);
      expect(result.ok, `「${input}」应该报错`).toBe(false);
      if (!result.ok) expect(result.reason).toContain('没有闭合');
    }
  });

  it('相邻的两段引号是各自独立的 token', () => {
    expect(tokens('"a" "b"')).toEqual(['a', 'b']);
    expect(tokens("'a' \"b\"")).toEqual(['a', 'b']);
  });

  it('中文和 emoji 原样保留', () => {
    expect(tokens('SET 名字 "张三"')).toEqual(['SET', '名字', '张三']);
    expect(tokens('SET k "🎉"')).toEqual(['SET', 'k', '🎉']);
  });
});

describe('命令回显', () => {
  it('普通参数不加引号', () => {
    expect(formatArgs(['SET', 'key', 'value'])).toBe('SET key value');
    expect(formatArgs(['KEYS', '*'])).toBe('KEYS *');
    expect(formatArgs(['EXPIRE', 'k', '60'])).toBe('EXPIRE k 60');
  });

  it('带空格的参数重新加引号，保证复制回去还能执行', () => {
    expect(formatArgs(['SET', 'k', 'hello world'])).toBe('SET k "hello world"');
    expect(formatArgs(['SET', 'k', ''])).toBe('SET k ""');
  });

  it('参数里的引号和反斜杠会被转义', () => {
    expect(formatArgs(['SET', 'k', 'say "hi"'])).toBe('SET k "say \\"hi\\""');
    expect(formatArgs(['SET', 'k', 'a\\b'])).toBe('SET k "a\\\\b"');
  });

  it('转义之后能被分词器解回原样（往返一致）', () => {
    const cases = [
      ['SET', 'k', 'hello world'],
      ['SET', 'k', 'say "hi"'],
      ['SET', 'k', 'a\\b'],
      ['SET', 'k', ''],
      ['SET', '名字', '张三 李四'],
    ];

    for (const args of cases) {
      const roundTripped = tokenize(formatArgs(args));
      expect(roundTripped.ok, `「${formatArgs(args)}」应该能解回来`).toBe(true);
      if (roundTripped.ok) expect(roundTripped.tokens).toEqual(args);
    }
  });
});
