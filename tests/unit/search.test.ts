/**
 * 模糊搜索：匹配 + 打分。
 *
 * 这一层是「搜索框到底好不好用」的全部 —— 界面上只是把结果按分排下来。
 * 所以断言打在两件事上：**能不能匹配上**（子序列、大小写、边界情况），
 * 以及**谁排在谁前面**（打分那几条规则）。
 */
import { describe, expect, it } from 'vitest';
import { fuzzyBest, fuzzyFilter, fuzzyMatch, fuzzyScore } from '../../src/shared/search';

describe('模糊匹配：能不能匹配上', () => {
  it('空查询匹配一切（调用方据此走「不过滤」那条路）', () => {
    expect(fuzzyMatch('', '随便什么')).toEqual({ score: 1, positions: [] });
  });

  it('子序列就行：prod → production-api', () => {
    expect(fuzzyScore('prod', 'production-api')).not.toBeNull();
  });

  it('顺序不对就匹配不上', () => {
    expect(fuzzyScore('dorp', 'production')).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(fuzzyScore('PROD', 'production')).toBe(fuzzyScore('prod', 'production'));
  });

  it('查询比文本还长 → 匹配不上（不可能装得下）', () => {
    expect(fuzzyScore('production', 'prod')).toBeNull();
  });

  it('给得出命中位置，而且位置是对的', () => {
    // p-r-o-d-u-c-t-i-o-n 里搜 prd：p(0) r(1) d(3)
    expect(fuzzyMatch('prd', 'production')?.positions).toEqual([0, 1, 3]);
  });

  it('中文按字符匹配', () => {
    expect(fuzzyScore('项目', '我的项目目录')).not.toBeNull();
  });
});

describe('打分：谁该排在前面', () => {
  it('词首 / 分隔符之后的命中，比词中间的值钱', () => {
    // 「x-ab」里 ab 在分隔符之后，「xabx」里在词中间 —— 同样长度，前者该赢
    expect(fuzzyScore('ab', 'x-ab')!).toBeGreaterThan(fuzzyScore('ab', 'xabx')!);
  });

  it('开头的命中最高', () => {
    expect(fuzzyScore('prod', 'prod-db')!).toBeGreaterThan(fuzzyScore('prod', 'my-prod-db')!);
  });

  it('连着的比断开的强', () => {
    expect(fuzzyScore('abc', 'abc-xyz')!).toBeGreaterThan(fuzzyScore('abc', 'a-b-c-xyz')!);
  });

  it('同样匹配上时短的赢（说明匹配得更「满」）', () => {
    expect(fuzzyScore('api', 'api')!).toBeGreaterThan(fuzzyScore('api', 'api-server-backend')!);
  });

  it('搜 IP 片段能找到带点的地址', () => {
    // 用户不会老实打点号：`192168` 得能搜到 `192.168.1.20`
    expect(fuzzyScore('192168', '192.168.1.20')).not.toBeNull();
  });

  it('路径片段也是（跨分隔符）', () => {
    // `D:\ws\api` 里搜 `wsapi`：w(3) s(4) 跳过 `\` a(6) p(7) i(8)
    expect(fuzzyScore('wsapi', 'D:\\ws\\api')).not.toBeNull();
  });

  it('⚠️ 再差也是正分 —— 不能和「没匹配」混在一起', () => {
    // 后面拖了两百个字符、跳得厉害：分数可能被扣得很低，但必须 > 0，
    // 否则排序时它会掉到「没匹配」那一堆里（界面上就是「明明有却搜不到」）
    const score = fuzzyScore('a', 'x'.repeat(200) + 'a');
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });
});

describe('多字段与过滤', () => {
  it('名字和地址两段里，任一段命中就算命中', () => {
    const fields = ['production', '10.0.0.1'];
    expect(fuzzyBest('prod', fields)).not.toBeNull();
    expect(fuzzyBest('10.0', fields)).not.toBeNull(); // IP 在第二段
    expect(fuzzyBest('zzz', fields)).toBeNull();
  });

  it('取的是最高的那一分', () => {
    expect(fuzzyBest('prod', ['prod', 'my-production-server'])).toBe(
      fuzzyScore('prod', 'prod'),
    );
  });

  it('⚠️ 空查询原样返回，**连顺序都不动**（「和以前一模一样」那条约定）', () => {
    const items = [{ n: 'b' }, { n: 'a' }, { n: 'c' }];
    expect(fuzzyFilter(items, '', (i) => [i.n])).toEqual(items);
    // 全是空白也算空
    expect(fuzzyFilter(items, '   ', (i) => [i.n])).toEqual(items);
  });

  it('过滤掉不匹配的，剩下的按分排序', () => {
    const items = [{ n: 'my-prod-db' }, { n: 'prod-db' }, { n: 'zzz' }];
    expect(fuzzyFilter(items, 'prod', (i) => [i.n]).map((i) => i.n)).toEqual([
      'prod-db',
      'my-prod-db',
    ]);
  });

  it('一条都不匹配时返回空数组（调用方据此显示「没有匹配的」）', () => {
    expect(fuzzyFilter([{ n: 'abc' }], 'zzzz', (i) => [i.n])).toEqual([]);
  });
});
