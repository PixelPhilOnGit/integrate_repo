/**
 * `docs/seq-format.md` 里那个例子**必须真的能解析**。
 *
 * 那份文档是给人和 AI 看的契约：用户会（也已经被建议）让窗格里的 Claude Code
 * 照着它生成 `.seq.json`。文档一旦和代码漂移，照着写出来的图就会打不开 ——
 * 而那种错**只有用户撞到才发现**（我们自己的测试全都用 `createDoc` 造数据，
 * 一个手写字面量都不碰）。
 *
 * 所以这里把文档里第一个 JSON 代码块**抽出来真解析一遍**，顺带验它声称的形状。
 * 断言用文档里写死的那些值（标题、id、坐标间距）—— 文档改了而例子不自洽，
 * 这里就会红。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDoc, serializeDoc } from '../../src/modules/diagram/core/schema';

function jsonExampleIn(file: string): string {
  const md = readFileSync(file, 'utf8');
  const match = /```json\n([\s\S]*?)```/.exec(md);
  if (match?.[1] === undefined) throw new Error(`${file} 里找不到 json 代码块`);
  return match[1];
}

function docExample(): string {
  return jsonExampleIn('docs/seq-format.md');
}

describe('docs/seq-format.md 里的例子', () => {
  it('能解析，而且形状和文档里说的一样', () => {
    const doc = parseDoc(docExample());

    expect(doc.title).toBe('登录流程');
    expect(doc.schemaVersion).toBe(1);

    // 参与者：id / 类型 / 名字 / 坐标都在
    expect(doc.participants.map((p) => p.id)).toEqual(['user', 'web', 'api', 'db']);
    expect(doc.participants.map((p) => p.kind)).toEqual([
      'actor',
      'boundary',
      'control',
      'database',
    ]);
    expect(doc.participants.map((p) => p.x)).toEqual([120, 320, 520, 720]);

    // 消息：一条都没被丢掉 —— 说明 from/to 全都指向存在的参与者
    // （悬空引用会被解析器**静默丢掉**，正是文档里警告的那条）
    expect(doc.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(doc.messages.map((m) => m.kind)).toEqual([
      'sync',
      'sync',
      'sync',
      'return',
      'return',
    ]);
    // y 递增（文档里那句「间距 60，第一条 140」）
    expect(doc.messages.map((m) => m.y)).toEqual([140, 200, 260, 320, 380]);

    expect(doc.activations).toHaveLength(1);
    expect(doc.activations[0]).toMatchObject({
      participant: 'api',
      startMessageId: 'm2',
      endMessageId: 'm5',
    });
    expect(doc.notes.map((n) => n.text)).toEqual(['token 有效期 2 小时']);
  });

  it('写出去再读回来还是同一份（AI 改完、我们存回去不会走样）', () => {
    const doc = parseDoc(docExample());
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });
});

/**
 * 同一个例子也躺在 skill 里（`.claude/skills/sequence-diagram/SKILL.md`）——
 * 那份是**用户会真正贴给 AI 的**东西。它里面的例子同样必须解析得动，
 * 不然 AI 照着它写出来的图就是坏的。
 */
describe('.claude/skills/sequence-diagram/SKILL.md 里的例子', () => {
  it('也能解析，而且和文档那份说的是同一张图', () => {
    const fromSkill = parseDoc(jsonExampleIn('.claude/skills/sequence-diagram/SKILL.md'));
    const fromDoc = parseDoc(docExample());

    // 参与者、消息、激活条都对得上（skill 里省了 theme，那部分不参与比较）
    expect(fromSkill.participants).toEqual(fromDoc.participants);
    expect(fromSkill.messages).toEqual(fromDoc.messages);
    expect(fromSkill.activations).toEqual(fromDoc.activations);
    expect(fromSkill.notes).toEqual(fromDoc.notes);
  });
});
