//! 任务库：一个 SQLite 文件 + 一个文件资料目录 + 增删改查。
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
//! 标题 + 描述 + 状态 + 一列**资料条目**。资料是这一版从「单个备注框」长出来的：
//! 一段结论、一份文档、一张截图，都是「这条任务要留着的东西」，但形态不同、
//! 而且不止一条 —— 所以是一条条挂在任务下面的（`task_attachments` 表），
//! 每条的形态要么是**文字**（直接写）要么是**文件**（拷进来的）。
//!
//! 文件**不在库里**（BLOB 会把库撑大、也没法拿系统程序打开），落在
//! `<库文件同目录>/tasks_files/<任务 id>/<资料 id>_<清洗过的原名>`：
//! 盘上的名字、库里存的名字、界面显示的名字是**同一个**，谁都能互相推出来，
//! 不撒谎。整个任务库 = tasks.db + tasks_files/，备份和搬迁一起走。
//!
//! # 时间
//!
//! 一律**毫秒时间戳（i64）**，和前端 `Date.now()` 同一个刻度 —— 这样两边
//! 不用做任何换算，也不会撞上时区和夏令时。排「最近改过的」靠 `updated_at`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

/// 一条资料的形态。**就两种**：文字（敲/粘一段）和文件（从盘上拷一份进来）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Text,
    File,
}

impl AttachmentKind {
    fn as_str(self) -> &'static str {
        match self {
            AttachmentKind::Text => "text",
            AttachmentKind::File => "file",
        }
    }

    /// 从库里读回来。**不认识的当文字**（同 [`TaskStatus::from_str`] 的理由：
    /// 读不出来比读错更糟，而文字条目没有会指向磁盘的字段，猜错的代价最小）。
    fn from_str(raw: &str) -> AttachmentKind {
        match raw {
            "file" => AttachmentKind::File,
            _ => AttachmentKind::Text,
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
    /// 这条任务挂着的资料（文字 / 文件），按加入的先后排。
    ///
    /// **跟着任务一起读**（`list()` 里一次全查出来再分组）：前端的筛选要在
    /// 附件文字和文件名里搜（「上次那件事是为什么挂的」就写在某条资料里），
    /// 而筛选是对已加载的任务在内存里做的 —— 不同步带上的话，搜索就少一块。
    /// 数量是有界的（每条任务几条），不像进度是流水账，不值得单独一趟往返。
    pub attachments: Vec<Attachment>,
    /// 这条任务下的**待办项**（小清单），按加入顺序。
    ///
    /// 和资料的分工：资料是「要留着的东西」（文档、链接、截图），待办项是
    /// **「还差哪几步」** —— 一条条勾掉的施工清单。也随 `list()` 一次分组带回
    /// （同样的理由：搜索要在待办文字里搜，前端筛选是内存里做的）。
    pub todos: Vec<TodoItem>,
}

/// 一条**待办项**：任务里的小清单条目（「先改配置」「再跑回归」）。
///
/// 单独一张表（`task_todos`）：一对多、要保序、要能单独勾/删 —— 和进度
/// 记录同一个形状的理由，区别是它**有可变状态**（done）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub task_id: String,
    pub text: String,
    pub done: bool,
    /// 毫秒时间戳（记下来的那一刻）
    pub created_at: i64,
    /// 勾掉的那一刻；取消勾选会**清回 null** —— 「什么时候干完的」只对
    /// 真干完的有意义，留着一个过期的完成时间只会骗到回顾的人
    pub done_at: Option<i64>,
}

/// 一条资料：一段文字，或者一个文件。
///
/// 两个形态共用一个结构体（而不是 enum）：字段就这几个，SQLite 那边也好映射，
/// **不适用的字段是空串/0**（和旧版 `Task.note` 用 `String` 一个路子）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub task_id: String,
    pub kind: AttachmentKind,
    /// `kind = text` 时是内容；`kind = file` 时是空串
    pub text: String,
    /// `kind = file` 时是（清洗过的）原名，盘上那份也叫这个；`kind = text` 时是空串
    pub file_name: String,
    /// `kind = file` 时是字节数；`kind = text` 时是 0
    pub file_size: i64,
    /// 毫秒时间戳
    pub created_at: i64,
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
    /// 文件资料落盘的地方：**库文件同目录的 `tasks_files/`**。
    ///
    /// 由 `open()` 收到的库路径推导 —— 这一层仍然不认识「应用数据目录」这个概念，
    /// 调用方指到哪儿，任务库就整个落在哪儿（db + 文件夹一起走）。
    files_dir: PathBuf,
}

/// 当前库结构版本。**加字段/加索引时 +1，并在 [`migrate`] 里补一段** ——
/// 用户库里的数据不能因为一次升级就没了。
///
/// * v1：tasks 表
/// * v2：归档标记 + 进度记录表
/// * v3：资料条目表（老备注搬成第一条文字资料，`tasks.note` 列随之删掉）
/// * v4：待办项表（任务里的小清单）
const SCHEMA_VERSION: i64 = 4;

/// 库文件名按**场景**分卷：默认场景是 `tasks.db`（老路径零迁移），
/// 其余是 `tasks@<场景>.db`。**纯函数**（命令层算路径时用它，测试钉着）。
///
/// 场景名不允许含 `@`/路径字符（校验在命令层），所以这里拼不出逃逸路径。
pub fn db_file_name(scenario: &str) -> String {
    if scenario.is_empty() {
        "tasks.db".to_string()
    } else {
        format!("tasks@{scenario}.db")
    }
}

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

        // 文件资料目录：跟着库文件走（见 `files_dir` 的注释）。
        // ⚠️ 名字从库文件的**主名**推（`tasks.db` → `tasks_files/`；
        // 场景分卷的 `tasks@团队A.db` → `tasks@团队A_files/`）—— 写死
        // "tasks_files" 的话，各场景的附件会挤进同一个目录（还能用，但
        // 「一个场景一个库 + 一个文件夹」这个叙事就破了）。
        // `parent()` 在极端输入（没有父的路径）下给 None，退到当前目录。
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("tasks");
        let files_dir = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{stem}_files"));

        Ok(TaskStore { conn, files_dir })
    }

    /// 全部任务，**最近改过的排在前面**。
    ///
    /// 不带查询：过滤和模糊匹配在前端做（那里有和其它模块共用的那套匹配器），
    /// 而任务量级是几千条以内 —— 一次读出来比「每敲一个字往返一趟数据库」跟手。
    /// 真到了十万条那天，这里加个 `WHERE title LIKE ?` 就行（结构不用动）。
    pub fn list(&self) -> Result<Vec<Task>, TaskError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, body, status, created_at, updated_at, done_at, archived
             FROM tasks ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_task)?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }

        // 附件/待办各一条 SQL 全查出来再按任务分组，**不是每条任务查一次**（N+1）。
        // 几百条任务也就几百行，一次读完最省事。
        let mut attachments = self.attachments_by_task()?;
        let mut todos = self.todos_by_task()?;
        for task in &mut out {
            task.attachments = attachments.remove(&task.id).unwrap_or_default();
            task.todos = todos.remove(&task.id).unwrap_or_default();
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
            id: new_id("task", now),
            title: title.to_string(),
            body: body.to_string(),
            status: TaskStatus::Todo,
            created_at: now,
            updated_at: now,
            done_at: None,
            archived: false,
            // 新任务还没有资料/待办 —— 这里给空，读回来的列表也把它算成空，
            // 「建完的对象和读回来的对象相等」这条测试才立得住
            attachments: Vec::new(),
            todos: Vec::new(),
        };

        self.conn.execute(
            "INSERT INTO tasks (id, title, body, status, created_at, updated_at, done_at, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                task.id,
                task.title,
                task.body,
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
             SET title = ?2, body = ?3, status = ?4, updated_at = ?5, done_at = ?6, archived = ?7
             WHERE id = ?1",
            params![
                task.id,
                task.title,
                task.body,
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
        self.ensure_task(task_id)?;

        let now = now_ms();
        let entry = Progress {
            id: new_id("prog", now),
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
        self.touch(task_id, now)?;
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

    // ---------------------------------------------------------------- 资料

    /// 一条任务的资料，**按加入的先后**（先加的在前）。
    ///
    /// 决胜键用 `rowid` 而不是只靠 `created_at`：id 的时间戳是毫秒级的，
    /// 同一毫秒里连加两条完全可能（手快，或者一次迁移搬进来的），
    /// 只按时间排的话顺序会在两边的实现里偶发地不一致。
    pub fn attachments_of(&self, task_id: &str) -> Result<Vec<Attachment>, TaskError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, kind, text, file_name, file_size, created_at
             FROM task_attachments WHERE task_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![task_id], row_to_attachment)?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 加一条**文字**资料。
    pub fn add_text(&self, task_id: &str, text: &str) -> Result<Attachment, TaskError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(TaskError::BadInput {
                reason: "这一条是空的".to_string(),
            });
        }
        self.ensure_task(task_id)?;

        let now = now_ms();
        let entry = Attachment {
            id: new_id("att", now),
            task_id: task_id.to_string(),
            kind: AttachmentKind::Text,
            text: text.to_string(),
            file_name: String::new(),
            file_size: 0,
            created_at: now,
        };
        self.conn.execute(
            "INSERT INTO task_attachments (id, task_id, kind, text, file_name, file_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry.id,
                entry.task_id,
                entry.kind.as_str(),
                entry.text,
                entry.file_name,
                entry.file_size,
                entry.created_at,
            ],
        )?;
        self.touch(task_id, now)?;
        Ok(entry)
    }

    /// 加一条**文件**资料：把 `src` 拷一份到本库的 `tasks_files/` 下面。
    ///
    /// 拷而不引用（用户拍板的）：原文件之后挪走、删掉都不影响这条资料，
    /// 任务库自己就是完整的。代价是同一份文件存两份 —— 文档普遍很小，值。
    ///
    /// ⚠️ 顺序是**先拷、后插行**：拷贝失败就什么都没有（不落半条记录）；
    /// 拷成功了但插行失败，把刚拷的那份删掉再报错。崩在这两步中间的孤儿文件
    /// 是接受范围内的（注释在这儿，界面上看不到它就行）。
    pub fn add_file(&self, task_id: &str, src: &Path) -> Result<Attachment, TaskError> {
        self.ensure_task(task_id)?;
        if !safe_component(task_id) {
            return Err(TaskError::File {
                path: task_id.to_string(),
                reason: "这条任务的 id 不像是本程序建的，不敢往里放文件".to_string(),
            });
        }

        let meta = std::fs::metadata(src).map_err(|e| TaskError::File {
            path: src.display().to_string(),
            reason: format!("读不到这个源文件（是不是被移走了？）：{e}"),
        })?;
        if meta.is_dir() {
            return Err(TaskError::File {
                path: src.display().to_string(),
                reason: "选中的是文件夹 —— 这里只能挂文件".to_string(),
            });
        }

        // 非 UTF-8 的原名（Linux 上可能）走 lossy —— 存进库的就是清洗后的名字，
        // 「盘上名 = 库里名 = 展示名」三者一致，谁都能互相推出来
        let orig = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let file_name = sanitize_file_name(&orig);

        let now = now_ms();
        let att = Attachment {
            id: new_id("att", now),
            task_id: task_id.to_string(),
            kind: AttachmentKind::File,
            text: String::new(),
            file_name,
            file_size: meta.len() as i64,
            created_at: now,
        };

        let dir = self.files_dir.join(task_id);
        std::fs::create_dir_all(&dir).map_err(|e| TaskError::File {
            path: dir.display().to_string(),
            reason: format!("建资料目录失败：{e}"),
        })?;

        // 盘上名 = 资料 id 前缀 + 清洗过的原名：id 保证不撞名，原名保证肉眼可认
        let dst = dir.join(format!("{}_{}", att.id, att.file_name));
        std::fs::copy(src, &dst).map_err(|e| TaskError::File {
            path: src.display().to_string(),
            reason: format!("拷贝失败：{e}"),
        })?;

        let inserted = self.conn.execute(
            "INSERT INTO task_attachments (id, task_id, kind, text, file_name, file_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                att.id,
                att.task_id,
                att.kind.as_str(),
                att.text,
                att.file_name,
                att.file_size,
                att.created_at,
            ],
        );
        if let Err(e) = inserted {
            // 拷了但没记上：把刚拷的那份删掉，别留个谁也不知道的孤儿
            let _ = std::fs::remove_file(&dst);
            return Err(e.into());
        }

        self.touch(task_id, now)?;
        Ok(att)
    }

    /// 改一条文字资料的内容。
    ///
    /// **空的不收**（同 `add_progress` 的规矩）—— 要删就用
    /// [`remove_attachment`](Self::remove_attachment)，别让「清空」变成一个
    /// 藏起来的删除动作。
    pub fn update_text(&self, id: &str, text: &str) -> Result<Attachment, TaskError> {
        let mut att = self.attachment(id)?;
        if att.kind != AttachmentKind::Text {
            return Err(TaskError::BadInput {
                reason: "这条资料不是文字，改不了".to_string(),
            });
        }
        let text = text.trim();
        if text.is_empty() {
            return Err(TaskError::BadInput {
                reason: "空的存不下去（要删掉它，用删除）".to_string(),
            });
        }
        att.text = text.to_string();

        self.conn.execute(
            "UPDATE task_attachments SET text = ?2 WHERE id = ?1",
            params![att.id, att.text],
        )?;
        self.touch(&att.task_id, now_ms())?;
        Ok(att)
    }

    /// 删一条资料（文件资料连盘上的那份一起删）。返回「本来有没有」。
    ///
    /// ⚠️ **先删行、后删文件**：反过来（先删文件、删行失败）会留下一条
    /// 指向空文件的活记录 —— 界面上就是一个打不开的坏条目。
    /// 文件那边尽力而为：删不掉（被别的程序占着）也不影响这条记录消失。
    pub fn remove_attachment(&self, id: &str) -> Result<bool, TaskError> {
        let Some(att) = self.attachment_opt(id)? else {
            return Ok(false);
        };

        let affected = self
            .conn
            .execute("DELETE FROM task_attachments WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Ok(false);
        }

        if att.kind == AttachmentKind::File {
            if let Ok(path) = self.file_path(&att) {
                let _ = std::fs::remove_file(path);
            }
        }
        self.touch(&att.task_id, now_ms())?;
        Ok(true)
    }

    /// 读一条**文件**资料的字节。`max_bytes` 是上限 —— 缩略图只需要小图，
    /// 4 GB 的一个文件不该因为一次点击就把内存打满。
    pub fn read_attachment(&self, id: &str, max_bytes: u64) -> Result<Vec<u8>, TaskError> {
        let att = self.attachment(id)?;
        if att.kind != AttachmentKind::File {
            return Err(TaskError::BadInput {
                reason: "这条资料不是文件，读不了".to_string(),
            });
        }
        let path = self.file_path(&att)?;

        // 在不在、多大 —— 都先问磁盘（库里那个 size 是拷贝那一刻的快照，
        // 盘上的那份可能已经被人动过了）
        let meta = std::fs::metadata(&path).map_err(|_| TaskError::File {
            path: path.display().to_string(),
            reason: "文件不在了（被手动删过？）".to_string(),
        })?;
        if meta.len() > max_bytes {
            // 大小换算成好读的：小文件说 KB（「0.0 MB」看着像坏掉了）
            let bytes = meta.len() as f64;
            let shown = if bytes >= 1024.0 * 1024.0 {
                format!("{:.1} MB", bytes / (1024.0 * 1024.0))
            } else {
                format!("{:.0} KB", bytes / 1024.0)
            };
            return Err(TaskError::File {
                path: path.display().to_string(),
                reason: format!("这个文件有点大（{shown}），不在这里预览；点「打开」交给系统程序"),
            });
        }
        std::fs::read(&path).map_err(|e| TaskError::File {
            path: path.display().to_string(),
            reason: format!("读取失败：{e}"),
        })
    }

    /// 一条**文件**资料在我们库目录里的最终位置 —— 给「用系统程序打开」用。
    ///
    /// 路径**只从库里那一行推出来**（前端给的是 id，不是路径）：
    /// 这就是这个模块「参数表里没有路径」那条规矩在文件上的落点。
    pub fn attachment_file(&self, id: &str) -> Result<PathBuf, TaskError> {
        let att = self.attachment(id)?;
        if att.kind != AttachmentKind::File {
            return Err(TaskError::BadInput {
                reason: "这条资料不是文件，打不开".to_string(),
            });
        }
        let path = self.file_path(&att)?;
        if !path.is_file() {
            return Err(TaskError::File {
                path: path.display().to_string(),
                reason: "文件不在了（被手动删过？）".to_string(),
            });
        }
        Ok(path)
    }

    /// 删一条。返回「本来有没有」—— 前端可以据此决定要不要提示
    pub fn delete(&self, id: &str) -> Result<bool, TaskError> {
        let affected = self
            .conn
            .execute("DELETE FROM tasks WHERE id = ?1", params![id])?;

        if affected > 0 && safe_component(id) {
            // 行删掉了，它的资料文件夹也一起清（只清**我们自己的**目录，
            // 名字不对就跳过 —— id 是从外面来的，手改过的库不该能指到别的目录上）
            let _ = std::fs::remove_dir_all(self.files_dir.join(id));
        }
        Ok(affected > 0)
    }

    pub fn get(&self, id: &str) -> Result<Task, TaskError> {
        let mut task = self
            .conn
            .query_row(
                "SELECT id, title, body, status, created_at, updated_at, done_at, archived
                 FROM tasks WHERE id = ?1",
                params![id],
                row_to_task,
            )
            .optional()?
            .ok_or_else(|| TaskError::NotFound {
                id: id.to_string(),
            })?;
        task.attachments = self.attachments_of(id)?;
        task.todos = self.todos_of(id)?;
        Ok(task)
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

    // ---------------------------------------------------------------- 内部

    /// 这个 id 上有没有任务。**比 `get()` 便宜得多**（不读附件）——
    /// 内部的存在性检查都走它，别为了「有没有」把一整份资料读出来。
    fn ensure_task(&self, id: &str) -> Result<(), TaskError> {
        let found: Option<i64> = self
            .conn
            .query_row("SELECT 1 FROM tasks WHERE id = ?1", params![id], |row| {
                row.get(0)
            })
            .optional()?;
        if found.is_none() {
            return Err(TaskError::NotFound {
                id: id.to_string(),
            });
        }
        Ok(())
    }

    /// 动过资料也算「动过它」（同 `add_progress` 的理由：列表按 `updated_at` 排）。
    fn touch(&self, task_id: &str, at: i64) -> Result<(), TaskError> {
        self.conn.execute(
            "UPDATE tasks SET updated_at = ?2 WHERE id = ?1",
            params![task_id, at],
        )?;
        Ok(())
    }

    /// 全部附件按任务分组（`list()` 用：一条 SQL 顶 N 条）。
    fn attachments_by_task(&self) -> Result<HashMap<String, Vec<Attachment>>, TaskError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, kind, text, file_name, file_size, created_at
             FROM task_attachments ORDER BY task_id, created_at, rowid",
        )?;
        let rows = stmt.query_map([], row_to_attachment)?;

        let mut map: HashMap<String, Vec<Attachment>> = HashMap::new();
        for row in rows {
            let att = row?;
            map.entry(att.task_id.clone()).or_default().push(att);
        }
        Ok(map)
    }

    // ---------------------------------------------------------------- 待办项

    /// 一条任务下的全部待办项，**按加入顺序**（created_at + rowid 决胜 ——
    /// 和附件同一个口径：同毫秒连加两条时顺序也要稳定）。
    pub fn todos_of(&self, task_id: &str) -> Result<Vec<TodoItem>, TaskError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, text, done, created_at, done_at
             FROM task_todos WHERE task_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![task_id], row_to_todo)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    fn todos_by_task(&self) -> Result<HashMap<String, Vec<TodoItem>>, TaskError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, text, done, created_at, done_at
             FROM task_todos ORDER BY task_id, created_at, rowid",
        )?;
        let rows = stmt.query_map([], row_to_todo)?;

        let mut map: HashMap<String, Vec<TodoItem>> = HashMap::new();
        for row in rows {
            let item = row?;
            map.entry(item.task_id.clone()).or_default().push(item);
        }
        Ok(map)
    }

    /// 加一条待办。文字必须非空（空待办项是一行看不见的勾选框）。
    pub fn add_todo(&self, task_id: &str, text: &str) -> Result<TodoItem, TaskError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(TaskError::BadInput {
                reason: "待办内容不能是空的".to_string(),
            });
        }
        // 任务得在（外键也会拦，但这里先给一句人话）
        let _ = self.get_task_row_only(task_id)?;

        let now = now_ms();
        let item = TodoItem {
            id: new_id("todo", now),
            task_id: task_id.to_string(),
            text: text.to_string(),
            done: false,
            created_at: now,
            done_at: None,
        };
        self.conn.execute(
            "INSERT INTO task_todos (id, task_id, text, done, created_at, done_at)
             VALUES (?1, ?2, ?3, 0, ?4, NULL)",
            params![item.id, item.task_id, item.text, item.created_at],
        )?;
        self.touch(task_id, now)?;
        Ok(item)
    }

    /// 勾/取消勾。取消勾选把 `done_at` **清回 null**（见 `TodoItem` 的注释）。
    pub fn set_todo_done(&self, id: &str, done: bool) -> Result<TodoItem, TaskError> {
        let done_at = if done { Some(now_ms()) } else { None };
        let changed = self.conn.execute(
            "UPDATE task_todos SET done = ?2, done_at = ?3 WHERE id = ?1",
            params![id, done as i64, done_at],
        )?;
        if changed == 0 {
            return Err(TaskError::NotFound { id: id.to_string() });
        }
        let item = self.todo(id)?;
        self.touch(&item.task_id, now_ms())?;
        Ok(item)
    }

    /// 改文字。
    pub fn update_todo_text(&self, id: &str, text: &str) -> Result<TodoItem, TaskError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(TaskError::BadInput {
                reason: "待办内容不能是空的".to_string(),
            });
        }
        let changed = self
            .conn
            .execute("UPDATE task_todos SET text = ?2 WHERE id = ?1", params![id, text])?;
        if changed == 0 {
            return Err(TaskError::NotFound { id: id.to_string() });
        }
        let item = self.todo(id)?;
        self.touch(&item.task_id, now_ms())?;
        Ok(item)
    }

    /// 删一条待办。
    pub fn delete_todo(&self, id: &str) -> Result<(), TaskError> {
        let item = self.todo(id)?;
        self.conn
            .execute("DELETE FROM task_todos WHERE id = ?1", params![id])?;
        self.touch(&item.task_id, now_ms())?;
        Ok(())
    }

    fn todo(&self, id: &str) -> Result<TodoItem, TaskError> {
        self.conn
            .query_row(
                "SELECT id, task_id, text, done, created_at, done_at FROM task_todos WHERE id = ?1",
                params![id],
                row_to_todo,
            )
            .optional()?
            .ok_or_else(|| TaskError::NotFound {
                id: id.to_string(),
            })
    }

    /// 任务行本身（不带附件/待办）——给「存在性」检查用。
    fn get_task_row_only(&self, id: &str) -> Result<Task, TaskError> {
        self.conn
            .query_row(
                "SELECT id, title, body, status, created_at, updated_at, done_at, archived
                 FROM tasks WHERE id = ?1",
                params![id],
                row_to_task,
            )
            .optional()?
            .ok_or_else(|| TaskError::NotFound {
                id: id.to_string(),
            })
    }

    fn attachment_opt(&self, id: &str) -> Result<Option<Attachment>, TaskError> {
        let att = self
            .conn
            .query_row(
                "SELECT id, task_id, kind, text, file_name, file_size, created_at
                 FROM task_attachments WHERE id = ?1",
                params![id],
                row_to_attachment,
            )
            .optional()?;
        Ok(att)
    }

    fn attachment(&self, id: &str) -> Result<Attachment, TaskError> {
        self.attachment_opt(id)?.ok_or_else(|| TaskError::NotFound {
            id: id.to_string(),
        })
    }

    /// 一条文件资料在盘上的位置。**唯一定义处** —— 读、开、删都从这儿拿路径，
    /// 各写各的拼法迟早会有一处拼错。
    ///
    /// ⚠️ 三段（任务 id、资料 id、文件名）都是**从库里读出来的字符串**：
    /// 手改过的库能把它们写成 `../../`，拼进路径之前一律校验。
    fn file_path(&self, att: &Attachment) -> Result<PathBuf, TaskError> {
        let ok = safe_component(&att.task_id)
            && safe_component(&att.id)
            && !att.file_name.is_empty()
            && !att.file_name.contains(['/', '\\']);
        if !ok {
            return Err(TaskError::File {
                path: format!("{}/{}", att.task_id, att.id),
                reason: "这条资料在库里的位置不对（这个库被手工改过？）".to_string(),
            });
        }
        Ok(self
            .files_dir
            .join(&att.task_id)
            .join(format!("{}_{}", att.id, att.file_name)))
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
    if current < 3 {
        // 资料条目：一条任务挂多条「文字 / 文件」。和进度同一套形状
        //（一对多子表 + 外键级联）—— 但和进度是两个语义：进度是**流水账**
        //（记了就不改），资料是**要留着的东西**（可以改、可以删）。
        tx.execute_batch(
            "CREATE TABLE task_attachments (
                 id         TEXT PRIMARY KEY,
                 task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 kind       TEXT NOT NULL,
                 text       TEXT NOT NULL DEFAULT '',
                 file_name  TEXT NOT NULL DEFAULT '',
                 file_size  INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL
             );
             CREATE INDEX task_attachments_task ON task_attachments(task_id, created_at);",
        )?;

        // ⚠️ 老备注先搬成「第一条文字资料」，**再删列** —— 顺序反过来数据就没了。
        // 纯空白的不算一条（不该变成一条看不见的空资料）。
        // 时间用任务自己的 updated_at：「最后被动过的一刻」是唯一可用的近似，
        // 比「升级那一刻」诚实。
        let now = now_ms();
        let old: Vec<(String, String, i64)> = {
            let mut stmt = tx
                .prepare("SELECT id, TRIM(note), updated_at FROM tasks WHERE TRIM(note) <> ''")?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row?);
            }
            v
        };
        for (task_id, text, updated_at) in old {
            tx.execute(
                "INSERT INTO task_attachments (id, task_id, kind, text, file_name, file_size, created_at)
                 VALUES (?1, ?2, 'text', ?3, '', 0, ?4)",
                params![new_id("att", now), task_id, text, updated_at],
            )?;
        }

        // 列没了才算搬完：从这儿起，「备注」这个概念由资料表接管
        tx.execute_batch("ALTER TABLE tasks DROP COLUMN note;")?;
    }

    if current < 4 {
        // v3 → v4：待办项表（任务里的小清单）。纯加表，没有要搬的数据。
        // ⚠️ 外键 ON DELETE CASCADE：删任务时待办跟着走（外键在 open() 里开了）。
        tx.execute_batch(
            "CREATE TABLE task_todos (
                 id         TEXT PRIMARY KEY,
                 task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 text       TEXT NOT NULL,
                 done       INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 done_at    INTEGER
             );
             CREATE INDEX task_todos_task ON task_todos(task_id, created_at);",
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
        status: TaskStatus::from_str(&row.get::<_, String>(3)?),
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        done_at: row.get(6)?,
        archived: row.get::<_, i64>(7)? != 0,
        // 附件/待办由调用方补上（list 走分组、get 走单查）—— 行映射里不做额外查询
        attachments: Vec::new(),
        todos: Vec::new(),
    })
}

fn row_to_todo(row: &rusqlite::Row<'_>) -> rusqlite::Result<TodoItem> {
    Ok(TodoItem {
        id: row.get(0)?,
        task_id: row.get(1)?,
        text: row.get(2)?,
        done: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        done_at: row.get(5)?,
    })
}

fn row_to_attachment(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        kind: AttachmentKind::from_str(&row.get::<_, String>(2)?),
        text: row.get(3)?,
        file_name: row.get(4)?,
        file_size: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// id：毫秒时间戳 + 一个进程内的序号，前缀区分是什么东西
///（`task_...` / `att_...` / `prog_...`）。同一毫秒里连建几条也不会撞，
/// 序号用原子量，多线程调用也安全。
///
/// 为什么不在 Rust 侧引 uuid：就为了一个 id 引一个 crate 不划算，而这个形状
/// 已经保证了唯一性（时间 + 序号），而且**肉眼可读**（能看出是哪一刻建的）。
fn new_id(prefix: &str, now_ms: i64) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{:x}_{:x}", now_ms, seq)
}

/// 这个字符串能不能安全地当成**一层**目录名用。
///
/// 用来拦「从库里读出来的 id 被人写成了 `../../x`」这类事：必须是恰好一层
/// 普通名字 —— 不是空的、不含任何路径分隔符（两个平台的都算）、不是 `.` / `..`。
fn safe_component(s: &str) -> bool {
    if s.is_empty() || s.contains('/') || s.contains('\\') {
        return false;
    }
    let mut comps = Path::new(s).components();
    matches!(comps.next(), Some(std::path::Component::Normal(_))) && comps.next().is_none()
}

/// 把原名清洗成「能安全落盘、也能安全交给 `cmd /C start`」的样子。
///
/// 三类字符都要换掉：
/// * Windows 非法字符 `< > : " / \ | ? *` 和控制字符 —— 不换掉在 Windows 上根本写不进盘
/// * `% ^ &` —— Windows 上打开文件走 `cmd /C start`，`%` 会被做变量展开
///   （引号也挡不住），`^` 是转义符、`&` 会拆命令
///
/// 清洗后的名字**存进库、也写进盘**：盘上名 = 库里名 = 展示名，三者一致。
fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '%' | '^' | '&')
            {
                '_'
            } else {
                c
            }
        })
        .collect();

    // Windows 上结尾的空格和点会被默默吃掉（建出来的文件名和请求的不一样），
    // 干脆我们自己先去掉；整个名字空了就退化成 "file"
    let trimmed = cleaned.trim().trim_end_matches([' ', '.']).to_string();
    if trimmed.is_empty() {
        return "file".to_string();
    }

    // 主名截到 120 字节（扩展名保住）——避开各平台路径长度上限；
    // 按字节切也要落在字符边界上（中文名的每个字是 3 字节）
    const MAX_MAIN: usize = 120;
    let (main, ext) = match trimmed.rfind('.') {
        Some(i) if i > 0 && trimmed.len() - i <= 16 => (&trimmed[..i], &trimmed[i..]),
        _ => (trimmed.as_str(), ""),
    };
    if main.len() <= MAX_MAIN {
        return format!("{main}{ext}");
    }
    let mut cut = MAX_MAIN;
    while !main.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{}", &main[..cut], ext)
}

/// 两个纯字符串函数的单测（清洗、id 校验）。
///
/// **故意不放在 `tests/` 里**：那两个文件在 Windows 上连「名字里带 `%<>` 的文件」
/// 都造不出来，集成测试里验不到这些字符；这里直接喂字符串，三个平台都能跑。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 危险字符全换成下划线() {
        // Windows 非法字符 + cmd 元字符（`%` 在 `cmd /C start` 下引号也挡不住）
        assert_eq!(
            sanitize_file_name("报告%2024^版&终稿<真的>.txt"),
            "报告_2024_版_终稿_真的_.txt"
        );
        assert_eq!(sanitize_file_name("a:b*c?d|e\"f\ng.txt"), "a_b_c_d_e_f_g.txt");
    }

    #[test]
    fn 空的和纯点空格退化成_file() {
        assert_eq!(sanitize_file_name(""), "file");
        assert_eq!(sanitize_file_name("   "), "file");
        assert_eq!(sanitize_file_name("..."), "file");
        // 结尾的点和空格会被 Windows 默默吃掉，我们自己先去掉
        assert_eq!(sanitize_file_name("名字."), "名字");
        assert_eq!(sanitize_file_name("名字  "), "名字");
    }

    #[test]
    fn 太长的截断_扩展名保住() {
        let name = format!("{}.txt", "a".repeat(240));
        let out = sanitize_file_name(&name);
        assert!(out.ends_with(".txt"), "{out}");
        assert_eq!(out.len(), 124, "主名截到 120 字节 + .txt");
    }

    #[test]
    fn 中文名按字符边界截_不切出半个字() {
        let name = format!("{}.md", "很".repeat(60)); // 主名 180 字节，超了
        let out = sanitize_file_name(&name);
        assert!(out.ends_with(".md"), "{out}");
        let main = out.trim_end_matches(".md");
        assert!(main.len() <= 120 && main.len() % 3 == 0, "{main}");
        assert!(main.chars().all(|c| c == '很'));
    }

    #[test]
    fn id_校验_只放行正好一层名字() {
        assert!(safe_component("task_abc_1"));
        assert!(safe_component("att_abc_1"));
        assert!(!safe_component(""));
        assert!(!safe_component("."));
        assert!(!safe_component(".."));
        assert!(!safe_component("a/b"));
        assert!(!safe_component("../a"));
        assert!(!safe_component("a\\b"), "反斜杠在 Windows 上也是分隔符");
    }
}
