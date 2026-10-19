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

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use devtoolkit_knowledge::blocks;
use devtoolkit_knowledge::extract::{self, ExtractOutcome};
use devtoolkit_knowledge::images;
use devtoolkit_knowledge::mapping;
use devtoolkit_knowledge::frontmatter::Frontmatter;
use devtoolkit_knowledge::index::{
    reindex, CardRow, Index, ReindexReport, RunRow, SourceImage, SourceRecord, SourceRow,
};
use devtoolkit_knowledge::prompt::{self, PromptInput, PromptSource, RelatedCard, RELATED_LIMIT};
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

    /// 放掉全部打开的句柄（切场景时由 `scenario_set` 调）。
    /// 句柄里的 vault 根目录是**带场景**的，不清的话切完会拿着旧场景的库用。
    pub fn reset_open(&self) {
        if let Ok(mut open) = self.open.lock() {
            open.clear();
        }
    }
}

/// vault 根目录（惰性求；**路径的唯一来源**）。
///
/// 按**场景**分卷：默认场景是 `knowledge/`（老路径零迁移），具名场景是
/// `knowledge/@<名字>/` —— `@` 前缀保证和 vault 名撞不上（vault 名校验禁 `@`）。
/// 切换场景时 `KbState.open` 会被清空（`scenario_set` 里），句柄不会拿旧的用。
fn vaults_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
    let suffix = crate::scenario_commands::suffix();
    Ok(if suffix.is_empty() {
        data.join("knowledge")
    } else {
        data.join("knowledge").join(suffix)
    })
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

/// 一次上传的结果：成功的条目 + 单个文件的失败原因。
///
/// ⚠️ **单个文件失败不打断整批**（用户一次选了十个，不能因为第九个坏了
/// 把前八个也吞掉）。取消整个对话框返回 `Ok(None)`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAddOutcome {
    pub added: Vec<SourceRow>,
    pub errors: Vec<String>,
}

/// 挂资料（**可多选**）：对话框开在 Rust 侧、原件拷进 `_sources/`、现场提取
/// 文本和图片。
///
/// 取消返回 `Ok(None)`。单个文件提取失败**不当作挂载失败**（文件已经拷进来了，
/// 状态记 failed，生成时会说清楚）；图片抽不出来也不影响入库。
#[tauri::command]
pub async fn kb_source_add(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<KbState>>,
    name: String,
) -> Result<Option<SourceAddOutcome>, String> {
    // 对话框（照 task_commands.rs 的挂附件先例：channel(1) 当 oneshot 用）
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("选资料挂进这个知识库（可以多选）")
        .set_parent(&window)
        .pick_files(move |picked| {
            let paths = picked.map(|list| {
                list.into_iter()
                    .filter_map(|p| p.simplified().into_path().ok())
                    .collect::<Vec<_>>()
            });
            let _ = tx.try_send(paths);
        });
    let picked = rx
        .recv()
        .await
        .ok_or_else(|| "选文件的对话框没能开起来（主线程忙不过来？）".to_string())?;
    let Some(paths) = picked else {
        return Ok(None);
    };
    if paths.is_empty() {
        return Ok(None);
    }

    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let mut added = Vec::new();
        let mut errors = Vec::new();
        for src in paths {
            match add_one_source(&h, &src) {
                Ok(row) => added.push(row),
                Err(e) => errors.push(format!("{}：{e}", src.display())),
            }
        }
        Ok(Some(SourceAddOutcome { added, errors }))
    })
    .await
}

/// 挂一个文件：拷贝 → 文本提取 → 图片提取（落 `_files/`）→ 入库。
fn add_one_source(h: &VaultHandle, src: &Path) -> Result<SourceRow, String> {
    let file_name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "选的东西没有文件名".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // ⚠️ 批量上传同一毫秒的同名文件不能互相覆盖。
    let stored = h
        .vault
        .unique_source_stored_name(stamp, &sanitize_source_name(&file_name));
    let rel = format!("{SOURCES_DIR}/{stored}");
    let dest = h.vault.source_path(&stored);

    // 拷而不引用（老规矩：原文件挪走/删掉都不影响）
    let same = std::fs::canonicalize(src).ok() == std::fs::canonicalize(&dest).ok();
    if !same {
        std::fs::copy(src, &dest).map_err(|e| format!("拷进来失败了（{e}）"))?;
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

    // 图片：上传时就抽到 `_files/`（生成前就能显示、删除来源能精确清理）。
    // ⚠️ 抽图失败**不让上传失败** —— 记一句说明就好。
    let (images, image_note) = match images::extract_images(&dest, &ext) {
        Ok(set) => {
            let stem = images::source_stem(&stored);
            let mut saved = Vec::new();
            for (index, image) in set.images.iter().enumerate() {
                let file_rel = images::image_rel(&stem, index + 1, &image.ext);
                h.vault
                    .write_file(&file_rel, &image.bytes)
                    .map_err(|e| format!("图片存不进库（{e}）"))?;
                saved.push(SourceImage {
                    rel: file_rel,
                    original_name: image.original_name.clone(),
                    page: image.page,
                });
            }
            (saved, set.note)
        }
        Err(e) => (Vec::new(), format!("图片没有提取：{e}")),
    };

    let created = timefmt::now_iso();
    index_of(h)
        .upsert_source(&SourceRecord {
            rel: &rel,
            name: &file_name,
            byte_size: size,
            extract_status: status,
            extracted: &extracted,
            images: &images,
            image_note: &image_note,
            created: &created,
        })
        .map_err(|e| e.to_string())?;

    Ok(SourceRow {
        rel,
        name: file_name,
        byte_size: size,
        extract_status: status.to_string(),
        created,
        images,
        image_note,
    })
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
        // 先记下这份来源抽出来的图片（删行之后就查不到了）
        let source = idx.source(&rel).map_err(|e| e.to_string())?;

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

        // 连卡片一起删 → 这个来源抽出来的图片也没有存在意义了（尽力删，
        // 文件不在不算错）。保留卡片时**不动图片** —— 卡片还在引用它们。
        if delete_generated {
            if let Some(source) = &source {
                for image in &source.images {
                    let _ = h.vault.delete_file(&image.rel);
                }
            }
        }
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

/// 跑一次生成：读**一份或多份**资料 →（查相关的旧卡片）→ 组提示词 → 跑 CLI →
/// 解析校验 → 改写图片引用 → 写卡片文件 → 更新索引 → 记 run。
///
/// 多份资料允许模型把内容**综合进同一张卡**，每张卡的 `sources` 由模型标注
/// （缺省 = 本次全部资料）。进度走 `channel`（一句一句的 Note）；成败走返回值。
#[tauri::command]
pub async fn kb_generate(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    source_rels: Vec<String>,
    cli: String,
    note: String,
    channel: Channel<GenEvent>,
) -> Result<GenOutcome, String> {
    static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

    let cli = Cli::parse(&cli).ok_or_else(|| format!("不认识这个 CLI：{cli}"))?;
    let handle = handle_of(state.inner(), &app, &name)?;

    // 去重保序 + 数量/存在性校验（顺序就是提示词里的 S1..Sn）
    let mut rels: Vec<String> = Vec::new();
    for rel in source_rels {
        if !rels.contains(&rel) {
            rels.push(rel);
        }
    }
    if rels.is_empty() {
        return Err("先选至少一份资料".to_string());
    }
    if rels.len() > prompt::MAX_SOURCES {
        return Err(format!("一次最多整理 {} 份资料", prompt::MAX_SOURCES));
    }

    let sources: Vec<SourceRow> = {
        let idx = index_of(&handle);
        let mut out = Vec::with_capacity(rels.len());
        for rel in &rels {
            let source = idx
                .source(rel)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("这份资料不在库里：{rel}"))?;
            out.push(source);
        }
        out
    };

    // 编号：资料 S1..Sn、图片 I1..Im（全局连续）
    let (source_bindings, image_bindings) = mapping::build_bindings(&sources);

    // 每份资料的提取结果 + 绝对路径 + 属于它的图片
    let mut extract_outcomes: Vec<ExtractOutcome> = Vec::with_capacity(sources.len());
    let mut abs_paths: Vec<String> = Vec::with_capacity(sources.len());
    let mut images_by_source: Vec<Vec<mapping::ImageBinding>> = Vec::with_capacity(sources.len());
    {
        let idx = index_of(&handle);
        for source in &sources {
            let text = idx
                .source_extracted(&source.rel)
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            extract_outcomes.push(if text.trim().is_empty() {
                ExtractOutcome::None {
                    reason: "没有可用的提取文本（图片，或提取失败）".to_string(),
                }
            } else {
                ExtractOutcome::Text(text)
            });
            abs_paths.push(
                handle
                    .vault
                    .abs(&source.rel)
                    .map_err(|e| e.to_string())?
                    .display()
                    .to_string(),
            );
            images_by_source.push(
                image_bindings
                    .iter()
                    .filter(|image| image.source_rel == source.rel)
                    .cloned()
                    .collect(),
            );
        }
    }

    // 「查知识库」：有用户指示就用它；否则逐份资料名检索并去重。
    let related = {
        let idx = index_of(&handle);
        let queries: Vec<String> = if note.trim().is_empty() {
            sources
                .iter()
                .map(|s| {
                    s.name
                        .rsplit_once('.')
                        .map(|(stem, _)| stem.to_string())
                        .unwrap_or_else(|| s.name.clone())
                })
                .collect()
        } else {
            vec![note.clone()]
        };
        let mut out: Vec<RelatedCard> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        'outer: for query in queries {
            for card in idx.search(&query).map_err(|e| e.to_string())? {
                if out.len() >= RELATED_LIMIT {
                    break 'outer;
                }
                if seen.insert(card.rel.clone()) {
                    out.push(RelatedCard {
                        title: card.title,
                        excerpt: card.excerpt,
                        rel: card.rel,
                    });
                }
            }
        }
        out
    };

    let prompt_sources: Vec<PromptSource<'_>> = sources
        .iter()
        .enumerate()
        .map(|(index, source)| PromptSource {
            binding: &source_bindings[index],
            extract: &extract_outcomes[index],
            source_abs: &abs_paths[index],
            images: &images_by_source[index],
            image_note: &source.image_note,
        })
        .collect();
    let bundle = prompt::build(&PromptInput {
        sources: &prompt_sources,
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
        idx.insert_run(&run_id, &rels, cli.as_str(), "running", started_at)
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

    // 写卡片文件 + 索引。图片引用在这里统一改写成 `_files/<确定名>`；
    // 卡片的 sources 由模型标注的 S 编号解析成真实 rel。
    let (written, warnings) = crate::commands::blocking({
        let handle = Arc::clone(&handle);
        let usage = outcome.usage.clone();
        let run_id2 = run_id.clone();
        move || {
            let mut doc = doc;
            let mut warnings = mapping::rewrite_images(&mut doc, &image_bindings);
            let created = timefmt::now_iso();
            let mut rows: Vec<CardRow> = Vec::new();
            for card in &doc.cards {
                // 引用了某份资料的图片 → 自动把那资料并进 sources（否则删
                // 来源时卡片引用会悬空）。
                let extra = mapping::image_sources_in_card(card, &image_bindings);
                let (card_sources, mut source_warnings) = mapping::resolve_card_sources(
                    &card.sources,
                    &source_bindings,
                    &extra,
                );
                warnings.append(&mut source_warnings);

                let rel = unique_card_rel(&handle.vault, "", &card.title);
                let mut fm = Frontmatter::new(&card.title, &created);
                fm.tags = card.tags.clone();
                fm.sources = card_sources;
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
            Ok((rows, warnings))
        }
    })
    .await?;

    // 警告不静默：合并成一条事件发给用户（太多条就截断）。
    if !warnings.is_empty() {
        let shown = warnings.iter().take(5).cloned().collect::<Vec<_>>().join("；");
        let more = if warnings.len() > 5 {
            format!("（还有 {} 条）", warnings.len() - 5)
        } else {
            String::new()
        };
        let _ = channel.send(GenEvent {
            note: format!("提醒：{shown}{more}"),
            run_id: None,
        });
    }

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

/// 读一张图片的字节（卡片阅读器用）。
///
/// 参数只有 vault 名 + `target`（`_files/<文件名>` 或裸文件名）。绝对路径
/// 仍由 Rust 侧算 —— 和这个模块「参数表里没有路径」的立场一致。
/// 闸门在 `Vault::resolve_image_target` / `read_image`（单段、非软链、
/// canonicalize 归属、32 MiB 上限）。
#[tauri::command]
pub async fn kb_file_read(
    app: AppHandle,
    state: State<'_, Arc<KbState>>,
    name: String,
    target: String,
) -> Result<tauri::ipc::Response, String> {
    let state = Arc::clone(state.inner());
    crate::commands::blocking(move || {
        let h = handle_of(&state, &app, &name)?;
        let rel = h
            .vault
            .resolve_image_target(&target)
            .map_err(|e| e.to_string())?;
        let bytes = h
            .vault
            .read_image(&rel, MAX_IMAGE_READ)
            .map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

/// 单张图片的读取上限（和任务附件缩略图同一个量级）。
const MAX_IMAGE_READ: u64 = 32 * 1024 * 1024;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
