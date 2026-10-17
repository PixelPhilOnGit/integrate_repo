//! 群组数据库：群 / 成员 / 轮次 / 消息，一个 SQLite 文件。
//!
//! # 为什么是 SQLite 而不是 KV
//!
//! 群配置和消息要在**同一个事务**里保持一致（删群级联、保存成员列表）；
//! 消息要按轮次/成员排序、按 N 轮取上下文。KV 那套「整个数组读写」在
//! 多窗口下还会互相覆盖。
//!
//! 场景分卷在**命令层**算文件名：`groups.db` / `groups@团队A.db`（纯函数是
//! [`db_file_name`]）。切换场景时命令层负责先停掉旧场景的轮次、再丢掉句柄。
//!
//! # 两条容易写错的数据决定
//!
//! 1. `group_messages.member_id` **不建外键**，`speaker_name` 存**快照** ——
//!    成员删了/改名了，历史消息仍然要能读，而且显示的是当时那个名字。
//! 2. 历史排序是 `(轮次开始时间, 成员位置, 消息 id)`，**不是插入顺序**。
//!    并行模式下成员按完成先后落库，按插入顺序排会让气泡在「对账」之后跳位。
//!
//! # 句柄
//!
//! `Mutex<Connection>`：Connection 是 Send 不是 Sync，而一轮里多个成员会并发
//! 落库。锁内只有同步 SQL、没有 await —— 不可能长时间持有。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::adapter::{CliKind, Permission, TurnMode};
use crate::error::GroupError;

/// 库结构版本（`PRAGMA user_version`）。
const SCHEMA_VERSION: i64 = 1;

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 进程内唯一的 id（时间戳 + 计数器，没有 rand 依赖）。
fn new_id(prefix: &str) -> String {
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}_{}", now_ms(), n)
}

/// 场景化库文件名。默认场景是 `groups.db`（老路径零迁移语义），其余带 `@` 后缀。
///
/// 场景名合法性由 `shared/platform/scenario.ts` / `scenario_commands.rs` 保证
/// （不允许 `@`、路径分隔符），这里拼不出逃逸路径。
pub fn db_file_name(scenario: &str) -> String {
    if scenario.is_empty() {
        "groups.db".to_string()
    } else {
        format!("groups@{scenario}.db")
    }
}

// ---------------------------------------------------------------- 对外类型

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub mode: TurnMode,
    pub member_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberConfig {
    pub id: String,
    pub name: String,
    pub kind: CliKind,
    pub command: String,
    pub model: String,
    pub role_prompt: String,
    pub permission: Permission,
    pub extra_args: Vec<String>,
    pub position: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDetail {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub mode: TurnMode,
    pub context_turns: i64,
    pub context_chars: i64,
    pub timeout_secs: i64,
    pub members: Vec<MemberConfig>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 消息里的一条工具痕迹（和前端 `ToolTrace` 对应）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTrace {
    pub tool_id: Option<String>,
    pub name: String,
    pub display: String,
    /// `None` = 还没有结果；`Some(false)` = 成功；`Some(true)` = 失败。
    pub is_error: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMessage {
    pub id: i64,
    pub turn_id: String,
    /// `user` | `member` | `system`
    pub speaker_kind: String,
    pub member_id: Option<String>,
    pub speaker_name: String,
    pub member_position: i64,
    pub text: String,
    pub tools: Vec<ToolTrace>,
    /// `done` | `failed` | `cancelled`
    pub status: String,
    pub error: String,
    pub usage: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInput {
    /// 成员 id。**前端会带一个客户端生成的 id**（加成员后立刻可编辑，
    /// 不用等一次往返）；空串也接受，由这里分配。
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: CliKind,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub role_prompt: String,
    #[serde(default = "default_permission")]
    pub permission: Permission,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub position: i64,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupConfigInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub workspace: String,
    pub mode: TurnMode,
    #[serde(default = "default_context_turns")]
    pub context_turns: i64,
    #[serde(default = "default_context_chars")]
    pub context_chars: i64,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i64,
    #[serde(default)]
    pub members: Vec<MemberInput>,
}

fn default_permission() -> Permission {
    Permission::WorkspaceWrite
}
fn default_true() -> bool {
    true
}
fn default_context_turns() -> i64 {
    6
}
fn default_context_chars() -> i64 {
    24_000
}
fn default_timeout() -> i64 {
    600
}

/// `begin_turn` 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedTurn {
    pub turn_id: String,
    pub user_message_id: i64,
    pub started_at: i64,
}

/// 一个成员跑完时要落库的东西。
pub struct MemberOutcome<'a> {
    pub group_id: &'a str,
    pub turn_id: &'a str,
    pub member_id: &'a str,
    pub speaker_name: &'a str,
    pub member_position: i64,
    pub text: &'a str,
    pub tools: &'a [ToolTrace],
    pub status: &'a str,
    pub error: &'a str,
    pub usage: Option<&'a str>,
}

// ---------------------------------------------------------------- 库

pub struct GroupStore {
    conn: Mutex<Connection>,
}

impl GroupStore {
    /// 打开（不存在就建）。会顺手做两件事：迁移 + 恢复上一世遗留的 `running` 轮次。
    pub fn open(path: &Path) -> Result<Self, GroupError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| GroupError::io(format!("建目录 {}", parent.display()), e))?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, GroupError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, GroupError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&conn)?;
        let store = Self { conn: Mutex::new(conn) };
        store.recover_running_turns()?;
        Ok(store)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ------------------------------------------------------------ 群

    pub fn list_groups(&self) -> Result<Vec<GroupSummary>, GroupError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT g.id, g.name, g.workspace, g.mode, g.updated_at,
                    (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id)
             FROM groups g ORDER BY g.updated_at DESC, g.id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let mode: String = r.get(3)?;
            Ok(GroupSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                workspace: r.get(2)?,
                mode: TurnMode::parse(&mode).unwrap_or(TurnMode::Sequential),
                member_count: r.get(5)?,
                updated_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_group(&self, id: &str) -> Result<GroupDetail, GroupError> {
        let conn = self.lock();
        read_group(&conn, id)?.ok_or_else(|| GroupError::not_found(format!("群 {id}")))
    }

    pub fn create_group(&self, name: &str) -> Result<GroupDetail, GroupError> {
        let name = validate_group_name(name)?;
        let id = new_id("g");
        let now = now_ms();
        {
            let conn = self.lock();
            conn.execute(
                "INSERT INTO groups (id, name, workspace, mode, context_turns, context_chars,
                                     timeout_secs, created_at, updated_at)
                 VALUES (?1, ?2, '', 'sequential', 6, 24000, 600, ?3, ?3)",
                params![id, name, now],
            )?;
        }
        self.get_group(&id)
    }

    /// 全量保存（群 + 成员列表，一个事务）。成员 id 保留；本次没出现的删除。
    pub fn save_group(&self, input: &GroupConfigInput) -> Result<GroupDetail, GroupError> {
        let name = validate_group_name(&input.name)?;
        if !(1..=50).contains(&input.context_turns) {
            return Err(GroupError::bad_input("上下文轮数要在 1..=50 之间"));
        }
        if !(1000..=200_000).contains(&input.context_chars) {
            return Err(GroupError::bad_input("上下文字符预算要在 1000..=200000 之间"));
        }
        if !(10..=3600).contains(&input.timeout_secs) {
            return Err(GroupError::bad_input("单个成员超时要在 10..=3600 秒之间"));
        }
        validate_members(&input.members)?;

        let now = now_ms();
        {
            let mut conn = self.lock();
            let tx = conn.transaction()?;

            let exists: Option<i64> = tx
                .query_row("SELECT 1 FROM groups WHERE id = ?1", params![input.id], |r| r.get(0))
                .optional()?;
            if exists.is_none() {
                return Err(GroupError::not_found(format!("群 {}", input.id)));
            }

            tx.execute(
                "UPDATE groups SET name = ?2, workspace = ?3, mode = ?4, context_turns = ?5,
                                   context_chars = ?6, timeout_secs = ?7, updated_at = ?8
                 WHERE id = ?1",
                params![
                    input.id,
                    name,
                    input.workspace.trim(),
                    input.mode.as_str(),
                    input.context_turns,
                    input.context_chars,
                    input.timeout_secs,
                    now
                ],
            )?;

            let mut keep: Vec<String> = Vec::new();
            for (index, m) in input.members.iter().enumerate() {
                let id = if m.id.trim().is_empty() {
                    new_id("m")
                } else {
                    m.id.trim().to_string()
                };
                let position = if m.position >= 0 { m.position } else { index as i64 };
                let extra = serde_json::to_string(&m.extra_args)?;
                tx.execute(
                    "INSERT INTO group_members
                        (id, group_id, name, kind, command, model, role_prompt, permission,
                         extra_args, position, enabled, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
                     ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name, kind = excluded.kind, command = excluded.command,
                        model = excluded.model, role_prompt = excluded.role_prompt,
                        permission = excluded.permission, extra_args = excluded.extra_args,
                        position = excluded.position, enabled = excluded.enabled,
                        updated_at = excluded.updated_at",
                    params![
                        id,
                        input.id,
                        m.name.trim(),
                        m.kind.as_str(),
                        m.command.trim(),
                        m.model.trim(),
                        m.role_prompt,
                        permission_str(m.permission),
                        extra,
                        position,
                        m.enabled as i64,
                        now
                    ],
                )?;
                // ⚠️ 成员 id 是全局主键：一个 id 只能属于一个群（跨群冒用直接不给）。
                let owner: String = tx.query_row(
                    "SELECT group_id FROM group_members WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )?;
                if owner != input.id {
                    return Err(GroupError::bad_input("成员 id 属于另一个群"));
                }
                keep.push(id);
            }

            // 本次没出现的成员删掉（历史消息里存的是名字快照，不受影响）。
            if keep.is_empty() {
                tx.execute("DELETE FROM group_members WHERE group_id = ?1", params![input.id])?;
            } else {
                let placeholders = std::iter::repeat("?").take(keep.len()).collect::<Vec<_>>().join(",");
                let sql = format!(
                    "DELETE FROM group_members WHERE group_id = ?1 AND id NOT IN ({placeholders})"
                );
                let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(keep.len() + 1);
                values.push(&input.id);
                for id in &keep {
                    values.push(id);
                }
                tx.execute(&sql, values.as_slice())?;
            }

            tx.commit()?;
        }

        self.get_group(&input.id)
    }

    pub fn delete_group(&self, id: &str) -> Result<bool, GroupError> {
        if self.has_running_turn(id)? {
            return Err(GroupError::Busy { group_id: id.to_string() });
        }
        let conn = self.lock();
        let n = conn.execute("DELETE FROM groups WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    // ------------------------------------------------------------ 轮次 / 消息

    pub fn has_running_turn(&self, group_id: &str) -> Result<bool, GroupError> {
        let conn = self.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM group_turns WHERE group_id = ?1 AND status = 'running'",
            params![group_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// 开一轮：写 `group_turns` + 用户消息。调用方已经校验过「没有并发轮次」。
    pub fn begin_turn(
        &self,
        turn_id: &str,
        group_id: &str,
        user_text: &str,
        mention_ids: &[String],
        mode: TurnMode,
    ) -> Result<StartedTurn, GroupError> {
        let now = now_ms();
        let mentions = serde_json::to_string(mention_ids)?;
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO group_turns
                (id, group_id, user_text, mention_ids, mode, status, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)",
            params![turn_id, group_id, user_text, mentions, mode.as_str(), now],
        )?;
        tx.execute(
            "INSERT INTO group_messages
                (group_id, turn_id, speaker_kind, member_id, speaker_name, member_position,
                 text, tools, status, error, created_at)
             VALUES (?1, ?2, 'user', NULL, '用户', -1, ?3, '[]', 'done', '', ?4)",
            params![group_id, turn_id, user_text, now],
        )?;
        let user_message_id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(StartedTurn {
            turn_id: turn_id.to_string(),
            user_message_id,
            started_at: now,
        })
    }

    /// 一个成员跑完：落一条消息，返回消息 id。
    pub fn record_member_message(&self, o: &MemberOutcome) -> Result<i64, GroupError> {
        let tools = serde_json::to_string(o.tools)?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO group_messages
                (group_id, turn_id, speaker_kind, member_id, speaker_name, member_position,
                 text, tools, status, error, usage, created_at)
             VALUES (?1, ?2, 'member', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                o.group_id,
                o.turn_id,
                o.member_id,
                o.speaker_name,
                o.member_position,
                o.text,
                tools,
                o.status,
                o.error,
                o.usage,
                now_ms()
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn finish_turn(
        &self,
        turn_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), GroupError> {
        let conn = self.lock();
        conn.execute(
            "UPDATE group_turns SET status = ?2, error = ?3, finished_at = ?4 WHERE id = ?1",
            params![turn_id, status, error, now_ms()],
        )?;
        Ok(())
    }

    /// 最近 `limit` 条消息（**升序**返回；内部先取最近的再翻回来）。
    pub fn history(&self, group_id: &str, limit: usize) -> Result<Vec<GroupMessage>, GroupError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT * FROM (
                SELECT m.*, t.started_at AS turn_started
                FROM group_messages m JOIN group_turns t ON t.id = m.turn_id
                WHERE m.group_id = ?1
                ORDER BY t.started_at DESC, m.member_position DESC, m.id DESC
                LIMIT ?2
             ) ORDER BY turn_started ASC, member_position ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![group_id, limit as i64], row_to_message)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 最近的 `max_turns` 个**已完成**轮次的消息（不含正在跑的这一轮）。
    ///
    /// ⚠️ 顺序模式拼提示词时**必须**用这个而不是 `history()` —— 后者会把本轮
    /// 前面的回答也带进来，而它们已经单独出现在「本轮前序回答」里，重复。
    pub fn recent_context(
        &self,
        group_id: &str,
        max_turns: usize,
    ) -> Result<Vec<GroupMessage>, GroupError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id FROM group_turns
             WHERE group_id = ?1 AND status != 'running'
             ORDER BY started_at DESC LIMIT ?2",
        )?;
        let turn_ids: Vec<String> = stmt
            .query_map(params![group_id, max_turns as i64], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if turn_ids.is_empty() {
            return Ok(Vec::new());
        }

        // 按时间正序取这些轮次的全部消息。
        let placeholders = std::iter::repeat("?").take(turn_ids.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT m.*, t.started_at AS turn_started
             FROM group_messages m JOIN group_turns t ON t.id = m.turn_id
             WHERE m.turn_id IN ({placeholders})
             ORDER BY t.started_at ASC, m.member_position ASC, m.id ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(turn_ids.len());
        for id in &turn_ids {
            values.push(id);
        }
        let rows = stmt.query_map(values.as_slice(), row_to_message)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn clear_history(&self, group_id: &str) -> Result<(), GroupError> {
        if self.has_running_turn(group_id)? {
            return Err(GroupError::Busy { group_id: group_id.to_string() });
        }
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM group_messages WHERE group_id = ?1", params![group_id])?;
        tx.execute("DELETE FROM group_turns WHERE group_id = ?1", params![group_id])?;
        tx.commit()?;
        Ok(())
    }

    /// 启动时把上一世遗留的 `running` 轮次收成 failed，并补一条系统消息。
    ///
    /// ⚠️ 只在 `open()` 时调 —— 那是「归属表空着」的时刻。运行中调会把
    /// 正常在跑的轮次误判成崩溃遗留。
    pub fn recover_running_turns(&self) -> Result<usize, GroupError> {
        let now = now_ms();
        let mut conn = self.lock();
        let stale: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, group_id FROM group_turns WHERE status = 'running'",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if stale.is_empty() {
            return Ok(0);
        }

        let tx = conn.transaction()?;
        for (turn_id, group_id) in &stale {
            tx.execute(
                "UPDATE group_turns SET status = 'failed', error = ?2, finished_at = ?3
                 WHERE id = ?1",
                params![turn_id, "应用在这一轮跑完之前退出了", now],
            )?;
            tx.execute(
                "INSERT INTO group_messages
                    (group_id, turn_id, speaker_kind, member_id, speaker_name, member_position,
                     text, tools, status, error, created_at)
                 VALUES (?1, ?2, 'system', NULL, '系统', -1, ?3, '[]', 'failed', '', ?4)",
                params![
                    group_id,
                    turn_id,
                    "应用在这一轮跑完之前退出了，这一轮没有结果。",
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(stale.len())
    }
}

// ---------------------------------------------------------------- 内部

fn validate_group_name(name: &str) -> Result<String, GroupError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(GroupError::bad_input("群名不能为空"));
    }
    if name.chars().count() > 60 {
        return Err(GroupError::bad_input("群名太长了（最多 60 个字）"));
    }
    Ok(name.to_string())
}

fn validate_members(members: &[MemberInput]) -> Result<(), GroupError> {
    if members.len() > 12 {
        return Err(GroupError::bad_input("一个群最多 12 个成员"));
    }
    let mut seen: Vec<String> = Vec::new();
    for m in members {
        let name = m.name.trim();
        if name.is_empty() {
            return Err(GroupError::bad_input("成员名字不能为空"));
        }
        if name.chars().count() > 30 {
            return Err(GroupError::bad_input(format!("成员名太长了：{name}")));
        }
        let lower = name.to_lowercase();
        if seen.contains(&lower) {
            return Err(GroupError::bad_input(format!("成员名字重复了：{name}")));
        }
        seen.push(lower);
        if m.kind == CliKind::Custom && m.command.trim().is_empty() {
            return Err(GroupError::bad_input(format!(
                "成员「{name}」是自定义工具，必须填命令"
            )));
        }
    }
    Ok(())
}

fn permission_str(p: Permission) -> &'static str {
    match p {
        Permission::ReadOnly => "readOnly",
        Permission::WorkspaceWrite => "workspaceWrite",
        Permission::Full => "full",
    }
}

fn parse_permission(s: &str) -> Permission {
    Permission::parse(s).unwrap_or(Permission::WorkspaceWrite)
}

fn read_group(conn: &Connection, id: &str) -> Result<Option<GroupDetail>, GroupError> {
    let row = conn
        .query_row(
            "SELECT id, name, workspace, mode, context_turns, context_chars, timeout_secs,
                    created_at, updated_at
             FROM groups WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                ))
            },
        )
        .optional()?;

    let Some((id, name, workspace, mode, context_turns, context_chars, timeout_secs, created_at, updated_at)) = row else {
        return Ok(None);
    };

    let members = read_members(conn, &id)?;
    Ok(Some(GroupDetail {
        id,
        name,
        workspace,
        mode: TurnMode::parse(&mode).unwrap_or(TurnMode::Sequential),
        context_turns,
        context_chars,
        timeout_secs,
        members,
        created_at,
        updated_at,
    }))
}

fn read_members(conn: &Connection, group_id: &str) -> Result<Vec<MemberConfig>, GroupError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, kind, command, model, role_prompt, permission, extra_args,
                position, enabled
         FROM group_members WHERE group_id = ?1 ORDER BY position ASC, name ASC",
    )?;
    let rows = stmt.query_map(params![group_id], |r| {
        let kind: String = r.get(2)?;
        let permission: String = r.get(6)?;
        let extra: String = r.get(7)?;
        Ok(MemberConfig {
            id: r.get(0)?,
            name: r.get(1)?,
            kind: CliKind::parse(&kind).unwrap_or(CliKind::Claude),
            command: r.get(3)?,
            model: r.get(4)?,
            role_prompt: r.get(5)?,
            permission: parse_permission(&permission),
            extra_args: serde_json::from_str(&extra).unwrap_or_default(),
            position: r.get(8)?,
            enabled: r.get::<_, i64>(9)? != 0,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<GroupMessage> {
    let tools: String = r.get("tools")?;
    Ok(GroupMessage {
        id: r.get("id")?,
        turn_id: r.get("turn_id")?,
        speaker_kind: r.get("speaker_kind")?,
        member_id: r.get("member_id")?,
        speaker_name: r.get("speaker_name")?,
        member_position: r.get("member_position")?,
        text: r.get("text")?,
        tools: serde_json::from_str(&tools).unwrap_or_default(),
        status: r.get("status")?,
        error: r.get("error")?,
        usage: r.get("usage")?,
        created_at: r.get("created_at")?,
    })
}

fn migrate(conn: &Connection) -> Result<(), GroupError> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(GroupError::db(format!(
            "库结构版本 {current} 比程序支持的 {SCHEMA_VERSION} 新，拒绝打开（防止把数据写坏）"
        )));
    }
    if current < 1 {
        conn.execute_batch(
            "CREATE TABLE groups (
                id             TEXT PRIMARY KEY,
                name           TEXT NOT NULL,
                workspace      TEXT NOT NULL DEFAULT '',
                mode           TEXT NOT NULL DEFAULT 'sequential',
                context_turns  INTEGER NOT NULL DEFAULT 6,
                context_chars  INTEGER NOT NULL DEFAULT 24000,
                timeout_secs   INTEGER NOT NULL DEFAULT 600,
                created_at     INTEGER NOT NULL,
                updated_at     INTEGER NOT NULL
            );

            CREATE TABLE group_members (
                id           TEXT PRIMARY KEY,
                group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                name         TEXT NOT NULL,
                kind         TEXT NOT NULL,
                command      TEXT NOT NULL DEFAULT '',
                model        TEXT NOT NULL DEFAULT '',
                role_prompt  TEXT NOT NULL DEFAULT '',
                permission   TEXT NOT NULL DEFAULT 'workspaceWrite',
                extra_args   TEXT NOT NULL DEFAULT '[]',
                position     INTEGER NOT NULL DEFAULT 0,
                enabled      INTEGER NOT NULL DEFAULT 1,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL
            );
            CREATE INDEX group_members_group ON group_members(group_id, position);
            -- 成员名群内唯一。⚠️ 用 lower(name) 的表达式索引，大小写不同也算重复
            -- （SQLite 的 lower() 只对 ASCII 生效；中文本来就区分不了大小写）。
            -- 应用层还有一遍不区分大小写的校验（多窗口并发保存时这里兜底）。
            CREATE UNIQUE INDEX group_members_name ON group_members(group_id, lower(name));

            CREATE TABLE group_turns (
                id           TEXT PRIMARY KEY,
                group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                user_text    TEXT NOT NULL,
                mention_ids  TEXT NOT NULL DEFAULT '[]',
                mode         TEXT NOT NULL,
                status       TEXT NOT NULL,
                error        TEXT,
                started_at   INTEGER NOT NULL,
                finished_at  INTEGER
            );
            CREATE INDEX group_turns_group ON group_turns(group_id, started_at DESC);

            CREATE TABLE group_messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                turn_id         TEXT NOT NULL REFERENCES group_turns(id) ON DELETE CASCADE,
                speaker_kind    TEXT NOT NULL,
                member_id       TEXT,
                speaker_name    TEXT NOT NULL,
                member_position INTEGER NOT NULL DEFAULT -1,
                text            TEXT NOT NULL,
                tools           TEXT NOT NULL DEFAULT '[]',
                status          TEXT NOT NULL DEFAULT 'done',
                error           TEXT NOT NULL DEFAULT '',
                usage           TEXT,
                created_at      INTEGER NOT NULL
            );
            CREATE INDEX group_messages_group
                ON group_messages(group_id, turn_id, member_position, id);",
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> GroupStore {
        GroupStore::open_in_memory().expect("内存库")
    }

    fn cfg(group: &GroupDetail) -> GroupConfigInput {
        GroupConfigInput {
            id: group.id.clone(),
            name: group.name.clone(),
            workspace: group.workspace.clone(),
            mode: group.mode,
            context_turns: group.context_turns,
            context_chars: group.context_chars,
            timeout_secs: group.timeout_secs,
            members: group
                .members
                .iter()
                .map(|m| MemberInput {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    kind: m.kind,
                    command: m.command.clone(),
                    model: m.model.clone(),
                    role_prompt: m.role_prompt.clone(),
                    permission: m.permission,
                    extra_args: m.extra_args.clone(),
                    position: m.position,
                    enabled: m.enabled,
                })
                .collect(),
        }
    }

    fn member(name: &str, kind: CliKind) -> MemberInput {
        MemberInput {
            id: String::new(),
            name: name.into(),
            kind,
            command: String::new(),
            model: String::new(),
            role_prompt: String::new(),
            permission: Permission::WorkspaceWrite,
            extra_args: vec![],
            position: -1,
            enabled: true,
        }
    }

    #[test]
    fn 库文件名按场景分卷_默认场景零迁移() {
        assert_eq!(db_file_name(""), "groups.db");
        assert_eq!(db_file_name("团队A"), "groups@团队A.db");
    }

    #[test]
    fn 建群给默认值_成员为空() {
        let s = store();
        let g = s.create_group("项目群").expect("建群");
        assert_eq!(g.name, "项目群");
        assert_eq!(g.mode, TurnMode::Sequential);
        assert_eq!((g.context_turns, g.context_chars, g.timeout_secs), (6, 24000, 600));
        assert!(g.members.is_empty());
    }

    #[test]
    fn 群名空或过长被拒() {
        let s = store();
        assert!(s.create_group("  ").is_err());
        assert!(s.create_group(&"长".repeat(61)).is_err());
    }

    #[test]
    fn 保存成员_保序_保留_id_删除没出现的() {
        let s = store();
        let g = s.create_group("群").unwrap();
        let mut input = cfg(&g);
        input.members = vec![member("甲", CliKind::Claude), member("乙", CliKind::Codex)];
        let saved = s.save_group(&input).expect("保存");
        assert_eq!(saved.members.len(), 2);
        assert_eq!(saved.members[0].name, "甲");
        let yi_id = saved.members[1].id.clone();

        // 去掉甲、保留乙的 id 再存
        let mut input = cfg(&saved);
        input.members = vec![member("乙", CliKind::Codex)];
        input.members[0].id = yi_id.clone();
        let saved = s.save_group(&input).unwrap();
        assert_eq!(saved.members.len(), 1);
        assert_eq!(saved.members[0].id, yi_id, "已有成员的 id 必须保留");
    }

    #[test]
    fn 成员名重复_忽略大小写也拒() {
        let s = store();
        let g = s.create_group("群").unwrap();
        let mut input = cfg(&g);
        input.members = vec![member("Alice", CliKind::Claude), member("alice", CliKind::Claude)];
        let err = s.save_group(&input).expect_err("重名该被拒");
        assert!(err.to_string().contains("重复"));
    }

    #[test]
    fn 自定义成员必须填命令() {
        let s = store();
        let g = s.create_group("群").unwrap();
        let mut input = cfg(&g);
        input.members = vec![member("丙", CliKind::Custom)];
        assert!(s.save_group(&input).is_err());
    }

    #[test]
    fn 删群级联删成员和消息() {
        let s = store();
        let g = s.create_group("群").unwrap();
        let mut input = cfg(&g);
        input.members = vec![member("甲", CliKind::Claude)];
        let g = s.save_group(&input).unwrap();
        let member_id = g.members[0].id.clone();

        s.begin_turn("t1", &g.id, "你好", &[], TurnMode::Sequential).unwrap();
        s.record_member_message(&MemberOutcome {
            group_id: &g.id,
            turn_id: "t1",
            member_id: &member_id,
            speaker_name: "甲",
            member_position: 0,
            text: "在",
            tools: &[],
            status: "done",
            error: "",
            usage: None,
        })
        .unwrap();
        // 轮次收尾之后才允许删群（跑着的时候删群会被 Busy 拦下）。
        s.finish_turn("t1", "done", None).unwrap();

        assert!(s.delete_group(&g.id).unwrap());
        // 群没了，成员/轮次/消息都该跟着没
        assert!(s.get_group(&g.id).is_err());
        let conn = s.lock();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM group_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM group_members", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn 历史按轮次和成员位置排序_不受落库顺序影响() {
        let s = store();
        let g = s.create_group("群").unwrap();
        s.begin_turn("t1", &g.id, "问题", &[], TurnMode::Parallel).unwrap();
        // 并行：乙先落库（position 1），甲后落库（position 0）
        s.record_member_message(&MemberOutcome {
            group_id: &g.id, turn_id: "t1", member_id: "m2", speaker_name: "乙",
            member_position: 1, text: "乙答", tools: &[], status: "done", error: "", usage: None,
        }).unwrap();
        s.record_member_message(&MemberOutcome {
            group_id: &g.id, turn_id: "t1", member_id: "m1", speaker_name: "甲",
            member_position: 0, text: "甲答", tools: &[], status: "done", error: "", usage: None,
        }).unwrap();

        let history = s.history(&g.id, 100).unwrap();
        let speakers: Vec<&str> = history.iter().map(|m| m.speaker_name.as_str()).collect();
        assert_eq!(speakers, vec!["用户", "甲", "乙"], "顺序必须按成员位置，不是完成先后");
    }

    #[test]
    fn 上下文不含正在跑的轮次() {
        let s = store();
        let g = s.create_group("群").unwrap();
        s.begin_turn("t1", &g.id, "第一轮", &[], TurnMode::Sequential).unwrap();
        s.finish_turn("t1", "done", None).unwrap();
        s.begin_turn("t2", &g.id, "当前轮", &[], TurnMode::Sequential).unwrap();

        let ctx = s.recent_context(&g.id, 6).unwrap();
        let texts: Vec<&str> = ctx.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, vec!["第一轮"], "本轮消息不能进历史上下文");
    }

    #[test]
    fn 崩溃遗留的_running_轮次被收成_failed() {
        let s = store();
        let g = s.create_group("群").unwrap();
        s.begin_turn("t1", &g.id, "跑一半崩了", &[], TurnMode::Sequential).unwrap();

        // 模拟重启：同一路径再打开一次会触发 recover。内存库换个句柄做不到，
        // 直接调 recover 等价于 open 时那一步。
        let n = s.recover_running_turns().unwrap();
        assert_eq!(n, 1);
        let history = s.history(&g.id, 10).unwrap();
        assert!(history.iter().any(|m| m.speaker_kind == "system"));
        assert!(history.iter().any(|m| m.status == "failed"));
        // 幂等：再收一次没有东西可收
        assert_eq!(s.recover_running_turns().unwrap(), 0);
    }

    #[test]
    fn 有轮次在跑时_删群和清历史都被拒() {
        let s = store();
        let g = s.create_group("群").unwrap();
        s.begin_turn("t1", &g.id, "跑着", &[], TurnMode::Sequential).unwrap();
        assert!(matches!(s.delete_group(&g.id), Err(GroupError::Busy { .. })));
        assert!(matches!(s.clear_history(&g.id), Err(GroupError::Busy { .. })));
    }

    #[test]
    fn 清历史只清消息和轮次_群还在() {
        let s = store();
        let g = s.create_group("群").unwrap();
        s.begin_turn("t1", &g.id, "你好", &[], TurnMode::Sequential).unwrap();
        s.finish_turn("t1", "done", None).unwrap();
        s.clear_history(&g.id).unwrap();
        assert!(s.history(&g.id, 10).unwrap().is_empty());
        assert!(s.get_group(&g.id).is_ok());
    }

    #[test]
    fn 库版本比程序新时拒绝打开() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        let err = migrate(&conn).expect_err("该拒绝");
        assert!(err.to_string().contains("拒绝打开"));
    }

    #[test]
    fn 工具痕迹能存能读() {
        let s = store();
        let g = s.create_group("群").unwrap();
        s.begin_turn("t1", &g.id, "你好", &[], TurnMode::Sequential).unwrap();
        let tools = vec![ToolTrace {
            tool_id: Some("x1".into()),
            name: "Read".into(),
            display: "读 a.txt".into(),
            is_error: Some(false),
        }];
        s.record_member_message(&MemberOutcome {
            group_id: &g.id, turn_id: "t1", member_id: "m1", speaker_name: "甲",
            member_position: 0, text: "好", tools: &tools, status: "done", error: "", usage: None,
        }).unwrap();
        let history = s.history(&g.id, 10).unwrap();
        let msg = history.iter().find(|m| m.speaker_kind == "member").unwrap();
        assert_eq!(msg.tools, tools);
    }
}
