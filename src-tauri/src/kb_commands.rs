//! 知识库的 Tauri command。
//!
//! 和前几个模块的命令层一样**只做搬运**：真逻辑全在 `devtoolkit-knowledge`
//! 里（不依赖 tauri，能脱离 WebKit 跑测试）。这一层多出来两件事：
//! 把生成进度接上 `Channel`、以及维护「打开过的 vault 句柄」表。
//!
//! # 参数表里没有路径（老规矩）
//!
//! 前端传来传去的只有 **vault 名**和 **vault 内相对路径** —— 绝对路径一律
//! 由这里从 `app_data_dir()/knowledge` 算出来。上传原件的文件对话框也开在
//! Rust 侧（照 `task_commands.rs` 的挂附件先例），路径只活在 Rust 里。
//!
//! # 两把锁
//!
//! * `KbState.open`：vault 名 → 句柄。句柄里的索引是 `Mutex<Index>`
//!   （rusqlite 的 Connection 不是 Sync）。
//! * 句柄里的 `cancels`：runId → 取消开关。生成可以并发跑（各自一个 CLI
//!   进程），取消按 runId 点对点找。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use devtoolkit_knowledge::blocks;
use devtoolkit_knowledge::extract::{self, ExtractOutcome};
use devtoolkit_knowledge::frontmatter::Frontmatter;
use devtoolkit_knowledge::index::{reindex, CardRow, Index, ReindexReport, RunRow, SourceRow};
use devtoolkit_knowledge::prompt::{self, PromptInput, RelatedCard, RELATED_LIMIT};
use devtoolkit_knowledge::runner::{self, Cli, Progress, RunSpec};
use devtoolkit_knowledge::timefmt;
use devtoolkit_knowledge::vault::{self, unique_card_rel, Vault, SOURCES_DIR};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt as _;

/// 生成的默认超时（十分钟：长文档的整理够用，超了就是出事了）。
const GENERATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// 一个打开的知识库句柄。
struct VaultHandle {
    vault: Vault,
    /// ⚠️ rusqlite 的 Connection 不是 Sync —— 一把锁串行化全部索引操作。
    /// 索引操作都是毫秒级的小查询，锁竞争不是问题。
    index: Mutex<Index>,
    /// runId → 取消开关
    cancels: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

pub struct KbState {
    open: Mutex<HashMap<String, Arc<VaultHandle>>>,
}

impl KbState {
    pub fn new() -> Self {
        KbState {
            open: Mutex::new(HashMap::new()),
        }
    }
}

/// vault 根目录（惰性求；**路径的唯一来源**）。
fn vaults_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
    Ok(data.join("knowledge"))
}

/// vault 名的白名单：中文/字母/数字/`-`/`_`/空格，1..=48 个字符，
/// **不以点开头**（免得和隐藏目录搅在一起）。
fn vault_name_ok(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= 48
        && !trimmed.starts_with('.')
        && trimmed
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || !c.is_ascii())
}

fn handle_of(
    state: &KbState,
    app: &AppHandle,
    name: &str,
) -> Result<Arc<VaultHandle>, String> {
    let name = name.trim().to_string();
    if !vault_name_ok(&name) {
        return Err(format!("知识库名字不合法：{name}"));
    }
    {
        let open = state.open.lock().unwrap();
        if let Some(h) = open.get(&name) {
            return Ok(Arc::clone(h));
        }
    }
    let root = vaults_root(app)?.join(&name);
    let vault = Vault::open(&root).map_err(|e| e.to_string())?;
    vault.ensure_layout().map_err(|e| e.to_string())?;
    let index = Index::open(&vault.index_db_path()).map_err(|e| e.to_string())?;
    let handle = Arc::new(VaultHandle {
        vault,
        index: Mutex::new(index),
        cancels: Mutex::new(HashMap::new()),
    });
    state
        .open
        .lock()
        .unwrap()
        .insert(name, Arc::clone(&handle));
    Ok(handle)
}

fn index_of(h: &VaultHandle) -> std::sync::MutexGuard<'_, Index> {
    h.index.lock().unwrap()
}

// ------------------------------------------------------------------ 知识库

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub name: String,
    pub card_count: usize,
    pub source_count: usize,
}

/// 列出所有知识库（扫根目录下的目录）。
#[tauri::command]
pub async fn kb_vaults(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
) -> Result<Vec<VaultInfo>, String> {
    let root = vaults_root(&app)?;
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            names.push(name);
        }
    }
    names.sort();

    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let mut out = Vec::new();
        for name in names {
            // 数不出来就当 0（索引还没建 / 打不开）——列表页不该因为一个坏库炸
            let (card_count, source_count) = match handle_of(&state, &app, &name) {
                Ok(h) => {
                    let idx = index_of(&h);
                    (
                        idx.list_cards().map(|c| c.len()).unwrap_or(0),
                        idx.list_sources().map(|s| s.len()).unwrap_or(0),
                    )
                }
                Err(_) => (0, 0),
            };
            out.push(VaultInfo {
                name,
                card_count,
                source_count,
            });
        }
        Ok(out)
    })
    .await
}

/// 新建一个知识库（目录 + 布局）。
#[tauri::command]
pub async fn kb_vault_create(app: AppHandle, name: String) -> Result<(), String> {
    if !vault_name_ok(&name) {
        return Err(format!("知识库名字不合法：{name}"));
    }
    let root = vaults_root(&app)?.join(name.trim());
    crate::commands::blocking(move || Vault::create(&root).map(|_| ()).map_err(|e| e.to_string()))
        .await
}

/// 删除一个知识库（**连目录一起**，前端做强确认）。句柄表里的那份也放掉。
#[tauri::command]
pub async fn kb_vault_delete(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
) -> Result<(), String> {
    if !vault_name_ok(&name) {
        return Err(format!("知识库名字不合法：{name}"));
    }
    state.open.lock().unwrap().remove(name.trim());
    let root = vaults_root(&app)?.join(name.trim());
    crate::commands::blocking(move || {
        if !root.is_dir() {
            return Err(format!("知识库不存在：{}", root.display()));
        }
        std::fs::remove_dir_all(&root).map_err(|e| format!("删不掉（{e}）——有没有文件正被别处占着？"))
    })
    .await
}

/// 在系统文件管理器里打开这个知识库（让用户拿走/浏览自己的 md）。
#[tauri::command]
pub async fn kb_vault_reveal(app: AppHandle, name: String) -> Result<(), String> {
    if !vault_name_ok(&name) {
        return Err(format!("知识库名字不合法：{name}"));
    }
    let root = vaults_root(&app)?.join(name.trim());
    if !root.is_dir() {
        return Err(format!("知识库不存在：{}", root.display()));
    }
    crate::open::open_path(&root)
}

/// 同步：按磁盘重建索引（增量）。模块激活、生成完、用户手点都走它。
#[tauri::command]
pub async fn kb_sync(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
) -> Result<ReindexReport, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let report = reindex(&h.vault, &index_of(&h)).map_err(|e| e.to_string())?;
        Ok(report)
    })
    .await
}

// ------------------------------------------------------------------ 卡片

/// 全部卡片（侧栏/卡片墙）。
#[tauri::command]
pub async fn kb_cards(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
) -> Result<Vec<CardRow>, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let cards = index_of(&h).list_cards().map_err(|e| e.to_string())?;
        Ok(cards)
    })
    .await
}

/// 一张卡片的**文件内容**（真相在文件里：索引只有摘要）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDetail {
    pub rel: String,
    pub title: String,
    pub status: String,
    pub archived: bool,
    pub created: String,
    pub tags: Vec<String>,
    pub sources: Vec<String>,
    pub body: String,
}

#[tauri::command]
pub async fn kb_card_read(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    rel: String,
) -> Result<CardDetail, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let (fm, body) = h.vault.read_card(&rel).map_err(|e| e.to_string())?;
        let title = if fm.title.trim().is_empty() {
            rel.rsplit('/')
                .next()
                .unwrap_or(&rel)
                .trim_end_matches(".md")
                .to_string()
        } else {
            fm.title.clone()
        };
        Ok(CardDetail {
            rel,
            title,
            status: fm.status.as_str().to_string(),
            archived: fm.archived,
            created: fm.created,
            tags: fm.tags,
            sources: fm.sources,
            body,
        })
    })
    .await
}

/// 改状态/归档：**读文件 → 改 frontmatter → 写回 → 更新索引**（文件是真相）。
async fn patch_card(
    app: AppHandle,
    state: Arc<KbState>,
    name: String,
    rel: String,
    change: impl FnOnce(&mut Frontmatter) + Send + 'static,
) -> Result<(), String> {
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let (mut fm, body) = h.vault.read_card(&rel).map_err(|e| e.to_string())?;
        change(&mut fm);
        h.vault
            .write_card(&rel, &fm, &body)
            .map_err(|e| e.to_string())?;
        // 索引行跟着动（title 兜底和重建同口径）
        let title = if fm.title.trim().is_empty() {
            rel.rsplit('/')
                .next()
                .unwrap_or(&rel)
                .trim_end_matches(".md")
                .to_string()
        } else {
            fm.title.clone()
        };
        let meta = std::fs::metadata(h.vault.root().join(&rel)).ok();
        let row = CardRow {
            rel: rel.clone(),
            title,
            status: fm.status.as_str().to_string(),
            archived: fm.archived,
            created: fm.created.clone(),
            tags: fm.tags.clone(),
            sources: fm.sources.clone(),
            excerpt: String::new(),
            mtime: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            size: meta.map(|m| m.len()).unwrap_or(0),
        };
        let done = index_of(&h).upsert_card(&row, &body).map_err(|e| e.to_string());
        done
    })
    .await
}

#[tauri::command]
pub async fn kb_card_set_status(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    rel: String,
    status: String,
) -> Result<(), String> {
    let parsed = devtoolkit_knowledge::frontmatter::CardStatus::parse(&status);
    patch_card(app, Arc::clone(state.inner()), name, rel, move |fm| {
        fm.status = parsed;
    })
    .await
}

#[tauri::command]
pub async fn kb_card_set_archived(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    rel: String,
    archived: bool,
) -> Result<(), String> {
    patch_card(app, Arc::clone(state.inner()), name, rel, move |fm| {
        fm.archived = archived;
    })
    .await
}

/// 删除一张卡片（文件 + 索引行）。
#[tauri::command]
pub async fn kb_card_delete(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    rel: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        h.vault.delete_card(&rel).map_err(|e| e.to_string())?;
        let done = index_of(&h).remove_card(&rel).map_err(|e| e.to_string());
        done
    })
    .await
}

// ------------------------------------------------------------------ 搜索

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHits {
    pub cards: Vec<CardRow>,
    pub sources: Vec<SourceRow>,
}

#[tauri::command]
pub async fn kb_search(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    query: String,
) -> Result<SearchHits, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let idx = index_of(&h);
        if query.trim().is_empty() {
            return Ok(SearchHits {
                cards: idx.list_cards().map_err(|e| e.to_string())?,
                sources: idx.list_sources().map_err(|e| e.to_string())?,
            });
        }
        Ok(SearchHits {
            cards: idx.search(&query).map_err(|e| e.to_string())?,
            sources: idx.search_sources(&query).map_err(|e| e.to_string())?,
        })
    })
    .await
}

// ------------------------------------------------------------------ 来源

#[tauri::command]
pub async fn kb_sources(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
) -> Result<Vec<SourceRow>, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let sources = index_of(&h).list_sources().map_err(|e| e.to_string())?;
        Ok(sources)
    })
    .await
}

/// 挂一份原件：**对话框开在 Rust 侧**、原件拷进 `_sources/`、现场提取文本。
///
/// 取消返回 `Ok(None)`。提取失败**不当作挂载失败**（文件已经拷进来了，
/// 状态记 failed，生成时会说清楚）。
#[tauri::command]
pub async fn kb_source_add(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<KbState>>,
    name: String,
) -> Result<Option<SourceRow>, String> {
    // 对话框（照 task_commands.rs 的挂附件先例：channel(1) 当 oneshot 用）
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("选一份资料挂进这个知识库")
        .set_parent(&window)
        .pick_file(move |picked| {
            let path = picked
                .map(|p| p.simplified())
                .and_then(|p| p.into_path().ok());
            let _ = tx.try_send(path);
        });
    let picked = rx
        .recv()
        .await
        .ok_or_else(|| "选文件的对话框没能开起来（主线程忙不过来？）".to_string())?;
    let Some(src) = picked else {
        return Ok(None);
    };

    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let file_name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "选的东西没有文件名".to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let stored = format!("{stamp}_{}", sanitize_source_name(&file_name));
        let rel = format!("{SOURCES_DIR}/{stored}");
        let dest = h.vault.source_path(&stored);

        // 拷而不引用（老规矩：原文件挪走/删掉都不影响）
        let same = std::fs::canonicalize(&src).ok() == std::fs::canonicalize(&dest).ok();
        if !same {
            std::fs::copy(&src, &dest).map_err(|e| format!("拷进来失败了（{e}）"))?;
        }
        let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

        // 现场提取（图片给 None 不算失败）
        let ext = src
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let (status, extracted) = match extract::extract(&dest, &ext) {
            Ok(ExtractOutcome::Text(text)) => ("ok", text),
            Ok(ExtractOutcome::None { .. }) => ("none", String::new()),
            Err(_) => ("failed", String::new()),
        };

        let created = timefmt::now_iso();
        let idx = index_of(&h);
        idx.upsert_source(&rel, &file_name, size, status, &extracted, &created)
            .map_err(|e| e.to_string())?;
        Ok(Some(SourceRow {
            rel,
            name: file_name,
            byte_size: size,
            extract_status: status.to_string(),
            created,
        }))
    })
    .await
}

/// 文件名清洗（保留扩展名）：主名走卡片同一套规则，尾巴截短。
fn sanitize_source_name(name: &str) -> String {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !e.is_empty() && e.len() <= 10 => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let mut clean = vault::sanitize_card_name(stem);
    if clean == "卡片" && !stem.trim().is_empty() {
        clean = "文件".to_string(); // 兜底词别用「卡片」，这里不是卡片
    }
    format!("{clean}{ext}")
}

/// 删一份原件。`delete_generated` = 连它生出来的卡片一起删（用户选择）。
/// 返回连带删掉的卡片数。
#[tauri::command]
pub async fn kb_source_delete(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    rel: String,
    delete_generated: bool,
) -> Result<usize, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let idx = index_of(&h);

        let mut removed_cards = 0usize;
        if delete_generated {
            for card in idx.cards_of_source(&rel).map_err(|e| e.to_string())? {
                // 卡片文件删不掉不算错（可能已经被手删了）；索引行照清
                let _ = h.vault.delete_card(&card.rel);
                idx.remove_card(&card.rel).map_err(|e| e.to_string())?;
                removed_cards += 1;
            }
        } else {
            // 保留知识但断开链接：把卡片 frontmatter 里的这行来源摘掉
            //（断链提示留给「引用不存在的来源」那种手编情况，这里主动断干净）
            for card in idx.cards_of_source(&rel).map_err(|e| e.to_string())? {
                if let Ok((mut fm, body)) = h.vault.read_card(&card.rel) {
                    fm.sources.retain(|s| s != &rel);
                    if h.vault.write_card(&card.rel, &fm, &body).is_ok() {
                        let _ = idx.upsert_card(&card, &body);
                    }
                }
            }
        }

        // 原件文件 + 行
        let abs = h.vault.abs(&rel).map_err(|e| e.to_string())?;
        match std::fs::remove_file(&abs) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("原件的文件删不掉（{e}）")),
        }
        idx.remove_source(&rel).map_err(|e| e.to_string())?;
        Ok(removed_cards)
    })
    .await
}

// ------------------------------------------------------------------ 生成

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GenEvent {
    pub note: String,
    /// 第一条事件带上 runId（前端的「取消」需要它，而它在 generate 之前
    /// 无从知晓）—— 之后的进度事件不重复带
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenOutcome {
    pub run_id: String,
    pub cards: Vec<CardRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbe {
    pub claude: Option<String>,
    pub codex: Option<String>,
}

/// 两个 CLI 装没装（各自的 `--version`，并行探）。
#[tauri::command]
pub async fn kb_cli_probe() -> Result<CliProbe, String> {
    let (claude, codex) = tokio::join!(Cli::Claude.detect(), Cli::Codex.detect());
    let _ = (); // 留个形状：将来要加模型探测也在这
    Ok(CliProbe { claude, codex })
}

/// 跑一次生成：读原件提取文本 →（查相关的旧卡片）→ 组提示词 → 跑 CLI →
/// 解析校验 → 写卡片文件 → 更新索引 → 记 run。
///
/// 进度走 `channel`（一句一句的 Note）；成败走返回值。
#[tauri::command]
pub async fn kb_generate(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    source_rel: String,
    cli: String,
    note: String,
    channel: Channel<GenEvent>,
) -> Result<GenOutcome, String> {
    static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

    let cli = Cli::parse(&cli).ok_or_else(|| format!("不认识这个 CLI：{cli}"))?;
    let handle = handle_of(state.inner(), &app, &name)?;

    // 读来源（提取文本 + 展示名）
    let (source_name, extracted) = {
        let idx = index_of(&handle);
        let sources = idx.list_sources().map_err(|e| e.to_string())?;
        let source = sources
            .into_iter()
            .find(|s| s.rel == source_rel)
            .ok_or_else(|| format!("这份资料不在库里：{source_rel}"))?;
        let text = idx
            .source_extracted(&source_rel)
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        (source.name, text)
    };

    // 提取文本空了：要么是图片（直读原件），要么提取失败
    let source_abs = handle
        .vault
        .abs(&source_rel)
        .map_err(|e| e.to_string())?
        .display()
        .to_string();
    let extract_outcome = if extracted.trim().is_empty() {
        ExtractOutcome::None {
            reason: "没有可用的提取文本（图片，或提取失败）".to_string(),
        }
    } else {
        ExtractOutcome::Text(extracted)
    };

    // 「查知识库」：用用户指示（有的话）或资料名（去扩展名）当查询词，
    // 带相关的旧卡片进提示词
    let related = {
        let query = if note.trim().is_empty() {
            source_name
                .rsplit_once('.')
                .map(|(s, _)| s.to_string())
                .unwrap_or_else(|| source_name.clone())
        } else {
            note.clone()
        };
        let idx = index_of(&handle);
        idx.search(&query)
            .map_err(|e| e.to_string())?
            .into_iter()
            .take(RELATED_LIMIT)
            .map(|c| RelatedCard {
                title: c.title,
                excerpt: c.excerpt,
                rel: c.rel,
            })
            .collect::<Vec<_>>()
    };

    let bundle = prompt::build(&PromptInput {
        source_name: &source_name,
        extract: &extract_outcome,
        source_abs: &source_abs,
        related: &related,
        note: &note,
    });

    // run 记账 + 取消开关
    let run_id = format!(
        "run_{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        RUN_SEQ.fetch_add(1, Ordering::SeqCst)
    );
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    {
        let idx = index_of(&handle);
        idx.insert_run(&run_id, &source_rel, cli.as_str(), "running", started_at)
            .map_err(|e| e.to_string())?;
    }

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    handle
        .cancels
        .lock()
        .unwrap()
        .insert(run_id.clone(), cancel_tx);

    // 第一条事件先带 runId（前端拿它做取消）—— 就发在起进程之前
    let _ = channel.send(GenEvent {
        note: "开始生成".to_string(),
        run_id: Some(run_id.clone()),
    });

    let progress_channel = channel.clone();
    let progress = move |Progress(note): Progress| {
        let _ = progress_channel.send(GenEvent { note, run_id: None });
    };

    let outcome = runner::run(
        RunSpec {
            cli,
            program: None,
            prompt: bundle.prompt,
            read_files: bundle.read_files,
            timeout: GENERATE_TIMEOUT,
        },
        progress,
        cancel_rx,
    )
    .await;

    handle.cancels.lock().unwrap().remove(&run_id);

    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => {
            let msg = e.to_string();
            let _ = index_of(&handle).finish_run(
                &run_id,
                "failed",
                Some(&msg),
                None,
                0,
                now_ms(),
            );
            return Err(msg);
        }
    };

    // 解析 + 校验（失败也留 run 记录，原文放在 error 里给用户看）
    let doc = match blocks::parse_generated(&outcome.text).and_then(|d| {
        blocks::validate(&d)?;
        Ok(d)
    }) {
        Ok(d) => d,
        Err(e) => {
            let msg = e.to_string();
            let _ = index_of(&handle).finish_run(
                &run_id,
                "failed",
                Some(&msg),
                outcome.usage.as_deref(),
                0,
                now_ms(),
            );
            return Err(format!("{msg}。模型的原始输出已经留在这次生成记录里"));
        }
    };

    // 写卡片文件 + 索引
    let written = crate::commands::blocking({
        let handle = Arc::clone(&handle);
        let usage = outcome.usage.clone();
        let run_id2 = run_id.clone();
        move || {
            let created = timefmt::now_iso();
            let mut rows: Vec<CardRow> = Vec::new();
            for card in &doc.cards {
                let rel = unique_card_rel(&handle.vault, "", &card.title);
                let mut fm = Frontmatter::new(&card.title, &created);
                fm.tags = card.tags.clone();
                fm.sources = vec![source_rel.clone()];
                let body = blocks::blocks_to_markdown(&card.blocks);
                handle
                    .vault
                    .write_card(&rel, &fm, &body)
                    .map_err(|e| e.to_string())?;
                let meta = std::fs::metadata(handle.vault.root().join(&rel)).ok();
                let row = CardRow {
                    rel: rel.clone(),
                    title: card.title.clone(),
                    status: fm.status.as_str().to_string(),
                    archived: false,
                    created: created.clone(),
                    tags: card.tags.clone(),
                    sources: fm.sources.clone(),
                    excerpt: String::new(),
                    mtime: meta
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                    size: meta.map(|m| m.len()).unwrap_or(0),
                };
                index_of(&handle)
                    .upsert_card(&row, &body)
                    .map_err(|e| e.to_string())?;
                rows.push(row);
            }
            // 完成记账
            index_of(&handle)
                .finish_run(
                    &run_id2,
                    "done",
                    None,
                    usage.as_deref(),
                    rows.len() as i64,
                    now_ms(),
                )
                .map_err(|e| e.to_string())?;
            Ok(rows)
        }
    })
    .await?;

    let _ = channel.send(GenEvent {
        note: format!("写好了 {} 张卡片", written.len()),
        run_id: None,
    });
    Ok(GenOutcome {
        run_id,
        cards: written,
    })
}

/// 取消一次在跑的生成。
#[tauri::command]
pub async fn kb_generate_cancel(
    state: State<'_, Arc<KbState>>,
    name: String,
    run_id: String,
) -> Result<(), String> {
    let handle = state
        .open
        .lock()
        .unwrap()
        .get(name.trim())
        .map(Arc::clone)
        .ok_or_else(|| "这个知识库没有打开过".to_string())?;
    let sender = handle.cancels.lock().unwrap().remove(&run_id);
    match sender {
        Some(tx) => {
            let _ = tx.send(());
            Ok(())
        }
        None => Err("这一轮生成已经结束了".to_string()),
    }
}

/// 一份来源的生成历史。
#[tauri::command]
pub async fn kb_runs(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    source_rel: String,
) -> Result<Vec<RunRow>, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let runs = index_of(&h)
            .list_runs(&source_rel)
            .map_err(|e| e.to_string())?;
        Ok(runs)
    })
    .await
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
