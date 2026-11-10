/**
 * 知识库模块的 store。
 *
 * 和别的模块一个形状：模块级单例、`subscribe/getSnapshot`、命令失败交外壳
 * 错误条（模块不自己弹）。这个模块独有的两件事：
 *
 * * **搜索是下推到 SQL 的**（卡片正文不长不短，全量拉到前端再搜是浪费）——
 *   输入走 250ms 去抖，命中集非空时列表以它为底；
 * * **生成是一段带进度的长任务**：进度事件、runId（从第一条事件里拿）、
 *   取消、以及失败时保留现场（notes 不清空 —— 用户要看它跑到哪一步挂的）。
 */

import { describeError } from '../../../shell/store';
import type { ShellApi } from '../../../shell/types';
import { localStampNow } from '../core/format';
import {
  cardsUnder,
  childDirs,
  counts,
  visibleCards,
  nextUnreviewed,
  type KbCounts,
  type KbFilter,
} from '../core/filters';
import { knowledgeServices } from '../services';
import type {
  CardDetail,
  CardRow,
  CliProbe,
  SearchHits,
  SourceAddOutcome,
  SourceRow,
  VaultInfo,
} from '../services/types';

export interface GenState {
  /** 这一次生成用到的资料（1..=12 份） */
  sourceRels: string[];
  runId: string | null;
  notes: string[];
  /** null = 跑着；数字 = 成功写了 N 张 */
  done: number | null;
  error: string | null;
}

export interface KbState {
  ready: boolean;
  vaults: VaultInfo[];
  activeVault: string | null;
  cards: CardRow[];
  sources: SourceRow[];
  /** 卡片区里的全部目录（含空目录；`dir` 形式，空串 = 根） */
  dirs: string[];
  /** 当前浏览的目录（空串 = 根；根视图包含整棵树的卡片） */
  currentDir: string;
  filter: KbFilter;
  query: string;
  /** 搜索生效时的命中集（null = 没在搜） */
  hits: SearchHits | null;
  selectedRel: string | null;
  detail: CardDetail | null;
  detailLoading: boolean;
  cliProbe: CliProbe | null;
  /** 正在跑/刚跑完的生成（面板关掉前一直留着，失败现场要看） */
  gen: GenState | null;
}

export class KnowledgeStore {
  private listeners = new Set<() => void>();
  private shell: ShellApi | null = null;
  private state: KbState = {
    ready: false,
    vaults: [],
    activeVault: null,
    cards: [],
    sources: [],
    dirs: [],
    currentDir: '',
    filter: 'all',
    query: '',
    hits: null,
    selectedRel: null,
    detail: null,
    detailLoading: false,
    cliProbe: null,
    gen: null,
  };
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  attachShell(api: ShellApi): void {
    this.shell = api;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): KbState => this.state;

  /**
   * 当前筛选/搜索下可见的卡片（组件和「下一张」共用同一个口径）。
   * 搜索是**全库**的（用户找东西不该被当前目录困住）；不搜索时按目录子树。
   */
  visible = (): CardRow[] => {
    const { cards, filter, hits, currentDir } = this.state;
    return hits !== null
      ? visibleCards(cards, filter, hits.cards)
      : visibleCards(cardsUnder(cards, currentDir), filter, null);
  };

  counts = (): KbCounts => counts(cardsUnder(this.state.cards, this.state.currentDir));

  /** 当前目录的直接子目录（卡片墙上的文件夹卡片）。 */
  subdirs = (): string[] => childDirs(this.state.dirs, this.state.currentDir);

  /** 某个目录（子树）里有多少张**未归档**卡片 —— 文件夹卡片上的角标。 */
  countInDir = (dir: string): number =>
    cardsUnder(this.state.cards, dir).filter((c) => !c.archived).length;

  private set(patch: Partial<KbState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private fail(e: unknown): void {
    this.shell?.reportError(e);
  }

  /** 模块被切到时调（幂等） */
  async init(): Promise<void> {
    if (this.state.ready) return;
    this.set({ ready: true });
    await Promise.all([this.probeClis(), this.refreshVaults()]);
    const first = this.state.activeVault ?? this.state.vaults[0]?.name ?? null;
    if (first !== null) await this.setActiveVault(first);
  }

  async probeClis(): Promise<void> {
    try {
      const probe = await knowledgeServices.client.cliProbe();
      this.set({ cliProbe: probe });
    } catch (e) {
      this.fail(e);
    }
  }

  async refreshVaults(): Promise<void> {
    try {
      const vaults = await knowledgeServices.client.vaults();
      const active =
        this.state.activeVault !== null && vaults.some((v) => v.name === this.state.activeVault)
          ? this.state.activeVault
          : (vaults[0]?.name ?? null);
      this.set({ vaults, activeVault: active });
    } catch (e) {
      this.fail(e);
    }
  }

  /** 切库：清卡片现场，**同步一遍再拉**（用户可能在 Obsidian 里改过文件）。 */
  async setActiveVault(name: string): Promise<void> {
    this.cancelSearch();
    this.set({
      activeVault: name,
      cards: [],
      sources: [],
      dirs: [],
      currentDir: '',
      query: '',
      hits: null,
      selectedRel: null,
      detail: null,
      gen: null,
    });
    await this.syncAndReload();
  }

  async syncAndReload(): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      await knowledgeServices.client.sync(name);
      const [cards, sources, dirs] = await Promise.all([
        knowledgeServices.client.cards(name),
        knowledgeServices.client.sources(name),
        knowledgeServices.client.dirs(name),
      ]);
      // 当前目录被外部删掉/改名了：退回根目录
      const currentDir = this.existsDir(dirs, this.state.currentDir)
        ? this.state.currentDir
        : '';
      this.set({ cards, sources, dirs, currentDir });
      // 选中的卡片同步后可能变了内容/没了：重读或清掉
      const sel = this.state.selectedRel;
      if (sel !== null) {
        if (cards.some((c) => c.rel === sel)) {
          await this.selectCard(sel);
        } else {
          this.set({ selectedRel: null, detail: null });
        }
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private existsDir(dirs: readonly string[], dir: string): boolean {
    return dir === '' || dirs.includes(dir);
  }

  /** 取消一个还没到点的搜索（切目录/建卡时用，免得旧结果迟到）。 */
  private cancelSearch(): void {
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  /** 进入/退出目录：清搜索和阅读现场 —— 目录切换是「换一个浏览范围」。 */
  setCurrentDir(dir: string): void {
    if (dir !== '' && !this.state.dirs.includes(dir)) return;
    this.cancelSearch();
    this.set({
      currentDir: dir,
      query: '',
      hits: null,
      selectedRel: null,
      detail: null,
    });
  }

  /** 手动新建卡片（`dir` 缺省 = 当前目录），完成后打开它。 */
  async createCard(title: string, body: string, dir?: string): Promise<boolean> {
    const name = this.state.activeVault;
    if (name === null) return false;
    const target = dir ?? this.state.currentDir;
    try {
      const detail = await knowledgeServices.client.cardCreate(name, target, title, body);
      const [cards, dirs] = await Promise.all([
        knowledgeServices.client.cards(name),
        knowledgeServices.client.dirs(name),
      ]);
      this.cancelSearch();
      this.set({
        cards,
        dirs,
        currentDir: target,
        detail,
        selectedRel: detail.rel,
        query: '',
        hits: null,
        // 新卡是未评审：把筛选拨回「全部」，否则在「已评审/归档」档里
        // 建完卡返回会找不到它
        filter: 'all',
      });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** 保存标题与正文（阅读器「编辑」）。 */
  async updateCard(rel: string, title: string, body: string): Promise<boolean> {
    const name = this.state.activeVault;
    if (name === null) return false;
    try {
      const detail = await knowledgeServices.client.cardUpdate(name, rel, title, body);
      const cards = await knowledgeServices.client.cards(name);
      // 标题改了列表行也得跟着变（rel 没变）
      this.set({ cards, detail, selectedRel: detail.rel });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** 在正文末尾追加一条带本地时间的备注（「像任务备注一样」）。 */
  async appendToCard(rel: string, text: string): Promise<boolean> {
    const name = this.state.activeVault;
    if (name === null) return false;
    try {
      const detail = await knowledgeServices.client.cardAppend(
        name,
        rel,
        text,
        localStampNow()
      );
      const cards = await knowledgeServices.client.cards(name);
      this.set({ cards, detail, selectedRel: detail.rel });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** 新建目录（`parent` 缺省 = 当前目录），完成后进入它。 */
  async createDir(dirName: string, parent?: string): Promise<boolean> {
    const name = this.state.activeVault;
    if (name === null) return false;
    const target = parent ?? this.state.currentDir;
    try {
      const rel = await knowledgeServices.client.dirCreate(name, target, dirName);
      const dirs = await knowledgeServices.client.dirs(name);
      this.cancelSearch();
      this.set({ dirs, currentDir: rel, selectedRel: null, detail: null, query: '', hits: null });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  async renameDir(rel: string, newName: string): Promise<boolean> {
    const name = this.state.activeVault;
    if (name === null) return false;
    try {
      const newRel = await knowledgeServices.client.dirRename(name, rel, newName);
      const [cards, dirs] = await Promise.all([
        knowledgeServices.client.cards(name),
        knowledgeServices.client.dirs(name),
      ]);
      // 当前目录/选中的卡在被改名的子树里 → 跟着换前缀
      const remap = (path: string): string => {
        if (path === rel) return newRel;
        if (path.startsWith(`${rel}/`)) return `${newRel}${path.slice(rel.length)}`;
        return path;
      };
      const currentDir = remap(this.state.currentDir);
      const selectedRel = this.state.selectedRel === null ? null : remap(this.state.selectedRel);
      this.set({ cards, dirs, currentDir, selectedRel });
      if (selectedRel !== null) await this.selectCard(selectedRel);
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  async deleteDir(rel: string): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      await knowledgeServices.client.dirDelete(name, rel);
      const [cards, dirs] = await Promise.all([
        knowledgeServices.client.cards(name),
        knowledgeServices.client.dirs(name),
      ]);
      const inside = (path: string): boolean =>
        path === rel || path.startsWith(`${rel}/`);
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const currentDir = inside(this.state.currentDir) ? parent : this.state.currentDir;
      const selectedRel =
        this.state.selectedRel !== null && inside(this.state.selectedRel)
          ? null
          : this.state.selectedRel;
      this.set({
        cards,
        dirs,
        currentDir,
        selectedRel,
        detail: selectedRel === null ? null : this.state.detail,
      });
    } catch (e) {
      this.fail(e);
    }
  }

  /** 把卡片移到另一个目录；返回新 rel（失败 null）。 */
  async moveCard(rel: string, dir: string): Promise<string | null> {
    const name = this.state.activeVault;
    if (name === null) return null;
    try {
      const detail = await knowledgeServices.client.cardMove(name, rel, dir);
      const cards = await knowledgeServices.client.cards(name);
      this.set({ cards, detail, selectedRel: detail.rel });
      return detail.rel;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** 给卡片挂文件；返回挂完后共有几个附件（用户取消 null）。 */
  async attachFile(rel: string): Promise<number | null> {
    const name = this.state.activeVault;
    if (name === null) return null;
    try {
      const outcome = await knowledgeServices.client.cardAttach(name, rel);
      if (outcome === null) return null;
      const cards = await knowledgeServices.client.cards(name);
      this.set({ cards, detail: outcome.detail, selectedRel: outcome.detail.rel });
      if (outcome.errors.length > 0) {
        this.shell?.reportError(
          new Error(`有 ${outcome.errors.length} 个文件没能挂上：${outcome.errors.join('；')}`)
        );
      }
      return outcome.detail.attachments.length;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  async removeAttachment(rel: string, attachment: string): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      const detail = await knowledgeServices.client.cardAttachmentRemove(name, rel, attachment);
      const cards = await knowledgeServices.client.cards(name);
      this.set({ cards, detail, selectedRel: detail.rel });
    } catch (e) {
      this.fail(e);
    }
  }

  async openAttachment(rel: string, attachment: string): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      await knowledgeServices.client.cardAttachmentOpen(name, rel, attachment);
    } catch (e) {
      this.fail(e);
    }
  }

  async createVault(name: string): Promise<void> {
    try {
      await knowledgeServices.client.createVault(name);
      await this.refreshVaults();
      await this.setActiveVault(name);
    } catch (e) {
      this.fail(e);
    }
  }

  async deleteVault(name: string): Promise<void> {
    try {
      await knowledgeServices.client.deleteVault(name);
      if (this.state.activeVault === name) {
        this.set({
          activeVault: null,
          cards: [],
          sources: [],
          dirs: [],
          currentDir: '',
          selectedRel: null,
          detail: null,
        });
      }
      await this.refreshVaults();
      const next = this.state.vaults[0]?.name ?? null;
      if (this.state.activeVault === null && next !== null) await this.setActiveVault(next);
    } catch (e) {
      this.fail(e);
    }
  }

  async revealVault(): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      await knowledgeServices.client.revealVault(name);
    } catch (e) {
      this.fail(e);
    }
  }

  setFilter(filter: KbFilter): void {
    this.set({ filter });
  }

  /** 搜索框：去抖后下推 SQL（250ms 是「打字停顿」和「不觉得卡」的折中） */
  setQuery(query: string): void {
    this.set({ query });
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      void this.runSearch();
    }, 250);
  }

  private async runSearch(): Promise<void> {
    const { activeVault, query } = this.state;
    if (activeVault === null) return;
    try {
      if (query.trim() === '') {
        this.set({ hits: null });
        return;
      }
      const hits = await knowledgeServices.client.search(activeVault, query);
      // 迟到的搜索结果不许覆盖新一轮的输入
      if (this.state.query !== query) return;
      this.set({ hits });
    } catch (e) {
      this.fail(e);
    }
  }

  async selectCard(rel: string | null): Promise<void> {
    if (rel === null) {
      this.set({ selectedRel: null, detail: null });
      return;
    }
    const name = this.state.activeVault;
    if (name === null) return;
    this.set({ selectedRel: rel, detailLoading: true });
    try {
      const detail = await knowledgeServices.client.cardRead(name, rel);
      if (this.state.selectedRel !== rel) return; // 已经点去别处了
      this.set({ detail, detailLoading: false });
    } catch (e) {
      this.set({ detailLoading: false });
      this.fail(e);
    }
  }

  /** 按标题找一张卡（wikilink 点击）。找不到返回 null —— 调用方给断链提示 */
  cardByTitle(title: string): CardRow | null {
    const t = title.trim().toLowerCase();
    return this.state.cards.find((c) => c.title.trim().toLowerCase() === t) ?? null;
  }

  async setStatus(rel: string, status: 'unreviewed' | 'reviewed'): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      await knowledgeServices.client.cardSetStatus(name, rel, status);
      this.patchCardLocal(rel, { status });
    } catch (e) {
      this.fail(e);
    }
  }

  /** 「标为已评审 → 自动跳下一张未评审」——评审工作流的主按钮 */
  async markReviewedAndNext(rel: string): Promise<void> {
    // ⚠️ 「下一张」按**翻转前的浏览序**找：列表把未评审排前面，标记完之后
    // 这张会沉到已评审那一段里 —— 拿翻转后的序去找，永远找不到「后面」
    //（e2e 抓过一次：带「（续）」的那张明明在，跳过去的却是卡片墙）
    const orderBefore = this.visible();
    await this.setStatus(rel, 'reviewed');
    const next = nextUnreviewed(orderBefore, rel);
    await this.selectCard(next);
  }

  async setArchived(rel: string, archived: boolean): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      await knowledgeServices.client.cardSetArchived(name, rel, archived);
      this.patchCardLocal(rel, { archived });
      // 归档之后多半不该还开着（默认筛选里它会消失）
      if (this.state.selectedRel === rel && archived) {
        this.set({ selectedRel: null, detail: null });
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private patchCardLocal(
    rel: string,
    patch: Partial<Pick<CardRow, 'status' | 'archived'>>
  ): void {
    const cards = this.state.cards.map((c) => (c.rel === rel ? { ...c, ...patch } : c));
    const detail =
      this.state.detail !== null && this.state.detail.rel === rel
        ? { ...this.state.detail, ...patch }
        : this.state.detail;
    // 命中集也同步（搜索着的时候列表以它为准）
    const hits =
      this.state.hits === null
        ? null
        : {
            cards: this.state.hits.cards.map((c) => (c.rel === rel ? { ...c, ...patch } : c)),
            sources: this.state.hits.sources,
          };
    this.set({ cards, detail, hits });
  }

  async deleteCard(rel: string): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      await knowledgeServices.client.cardDelete(name, rel);
      if (this.state.selectedRel === rel) this.set({ selectedRel: null, detail: null });
      await this.reloadCardsOnly();
    } catch (e) {
      this.fail(e);
    }
  }

  private async reloadCardsOnly(): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      const cards = await knowledgeServices.client.cards(name);
      this.set({ cards });
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * 挂资料（可多选）。返回这次的结果（取消给 null）——UI 拿它决定要不要
   * 自动开生成面板。单个文件失败不打断整批，失败原因走上层错误条。
   */
  async addSource(): Promise<SourceAddOutcome | null> {
    const name = this.state.activeVault;
    if (name === null) return null;
    try {
      const outcome = await knowledgeServices.client.sourceAdd(name);
      if (outcome !== null) {
        const sources = await knowledgeServices.client.sources(name);
        this.set({ sources });
        if (outcome.errors.length > 0) {
          this.shell?.reportError(
            new Error(
              `有 ${outcome.errors.length} 个文件没能挂上：${outcome.errors.join('；')}`,
            ),
          );
        }
      }
      return outcome;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** 删原件；`deleteGenerated` 的强确认在 UI 层做。返回连带删掉的卡片数 */
  async deleteSource(rel: string, deleteGenerated: boolean): Promise<number> {
    const name = this.state.activeVault;
    if (name === null) return 0;
    try {
      const removed = await knowledgeServices.client.sourceDelete(name, rel, deleteGenerated);
      await this.syncAndReload();
      return removed;
    } catch (e) {
      this.fail(e);
      return 0;
    }
  }

  /**
   * 重新提取一份资料的图片（v0.18.0 之前上传的来源没有抽过图）。
   * 结果用外壳状态栏说清楚 —— 抽到几张、或者为什么一张都没有。
   */
  async reextractSource(rel: string): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    try {
      const row = await knowledgeServices.client.sourceReextract(name, rel);
      const sources = await knowledgeServices.client.sources(name);
      this.set({ sources });
      const count = row.images.length;
      this.shell?.setStatus(
        count > 0
          ? `重新提取完成：${count} 张图`
          : row.imageNote || '没有找到可提取的图片',
      );
    } catch (e) {
      this.fail(e);
    }
  }

  async generate(sourceRels: string[], cli: string, note: string): Promise<void> {
    const name = this.state.activeVault;
    if (name === null) return;
    this.set({ gen: { sourceRels, runId: null, notes: [], done: null, error: null } });
    try {
      const outcome = await knowledgeServices.client.generate(name, sourceRels, cli, note, (ev) => {
        const gen = this.state.gen;
        if (gen === null) return;
        this.set({
          gen: {
            ...gen,
            runId: ev.runId ?? gen.runId,
            notes: [...gen.notes.slice(-40), ev.note],
          },
        });
      });
      const gen = this.state.gen;
      this.set({ gen: gen === null ? null : { ...gen, done: outcome.cards.length } });
      await this.syncAndReload();
    } catch (e) {
      const gen = this.state.gen;
      const message = describeError(e);
      // ⚠️ 失败**不进外壳错误条**，留在生成面板里 —— 那里的 notes 是有上下文
      // 的现场（跑到哪一步挂的），弹到全局反而丢了上下文
      this.set({ gen: gen === null ? null : { ...gen, error: message } });
    }
  }

  /** 读一张图片（卡片阅读器内嵌显示用）；失败交给 `ImageEmbed` 回落角标。 */
  async readFile(target: string): Promise<ArrayBuffer> {
    const name = this.state.activeVault;
    if (name === null) throw new Error('没有打开的知识库');
    return await knowledgeServices.client.fileRead(name, target);
  }

  async cancelGenerate(): Promise<void> {
    const { activeVault, gen } = this.state;
    if (activeVault === null || gen === null || gen.runId === null) return;
    try {
      await knowledgeServices.client.cancelGenerate(activeVault, gen.runId);
      this.set({ gen: { ...gen, error: '已取消' } });
    } catch (e) {
      this.fail(e);
    }
  }

  dismissGen(): void {
    this.set({ gen: null });
  }
}

export const knowledgeStore = new KnowledgeStore();
