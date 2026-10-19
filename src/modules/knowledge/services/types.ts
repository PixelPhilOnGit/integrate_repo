/**
 * 知识库的服务层契约：前端 ↔ 命令层（tauri 实现）/ 假实现（浏览器版）。
 *
 * 字段名和 Rust 侧的 serde 输出一一对应（那边 `rename_all = "camelCase"`）。
 * 改这里 = 同时改 `kb_commands.rs` 的对应结构体。
 */

/** 一个知识库（vault）。`name` 是身份：命令层的参数只认它 */
export interface VaultInfo {
  name: string;
  cardCount: number;
  sourceCount: number;
}

/** 索引里的一张卡片（列表/搜索用；正文只带摘要） */
export interface CardRow {
  rel: string;
  title: string;
  status: 'unreviewed' | 'reviewed';
  archived: boolean;
  created: string;
  tags: string[];
  /** 关联的上传原件（`_sources/…`） */
  sources: string[];
  excerpt: string;
  mtime: number;
  size: number;
}

/** 一张卡片的完整内容（读的是**文件**，不是索引） */
export interface CardDetail {
  rel: string;
  title: string;
  status: 'unreviewed' | 'reviewed';
  archived: boolean;
  created: string;
  tags: string[];
  sources: string[];
  body: string;
}

/** 从一份资料里抽出来的图片 */
export interface SourceImage {
  /** vault 相对路径（`_files/<来源名>-img-<n>.<ext>`）—— 卡片里的 target */
  rel: string;
  /** 给人看的原始名字（PDF 用「第 N 页」，docx 用 zip 里的文件名） */
  originalName: string;
  page: number | null;
}

/** 一份上传的原件 */
export interface SourceRow {
  rel: string;
  name: string;
  byteSize: number;
  /** ok = 提取成功；none = 没有文本可提（图片）；failed = 提取失败 */
  extractStatus: 'ok' | 'none' | 'failed';
  created: string;
  /** 上传时抽到 `_files/` 的图片 */
  images: SourceImage[];
  /** 图片抽取的一句人话说明（空串 = 没什么要说的） */
  imageNote: string;
}

/** 一次（可多选的）上传结果 */
export interface SourceAddOutcome {
  added: SourceRow[];
  /** 单个文件的失败原因（其余文件照常入库） */
  errors: string[];
}

/** 一次生成 run 的账 */
export interface RunRow {
  id: string;
  /** 第一份资料（兼容旧字段） */
  sourceRel: string;
  /** 这一次用到的全部资料 */
  sourceRels: string[];
  cli: 'claude' | 'codex';
  status: 'running' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  usage: string | null;
  startedAt: number;
  finishedAt: number | null;
  cardCount: number;
}

export interface SearchHits {
  cards: CardRow[];
  sources: SourceRow[];
}

export interface ReindexReport {
  scanned: number;
  updated: number;
  removed: number;
  failed: number;
}

export interface GenEvent {
  note: string;
  /**
   * 第一条事件带上 runId —— 调用方在 generate 开始之前无从知晓它，
   * 而「取消」需要它（点对点找那次 run）。
   */
  runId?: string;
}

export interface GenOutcome {
  runId: string;
  cards: CardRow[];
}

export interface CliProbe {
  claude: string | null;
  codex: string | null;
}

/**
 * 生成进度的订阅口。
 *
 * tauri 实现在命令层用 `Channel` 推事件；假实现（浏览器）直接同步回调 ——
 * 两边对调用方是同一种形状（和 agents 的 onEvent 一个套路）。
 */
export type GenListener = (event: GenEvent) => void;

export interface KnowledgeClient {
  vaults(): Promise<VaultInfo[]>;
  createVault(name: string): Promise<void>;
  deleteVault(name: string): Promise<void>;
  revealVault(name: string): Promise<void>;
  /** 按磁盘重建索引（增量）。激活模块/生成完/手点「同步」时调 */
  sync(name: string): Promise<ReindexReport>;

  cards(name: string): Promise<CardRow[]>;
  cardRead(name: string, rel: string): Promise<CardDetail>;
  cardSetStatus(name: string, rel: string, status: string): Promise<void>;
  cardSetArchived(name: string, rel: string, archived: boolean): Promise<void>;
  cardDelete(name: string, rel: string): Promise<void>;

  search(name: string, query: string): Promise<SearchHits>;

  sources(name: string): Promise<SourceRow[]>;
  /**
   * 挂资料（可多选）；用户取消返回 null。
   * 单个文件失败不打断整批 —— 看返回里的 `errors`。
   */
  sourceAdd(name: string): Promise<SourceAddOutcome | null>;
  /** 删原件；`deleteGenerated` = 连它生成的卡片一起删。返回连带删掉的卡片数 */
  sourceDelete(name: string, rel: string, deleteGenerated: boolean): Promise<number>;

  /**
   * 跑一次生成（可多份资料）；进度走 `onEvent`（**第一条事件带 runId**）。
   */
  generate(
    name: string,
    sourceRels: string[],
    cli: string,
    note: string,
    onEvent: GenListener
  ): Promise<GenOutcome>;
  cancelGenerate(name: string, runId: string): Promise<void>;
  runs(name: string, sourceRel: string): Promise<RunRow[]>;

  /** 读图片字节（卡片阅读器内嵌显示用）。target 可以是 `_files/…` 或裸文件名 */
  fileRead(name: string, target: string): Promise<ArrayBuffer>;

  cliProbe(): Promise<CliProbe>;
}
