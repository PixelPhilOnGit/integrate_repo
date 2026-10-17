/**
 * 场景名校验（纯函数）。
 *
 * ⚠️ 规则和 Rust 侧（`scenario_commands.rs::valid_name`）**必须一字不差** ——
 * 这个名字会进文件路径（tasks@<名>.db、knowledge/@<名>/），两边判定漂移
 * 就是「一边能建、一边打不开」。
 */

import { describe, expect, it } from 'vitest';
import { validateScenarioName } from '../../src/shared/platform/scenario';

describe('validateScenarioName', () => {
  it('中英文、数字、- _ 空格都放行', () => {
    for (const ok of ['团队A', 'team-1', '客户 现场', 'a_b', 'A1']) {
      expect(validateScenarioName(ok), ok).toBeNull();
    }
  });

  it('@ 是分隔符_绝不许进名字（不然存储名会歧义）', () => {
    expect(validateScenarioName('a@b')).toContain('不能用的字符');
  });

  it('点和路径分隔符都挡（挡的是 .. 这类逃逸）', () => {
    expect(validateScenarioName('..')).not.toBeNull();
    expect(validateScenarioName('a.b')).not.toBeNull();
    expect(validateScenarioName('a/b')).not.toBeNull();
    expect(validateScenarioName('a\\b')).not.toBeNull();
  });

  it('空串和前后空白、超长都挡', () => {
    expect(validateScenarioName('')).not.toBeNull();
    expect(validateScenarioName(' 前后有空白 ')).not.toBeNull();
    expect(validateScenarioName('汉'.repeat(31))).not.toBeNull();
    expect(validateScenarioName('汉'.repeat(30))).toBeNull();
  });
});
