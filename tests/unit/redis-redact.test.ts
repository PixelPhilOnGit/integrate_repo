import { describe, expect, it } from 'vitest';
import { REDACTED, redactArgs } from '../../src/modules/redis/core/redact';

describe('命令回显脱敏', () => {
  it('普通命令原样回显', () => {
    expect(redactArgs(['SET', 'k', 'v'])).toBe('SET k v');
    expect(redactArgs(['GET', 'k'])).toBe('GET k');
  });

  it('AUTH 的密码被隐藏', () => {
    const shown = redactArgs(['AUTH', 'my-secret-password']);
    expect(shown).not.toContain('my-secret-password');
    expect(shown).toContain(REDACTED);
    expect(shown.startsWith('AUTH')).toBe(true);
  });

  it('AUTH 带用户名时，用户名也一并隐藏', () => {
    // 隐藏用户名的代价可以接受，漏掉密码不行
    const shown = redactArgs(['AUTH', 'default', 'my-secret-password']);
    expect(shown).not.toContain('my-secret-password');
    expect(shown).not.toContain('default');
  });

  it('命令名大小写不敏感', () => {
    expect(redactArgs(['auth', 'secret'])).not.toContain('secret');
    expect(redactArgs(['Auth', 'secret'])).not.toContain('secret');
  });

  it('HELLO 里夹带的 AUTH 也会被隐藏', () => {
    const shown = redactArgs(['HELLO', '3', 'AUTH', 'default', 'my-secret-password']);
    expect(shown).not.toContain('my-secret-password');
    expect(shown).not.toContain('default');
    // AUTH 之前的参数还得看得见，否则看不懂这条命令是干嘛的
    expect(shown).toContain('HELLO');
    expect(shown).toContain('3');
  });

  it('光一个 AUTH 不炸', () => {
    expect(redactArgs(['AUTH'])).toBe('AUTH');
  });

  it('值里含 AUTH 这个词、但不在 token 位置上，不该误伤', () => {
    // 只有整个 token 等于 AUTH 才触发
    expect(redactArgs(['SET', 'k', 'AUTHORS'])).toBe('SET k AUTHORS');
    expect(redactArgs(['SET', 'k', 'my AUTH'])).toBe('SET k "my AUTH"');
  });

  it('参数里有空格时，隐藏之后剩下的部分仍然是可读的命令', () => {
    expect(redactArgs(['AUTH', 'a b c'])).toBe(`AUTH ${REDACTED}`);
  });
});
