//! 会话记录：把跑过的每一轮**落盘**。
//!
//! # 为什么要落
//!
//! 两个用途，都不是「顺便记个日志」：
//!
//! 1. **「哪个上下文策略划算」只有这里能回答。** 每一轮的用量（输入 / 输出 /
//!    缓存命中 / 缓存写入）都记下来，才谈得上比较全量和滚动的成本。
//!    没有这份数据，那个可配的策略就只是个开关，用户看不出它值不值。
//! 2. 三期要做**检索**（从历史里召回相关的片段），原料就是这些记录。
//!
//! # 为什么是「每轮一次写」而不是「结束了一次性写」
//!
//! `[profile.release]` 里是 `panic = "abort"` —— 进程炸了就是炸了，没有
//! `Drop`、没有 unwind、攒在内存里的东西**一个字都留不下来**。
//! 一次长 run 可能跑几十轮，攒到最后写等于把整份记录押在「它一定能跑完」上。
//! 每次一条 INSERT（SQLite 默认 autocommit），最坏情况只丢最后一轮。
//!
//! # 为什么放在 assistant 这个 crate 里，而不是另起一个
//!
//! `store` 和 `tasks` 各有一个 SQLite 模块，是因为它们的消费者**是多个模块**
//! （键值层所有人用、任务是所有事的入口）。这一份只服务助手，而且存的就是
//! 这个 crate 自己的类型（`Usage` / `RunStatus` / `ContextStrategy`）——
//! 拆出去只会多一个 crate、多一处 workspace 配置，换来的是把一个内部的
//! 实现细节变成两个 crate 之间的公共契约。
//!
//! ⚠️ 这条判断**会因为消费者出现而失效**：等第二个模块要读这些记录
//! （比如任务接 agent 之后要按任务查执行历史），就该像 `store` 那样拆出去。
//!
//! # `Mutex` 是给谁加的
//!
//! `rusqlite::Connection` 是 `Send` 但**不是 `Sync`**。而这个结构要被
//! `Arc` 拿着跨 await 走（run 是 async 的），所以自己包一层。
//! 锁的临界区里只有 SQLite 调用、**没有 await**（每次都用完就放），
//! 所以用 `std::sync::Mutex` 就够，不需要 `tokio::sync::Mutex`。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::journal::{Journal, RunHandle};
use crate::message::{StopReason, Usage};
use crate::session::{RunSpec, RunStatus};

/// 库结构版本，记在 `PRAGMA user_version` 里。
///
/// ⚠️ **加字段就 +1 并补一段迁移**，别改老的那一段 —— 用户可能从很老的版本
/// 直接跳上来（见 `tasks` 那份的同名注释，规矩是同一个）。改老迁移段的话，
/// 一个只在别人机器上出现的问题会变成「新装的好好的、升级的炸了」。
const SCHEMA_VERSION: i64 = 1;

/// 会话记录读写失败。
#[derive(Debug)]
pub enum TranscriptError {
    /// 库文件打不开 / 建不出来。
    Open {
        /// 文件路径。
        path: String,
        /// 为什么。
        reason: String,
    },
    /// 结构迁移没跑成（文件在，但结构我们不认识）。
    Migrate {
        /// 为什么。
        reason: String,
    },
    /// 读写某一行的失败。
    Query {
        /// 为什么。
        reason: String,
    },
}

impl std::fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscriptError::Open { path, reason } => write!(
                f,
                "会话记录库打不开：{path}\n原因：{reason}\n（目录没有写权限、或者磁盘满了都会这样）"
            ),
            TranscriptError::Migrate { reason } => write!(
                f,
                "会话记录库的结构不对：{reason}\n（这个文件被别的版本或手工改过？备份之后删掉它可以从头开始）"
            ),
            TranscriptError::Query { reason } => write!(f, "会话记录读写失败：{reason}"),
        }
    }
}

impl std::error::Error for TranscriptError {}

impl From<rusqlite::Error> for TranscriptError {
    fn from(e: rusqlite::Error) -> Self {
        TranscriptError::Query {
            reason: e.to_string(),
        }
    }
}

/// 一次 run 开始时要记下来的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunHeader {
    /// 会话标识（命令层给的，同一个对话窗口下的几次 run 用它串起来）。
    pub session: String,
    /// 用户这一句。
    pub prompt: String,
    /// 这次用的上下文策略（[`crate::context::ContextStrategy::as_str`]）。
    pub strategy: String,
    /// 模型 id。
    pub model: String,
    /// provide 标识（`anthropic` / `openai`）。
    pub provider: String,
    /// 工作区路径（**只用于回看时认出来是哪份活儿**，不参与任何安全判断）。
    pub workspace: String,
}

/// 记录里的一次 run（回看列表用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSummary {
    /// 行 id。
    pub id: i64,
    /// 用户那一句。
    pub prompt: String,
    /// 用的什么策略。
    pub strategy: String,
    /// 开始时间（Unix 秒）。
    pub started_at: i64,
    /// 结束时间。**没结束（或者结束时崩了）就是 `None`** —— 别用「现在」去填，
    /// 那会让一次中断的 run 看起来像刚刚正常跑完的。
    pub ended_at: Option<i64>,
    /// 收尾状态。
    pub status: Option<String>,
    /// 累计用掉的 token。
    pub total_tokens: u64,
    /// 跑了几轮。
    pub turns: i64,
}

/// 会话记录的库。
#[derive(Debug)]
pub struct Transcript {
    conn: Mutex<Connection>,
}

impl Transcript {
    /// 打开（或者建出）一个库文件。
    pub fn open(path: &Path) -> Result<Self, TranscriptError> {
        let conn = Connection::open(path).map_err(|e| TranscriptError::Open {
            path: path.display().to_string(),
            reason: e.to_string(),
        })?;
        Self::init(conn)
    }

    /// 内存库（测试用，进程结束就没了）。
    pub fn open_in_memory() -> Result<Self, TranscriptError> {
        let conn = Connection::open_in_memory().map_err(|e| TranscriptError::Open {
            path: ":memory:".to_string(),
            reason: e.to_string(),
        })?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, TranscriptError> {
        // ⚠️ **外键在 SQLite 里默认是关的**，而且是 **per-connection** 的设置。
        // 不开的话 `ON DELETE CASCADE` 就是一段死代码：删一次 run 会留下一堆
        // 再也对不上号的 turns 行 —— 不报错，只是这个库慢慢变成垃圾。
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate(&conn)?;
        Ok(Transcript {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        // 中毒了也接着用：这里存的是记录，不是需要保持一致性的状态。
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 记一次 run 的开始，返回它的行 id。
    pub fn begin(&self, header: &RunHeader) -> Result<i64, TranscriptError> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO runs
               (session, prompt, strategy, model, provider, workspace, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                header.session,
                header.prompt,
                header.strategy,
                header.model,
                header.provider,
                header.workspace,
                now(),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 记一轮的用量。
    pub fn record_turn(
        &self,
        run: i64,
        n: usize,
        usage: &Usage,
        stop: &StopReason,
    ) -> Result<(), TranscriptError> {
        self.lock().execute(
            "INSERT INTO turns
               (run_id, n, at, uncached_input, cache_read, cache_creation_5m,
                cache_creation_1h, output, stop_reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                run,
                n as i64,
                now(),
                usage.uncached_input as i64,
                usage.cache_read as i64,
                usage.cache_creation_5m as i64,
                usage.cache_creation_1h as i64,
                usage.output as i64,
                stop_reason_str(stop),
            ],
        )?;
        Ok(())
    }

    /// 给一次 run 收尾。
    pub fn end(&self, run: i64, status: &RunStatus) -> Result<(), TranscriptError> {
        self.lock().execute(
            "UPDATE runs SET ended_at = ?2, status = ?3, detail = ?4 WHERE id = ?1",
            params![run, now(), status_str(status), status_detail(status)],
        )?;
        Ok(())
    }

    /// 最近的几次 run（界面上的历史列表）。
    pub fn recent(&self, limit: usize) -> Result<Vec<RunSummary>, TranscriptError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT r.id, r.prompt, r.strategy, r.started_at, r.ended_at, r.status,
                    COALESCE(SUM(t.uncached_input + t.cache_read
                                 + t.cache_creation_5m + t.cache_creation_1h
                                 + t.output), 0) AS total,
                    COUNT(t.id)
               FROM runs r
               LEFT JOIN turns t ON t.run_id = r.id
              GROUP BY r.id
              ORDER BY r.started_at DESC, r.id DESC
              LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(RunSummary {
                id: row.get(0)?,
                prompt: row.get(1)?,
                strategy: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                status: row.get(5)?,
                total_tokens: row.get::<_, i64>(6)? as u64,
                turns: row.get(7)?,
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 某一次 run 的每一轮（「哪个策略划算」的原始数据）。
    pub fn turns_of(&self, run: i64) -> Result<Vec<Usage>, TranscriptError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT uncached_input, cache_read, cache_creation_5m, cache_creation_1h, output
               FROM turns WHERE run_id = ?1 ORDER BY n",
        )?;
        let rows = stmt.query_map(params![run], |row| {
            Ok(Usage {
                uncached_input: row.get::<_, i64>(0)? as u64,
                cache_read: row.get::<_, i64>(1)? as u64,
                cache_creation_5m: row.get::<_, i64>(2)? as u64,
                cache_creation_1h: row.get::<_, i64>(3)? as u64,
                output: row.get::<_, i64>(4)? as u64,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}

/// 把 [`Transcript`] 接到循环上（实现 [`Journal`]）。
///
/// 运行期的那些字段（会话 id、模型、provider、工作区）不在 [`RunSpec`] 里，
/// 所以由**构造它的那一层**（命令层）带进来 —— 循环本身不该知道模型叫什么。
#[derive(Debug)]
pub struct TranscriptJournal {
    store: Arc<Transcript>,
    session: String,
    model: String,
    provider: String,
    workspace: String,
}

impl TranscriptJournal {
    /// 建一个。
    pub fn new(
        store: Arc<Transcript>,
        session: impl Into<String>,
        model: impl Into<String>,
        provider: impl Into<String>,
        workspace: impl Into<String>,
    ) -> Self {
        TranscriptJournal {
            store,
            session: session.into(),
            model: model.into(),
            provider: provider.into(),
            workspace: workspace.into(),
        }
    }
}

impl Journal for TranscriptJournal {
    fn start(&self, spec: &RunSpec) -> RunHandle {
        let header = RunHeader {
            session: self.session.clone(),
            prompt: spec.prompt.clone(),
            strategy: spec.strategy.as_str(),
            model: self.model.clone(),
            provider: self.provider.clone(),
            workspace: self.workspace.clone(),
        };
        match self.store.begin(&header) {
            Ok(id) => RunHandle(id),
            // ⚠️ 记不上不能让 run 停下来（见 `journal.rs` 的模块文档）。
            // 说一声是为了**排查得动** —— 静默失败的话，「为什么没有记录」
            // 这个问题会花掉一个人一下午。
            Err(e) => {
                eprintln!("[assistant] 记不下这次 run：{e}");
                RunHandle(0)
            }
        }
    }

    fn turn(&self, handle: &RunHandle, n: usize, usage: &Usage, stop: &StopReason) {
        // 🔢 handle 是 0 就说明 `start` 那边就没记上，别再往上撞一遍。
        if handle.0 == 0 {
            return;
        }
        if let Err(e) = self.store.record_turn(handle.0, n, usage, stop) {
            eprintln!("[assistant] 记不下第 {n} 轮：{e}");
        }
    }

    fn finish(&self, handle: &RunHandle, status: &RunStatus) {
        if handle.0 == 0 {
            return;
        }
        if let Err(e) = self.store.end(handle.0, status) {
            eprintln!("[assistant] 收不了尾：{e}");
        }
    }
}

// ---------------------------------------------------------------------- 内部

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        // 系统时钟往前调过（或者机器刚启动）—— 记 0 比 panic 强。
        .unwrap_or(0)
}

/// 收尾状态的短名。**改了老数据就对不上**，别改。
fn status_str(status: &RunStatus) -> &'static str {
    match status {
        RunStatus::Completed { .. } => "completed",
        RunStatus::Aborted { .. } => "aborted",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Failed { .. } => "failed",
    }
}

/// 为什么是这个结局（给排查用，不是给界面看的文案）。
fn status_detail(status: &RunStatus) -> Option<String> {
    match status {
        RunStatus::Completed { .. } | RunStatus::Cancelled => None,
        RunStatus::Aborted { reason } => Some(format!("{reason:?}")),
        RunStatus::Failed { message } => Some(message.clone()),
    }
}

/// `StopReason` 的短名。
fn stop_reason_str(stop: &StopReason) -> String {
    format!("{stop:?}")
}

/// 建表 / 升级。
///
/// ⚠️ 照 `tasks` 那份的规矩：
/// * 每一步都**能从任意旧版本跑上来**（用户可能从很老的版本直接跳过来）；
/// * 加列用 `ALTER TABLE ... ADD COLUMN` 带默认值，**不重建表**；
/// * 库比我们新就**明确报错**，不动它（用户降级回去过）。
fn migrate(conn: &Connection) -> Result<(), TranscriptError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if current == SCHEMA_VERSION {
        return Ok(());
    }
    if current > SCHEMA_VERSION {
        return Err(TranscriptError::Migrate {
            reason: format!(
                "这个库是更新的版本建的（结构版本 {current}，本程序只认 {SCHEMA_VERSION}）"
            ),
        });
    }

    let tx = conn.unchecked_transaction()?;
    if current < 1 {
        tx.execute_batch(
            "CREATE TABLE runs (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 session    TEXT NOT NULL,
                 prompt     TEXT NOT NULL,
                 strategy   TEXT NOT NULL,
                 model      TEXT NOT NULL,
                 provider   TEXT NOT NULL,
                 workspace  TEXT NOT NULL,
                 started_at INTEGER NOT NULL,
                 -- ⚠️ 可空是**有含义**的：空 = 这次 run 没跑完（崩了 / 被杀了）。
                 -- 别拿「现在」去填，那会让一次中断看起来像正常结束。
                 ended_at   INTEGER,
                 status     TEXT,
                 detail     TEXT
             );

             -- 每一轮的用量。这是「哪个上下文策略划算」唯一的来源，
             -- 所以四个口径分开存（合成一个总数就算不出准确成本了）。
             CREATE TABLE turns (
                 id                INTEGER PRIMARY KEY AUTOINCREMENT,
                 run_id            INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                 n                 INTEGER NOT NULL,
                 at                INTEGER NOT NULL,
                 uncached_input    INTEGER NOT NULL,
                 cache_read        INTEGER NOT NULL,
                 cache_creation_5m INTEGER NOT NULL,
                 cache_creation_1h INTEGER NOT NULL,
                 output            INTEGER NOT NULL,
                 stop_reason       TEXT NOT NULL
             );
             CREATE INDEX turns_run ON turns(run_id, n);
             CREATE INDEX runs_session ON runs(session, started_at DESC);",
        )?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    tx.commit()?;
    Ok(())
}

/// 按会话查最近的几次（界面上「这个窗口之前聊过什么」）。
impl Transcript {
    /// 某个会话下面的 run。
    pub fn runs_of_session(
        &self,
        session: &str,
        limit: usize,
    ) -> Result<Vec<RunSummary>, TranscriptError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT r.id, r.prompt, r.strategy, r.started_at, r.ended_at, r.status,
                    COALESCE(SUM(t.uncached_input + t.cache_read
                                 + t.cache_creation_5m + t.cache_creation_1h
                                 + t.output), 0) AS total,
                    COUNT(t.id)
               FROM runs r
               LEFT JOIN turns t ON t.run_id = r.id
              WHERE r.session = ?1
              GROUP BY r.id
              ORDER BY r.started_at DESC, r.id DESC
              LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session, limit as i64], |row| {
            Ok(RunSummary {
                id: row.get(0)?,
                prompt: row.get(1)?,
                strategy: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                status: row.get(5)?,
                total_tokens: row.get::<_, i64>(6)? as u64,
                turns: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 上一次 run 是哪次（恢复对话时要用）。
    pub fn latest_run_of(&self, session: &str) -> Result<Option<i64>, TranscriptError> {
        Ok(self
            .lock()
            .query_row(
                "SELECT id FROM runs WHERE session = ?1 ORDER BY started_at DESC, id DESC LIMIT 1",
                params![session],
                |row| row.get(0),
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::ContextStrategy;
    use crate::loop_runner::{AbortReason, Limits};

    fn journal() -> (Arc<Transcript>, TranscriptJournal) {
        let store = Arc::new(Transcript::open_in_memory().unwrap());
        let j = TranscriptJournal::new(
            store.clone(),
            "sess-1",
            "claude-opus-5",
            "anthropic",
            "/tmp/ws",
        );
        (store, j)
    }

    fn spec(prompt: &str) -> RunSpec {
        RunSpec {
            run_id: 1,
            system: "你是助手".into(),
            prompt: prompt.into(),
            history: vec![],
            strategy: ContextStrategy::Full,
            tools: vec![],
            limits: Limits::default(),
            max_tokens: 4096,
            journal: None,
        }
    }

    fn usage(i: u64, o: u64) -> Usage {
        Usage {
            uncached_input: i,
            output: o,
            cache_read: 10,
            cache_creation_5m: 5,
            cache_creation_1h: 2,
        }
    }

    #[test]
    fn a_run_round_trips_with_its_turns() {
        let (store, j) = journal();
        let h = j.start(&spec("看看 a.txt"));
        j.turn(&h, 1, &usage(100, 20), &StopReason::ToolUse);
        j.turn(&h, 2, &usage(200, 30), &StopReason::EndTurn);
        j.finish(&h, &RunStatus::Completed { reason: StopReason::EndTurn });

        let recent = store.recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].prompt, "看看 a.txt");
        assert_eq!(recent[0].turns, 2);
        assert_eq!(recent[0].status.as_deref(), Some("completed"));
        assert!(recent[0].ended_at.is_some(), "收尾了就该有结束时间");
        // 100+20 + 200+30 + 每轮 (10+5+2) ×2 = 384
        assert_eq!(recent[0].total_tokens, 384);

        // 每一轮单独取出来 —— 这是比较策略的那份原始数据。
        let turns = store.turns_of(recent[0].id).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].uncached_input, 100);
        assert_eq!(turns[1].output, 30);
    }

    #[test]
    fn a_run_that_never_finished_has_no_end_time() {
        // ⚠️ 这条盯的是「别拿现在去填结束时间」：一次中断的 run 要是看起来
        // 正常结束了，按它算时长会算出垃圾。
        let (store, j) = journal();
        let h = j.start(&spec("跑一半崩了"));
        j.turn(&h, 1, &usage(10, 5), &StopReason::ToolUse);
        // 不调 finish —— 模拟进程被杀

        let recent = store.recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].ended_at, None);
        assert_eq!(recent[0].status, None);
    }

    #[test]
    fn every_ending_gets_recorded_as_its_own_status() {
        let (store, j) = journal();

        let cases = [
            (
                RunStatus::Completed { reason: StopReason::EndTurn },
                "completed",
            ),
            (
                RunStatus::Aborted {
                    reason: AbortReason::BudgetExhausted {
                        used: 120,
                        budget: 100,
                    },
                },
                "aborted",
            ),
            (RunStatus::Cancelled, "cancelled"),
            (
                RunStatus::Failed {
                    message: "key 不对".into(),
                },
                "failed",
            ),
        ];

        for (status, want) in &cases {
            let h = j.start(&spec("x"));
            j.turn(&h, 1, &usage(1, 1), &StopReason::EndTurn);
            j.finish(&h, status);
            let _ = want;
        }

        let recent = store.recent(10).unwrap();
        assert_eq!(recent.len(), 4);
        let got: Vec<_> = recent.iter().filter_map(|r| r.status.clone()).collect();
        for (_, want) in &cases {
            assert!(got.contains(&want.to_string()), "少了 {want}：{got:?}");
        }
        // 中止和失败都要带上原因，否则回看时只看到「中止了」不知道为什么。
        assert!(recent.iter().all(|r| r.ended_at.is_some()));
    }

    #[test]
    fn the_strategy_is_recorded_because_that_is_the_whole_point() {
        // 这份数据存在的理由就是回答「哪个策略划算」，所以策略本身必须先记下来，
        // 而且**四种要能分开**（全量 / 滚动 / 摘要 / 检索各一行）。
        let (store, j) = journal();
        for s in [
            ContextStrategy::Full,
            ContextStrategy::Rolling { keep_last_atoms: 10 },
            ContextStrategy::Summarize { keep_recent: 5 },
            ContextStrategy::Retrieve { top_k: 3 },
        ] {
            let mut sp = spec("x");
            sp.strategy = s;
            let h = j.start(&sp);
            j.finish(&h, &RunStatus::Cancelled);
        }
        let recent = store.recent(10).unwrap();
        let names: Vec<_> = recent.iter().map(|r| r.strategy.as_str()).collect();
        for want in ["full", "rolling:10", "summarize:5", "retrieve:3"] {
            assert!(names.contains(&want), "少了 {want}：{names:?}");
        }
    }

    #[test]
    fn a_broken_handle_does_not_panic_or_write_junk() {
        // `start` 失败时给的是 0，后面的 turn / finish 必须**安静地跳过** ——
        // 拿 0 去插入会撞外键（或者更糟：写进一条对不上号的记录）。
        let (store, j) = journal();
        let h = RunHandle(0);
        j.turn(&h, 1, &usage(1, 1), &StopReason::EndTurn);
        j.finish(&h, &RunStatus::Cancelled);
        assert!(store.recent(10).unwrap().is_empty());
    }

    #[test]
    fn sessions_do_not_see_each_others_runs() {
        let store = Arc::new(Transcript::open_in_memory().unwrap());
        let a = TranscriptJournal::new(store.clone(), "a", "m", "p", "/ws");
        let b = TranscriptJournal::new(store.clone(), "b", "m", "p", "/ws");

        a.start(&spec("a 的活儿"));
        b.start(&spec("b 的活儿"));

        assert_eq!(store.runs_of_session("a", 10).unwrap().len(), 1);
        assert_eq!(
            store.runs_of_session("a", 10).unwrap()[0].prompt,
            "a 的活儿"
        );
        assert_eq!(store.runs_of_session("b", 10).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_run_takes_its_turns_with_it() {
        // ⚠️ 靠 `PRAGMA foreign_keys = ON`（SQLite 默认是关的）。
        // 不开的话这里是静默留垃圾 —— 不报错，只是库慢慢烂掉。
        let (store, j) = journal();
        let h = j.start(&spec("x"));
        j.turn(&h, 1, &usage(1, 1), &StopReason::EndTurn);

        store
            .lock()
            .execute("DELETE FROM runs WHERE id = ?1", params![h.0])
            .unwrap();

        let left: i64 = store
            .lock()
            .query_row("SELECT COUNT(*) FROM turns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "外键没生效，turns 里留了孤儿");
    }

    #[test]
    fn a_newer_schema_is_refused_rather_than_guessed_at() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        let err = Transcript::init(conn).unwrap_err();
        assert!(matches!(err, TranscriptError::Migrate { .. }));
        assert!(err.to_string().contains("99"), "{err}");
    }
}
