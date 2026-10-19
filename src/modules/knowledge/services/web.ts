/**
 * 知识库的浏览器版（假实现）：内存 vault + 假生成器。
 *
 * **这不是「顺便支持浏览器」**——它是 e2e 唯一能驱动的版本（和 tasks 的
 * 假库、agents 的假 agent 同一个立场）。语义要和 Rust 侧**逐条对齐**：
 * status 白名单、归档是独立轴、删来源的两种语义（连带删 / 断链）、
 * 生成的 runId 从第一条事件带出。真落盘/真提取/真 CLI 归 Rust 那组测试。
 *
 * 种子内容刻意放了一张**带 seq 围栏**的卡片和一张**带 wikilink/图片嵌入**的
 * 卡片 —— 「多种表现形式放到一起」这条需求在 e2e 里就有东西可点。
 */

import type {
  CardDetail,
  CardRow,
  GenEvent,
  GenListener,
  KnowledgeClient,
  RunRow,
  SourceAddOutcome,
  SourceRow,
  VaultInfo,
} from './types';

interface FakeVault {
  cards: CardDetail[];
  sources: SourceRow[];
  runs: RunRow[];
  /** `_files/…` → 字节（e2e 验内嵌图片/断链回落用） */
  files: Map<string, Uint8Array>;
  genSeq: number;
  /** 正在跑的 runId → 已取消？ */
  cancelled: Set<string>;
}

/** 一张真的 1×1 PNG（透明）—— e2e 里 `<img>` 能真的加载出来。 */
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
  0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const SEQ_SAMPLE = JSON.stringify({
  title: '登录流程',
  participants: [
    { id: 'p1', name: '用户' },
    { id: 'p2', name: '服务端' },
  ],
  messages: [
    { from: 'p1', to: 'p2', text: 'POST /login' },
    { from: 'p2', to: 'p1', text: '200 + token' },
  ],
});

function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function rowOf(d: CardDetail): CardRow {
  return {
    rel: d.rel,
    title: d.title,
    status: d.status,
    archived: d.archived,
    created: d.created,
    tags: d.tags,
    sources: d.sources,
    excerpt: excerptOf(d.body),
    mtime: Date.parse('2026-10-16T00:00:00Z'),
    size: d.body.length,
  };
}

/**
 * 测试重置钩子（照 tasks 的 `__resetTasksForTest` 先例）。
 *
 * 假的 vault 表是**闭包状态**：store 的单测之间共享同一个实例，不重置的话
 * 上一个用例生成的卡片会漂到下一个用例里（踩过：断言「连带的卡片」数和
 * 来源引用时全错位）。
 */
const resetters: Array<() => void> = [];

export function __resetWebKnowledgeForTest(): void {
  for (const reset of resetters) reset();
}

export function createWebKnowledgeClient(): KnowledgeClient {
  const vaults = new Map<string, FakeVault>();
  resetters.push(() => vaults.clear());
  let clock = 0;
  const stamp = (): string => {
    clock += 1;
    return new Date(Date.parse('2026-10-16T12:00:00Z') + clock * 60_000).toISOString();
  };

  /** 首次访问时种一个示例库（e2e 的起点就是它）。 */
  const ensureSeed = (): void => {
    if (vaults.size > 0) return;
    vaults.set('示例库', {
      cards: [
        {
          rel: '登录流程.md',
          title: '登录流程',
          status: 'unreviewed',
          archived: false,
          created: '2026-10-14T09:00:00Z',
          tags: ['认证'],
          sources: [],
          body: `# 登录流程\n\n客户端拿到 token 之后带着它访问接口。\n\n\`\`\`seq\n${SEQ_SAMPLE}\n\`\`\`\n`,
        },
        {
          rel: '架构备忘.md',
          title: '架构备忘',
          status: 'reviewed',
          archived: false,
          created: '2026-10-15T09:00:00Z',
          tags: ['架构'],
          sources: [],
          body: `# 架构备忘\n\n参考 [[登录流程]] 的约定，**服务端不存明文**。\n\n看 [文档](https://example.com/docs) 和这张图：\n\n![[架构图.png]]\n\n还有一张找不到的：\n\n![[缺失图.png]]\n`,
        },
        {
          rel: '旧笔记.md',
          title: '旧笔记',
          status: 'reviewed',
          archived: true,
          created: '2026-09-01T09:00:00Z',
          tags: [],
          sources: [],
          body: '过时的东西，先收起来。\n',
        },
      ],
      sources: [],
      runs: [],
      files: new Map([['_files/架构图.png', PNG_1X1]]),
      genSeq: 0,
      cancelled: new Set(),
    });
  };

  const vaultOf = (name: string): FakeVault => {
    ensureSeed();
    const v = vaults.get(name);
    if (!v) throw new Error(`知识库不存在：${name}`);
    return v;
  };

  return {
    async vaults(): Promise<VaultInfo[]> {
      ensureSeed();
      return [...vaults.entries()].map(([name, v]) => ({
        name,
        cardCount: v.cards.length,
        sourceCount: v.sources.length,
      }));
    },

    async createVault(name: string): Promise<void> {
      ensureSeed();
      if (vaults.has(name)) throw new Error(`已经存在：${name}`);
      vaults.set(name, {
        cards: [],
        sources: [],
        runs: [],
        files: new Map(),
        genSeq: 0,
        cancelled: new Set(),
      });
    },

    async deleteVault(name: string): Promise<void> {
      ensureSeed();
      if (!vaults.delete(name)) throw new Error(`知识库不存在：${name}`);
    },

    async revealVault(_name: string): Promise<void> {
      // 浏览器版没有系统文件管理器 —— 空操作（菜单项在 UI 层对 web 版不渲染）
    },

    async sync(_name: string) {
      ensureSeed();
      return { scanned: 0, updated: 0, removed: 0, failed: 0 };
    },

    async cards(name: string): Promise<CardRow[]> {
      return vaultOf(name).cards.map(rowOf);
    },

    async cardRead(name: string, rel: string): Promise<CardDetail> {
      const c = vaultOf(name).cards.find((x) => x.rel === rel);
      if (!c) throw new Error(`卡片不存在：${rel}`);
      return { ...c, tags: [...c.tags], sources: [...c.sources] };
    },

    async cardSetStatus(name: string, rel: string, status: string): Promise<void> {
      const c = vaultOf(name).cards.find((x) => x.rel === rel);
      if (!c) throw new Error(`卡片不存在：${rel}`);
      c.status = status === 'reviewed' ? 'reviewed' : 'unreviewed';
    },

    async cardSetArchived(name: string, rel: string, archived: boolean): Promise<void> {
      const c = vaultOf(name).cards.find((x) => x.rel === rel);
      if (!c) throw new Error(`卡片不存在：${rel}`);
      c.archived = archived;
    },

    async cardDelete(name: string, rel: string): Promise<void> {
      const v = vaultOf(name);
      v.cards = v.cards.filter((c) => c.rel !== rel);
    },

    async search(name: string, query: string) {
      const v = vaultOf(name);
      const q = query.trim().toLowerCase();
      const hit = (text: string): boolean => text.toLowerCase().includes(q);
      return {
        cards: v.cards
          .filter((c) => hit(c.title) || hit(c.body) || c.tags.some(hit))
          .map(rowOf),
        sources: v.sources.filter((s) => hit(s.name)),
      };
    },

    async sources(name: string): Promise<SourceRow[]> {
      return [...vaultOf(name).sources];
    },

    async sourceAdd(name: string): Promise<SourceAddOutcome | null> {
      const v = vaultOf(name);
      const n = v.sources.length + 1;
      // 浏览器版没有真文件对话框 —— 造一份假资料（照 tasks 的先例）。
      // 每份带一张图，让「来源行显示 N 张图」和内嵌显示都有东西可验。
      const imageRel = `_files/示例资料${n}-img-1.png`;
      v.files.set(imageRel, PNG_1X1);
      const source: SourceRow = {
        rel: `_sources/示例资料${n}.md`,
        name: `示例资料${n}.md`,
        byteSize: 1024,
        extractStatus: 'ok',
        created: stamp(),
        images: [{ rel: imageRel, originalName: `示例图片${n}.png`, page: null }],
        imageNote: '',
      };
      v.sources.push(source);
      return { added: [{ ...source }], errors: [] };
    },

    async sourceDelete(name: string, rel: string, deleteGenerated: boolean): Promise<number> {
      const v = vaultOf(name);
      v.sources = v.sources.filter((s) => s.rel !== rel);
      let removed = 0;
      for (const c of v.cards) {
        if (!c.sources.includes(rel)) continue;
        if (deleteGenerated) {
          removed += 1;
        } else {
          c.sources = c.sources.filter((s) => s !== rel);
        }
      }
      if (deleteGenerated) v.cards = v.cards.filter((c) => !c.sources.includes(rel));
      return removed;
    },

    async generate(name, sourceRels, cli, note, onEvent: GenListener) {
      const v = vaultOf(name);
      v.genSeq += 1;
      const runId = `run_fake_${v.genSeq}`;
      if (sourceRels.length === 0) throw new Error('先选至少一份资料');
      const sources = sourceRels.map((rel) => {
        const hit = v.sources.find((s) => s.rel === rel);
        if (!hit) throw new Error(`这份资料不在库里：${rel}`);
        return hit;
      });
      const sourceRel = sourceRels[0] ?? '';

      const startedAt = Date.now();
      const emit = (note: string, first = false): void => {
        const ev: GenEvent = first ? { note, runId } : { note };
        onEvent(ev);
      };
      emit('开始生成', true);

      v.runs.unshift({
        id: runId,
        sourceRel,
        sourceRels: [...sourceRels],
        cli: cli === 'codex' ? 'codex' : 'claude',
        status: 'running',
        error: null,
        usage: null,
        startedAt,
        finishedAt: null,
        cardCount: 0,
      });

      const step = async (note: string): Promise<void> => {
        await new Promise((r) => setTimeout(r, 30));
        if (v.cancelled.has(runId)) throw new Error('被取消了');
        emit(note);
      };

      try {
        await step('把资料交给 CLI…');
        await step(note.trim() === '' ? '整理中…' : `按你的要求整理：${note.trim()}`);
        await step('写卡片…');

        const base =
          sources.length === 1
            ? (sources[0]?.name ?? '资料').replace(/\.[^.]+$/, '')
            : `综合 ${sources.length} 份资料`;
        const created = stamp();
        // 去重要和 Rust 的 `unique_card_rel` 一个口径（同名加序号）——
        // 假实现这里一开始没去重，两轮生成同名资料就撞出两张同 rel 的卡
        //（e2e 抓的；「语义逐条对齐」不是口号）
        const uniqueRel = (title: string): string => {
          let rel = `${title}.md`;
          let n = 2;
          while (v.cards.some((c) => c.rel === rel)) {
            rel = `${title} (${n}).md`;
            n += 1;
          }
          return rel;
        };
        const titles = [`整理：${base}`, `整理：${base}（续）`];
        const firstImage = sources[0]?.images[0]?.rel;
        const made: CardDetail[] = titles.map((title, i) => ({
          rel: uniqueRel(title),
          title,
          status: 'unreviewed',
          archived: false,
          created,
          tags: ['生成'],
          sources: [...sourceRels],
          body:
            i === 0
              ? `# ${title}\n\n从「${sources.map((s) => s.name).join('」「')}」整理出的要点。\n` +
                (firstImage ? `\n![[${firstImage}]]\n` : '')
              : `# ${title}\n\n补充内容。相关：[[整理：${base}]]\n`,
        }));
        v.cards.push(...made);

        const run = v.runs.find((r) => r.id === runId);
        if (run) {
          run.status = 'done';
          run.finishedAt = Date.now();
          run.cardCount = made.length;
          run.usage = '{"usage":{"input_tokens":123,"output_tokens":45}}';
        }
        emit(`写好了 ${made.length} 张卡片`);
        return { runId, cards: made.map(rowOf) };
      } catch (e) {
        const run = v.runs.find((r) => r.id === runId);
        if (run) {
          run.status = 'failed';
          run.finishedAt = Date.now();
          run.error = e instanceof Error ? e.message : String(e);
        }
        throw e;
      }
    },

    async cancelGenerate(name: string, runId: string): Promise<void> {
      vaultOf(name).cancelled.add(runId);
    },

    async runs(name: string, sourceRel: string): Promise<RunRow[]> {
      return vaultOf(name).runs.filter((r) => r.sourceRels.includes(sourceRel));
    },

    async fileRead(name: string, target: string): Promise<ArrayBuffer> {
      const v = vaultOf(name);
      const rel = target.startsWith('_files/') ? target : `_files/${target}`;
      const bytes = v.files.get(rel);
      if (!bytes) throw new Error(`图片不在库里：${target}`);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    },

    async cliProbe() {
      // 和真实现对应：claude 装着、codex 没装（顺带让「没装的键禁用」的
      // 那条 UI 分支在 e2e 里有东西可测）
      return { claude: 'fake-claude 0.0.0', codex: null };
    },
  };
}
