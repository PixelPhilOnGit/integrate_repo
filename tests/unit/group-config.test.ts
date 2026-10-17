/**
 * 群组配置的默认值与校验（纯逻辑）。
 *
 * 规则和后端 `group/src/store.rs` 的 `validate_members` 一一对应 ——
 * 两边不一致的症状是「前端能保存、后端拒绝」或者反过来。
 */

import { describe, expect, it } from 'vitest';
import {
  blankMember,
  formatExtraArgs,
  parseExtraArgs,
  toConfigInput,
  validateGroupConfig,
} from '../../src/modules/group/core/config';
import type { GroupDetail, MemberConfig } from '../../src/modules/group/services/types';

function member(overrides: Partial<MemberConfig> = {}): MemberConfig {
  return { ...blankMember(0, '甲'), ...overrides };
}

function detail(members: MemberConfig[], overrides: Partial<GroupDetail> = {}): GroupDetail {
  return {
    id: 'g1',
    name: '项目群',
    workspace: '/work',
    mode: 'sequential',
    contextTurns: 6,
    contextChars: 24000,
    timeoutSecs: 600,
    members,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('validateGroupConfig', () => {
  it('正常配置没问题', () => {
    expect(validateGroupConfig(detail([member()]))).toBeNull();
  });

  it('群名不能为空', () => {
    expect(validateGroupConfig(detail([], { name: '  ' }))).toContain('群名');
  });

  it('成员名不能为空、不能重复（忽略大小写）', () => {
    expect(validateGroupConfig(detail([member({ name: '' })]))).toContain('名字不能为空');
    expect(
      validateGroupConfig(detail([member({ name: 'Alice' }), member({ name: 'alice' })])),
    ).toContain('重复');
  });

  it('自定义工具必须填命令', () => {
    expect(
      validateGroupConfig(detail([member({ kind: 'custom', command: '' })])),
    ).toContain('必须填命令');
    expect(
      validateGroupConfig(detail([member({ kind: 'custom', command: '/bin/my-agent' })])),
    ).toBeNull();
  });

  it('上下文/超时范围', () => {
    expect(validateGroupConfig(detail([], { contextTurns: 0 }))).toContain('轮数');
    expect(validateGroupConfig(detail([], { contextChars: 10 }))).toContain('字符');
    expect(validateGroupConfig(detail([], { timeoutSecs: 5 }))).toContain('超时');
  });

  it('成员数量上限', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      member({ name: `成员${i}`, position: i }),
    );
    expect(validateGroupConfig(detail(many))).toContain('12');
  });
});

describe('toConfigInput', () => {
  it('按 position 排序、去掉两头空白、位置重新编号', () => {
    const input = toConfigInput(
      detail([
        member({ id: 'm2', name: ' 乙 ', position: 1 }),
        member({ id: 'm1', name: '甲', position: 0 }),
      ]),
    );
    expect(input.members.map((m) => m.name)).toEqual(['甲', '乙']);
    expect(input.members.map((m) => m.position)).toEqual([0, 1]);
    expect(input.name).toBe('项目群');
  });
});

describe('额外参数', () => {
  it('一行一个；空行丢掉；两头空白去掉', () => {
    expect(parseExtraArgs('  --bare\n\n  --foo=1  \n')).toEqual(['--bare', '--foo=1']);
  });

  it('format 是 parse 的逆', () => {
    const args = ['--bare', '--foo=1'];
    expect(parseExtraArgs(formatExtraArgs(args))).toEqual(args);
  });
});
