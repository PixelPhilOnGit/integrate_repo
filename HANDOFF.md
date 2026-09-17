# Devtoolkit 交接文档

> 写于 2026-09-17。接手前先读这一份，比读代码快。
>
> 这一天的三件事按顺序是：**模块化重构 + 改名** → **Redis 模块（含改成浏览式）**
> → **SQL 模块**。README 讲「是什么、怎么用」，这一份讲「为什么是这样、哪里会坑」。

---

## 一句话状态

**三个模块（顺序图 / Redis / 数据库）都可用，架构被三个真实模块验证过了。**
SSH 没开始做。凭据是明文存储（用户明确选的），上生产前必须换钥匙串。

---

## 现在能做什么

### 顺序图（完整）

选本地文件夹当工作区、目录树（建子目录/重命名/拖拽/右键菜单）、画 UML 顺序图
（六种参与者、四种消息、激活条、注释）、直接操作（拖消息两端改收发方、
拖激活条下边缘截断）、撤销重做、主题、导出 SVG / PNG / Mermaid。

### Redis（浏览式）

侧栏「连接 → 库（带 key 数）」→ 主区 key 列表（类型标签、pattern 过滤、滚动加载）
+ 选中 key 的值（按类型换渲染：string 原文 / list 有序表 / hash 键值表 / zset 带分数）。
命令台收成一个页签。`` `AUTH` `` 的回显会打码。

> 这个模块的界面**返工过一次**。第一版把命令台当主界面，用户的原话是
> 「体验不如 redis 常见的客户端，不需要那么多功能，基本能看到 db0、db1 这些，
> 可以选择，选择后可以展示一些基本已有的 key 给我」——
> 指出的是**主次关系反了**：命令台假设用户已经知道要敲什么，而 GUI 客户端
> 恰恰是要替用户省掉这件事。见「设计决定」一节。

### 数据库（MySQL + PostgreSQL 合一）

连接配置里选引擎。侧栏「连接 → 库 → 表」（**表缩进在当前库底下**），
点一张表生成 `SELECT * FROM 表 LIMIT 100`；主区 SQL 编辑器（Ctrl+Enter 执行、
Alt+↑↓ 翻历史）+ 结果表格。NULL 和空串在视觉上分得开。

---

## 怎么跑起来

```bash
npm install
npm run dev          # 浏览器版（不需要任何系统依赖，最容易跑起来）
npm run tauri:dev    # 桌面版（需要 Rust + 系统 WebView 依赖，见 README）
```

**浏览器版不是玩具**：headless 环境起不了原生窗口，Playwright 全靠它驱动。
所以每个连接类模块都自带一份**足够真的假实现**（假 Redis 有五种类型和演示数据，
假 SQL 引擎能真的执行 `SELECT * FROM 用户`）。对着写死的假数据断言等于自欺。

```bash
npm run typecheck    # 类型检查
npm test             # 492 个纯逻辑单测（秒级）
npm run test:e2e     # 114 个端到端测试（真实 Chromium）
cd src-tauri && CARGO_BUILD_JOBS=2 cargo test   # 141 个 Rust 测试
```

### ⚠️ 跑测试/编译之前必读

```bash
nice -n 19 ionice -c3 env CARGO_BUILD_JOBS=2 cargo test
```

- **这台机器只有 2 核**。cargo 会把两个核吃满，code-server（Node）抢不到 CPU
  就会掉线。套 `nice` 让交互式会话永远优先。
- **不要并发跑多个构建**。
- **`CARGO_BUILD_JOBS=2` 不是可选项**，默认并行度会 OOM。
- 跑完测试**检查有没有残留的数据库进程**（见「踩过的坑」里那段惨案）。

### Rust 测试要装服务端

```bash
sudo apt-get install -y redis-server postgresql mysql-server
```

集成测试**自己拉起随机端口、不落盘的真实例**，`Drop` 时杀掉。没装会明确报错
并给安装命令，**不会静默跳过**（静默跳过等于这些测试永远不跑而没人发现）。

> SQL 那套还要求测试进程能切到 `postgres` / `mysql` 系统用户 ——
> 这两个引擎拒绝以 root 运行，夹具靠 `CommandExt::uid/gid` 降权。

---

## 架构

```
src/
├── shared/        通用层
│   └── connections/   三个连接类模块共用的连接层
│                      ★ 不 import 任何模块
├── shell/         外壳：模块注册表、图标栏、状态栏、错误条
│                  ★ 不认识任何具体模块，只认 Module 接口
└── modules/
    ├── diagram/   顺序图
    ├── redis/     Redis
    ├── sql/       数据库
    └── devplaceholder/  占位（验证「加模块 = 一个目录 + 一行」）
```

```
src-tauri/
├── src/         commands.rs（文件）/ redis_commands.rs / sql_commands.rs
├── core/        devtoolkit-core：路径安全 + 文件操作
├── redis/       devtoolkit-redis：连接管理、命令执行、回复解析
└── sql/         devtoolkit-sql：MySQL / PostgreSQL 连接与查询
```

三个 crate 都**不依赖 tauri**，所以能脱离 WebKit/GTK 跑测试（含打真服务端的集成测试）。

### 加一个模块要做什么

**写一个目录 + `src/shell/registry.ts` 加一行。**

```ts
export const MODULES = [diagramModule, redisModule, sqlModule, devPlaceholderModule];
```

接口在 `src/shell/types.ts` 的 `Module`。**三个真实模块都是这么加上去的**，
外壳和 `shared/platform/` 一行没改 —— 这条承诺是被验证过的，不是口号。

> ⚠️ 注册表顺序 = 图标栏顺序 = `Ctrl+1..4` 的顺序，**是面向用户的**。
> 另外 `main.tsx` 的 `defaultExtension` 取 `MODULES[0]`，顺序图必须留在第一位。

### 模块自己带平台桥

`shared/platform/` 只提供「文件操作 + 系统对话框」这类所有模块都可能用的能力。
**具体模块的网络能力不放进共享层**（那会让共享层认识具体模块）——
每个连接类模块自带 `services/`（接口 + tauri 实现 + 浏览器实现），
共享的只有 `shared/connections/` 里那点通用的东西。

---

## 抽了什么、刻意没抽什么

### 抽了（`shared/connections/`，三个消费者）

| 东西 | 为什么现在就对 |
|---|---|
| `kv.ts`：`KeyValueStore` + tauri/localStorage 两实现 | 接口 100% 通用，零模块概念 |
| `profiles.ts`：`createProfileStore<T>` + 整形 helper | **最强论据是凭据**：明文密码读写收拢一处，将来换钥匙串**一次覆盖三个模块**而不是改三遍 |
| `types.ts`：`ConnStatus` / `WithoutSeq` / `ConnectionRuntime<Info>` | 纯类型，泛型化后无模块知识 |
| `ConnectionRow`：连接行 + 折叠箭头 + 右键钩子 | 三个模块的行长得一样 |

### 刻意**没**抽（不是遗漏）

- **通用 TreeView**：文件树是「同步全量」的，而 key 树/表树要**异步懒加载**，
  接口形状会被推翻。等真凑齐三个消费者再抽。
- **连接状态机工厂**：现在 Redis 和 SQL 各写了一份 store，有重复。
  **等 SQL 的 store 也稳定下来，把两份并排对比之后再抽** —— 那时候的抽象才有依据。
  现在抽是凭猜测设计。
- **命令台整套**（分词/渲染/历史/脱敏）：Redis 专属。

### 文件类型通用化：**触发条件变了**

之前写的是「第一个模块落地时把 `list_tree` 扩展名参数、`create_file` 泛化、
`rename_entry` 假设、`FileTree` 注入类型描述符这四条做掉」。

**Redis 和 SQL 都落地了，四条一条都没做，而且是对的**：这两个都是**网络模块，
根本不碰文件树**。当初推迟的理由是「第二个模块还没影，抽象是凭猜测设计的」；
现在有影了，但它不经过文件层 —— **抽象仍然只有一个消费者**。

**新的触发条件：等第一个需要往工作区列别的文件类型的模块出现时再做。**
（比如「Markdown 笔记」「HTTP 请求集合」。）在那之前照着
`modules/diagram/core/fileType.ts` 抄一遍就是，别去抽公共的。

---

## 验证到什么程度

| 层 | 数量 | 状态 |
|---|---|---|
| 前端单测 | 492 | ✅ |
| e2e | 114 | ✅（18 SQL、15 Redis、7 外壳、其余顺序图） |
| Rust | 141 | ✅（35 SQL + 50 Redis 打真服务端，其余纯逻辑） |

### 真机验证做过的

- **Redis**：Xvfb 里跑 release 二进制连真 `redis-server`。界面上显示的
  `Redis 7.0.15` 是从真实 `INFO server` 解析出来的；`SET "名字" "张三"` → `GET` 回来
  `"张三"`；`KEYS *` 列出了用 `redis-cli` 塞进去的 key；敲错命令是红字内联、
  **没弹外壳错误条**；`AUTH 超级机密` 回显成 `AUTH ••••••`。
- **SQL**：连真 PostgreSQL 16，点「用户」表生成查询、执行、`3 行 · 耗时 0ms`，
  列头带真实类型（`id int4` / `注册时间 timestamptz`），王五那行的 `(NULL)` 是灰色斜体。
- **Redis 改版后**：连真 Redis，侧栏列出 db0..db15 及各库 key 数，点 db1 切库、
  状态栏库号跟着变、hash 渲染成两列表格。

### 没验证到的

- **Windows / macOS 安装包**：这台 Linux 打不了。`release.yml` 配好了，推 `v*` tag 触发。
- **`.deb` 重新打包**：这一轮没打（打包配置没动）。
- **CI 上的新东西**：release.yml 加了装 `redis-server` 的步骤、测试扩到 redis crate，
  但没在真实 GitHub runner 上跑过。
  ⚠️ **`Cargo.lock` 必须和 `Cargo.toml` 一起提交**（CI 用 `--locked`），本轮已同步。

---

## ⚠️ 踩过的坑（省得你再踩）

### 最容易骗到自己的那个

- **跑 release 二进制之前先把 dev server 关掉。**
  `Cargo.toml` 里少了 `[features] custom-protocol`（本轮已补），release 二进制就
  **不内嵌前端产物**，而是去连 `devUrl`（localhost:5173）。
  后果是**开发机上它永远是"好的"** —— 只要 dev server 开着，UI 就是最新的那份。
  之前几次「真机冒烟」其实连的都是 dev server，根本没测到内嵌产物。
  装到用户机器上就是**一片白**。

  验证打包产物要这样：
  ```bash
  pkill -f 'vit[e]'                       # 先关 dev server，否则测的不是打包产物
  npx tauri build --no-bundle
  xvfb-run -a --server-args="-screen 0 1440x900x24" ./src-tauri/target/release/devtoolkit
  ```
  判断依据：带 `custom-protocol` 的二进制会**大 10 万字节左右**。

### 这台机器的 shell 陷阱

- **`pkill -f '<模式>'` 会匹配到它自己的命令行**，把正在跑的那条 shell 一起杀掉。
  表现是「退出码 144、没有任何输出」，看起来像环境崩了。
  解法：让模式不自匹配 —— `pkill -f 'vit[e]'`、`pkill -f 'devtoolk[i]t'`。
  > 这一天在这上面栽了四五次，包括在 python 脚本里筛进程时又栽了一次
  > （脚本自己的命令行里带着匹配串）。**要筛进程就把脚本写进文件**。
- **`cmd | tail` 会把退出码吃掉**（`$?` 是管道最后一个命令的）。编译失败时照样显示
  `exited with code 0`。用 `set -o pipefail` 或 `${PIPESTATUS[0]}`。
- **cargo 镜像配在 `/root/.cargo/config`（无扩展名）**，它**优先于** `config.toml`。
  往 `config.toml` 写东西会被静默忽略。现成配的是阿里云稀疏索引，可用，**别动**。

### 数据库测试夹具（血泪）

- **收尾必须杀整个进程组**：数据库是 shell `&` 出来的子进程，只杀 shell 会留孤儿。
  **而且不能写 `kill -KILL -12345`** —— procps 的 kill 把它当选项解析，一个都杀不掉。
  要用 `sh -c "kill -9 -<pgid>"`。
  > 漏过两轮孤儿进程（第二次 12 个 mysqld），把机器吃到只剩 500M，
  > **用户的 code-server 会话被反复踢下线**。
- **启动失败之后不要再重试**：`OnceLock::get_or_init` 在闭包 panic 之后不缓存，
  每个后续用例都会再起一个实例 —— 形成「越起越慢、越慢越超时、越超时越起」
  的死亡螺旋。夹具里加了原子计数器，失败一次就不再重试。
- **两个引擎都拒绝以 root 运行**，要 `CommandExt::uid/gid` 降权 + 先 chown 数据目录。
- **`mysqld --initialize-insecure` 建的 root 是 `root@localhost`，只认 unix socket**。
  直接走 TCP 会报 `ERROR 1130: Host '127.0.0.1' is not allowed to connect`。
  夹具先用 socket 建一个 `root@'%'`。

### 驱动细节

- **PostgreSQL 的 `SimpleColumn` 只有列名、没有类型**，而且**零行的 SELECT
  连 RowDescription 都不给**。类型名要单独走一次 `prepare`（纯元数据往返）补上。
- **PG 的 `Error::to_string()` 对引擎报错只给 `"db error"`**，原因在 `DbError` 里，
  要把 severity/message/detail/hint 拼出来。
- **多语句要按语句分开收行**：`SELECT 1; SELECT 2` 混在一起会变成「两行」。
  另外只有**没产出行**的语句才把 `CommandComplete` 的数当影响行数。
- **MySQL 的 DATE 和 DATETIME 在协议上长得一样**，得看列类型才分得出
  `2026-09-17` 和 `2026-09-17 00:00:00`；TIME 可以超过 24 小时（值里带 days）。
- **递归 CTE 默认上限 1000**（`cte_max_recursion_depth`）。
- **redis crate 只能用 0.32.x，不能用 1.x** —— 1.x 的 MSRV 是 1.88。
  现在 `rust-version` 已经提到 1.89，那个理由不成立了，但 0.32 已经跑通并被覆盖，
  升级是普通的升级任务，没有坑。
- **`Value::ServerError` 不是 `Err`**：`send_packed_command` 返回原始回复树，
  服务器错误在里面是一个 `Value`；而 `query_async` 会**递归**把嵌在数组/Map 里的
  错误也提成 `Err`。命令台要的是前者。
- **`MultiplexedConnection` 在 `redis::aio` 下**，不在 crate 根。
- **`MutexGuard` 跨 await 会编译不过**（future 不是 `Send`）。做法是 clone 出连接、
  guard 当场释放。

### 前端

- **`noUncheckedIndexedAccess` 开着**，`arr[i]` 一律是 `T | undefined`。
  字符串用 `charAt()`；数组老老实实判空。
- **`Omit<联合类型, K>` 会把各分支的独有字段全丢掉**，要写
  `T extends unknown ? Omit<T, K> : never`（见 `WithoutSeq`）。
- **CSS 类名先 grep 再用**：`.rd-dot` 已经被文件树占了（还带 `margin-left: auto`），
  直接复用会撞车。
- **`justify-content: space-between` 是个陷阱**：子元素个数一变，排布就变。
  SQL 的库行本来只有「名字 + key 数」两个，加了折叠箭头之后**名字被挤到了右边**。
  而且子行的缩进如果没超过父级名字的位置，看起来就是并列的兄弟节点
  （实测两边都在 x=100）。**这类布局 bug 要靠量几何才看得出来**，肉眼容易放过。
- **`.rd-content` / `.rd-body` 必须是"布局透明"的**（`flex: 1; min-height: 0`），
  忘了会让工具栏和主区域尺寸漂移。

---

## 设计决定（几条不那么显然的）

- **激活条锚定消息 id，不是坐标** —— 拖消息时自动跟随，删消息时自动清理
- **`participants` 按 x 有序、`messages` 按 y 有序是强制不变量**
- **缩放改 `viewBox` 不用 CSS transform** —— 后者把矢量文字变成位图
- **内联编辑用 `<textarea>` 浮层，不用 `foreignObject`** —— macOS 输入法候选框问题
- **网络客户端放 Rust 侧** —— CSP 的 `connect-src` 敞不开，前端直连会被拦
- **服务器/引擎报错是「一条结果」，不是「执行失败」** —— Redis 的
  `-ERR unknown command` 和 SQL 的表不存在都内联显示在结果区里，**不弹外壳错误条**。
  判反了的话，敲错一个命令就会把连接显示成断开。三个模块都有守门测试盯着这条。
- **浏览优先，不是命令台优先** —— 见 Redis 那节。SQL 也遵循同一条：
  连上就自动列出库和表，点表生成查询。
- **命令参数逐个塞进 `Cmd` / 走驱动 API，绝不拼字符串** —— 否则就是协议注入
- **切模块不断开连接** —— 连接是廉价且用户预期跨模块存活的资源

---

## 环境变更（这台机器）

1. **装了服务端**：`redis-server` 7.0.15、`postgresql` 16、`mysql-server` 8.0.46
   （集成测试要用）。另外 `openssh-server` 本来就在。
2. **code-server 改成 HTTPS**（上一轮做的，仍有效）：自签证书在
   `~/.config/code-server/rustdraw.crt`。原因是 `http://` 不是安全上下文，
   `navigator.clipboard` 不可用。重启用 `systemctl restart code-server`。
   > ⚠️ **密码还是 `123456`，端口公网可达**。建议换掉或只监听 127.0.0.1。
3. **cargo 镜像不用配** —— `/root/.cargo/config` 早就有阿里云镜像了。
   曾经往 `~/.cargo/config.toml` 写过一份，发现被静默忽略（无后缀的优先），已删。
4. 系统里跑着一个 apt 装的 `mysqld`（监听 3306），不是测试起的。
   测试用的实例都带 `--datadir=/tmp/devtoolkit-sql-test-*` 标记，好区分。

---

## 下一步：SSH 终端

用户明确要的下一个。范围也定了：

- **完整终端**（xterm.js + PTY），不是「执行一条命令看输出」
- 实现用**纯 Rust 的 `russh`** —— 换来三平台打包不用装系统库，
  代价是 69 个直接依赖、编译慢。**开工前先量一次真实编译耗时。**

⚠️ **主机密钥必须做 TOFU（首次信任）并持久化指纹**，指纹变了要明确告警。
一个静默接受任何主机密钥的 SSH 客户端就是 MITM 的靶子 —— 这条不能省。

注意 SSH 的数据流模型和前面三个**完全不同**：不是请求-响应，而是长连接上的
双向流（读循环 → 事件推给前端；写/resize/关闭走 command）。
前三个模块的 store 形状套不上，得重新想。

之后还有：MongoDB。

### ⚠️ 上生产之前必须解决的：凭据存储

现在连接密码是**明文**存进各模块的 json 文件（桌面端）或 localStorage（浏览器版）——
用户明确选了这条路（沿用工区路径那套「先明文、标记待改」）。

读写收敛在一处：**`src/shared/connections/profiles.ts`**。
那里的注释写了迁移到系统钥匙串的三步。**因为三个模块共用这一份，
迁移一次就覆盖全部**，这是当初抽共享层的主要理由。

真正拿它连生产环境之前必须换掉 —— 否则等于把密码摊在文件系统上，
任何能读你文件的进程都能拿到。

---

## 代码规模（参考）

| | 行数 |
|---|---|
| 前端 `src/` | ~13.3k |
| Rust `src-tauri/` | ~6.6k |
| 测试 `tests/` | ~7.4k |

提交历史（`git log --oneline`）按 feature 拆得比较干净，
每个提交的 message 里都写了「为什么这么做」和踩到的坑，值得一读。
