//! 任务库：一个 SQLite 文件 + 增删改查。
//!
//! # 为什么是 SQLite，而不是又一个 JSON
//!
//! 另外几个模块（连接档案、工作目录、启动参数）存的是**一坨整体**：读出来、
//! 改一处、整体写回去就完事，结点是「一个 JSON 文件」。
//!
//! 任务不一样，它天然是**一堆行**：要按状态筛、要按时间排、要搜标题和描述、
//! 以后还要和 agent 的执行记录**联起来查**（「这条任务是谁跑的、跑了多久」）。
//! 这些用 JSON 也能做，但每加一个维度就得在内存里重写一遍过滤和排序，
//! 而且**并发写**会丢数据（两份整体覆盖彼此）。SQLite 是这一层该用的东西：
//! 单文件、无服务端、事务、索引，三个平台都不需要用户装任何东西（`bundled`）。
//!
//! # 一个任务长什么样
//!
//! 标题 + 描述 + 状态 + 备注，就这四样（用户明确要的粒度）。**字段少才好用** ——
//! 优先级、日期、标签这些是「用起来之后发现自己需要」的东西，到时候加列很容易
//! （`user_version` 那套迁移就是为这个准备的）。
//!
//! # 时间
//!
//! 一律**毫秒时间戳（i64）**，和前端 `Date.now()` 同一个刻度 —— 这样两边
//! 不用做任何换算，也不会撞上时区和夏令时。排「最近改过的」靠 `updated_at`。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::TaskError;

/// 任务的状态。**就三档**（用户要的粒度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    /// 还没开始
    Todo,
    /// 正在做
    Doing,
    /// 做完了
    Done,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::Doing => "doing",
            TaskStatus::Done => "done",
        }
    }

    /// 从库里读回来。**不认识的当 `Todo`**：手改过的库、或者以后加了新状态
    /// 又降级回来，都不该让整个列表读不出来。
    fn from_str(raw: &str) -> TaskStatus {
        match raw {
            "doing" => TaskStatus::Doing,
            "done" => TaskStatus::Done,
            _ => TaskStatus::Todo,
        }
    }
}

/// 一条任务。字段名就是前端拿到的字段名（serde 转 camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    /// 描述：这件事到底要干什么
    pub body: String,
    /// 备注：做完之后回填的（结论、踩过的坑、下次注意什么）
    pub note: String,
    pub status: TaskStatus,
    /// 毫秒时间戳
    pub created_at: i64,
    pub updated_at: i64,
    /// 什么时候标成「完成」的。没完成就是 null
    pub done_at: Option<i64>,
    /// 归档。
    ///
    /// **和状态是两件事**：状态说的是「做没做完」，归档说的是「还要不要摆在眼前」。
    /// 完成的会先进「已完成」，用户确认不用再看了才归档 —— 归档之后默认不出现在
    /// 列表里（有「归档」那一档专门看它们），但**一条都不会删**：
    /// 回顾和「上次那件事是怎么解决的」全靠它们。
    pub archived: bool,
}

/// 一条进度记录：什么时候干了什么。
///
/// 单独一张表（`task_progress`）而不是塞进任务的一个 JSON 列：它是一对多、
/// 要按时间排、要能单独增删，而且**回顾时读的就是它**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub task_id: String,
    /// 毫秒时间戳（记下来的那一刻，**不给用户改** —— 那是这条记录的意义所在）
    pub at: i64,
    pub text: String,
}

/// 改哪些字段。`None` = 不动它（和「改成空字符串」是两件事）。
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub note: Option<String>,
    pub status: Option<TaskStatus>,
    pub archived: Option<bool>,
}

/// 各状态有多少条。侧栏和筛选器上要显示
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCounts {
    pub todo: i64,
    pub doing: i64,
    pub done: i64,
}

pub struct TaskStore {
    conn: Connection,
}

/// 当前库结构版本。**加字段/加索引时 +1，并在 [`migrate`] 里补一段** ——
/// 用户库里的数据不能因为一次升级就没了。
///
/// * v1：tasks 表
/// * v2：归档标记 + 进度记录表
const SCHEMA_VERSION: i64 = 2;

impl TaskStore {
    /// 开库（不存在就建），并把结构升到当前版本。
    pub fn open(path: &Path) -> Result<Self, TaskError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| TaskError::Open {
                path: parent.display().to_string(),
                reason: e.to_string(),
            })?;
        }

        let conn = Connection::open(path).map_err(|e| TaskError::Open {
            path: path.display().to_string(),
            reason: e.to_string(),
        })?;

        // ⚠️ 外键先开上：现在还没有第二张表，但「任务 → 执行记录」那张表迟早要来，
        // 而 SQLite 的外键**默认是关的** —— 等到那时候才想起来开，就得先怀疑
        // 一堆脏数据是从哪来的
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        // 崩溃/断电时不丢已提交的事务。桌面应用就一个进程写，性能不是瓶颈
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;

        migrate(&conn)?;
        Ok(TaskStore { conn })
    }

    /// 全部任务，**最近改过的排在前面**。
    ///
    /// 不带查询：过滤和模糊匹配在前端做（那里有和其它模块共用的那套匹配器），
    /// 而任务量级是几千条以内 —— 一次读出来比「每敲一个字往返一趟数据库」跟手。
    /// 真到了十万条那天，这里加个 `WHERE title LIKE ?` 就行（结构不用动）。
    pub fn list(&self) -> Result<Vec<Task>, TaskError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, body, note, status, created_at, updated_at, done_at, archived
             FROM tasks ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_task)?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 新建一条。标题是必须的（空标题的任务在列表里就是一行空白，谁也认不出来）
    pub fn create(&self, title: &str, body: &str) -> Result<Task, TaskError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(TaskError::BadInput {
                reason: "标题不能是空的".to_string(),
            });
        }

        let now = now_ms();
        let task = Task {
            id: new_id(now),
            title: title.to_string(),
            body: body.to_string(),
            note: String::new(),
            status: TaskStatus::Todo,
            created_at: now,
            updated_at: now,
            done_at: None,
            archived: false,
        };

        self.conn.execute(
            "INSERT INTO tasks (id, title, body, note, status, created_at, updated_at, done_at, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                task.id,
                task.title,
                task.body,
                task.note,
                task.status.as_str(),
                task.created_at,
                task.updated_at,
                task.done_at,
                i64::from(task.archived),
            ],
        )?;
        Ok(task)
    }

    /// 改一条。**没提到的字段一个都不动。**
    ///
    /// 状态改成 `Done` 时顺手记 `done_at`（改回别的状态就清掉）——
    /// 「什么时候做完的」是复盘时最常问的一个问题，而它**没法事后补**
    /// （`updated_at` 会被别的改动覆盖）。
    pub fn update(&self, id: &str, patch: &TaskPatch) -> Result<Task, TaskError> {
        let mut task = self.get(id)?;

        if let Some(title) = &patch.title {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err(TaskError::BadInput {
                    reason: "标题不能改成空的".to_string(),
                });
            }
            task.title = trimmed.to_string();
        }
        if let Some(body) = &patch.body {
            task.body = body.clone();
        }
        if let Some(note) = &patch.note {
            task.note = note.clone();
        }
        if let Some(status) = patch.status {
            if status != task.status {
                task.done_at = if status == TaskStatus::Done {
                    Some(now_ms())
                } else {
                    None
                };
            }
            task.status = status;
        }
        if let Some(archived) = patch.archived {
            task.archived = archived;
        }

        task.updated_at = now_ms();
        self.conn.execute(
            "UPDATE tasks
             SET title = ?2, body = ?3, note = ?4, status = ?5, updated_at = ?6, done_at = ?7,
                 archived = ?8
             WHERE id = ?1",
            params![
                task.id,
                task.title,
                task.body,
                task.note,
                task.status.as_str(),
                task.updated_at,
                task.done_at,
                i64::from(task.archived),
            ],
        )?;
        Ok(task)
    }

    /// 记一笔进度。**时间由我们说了算**（见 [`Progress::at`]）。
    pub fn add_progress(&self, task_id: &str, text: &str) -> Result<Progress, TaskError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(TaskError::BadInput {
                reason: "这一笔是空的".to_string(),
            });
        }
        // 任务不存在就别写 —— 外键会拦（`ON DELETE CASCADE` 保证了删任务时
        // 进度跟着走，反过来写一条孤儿记录则毫无意义）
        self.get(task_id)?;

        let now = now_ms();
        let entry = Progress {
            id: new_id(now),
            task_id: task_id.to_string(),
            at: now,
            text: text.to_string(),
        };
        self.conn.execute(
            "INSERT INTO task_progress (id, task_id, at, text) VALUES (?1, ?2, ?3, ?4)",
            params![entry.id, entry.task_id, entry.at, entry.text],
        )?;

        // 记一笔也算「动过它」—— 列表按 updated_at 排，用户记完进度应该看到它
        // 冒到最前面
        self.conn.execute(
            "UPDATE tasks SET updated_at = ?2 WHERE id = ?1",
            params![task_id, now],
        )?;
        Ok(entry)
    }

    /// 一条任务的进度，**从早到晚**（读起来就是一条时间线）。
    pub fn progress_of(&self, task_id: &str) -> Result<Vec<Progress>, TaskError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, at, text FROM task_progress WHERE task_id = ?1 ORDER BY at",
        )?;
        let rows = stmt.query_map(params![task_id], |row| {
            Ok(Progress {
                id: row.get(0)?,
                task_id: row.get(1)?,
                at: row.get(2)?,
                text: row.get(3)?,
            })
        })?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 删一条。返回「本来有没有」—— 前端可以据此决定要不要提示
    pub fn delete(&self, id: &str) -> Result<bool, TaskError> {
        let affected = self
            .conn
            .execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    pub fn get(&self, id: &str) -> Result<Task, TaskError> {
        let task = self
            .conn
            .query_row(
                "SELECT id, title, body, note, status, created_at, updated_at, done_at, archived
                 FROM tasks WHERE id = ?1",
                params![id],
                row_to_task,
            )
            .optional()?;
        task.ok_or_else(|| TaskError::NotFound {
            id: id.to_string(),
        })
    }

    pub fn counts(&self) -> Result<TaskCounts, TaskError> {
        let mut counts = TaskCounts {
            todo: 0,
            doing: 0,
            done: 0,
        };
        // ⚠️ **归档的不计**：角标和筛选器数的是「手头还有多少事」，
        // 归档的意思是「这些不用看了」—— 把它们算进去，角标就会一直挂着一个数
        let mut stmt = self
            .conn
            .prepare("SELECT status, COUNT(*) FROM tasks WHERE archived = 0 GROUP BY status")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (status, n) = row?;
            match TaskStatus::from_str(&status) {
                TaskStatus::Todo => counts.todo = n,
                TaskStatus::Doing => counts.doing = n,
                TaskStatus::Done => counts.done = n,
            }
        }
        Ok(counts)
    }
}

/// 建表 / 升级。靠 `PRAGMA user_version` 记账（SQLite 自己的文件头里就存着，
/// 不需要另外一张表）。
///
/// ⚠️ **每一步都要能从任意旧版本跑上来**：用户可能从 0.3 直接跳到 0.7。
/// 所以这里是「while version < N」的形状，而不是「if version == N-1」。
fn migrate(conn: &Connection) -> Result<(), TaskError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if current == SCHEMA_VERSION {
        return Ok(());
    }
    if current > SCHEMA_VERSION {
        // 用更新的版本开过这个库（用户降级回去）。**不动它**比乱改安全
        return Err(TaskError::Migrate {
            reason: format!("这个库是更新的版本建的（结构版本 {current}，本程序只认 {SCHEMA_VERSION}）"),
        });
    }

    let tx = conn.unchecked_transaction()?;
    if current < 1 {
        tx.execute_batch(
            "CREATE TABLE tasks (
                 id         TEXT PRIMARY KEY,
                 title      TEXT NOT NULL,
                 body       TEXT NOT NULL DEFAULT '',
                 note       TEXT NOT NULL DEFAULT '',
                 status     TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 done_at    INTEGER
             );
             -- 列表默认按 updated_at 倒序看，状态筛选也要走索引
             CREATE INDEX tasks_status_updated ON tasks(status, updated_at DESC);",
        )?;
    }
    if current < 2 {
        // ⚠️ 加列用 `ALTER TABLE ... ADD COLUMN` 并给默认值 —— 老行怎么办
        // 就靠这个默认值（归档是 0，也就是「都没归档」）。
        // **不能重建表**：用户库里有数据，重建一次就是一次数据搬迁的风险。
        tx.execute_batch(
            "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

             -- 进度记录：一条任务下面挂着的一串「什么时候干了什么」。
             -- 单独一张表而不是塞进 tasks 的一个 JSON 列：它是**一对多**，
             -- 而且回顾时要按时间排、要能被单独增删。
             CREATE TABLE task_progress (
                 id      TEXT PRIMARY KEY,
                 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 at      INTEGER NOT NULL,
                 text    TEXT NOT NULL
             );
             CREATE INDEX task_progress_task ON task_progress(task_id, at);",
        )?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    tx.commit()?;
    Ok(())
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        note: row.get(3)?,
        status: TaskStatus::from_str(&row.get::<_, String>(4)?),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        done_at: row.get(7)?,
        archived: row.get::<_, i64>(8)? != 0,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 任务 id。和时间一样是**毫秒时间戳 + 一个进程内的序号**：同一毫秒里连建
/// 几条也不会撞。序号用原子量，多线程调用也安全。
///
/// 为什么不在 Rust 侧引 uuid：就为了一个 id 引一个 crate 不划算，而这个形状
/// 已经保证了唯一性（时间 + 序号），而且**肉眼可读**（能看出是哪一刻建的）。
fn new_id(now_ms: i64) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("task_{:x}_{:x}", now_ms, seq)
}
