/**
 * `location.hash` → 模块名 的解析（多窗口的新窗口落点靠它）。
 *
 * ⚠️ 这里测的是**纯解析**那半（`moduleHash.ts`，零 import）。「id 得真在
 * 注册表里」的校验在 `registry.moduleIdFromHash` 里，由 e2e 的
 * `/#nope 回落第一个模块` 用例钉着（那条测试顺手把整条作用链也一起验了）。
 */

import { describe, expect, it } from 'vitest';
import { parseModuleHash } from '../../src/shell/moduleHash';

describe('parseModuleHash', () => {
  it('认出普通的 #<module>', () => {
    expect(parseModuleHash('#agents')).toBe('agents');
    expect(parseModuleHash('#diagram')).toBe('diagram');
  });

  it('#agents?x 这种带尾巴的取 ? 之前那截', () => {
    expect(parseModuleHash('#agents?x=1')).toBe('agents');
  });

  it('空的和只有 # 的都给 null（回落第一个模块）', () => {
    expect(parseModuleHash('')).toBeNull();
    expect(parseModuleHash('#')).toBeNull();
    expect(parseModuleHash('#   ')).toBeNull();
  });

  it('两头空白先去掉', () => {
    expect(parseModuleHash('#  agents  ')).toBe('agents');
  });

  it('大小写**不动**（模块 id 是面向用户的精确值，Reg 不认 Registration）', () => {
    // 注意：这里只断言"原样带出来"，认不认识是 registry 校验层的事
    expect(parseModuleHash('#Agents')).toBe('Agents');
  });
});
