//! 派生索引：卡片的搜索/筛选都查它，**但它随时可以重建**。
//!
//! # 为什么索引是派生的（而不是像任务那样当真相）
//!
//! 库的承诺是「文件是真相」（用户拍板的 Obsidian 形态）：卡片是 md，改内容的
//! 手可以是我们，也可以是用户自己开的 Obsidian。索引只是**为了快**——删掉
//! `index.db` 下次进模块全量重建，一条知识都不丢。所以这里的任何写失败都
//! 不该让界面报大错：重扫一遍就自愈。
//!
//! # 增量重建
//!
//! [`reindex`] 比对的依据是文件 **mtime + size**（两端任一变了就重解析）。
//! 卡片是文本文件，这个判据够便宜也够准；外部编辑器改了内容不动 mtime 那种
//! 病态情况（几乎不存在）留给「全量重建」兜底。
//!
//! # 全文搜索现在用 LIKE
//!
//! 用户原话是「metadata 索引方式，方便搜索内容」——v1 就是结构化列 + LIKE
//! （跨 title/tags/正文）。rusqlite 的 bundled 没开 FTS5，加那个 feature 会
//! 牵动全 workspace 的 libsqlite3-sys 编译，**单独论证**（HANDOFF 记了）。
//! 数据量到「LIKE 扫不动」的那天再上 FTS5，迁移链是现成的。

use std::collections::HashSet;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::KbError;
use crate::vault::{Vault, CARD_EXT};

/// 索引库的结构版本（`PRAGMA user_version`）。迁移照 tasks 的规矩：
/// **每一步都要能从任意旧版本跑上来**。
const SCHEMA_VERSION: i64 = 2;

/// 列表/搜索里带出来的摘要长度（正文前 N 个字符）
const EXCERPT_CHARS: usize = 200;

/// 索引里的一张卡片（列表/搜索用；正文只带摘要）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub rel: String,
    pub title: String,
    pub status: String,
    pub archived: bool,
    pub created: String,
    pub tags: Vec<String>,
    /// 正文摘要（卡片墙/搜索结果里显示）
    pub excerpt: String,
    /// 来自 frontmatter（卡片关联的上传原件，`_sources/…`）
    pub sources: Vec<String>,
    pub mtime: u64,
    pub size: u64,
}

/// 从一份资料里抽出来的图片（存索引，供提示词/UI/删除清理用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceImage {
    /// vault 相对路径（`_files/<来源名>-img-<n>.<ext>`）—— 也是卡片里的 target
    pub rel: String,
    /// 给人看的原始名字（PDF 用「第 N 页」，docx 用 zip 里的文件名）
    pub original_name: String,
    pub page: Option<u32>,
}

/// 索引里的一份上传原件。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub rel: String,
    pub name: String,
    pub byte_size: u64,
    pub extract_status: String,
    pub created: String,
    /// 上传时抽到 `_files/` 的图片
    pub images: Vec<SourceImage>,
    /// 图片抽取的一句人话说明（空串 = 没什么要说的）
    pub image_note: String,
}

/// upsert 一份来源用的借用形状（避免调用方构造一堆 String）。
pub struct SourceRecord<'a> {
    pub rel: &'a str,
    pub name: &'a str,
    pub byte_size: u64,
    pub extract_status: &'a str,
    pub extracted: &'a str,
    pub images: &'a [SourceImage],
    pub image_note: &'a str,
    pub created: &'a str,
}

/// 一次生成 run 的账（为「重新生成/看花费/排查」留在索引里）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    /// 第一份资料（兼容旧字段/旧查询）
    pub source_rel: String,
    /// 这一次用到的全部资料（按勾选顺序）
    pub source_rels: Vec<String>,
    pub cli: String,
    pub status: String,
    pub error: Option<String>,
    pub usage: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub card_count: i64,
}

pub struct Index {
    conn: Connection,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self, KbError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| KbError::io(parent.display().to_string(), e))?;
        }
        let conn = Connection::open(path)?;
        let idx = Index { conn };
        idx.migrate()?;
        Ok(idx)
    }

    pub fn open_in_memory() -> Result<Self, KbError> {
        let idx = Index {
            conn: Connection::open_in_memory()?,
        };
        idx.migrate()?;
        Ok(idx)
    }

    fn migrate(&self) -> Result<(), KbError> {
        self.conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let current: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(KbError::db(format!(
                "索引库比程序新（v{current} > v{SCHEMA_VERSION}）——升级 Devtoolkit 再打开"
            )));
        }
        if current < 1 {
            self.conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS cards (
                     rel TEXT PRIMARY KEY,
                     title TEXT NOT NULL,
                     status TEXT NOT NULL,
                     archived INTEGER NOT NULL DEFAULT 0,
                     created TEXT NOT NULL DEFAULT '',
                     tags TEXT NOT NULL DEFAULT '[]',
                     sources TEXT NOT NULL DEFAULT '[]',
                     body TEXT NOT NULL DEFAULT '',
                     mtime INTEGER NOT NULL DEFAULT 0,
                     size INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS sources (
                     rel TEXT PRIMARY KEY,
                     name TEXT NOT NULL,
                     byte_size INTEGER NOT NULL DEFAULT 0,
                     extract_status TEXT NOT NULL DEFAULT 'none',
                     extracted TEXT NOT NULL DEFAULT '',
                     created TEXT NOT NULL DEFAULT ''
                 );
                 CREATE TABLE IF NOT EXISTS runs (
                     id TEXT PRIMARY KEY,
                     source_rel TEXT NOT NULL,
                     cli TEXT NOT NULL,
                     status TEXT NOT NULL,
                     error TEXT,
                     usage TEXT,
                     started_at INTEGER NOT NULL,
                     finished_at INTEGER,
                     card_count INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source_rel);",
            )?;
        }
        if current < 2 {
            // v1 → v2：来源的图片清单 + run 的多来源。用 table_info 判断列是否
            // 已存在（半迁移之后再次启动不能炸）。**加列不重建表**。
            for (table, column, ddl) in [
                ("sources", "images", "ALTER TABLE sources ADD COLUMN images TEXT NOT NULL DEFAULT '[]'"),
                ("sources", "image_note", "ALTER TABLE sources ADD COLUMN image_note TEXT NOT NULL DEFAULT ''"),
                ("runs", "source_rels", "ALTER TABLE runs ADD COLUMN source_rels TEXT NOT NULL DEFAULT '[]'"),
            ] {
                if !self.has_column(table, column)? {
                    self.conn.execute_batch(ddl)?;
                }
            }

            // 回填：老 run 只有一份来源 → `source_rels = [source_rel]`。
            let stale: Vec<(String, String)> = {
                let mut stmt = self
                    .conn
                    .prepare("SELECT id, source_rel FROM runs WHERE source_rels = '[]'")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (id, source_rel) in stale {
                let json = serde_json::to_string(&[source_rel])
                    .map_err(|e| KbError::db(e.to_string()))?;
                self.conn
                    .execute("UPDATE runs SET source_rels = ?2 WHERE id = ?1", params![id, json])?;
            }
        }
        self.conn
            .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
        Ok(())
    }

    /// 表里有没有这一列（迁移的幂等判据）。
    fn has_column(&self, table: &str, column: &str) -> Result<bool, KbError> {
        let mut stmt = self.conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    // ------------------------------------------------------------------ 卡片

    /// 写一行卡片（重建/生成/状态变更都走它）。
    pub fn upsert_card(&self, c: &CardRow, body: &str) -> Result<(), KbError> {
        self.conn.execute(
            "INSERT INTO cards (rel, title, status, archived, created, tags, sources, body, mtime, size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(rel) DO UPDATE SET
               title=excluded.title, status=excluded.status, archived=excluded.archived,
               created=excluded.created, tags=excluded.tags, sources=excluded.sources,
               body=excluded.body, mtime=excluded.mtime, size=excluded.size",
            params![
                c.rel,
                c.title,
                c.status,
                c.archived as i32,
                c.created,
                serde_json::to_string(&c.tags).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&c.sources).unwrap_or_else(|_| "[]".to_string()),
                body,
                c.mtime as i64,
                c.size as i64,
            ],
        )?;
        Ok(())
    }

    pub fn remove_card(&self, rel: &str) -> Result<(), KbError> {
        self.conn
            .execute("DELETE FROM cards WHERE rel = ?1", params![rel])?;
        Ok(())
    }

    /// 全量列出（不进搜索；侧栏/卡片墙用）。按 title 排序交给前端（搜索命中要
    /// 按自己的规则排，排序口径放前端一处，免得两边漂）。
    pub fn list_cards(&self) -> Result<Vec<CardRow>, KbError> {
        let mut stmt = self.conn.prepare(
            "SELECT rel, title, status, archived, created, tags, sources, body, mtime, size
             FROM cards ORDER BY rel",
        )?;
        let rows = stmt
            .query_map([], row_to_card)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn card(&self, rel: &str) -> Result<Option<CardRow>, KbError> {
        self.conn
            .query_row(
                "SELECT rel, title, status, archived, created, tags, sources, body, mtime, size
                 FROM cards WHERE rel = ?1",
                params![rel],
                row_to_card,
            )
            .optional()
            .map_err(Into::into)
    }

    /// 全文搜索（LIKE）：title / tags 序列化串 / 正文。`q` 里的 `%`/`_`
    /// 按字面处理（转义）——用户搜「100%」不该变成通配符。
    pub fn search(&self, q: &str) -> Result<Vec<CardRow>, KbError> {
        let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let like = format!("%{escaped}%");
        let mut stmt = self.conn.prepare(
            "SELECT rel, title, status, archived, created, tags, sources, body, mtime, size
             FROM cards
             WHERE title LIKE ?1 ESCAPE '\\' OR tags LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\'
             ORDER BY rel",
        )?;
        let rows = stmt
            .query_map(params![like], row_to_card)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 某份原件「生出来的」卡片（删来源时的连带清理用）。
    pub fn cards_of_source(&self, source_rel: &str) -> Result<Vec<CardRow>, KbError> {
        // sources 列是 JSON 数组 —— LIKE 一把就够（值里带引号的精确匹配，
        // 比解析一遍 JSON 便宜，也不会因为手编出畸形 JSON 漏删）。
        // ⚠️ `_sources` 自带下划线（LIKE 的单字符通配符），必须转义。
        let like = format!("%\"{}\"%", escape_like(source_rel));
        let mut stmt = self.conn.prepare(
            "SELECT rel, title, status, archived, created, tags, sources, body, mtime, size
             FROM cards WHERE sources LIKE ?1 ESCAPE '\\'",
        )?;
        let rows = stmt
            .query_map(params![like], row_to_card)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 重建的增量判据：索引里这行的 (mtime, size)。
    pub fn card_meta(&self, rel: &str) -> Result<Option<(u64, u64)>, KbError> {
        let got: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT mtime, size FROM cards WHERE rel = ?1",
                params![rel],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(got.map(|(m, s)| (m as u64, s as u64)))
    }

    pub fn all_card_rels(&self) -> Result<Vec<String>, KbError> {
        let mut stmt = self.conn.prepare("SELECT rel FROM cards")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ------------------------------------------------------------------ 来源

    pub fn upsert_source(&self, s: &SourceRecord<'_>) -> Result<(), KbError> {
        let images = serde_json::to_string(s.images).map_err(|e| KbError::db(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO sources (rel, name, byte_size, extract_status, extracted, created,
                                  images, image_note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(rel) DO UPDATE SET
               name=excluded.name, byte_size=excluded.byte_size,
               extract_status=excluded.extract_status, extracted=excluded.extracted,
               images=excluded.images, image_note=excluded.image_note",
            params![
                s.rel,
                s.name,
                s.byte_size as i64,
                s.extract_status,
                s.extracted,
                s.created,
                images,
                s.image_note
            ],
        )?;
        Ok(())
    }

    pub fn list_sources(&self) -> Result<Vec<SourceRow>, KbError> {
        let mut stmt = self.conn.prepare(
            "SELECT rel, name, byte_size, extract_status, created, images, image_note
             FROM sources ORDER BY created, rel",
        )?;
        let rows = stmt.query_map([], row_to_source)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 单查一份来源（生成时校验 rel 是否存在）。
    pub fn source(&self, rel: &str) -> Result<Option<SourceRow>, KbError> {
        self.conn
            .query_row(
                "SELECT rel, name, byte_size, extract_status, created, images, image_note
                 FROM sources WHERE rel = ?1",
                params![rel],
                row_to_source,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn source_extracted(&self, rel: &str) -> Result<Option<String>, KbError> {
        self.conn
            .query_row(
                "SELECT extracted FROM sources WHERE rel = ?1",
                params![rel],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn remove_source(&self, rel: &str) -> Result<(), KbError> {
        self.conn
            .execute("DELETE FROM sources WHERE rel = ?1", params![rel])?;
        Ok(())
    }

    /// 来源的全文搜索（生成时的「查知识库」也用它找相关的旧卡片）。
    pub fn search_sources(&self, q: &str) -> Result<Vec<SourceRow>, KbError> {
        let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let like = format!("%{escaped}%");
        let mut stmt = self.conn.prepare(
            "SELECT rel, name, byte_size, extract_status, created, images, image_note
             FROM sources
             WHERE name LIKE ?1 ESCAPE '\\' OR extracted LIKE ?1 ESCAPE '\\'
             ORDER BY rel",
        )?;
        let rows = stmt
            .query_map(params![like], row_to_source)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // -------------------------------------------------------------- 生成 run

    #[allow(clippy::too_many_arguments)]
    pub fn insert_run(
        &self,
        id: &str,
        source_rels: &[String],
        cli: &str,
        status: &str,
        started_at: i64,
    ) -> Result<(), KbError> {
        // ⚠️ `source_rel` 是 NOT NULL 的旧列 —— 始终写第一份，别只写 JSON。
        let first = source_rels.first().map(String::as_str).unwrap_or("");
        let json = serde_json::to_string(source_rels).map_err(|e| KbError::db(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO runs (id, source_rel, source_rels, cli, status, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, first, json, cli, status, started_at],
        )?;
        Ok(())
    }

    pub fn finish_run(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
        usage: Option<&str>,
        card_count: i64,
        finished_at: i64,
    ) -> Result<(), KbError> {
        self.conn.execute(
            "UPDATE runs SET status = ?2, error = ?3, usage = ?4, card_count = ?5, finished_at = ?6
             WHERE id = ?1",
            params![id, status, error, usage, card_count, finished_at],
        )?;
        Ok(())
    }

    /// 某份资料的生成历史 —— **包含**它的 run 都算（多来源 run 在任一成员的
    /// 历史里都能看到）。
    pub fn list_runs(&self, source_rel: &str) -> Result<Vec<RunRow>, KbError> {
        let like = format!("%\"{}\"%", escape_like(source_rel));
        let mut stmt = self.conn.prepare(
            "SELECT id, source_rel, source_rels, cli, status, error, usage, started_at,
                    finished_at, card_count
             FROM runs WHERE source_rels LIKE ?1 ESCAPE '\\' ORDER BY started_at DESC",
        )?;
        let rows = stmt
            .query_map(params![like], |r| {
                let rels: String = r.get(2)?;
                Ok(RunRow {
                    id: r.get(0)?,
                    source_rel: r.get(1)?,
                    source_rels: serde_json::from_str(&rels).unwrap_or_default(),
                    cli: r.get(3)?,
                    status: r.get(4)?,
                    error: r.get(5)?,
                    usage: r.get(6)?,
                    started_at: r.get(7)?,
                    finished_at: r.get(8)?,
                    card_count: r.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

/// LIKE 模式里的字面量转义（`_sources` 自带下划线，不转义会误匹配）。
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn row_to_source(r: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRow> {
    let images: String = r.get(5)?;
    Ok(SourceRow {
        rel: r.get(0)?,
        name: r.get(1)?,
        byte_size: r.get::<_, i64>(2)? as u64,
        extract_status: r.get(3)?,
        created: r.get(4)?,
        images: serde_json::from_str(&images).unwrap_or_default(),
        image_note: r.get(6)?,
    })
}

fn row_to_card(r: &rusqlite::Row<'_>) -> rusqlite::Result<CardRow> {
    let body: String = r.get(7)?;
    let tags: String = r.get(5)?;
    let sources: String = r.get(6)?;
    Ok(CardRow {
        rel: r.get(0)?,
        title: r.get(1)?,
        status: r.get(2)?,
        archived: r.get::<_, i32>(3)? != 0,
        created: r.get(4)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        sources: serde_json::from_str(&sources).unwrap_or_default(),
        excerpt: excerpt_of(&body),
        mtime: r.get::<_, i64>(8)? as u64,
        size: r.get::<_, i64>(9)? as u64,
    })
}

/// 摘要：按**字符**截（不是字节切割，多字节文字不会被切出半个字符）。
fn excerpt_of(body: &str) -> String {
    let mut out = String::new();
    for (i, ch) in body.chars().enumerate() {
        if i >= EXCERPT_CHARS {
            out.push('…');
            break;
        }
        if ch == '\n' {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// 重建报告（命令层原样回给前端，「已同步 N 张」这类文案用它）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexReport {
    pub scanned: usize,
    pub updated: usize,
    pub removed: usize,
    pub failed: usize,
}

/// 按磁盘重建索引（增量）：变了的重解析，没了的删行。
///
/// 单个文件读失败**不让整次重建失败**（记一个 failed 计数）——比如用户正在
/// 别处编辑、文件被锁了一下，那种不值得把整个知识库标红。
pub fn reindex(vault: &Vault, index: &Index) -> Result<ReindexReport, KbError> {
    let files = vault.scan_cards()?;
    let mut report = ReindexReport {
        scanned: files.len(),
        ..Default::default()
    };
    let mut seen: HashSet<String> = HashSet::new();

    for f in files {
        seen.insert(f.rel.clone());
        match index.card_meta(&f.rel)? {
            Some((mtime, size)) if mtime == f.mtime && size == f.size => continue,
            _ => {}
        }
        match vault.read_card(&f.rel) {
            Ok((fm, body)) => {
                // title 缺失（手编删掉了/新写的文件）：拿文件名兜底 —— 列表里
                // 不留空白行，比保真空标题有用
                let title = if fm.title.trim().is_empty() {
                    file_stem(&f.rel)
                } else {
                    fm.title.clone()
                };
                let row = CardRow {
                    rel: f.rel.clone(),
                    title,
                    status: fm.status.as_str().to_string(),
                    archived: fm.archived,
                    created: fm.created.clone(),
                    tags: fm.tags.clone(),
                    sources: fm.sources.clone(),
                    excerpt: String::new(), // upsert 时由 body 现算
                    mtime: f.mtime,
                    size: f.size,
                };
                if index.upsert_card(&row, &body).is_ok() {
                    report.updated += 1;
                } else {
                    report.failed += 1;
                }
            }
            Err(_) => report.failed += 1,
        }
    }

    for rel in index.all_card_rels()? {
        if !seen.contains(&rel) {
            index.remove_card(&rel)?;
            report.removed += 1;
        }
    }

    Ok(report)
}

/// 文件名兜底标题（`团队/登录流程.md` → `登录流程`）。
fn file_stem(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.strip_suffix(CARD_EXT).unwrap_or(name).to_string()
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::Frontmatter;

    fn tmp_vault(tag: &str) -> Vault {
        let base = std::env::temp_dir().join(format!(
            "devtoolkit-kb-idx-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Vault::create(base).expect("建 vault")
    }

    #[test]
    fn 重建_新文件进索引_删掉的文件出索引() {
        let v = tmp_vault("reindex");
        let idx = Index::open_in_memory().unwrap();
        v.write_card("a.md", &Frontmatter::new("甲", "2026-01-01"), "# 内容一\n").unwrap();

        let r = reindex(&v, &idx).unwrap();
        assert_eq!(r, ReindexReport { scanned: 1, updated: 1, removed: 0, failed: 0 });
        let cards = idx.list_cards().unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].title, "甲");
        assert_eq!(cards[0].excerpt, "# 内容一");

        // 没变 → 第二次重建不动它（增量）
        let r = reindex(&v, &idx).unwrap();
        assert_eq!(r.updated, 0);

        // 删掉文件 → 行也该没了
        v.delete_card("a.md").unwrap();
        let r = reindex(&v, &idx).unwrap();
        assert_eq!(r.removed, 1);
        assert!(idx.list_cards().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(v.root());
    }

    #[test]
    fn 标题缺失拿文件名兜底() {
        let v = tmp_vault("notitle");
        let idx = Index::open_in_memory().unwrap();
        // 手编的文件：有 frontmatter 但没 title
        std::fs::write(v.root().join("我的卡.md"), "---\nstatus: reviewed\n---\n正文").unwrap();
        reindex(&v, &idx).unwrap();
        let cards = idx.list_cards().unwrap();
        assert_eq!(cards[0].title, "我的卡");
        assert_eq!(cards[0].status, "reviewed");
        let _ = std::fs::remove_dir_all(v.root());
    }

    #[test]
    fn 搜索_跨标题正文标签_且百分号按字面() {
        let idx = Index::open_in_memory().unwrap();
        let mut row = CardRow {
            rel: "a.md".into(),
            title: "登录流程".into(),
            status: "unreviewed".into(),
            archived: false,
            created: String::new(),
            tags: vec!["auth".into()],
            excerpt: String::new(),
            sources: vec![],
            mtime: 1,
            size: 1,
        };
        idx.upsert_card(&row, "正文里有 refresh token 的字样 100% 覆盖率").unwrap();
        row.rel = "b.md".into();
        row.title = "别的".into();
        idx.upsert_card(&row, "无关内容").unwrap();

        assert_eq!(idx.search("登录").unwrap().len(), 1, "标题命中");
        assert_eq!(idx.search("auth").unwrap().len(), 2, "标签命中（两行标签一样）");
        assert_eq!(idx.search("refresh").unwrap().len(), 1, "正文命中（只有 a.md 有）");
        // `%` 是字面量不是通配符：搜 `100%` 命中（a.md 正文里有），搜 `1%0` 不命中
        assert_eq!(idx.search("100%").unwrap().len(), 1);
        assert_eq!(idx.search("1%0").unwrap().len(), 0);
    }

    #[test]
    fn 按来源找卡片_给删来源的连带清理用() {
        let idx = Index::open_in_memory().unwrap();
        let row = CardRow {
            rel: "x.md".into(),
            title: "t".into(),
            status: "unreviewed".into(),
            archived: false,
            created: String::new(),
            tags: vec![],
            excerpt: String::new(),
            sources: vec!["_sources/abc_报告.pdf".into()],
            mtime: 1,
            size: 1,
        };
        idx.upsert_card(&row, "").unwrap();
        assert_eq!(idx.cards_of_source("_sources/abc_报告.pdf").unwrap().len(), 1);
        assert_eq!(idx.cards_of_source("_sources/别的.pdf").unwrap().len(), 0);
    }

    // ------------------------------------------------------ v2：图片 + 多来源

    fn source_record<'a>(rel: &'a str, images: &'a [SourceImage]) -> SourceRecord<'a> {
        SourceRecord {
            rel,
            name: "报告.pdf",
            byte_size: 12,
            extract_status: "ok",
            extracted: "正文",
            images,
            image_note: "",
            created: "2026-01-01",
        }
    }

    #[test]
    fn 来源的图片清单能存能读() {
        let idx = Index::open_in_memory().unwrap();
        let images = vec![SourceImage {
            rel: "_files/1729_报告-img-1.jpg".into(),
            original_name: "第2页-image1-0.jpg".into(),
            page: Some(2),
        }];
        idx.upsert_source(&source_record("_sources/1729_报告.pdf", &images))
            .unwrap();

        let sources = idx.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].images, images);
        assert_eq!(sources[0].image_note, "");
        assert!(idx.source("_sources/1729_报告.pdf").unwrap().is_some());
        assert!(idx.source("_sources/没有.pdf").unwrap().is_none());
    }

    #[test]
    fn 多来源_run_在任一成员的历史里都能看到() {
        let idx = Index::open_in_memory().unwrap();
        let rels = vec!["_sources/a.pdf".to_string(), "_sources/b.pdf".to_string()];
        idx.insert_run("r1", &rels, "claude", "running", 7).unwrap();

        let a = idx.list_runs("_sources/a.pdf").unwrap();
        let b = idx.list_runs("_sources/b.pdf").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].source_rels, rels);
        assert_eq!(a[0].source_rel, "_sources/a.pdf", "旧字段写第一份");
        assert!(idx.list_runs("_sources/c.pdf").unwrap().is_empty());
    }

    #[test]
    fn 按来源找卡片_下划线按字面匹配不误伤() {
        let idx = Index::open_in_memory().unwrap();
        let row = CardRow {
            rel: "x.md".into(),
            title: "t".into(),
            status: "unreviewed".into(),
            archived: false,
            created: String::new(),
            tags: vec![],
            excerpt: String::new(),
            sources: vec!["_sources/a_b.pdf".into()],
            mtime: 1,
            size: 1,
        };
        idx.upsert_card(&row, "").unwrap();
        // `_` 如果没转义，这个模式会命中 `a_b`
        assert_eq!(idx.cards_of_source("_sources/axb.pdf").unwrap().len(), 0);
        assert_eq!(idx.cards_of_source("_sources/a_b.pdf").unwrap().len(), 1);
    }

    #[test]
    fn v1_库升级到_v2_会回填_run_的来源数组() {
        // 手写一个 v1 结构的库（不经过 migrate），塞一条 run，再用新代码打开。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sources (
                 rel TEXT PRIMARY KEY, name TEXT NOT NULL, byte_size INTEGER NOT NULL DEFAULT 0,
                 extract_status TEXT NOT NULL DEFAULT 'none', extracted TEXT NOT NULL DEFAULT '',
                 created TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE runs (
                 id TEXT PRIMARY KEY, source_rel TEXT NOT NULL, cli TEXT NOT NULL,
                 status TEXT NOT NULL, error TEXT, usage TEXT, started_at INTEGER NOT NULL,
                 finished_at INTEGER, card_count INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO runs (id, source_rel, cli, status, started_at)
             VALUES ('r1', '_sources/老资料.pdf', 'claude', 'done', 1);
             PRAGMA user_version = 1;",
        )
        .unwrap();

        let idx = Index { conn };
        idx.migrate().unwrap();
        let runs = idx.list_runs("_sources/老资料.pdf").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].source_rels, ["_sources/老资料.pdf"]);
        // 幂等：再跑一次不炸
        idx.migrate().unwrap();
    }

    #[test]
    fn 索引版本比程序新时明确拒绝() {
        let idx = Index::open_in_memory().unwrap();
        idx.conn
            .execute_batch("PRAGMA user_version = 999;")
            .unwrap();
        let err = idx.migrate().unwrap_err();
        assert!(err.to_string().contains("比程序新"), "拿到：{err}");
    }
}
