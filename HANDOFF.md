# Devtoolkit 交接文档

> 初版写于 2026-09-17（模块化重构），同日晚些时候补入 Redis 模块。
> 接手前先读这一份，比读代码快。

---

## 这是什么

一个**开发者工作台**桌面应用：把平时要开好几个软件才干完的事收进一个程序里。

技术形态是 **[Tauri 2](https://v2.tauri.app/)**：Rust 进程提供系统能力（文件、网络连接），
它内嵌一个系统 WebView 渲染界面。前端是 React 19 + TypeScript + Vite。

**当前有两个可用模块：顺序图编辑器、Redis 客户端。** MySQL/PostgreSQL、SSH 还没开始做。

---

## 现在能做什么

### 顺序图模块（完整可用）

- 选一个本地文件夹当**工作区**，左侧是目录树（可建子目录分类、重命名、拖拽移动、右键菜单）
- 画 UML 顺序图：参与者（人形/对象/边界/控制/实体/数据库）、生命线、
  四种消息（同步/异步/返回/自调用）、激活条、注释
- **直接操作**：从生命线拖出消息、拖消息两端改收发方、拖激活条下边缘截断、
  右键菜单、双击内联编辑（中文输入法正常）
- 撤销重做、快捷键、主题自定义
- 导出 **SVG / PNG / Mermaid**

### Redis 模块（纵向切片：连接 + 命令台）

- 保存多个**连接**（增删改、连接/断开、状态点），档案落盘、重启还在
- **命令台**：输入命令 → 执行 → 结果按 redis-cli 的记号渲染
  （`(integer) 1` / `"value"` / `(nil)` / `(error) ERR ...`，数组逐项编号、嵌套缩进）
- ↑↓ 翻命令历史，Ctrl+L 清屏，`AUTH` 回显自动打码
- 故意**不做**的：key 浏览器（SCAN 列表/看值）、集群、pub/sub、哨兵。
  这是用户拍板的范围。

打包成 Windows / macOS / Linux 安装包。

---

## 怎么跑起来

```bash
npm install

npm run dev          # 浏览器版（不需要任何系统依赖，最容易跑起来）
npm run tauri:dev    # 桌面版（需要 Rust + 系统 WebView 依赖，见 README）
```

**浏览器版不是玩具**：它是整个自动化验证链路的前提。headless 环境里没法启动原生窗口，
Playwright 靠它才能驱动完整的编辑器逻辑。

```bash
npm run typecheck    # 类型检查
npm test             # 407 个纯逻辑单测（秒级）
npm run test:e2e     # 85 个端到端测试（真实 Chromium）
cd src-tauri && CARGO_BUILD_JOBS=2 cargo test   # 82 个 Rust 测试
```

> `CARGO_BUILD_JOBS=2` 不是可选项：这台机器 2 核 3.6G，默认并行度会 OOM。

Redis 那部分 Rust 测试**要机器上装了 `redis-server`**（见「环境变更」）。它们会自己
拉起一个随机端口、不落盘的真实例，`Drop` 时杀掉。没装的话会明确报错并给安装命令，
不会静默跳过。

---

## 架构（一分钟版）

```
src/
├── shared/       通用层：几何、id、文字测量、撤销栈、平台桥、通用组件
│                 ★ 不 import 任何模块
├── shell/        外壳：模块注册表、图标栏、状态栏、错误条
│                 ★ 不认识任何具体模块，只认 Module 接口
└── modules/
    ├── diagram/        顺序图（全部功能都在这）
    ├── redis/          Redis 客户端
    └── devplaceholder/ 占位模块，验证架构用
```

**核心原则：外壳只负责"把当前模块画出来"和"显示状态/错误"，其余全归模块。**

每个模块自己持有自己的 store。模块之间不通过外壳通信，外壳也不替模块存业务状态。
唯一一处「同时认识外壳和模块」的地方是 `src/main.tsx`（组合根）。

### 加一个模块要做什么

**写一个目录 + 在 `src/shell/registry.ts` 加一行。**

```ts
// src/shell/registry.ts
export const MODULES = [diagramModule, redisModule, devPlaceholderModule];
```

接口定义在 `src/shell/types.ts` 的 `Module`：`id / name / icon / Toolbar? / Sidebar /
Main / Inspector? / StatusItems? / platform / onActivate? / onDeactivate?`。

**Redis 模块验证了这条承诺的更强形式**：它需要一个全新类别的能力（网络），
而外壳和 `shared/` **一行都没改**。它自己带了一套服务层
（`modules/redis/services/`：接口 + tauri 实现 + 浏览器实现），结构和
`shared/platform/` 一样，只是归模块所有。

> 注册表里的顺序 = 图标栏顺序 = `Ctrl+1/2/3` 的顺序，所以它**是面向用户的**。
> 另外 `main.tsx` 的 `defaultExtension` 取的是 `MODULES[0]`，顺序图必须留在第一位，
> 否则「新建文件」的默认后缀会变空。

---

## 这次（2026-09-17）做了什么

### 前半程：重构成「外壳 + 模块」

1. **新建 `shared/` 层** —— 把 `geometry / ids / text / history / 平台桥 / ContextMenu / exportSvg`
   搬进去。搬之前先解掉三处耦合
2. **搬 28 个文件** 进 `modules/diagram/`
3. **建 `shell/`** —— 注册表、模块接口、图标栏、外壳 store、AppShell
4. **拆掉 `App.tsx`** —— 内容分给 `shell/AppShell.tsx` 和 `modules/diagram/DiagramModule.tsx`
5. **加占位模块**，验证"加模块 = 一个目录 + 一行"
6. **改名 Devtoolkit 0.2.0**（原 rustDraw 0.1.0）

搬之前解掉的三处耦合：

| 问题 | 修法 |
|---|---|
| `platform/web.ts` 反向依赖画图模块（`seed()` 硬编码了顺序图示例文档） | 平台层暴露种子注入点，模块通过 `Module.platform` 声明 |
| `Diagram.tsx` / `InlineEditor.tsx` 从 store 导入类型 | 类型下移到 `modules/diagram/types.ts` |
| `exportSvg` / `history` 绑死画图的 `Theme` / `Doc` | 前者参数化成 `css + backgroundColor + bounds`，后者泛型化成 `History<T>` |

### 后半程：第二个模块（Redis）

按顺序图那套架构把 Redis 落下来，跑通「连接 → 执行 → 展示结果」。分五步：

1. **`Selection` 等类型真正下移**到 `modules/diagram/types.ts`（上一轮留的尾巴），
   消掉 `render/` 从 store 导类型这处原则违反
2. **新 crate `src-tauri/redis/`**（`devtoolkit-redis`，不依赖 tauri）：
   连接管理、命令执行、回复解析。集成测试自己拉起真 `redis-server` 来打
3. **Tauri 命令层** `src-tauri/src/redis_commands.rs`：三个薄封装
   （`redis_connect` / `redis_disconnect` / `redis_exec`）
4. **前端纯逻辑** `modules/redis/core/`：分词、回复渲染、历史、校验、脱敏、
   内存假 Redis —— 全部可在 node 下单测
5. **服务层 + UI + e2e**

### 有意推迟的：文件类型通用化（**理由变了，注意**）

上一版交接文档写着「**第一个模块落地时**，要顺手把这些通用化做掉」——
`list_tree` 加扩展名参数、`create_diagram` 泛化成 `create_file`、
`rename_entry` 里「文件即图文件」的假设、`FileTree` 注入「文件类型描述符」。

**Redis 落地了，但这四条一条都没做，而且是对的**：Redis 是**网络模块，根本不碰文件树**。
当初推迟的理由是「第二个模块还没影，抽出来的抽象是凭猜测设计的」；
现在第二个模块有影了，但它不经过文件层 —— **抽象仍然只有一个消费者，仍然缺需求验证**。

所以触发条件应该改成：**等第一个需要往工作区列别的文件类型的模块出现时再做**。
（比如「Markdown 笔记」「HTTP 请求集合」这类。）在那之前，
`fileType.ts` 那套三件套（`extension / isListable / displayName`）就是唯一消费者，
照着它抄一遍就是，别去抽公共的。

---

## 验证到什么程度

| 层 | 数量 | 状态 |
|---|---|---|
| 前端单测 | 407 | ✅ 全过 |
| e2e | 85 | ✅ 全过（含 13 条 Redis、7 条外壳） |
| Rust | 82 | ✅ 全过（含 21 条打真 Redis 的集成测试） |
| 打包 | — | ✅ 见下 |

重构本身做过**像素级验证**：搬 28 个文件、拆掉 `App.tsx` 建起整个外壳之后，
5 张基准截图 **0 像素差异**。基准截图脚本在 `scripts/baseline-screenshots.mjs`，
改动界面后跑一遍对比，肉眼可见的差异就说明改坏了。

> 脚本里有一段**等字体加载**的等待，别删。dev server 冷启动时第一帧可能拍到字体回退状态，
> 和后续跑出来差几十像素，会让人误以为改坏了代码。（实测：同代码连跑两次 0 差异，
> 冷启动那一次差 69 像素。）
>
> 注意它是**手动对比**工具，不做自动像素 diff。

**加 Redis 模块时刷新过一次基线**（`/tmp/baseline/`，2026-09-17 15:47）。
刷新前那份是**外壳重构之前**的 —— 界面还叫 rustDraw、图标栏根本不存在，
内容区从 x=0 开始。拿它对比会看到整幅图「到处都不一样」，
而实际原因是内容区整体右移了 46px（图标栏的宽度）。**别被它误导**：
对不上不等于改坏了，先确认手上那份基准是哪个年代的。

新增模块这类改动刷新基线时，除了肉眼比对，还有个更硬的检查：
**新加的 CSS 类是不是只被新模块引用**。

```bash
grep -rl 'rd-conn-\|rd-console' src/ | grep -v '^src/modules/redis/'   # 应该没有输出
```

没有输出就说明新样式不可能影响老模块；再加上「只往 `styles.css` 尾部追加、
不改任何已有规则」，老模块的渲染结果就是不变的（顺序图那 72 条 e2e 也覆盖着）。

### 这次又逮到三个真 bug（测试写对了的证明）

值得记下来，因为它们说明「哪些测试值得写」：

1. **`createProfile` 只设了 `selectedId`，忘了把新档案加进 `profiles`** ——
   点了「新建」什么都不会发生。**e2e 逮到的**，而我当时还没写 store 单测。
   补上 `tests/unit/redis-store.test.ts` 之后这类 bug 才有一层拦截。
2. **翻历史翻到底时，还回去的是历史里那条命令而不是用户自己的草稿** ——
   因为翻页过程本身在改 `draft`。补了 `historyDraft` 字段单独存。
   **e2e 逮到的**，store 单测当时那条用例的草稿是空的，漏了。
3. **`connect` 里只检查 `send_packed_command` 有没有 `Err`** ——
   服务器回 `-NOAUTH` 时返回的是 `Ok(Value::ServerError(..))`，
   于是没通过认证的连接会被当成建连成功。写测试时发现的。

### 真机 + 真 Redis 冒烟（做过了）

在 Xvfb 里跑 release 二进制、连着**真的 `redis-server`**（另起一个实例在 6399，
避免碰到 6379 上那个不知来路的进程），用 xdotool 点图标 → 新建连接 → 改端口 → 连接 → 敲命令，
全程截图确认：

- 界面上显示的 `Redis 7.0.15` 是从真实 `INFO server` 里解析出来的 → 整条 Rust 链路通
- `PING` → `PONG`；`SET "名字" "张三"` → `OK`；`GET "名字"` → `"张三"`（中文真值往返）
- `KEYS *` 列出了用 `redis-cli` 塞进去的 key → 确实读的是真服务器
- `FLY_TO_MARS` → 红字 `(error) ERR unknown command ...` 内联在日志里，
  **没有弹外壳错误条**，连接存活
- `AUTH 我的超级机密密码` → 回显是 `AUTH ••••••`，密码没进日志
- 每条命令后面显示往返耗时（10ms / 5.0ms / …），状态栏显示「上次 5.0ms」

### 没验证到的

- **Windows / macOS 安装包**：这台 Linux 打不了（macOS 物理上不可能交叉编译，
  Windows 要 MSVC 工具链）。`.github/workflows/release.yml` 已经配好，推 `v*` tag 会触发。
- **`.deb` 打包**：这一轮**没重新打**（上一轮打过，元数据正常）。改动主要是新增模块，
  打包配置没动，风险低。
- **CI 上的 `cargo test --package devtoolkit-redis --locked`**：workflow 改过了
  （加了装 `redis-server` 的步骤），但**没在真实的 GitHub runner 上跑过**。
  `--locked` 要求 `Cargo.lock` 是最新的 —— 这次 `Cargo.toml` 加了依赖，锁文件已经跟着更新了，
  提交时**两者必须一起进**，否则 CI 直接失败。

---

## 没做完 / 下一步

### 立刻要做的

1. **真机 + 真 Redis 手动冒烟**（见上，这是唯一没被自动化覆盖的缝）
2. **`modules/diagram/state/store.ts` 还有 691 行**
   外壳 store 已经剥出去了（`shell/store.ts`），但模块 store 本身没拆。
   里面工作区、文件树、文档、历史、选中、视口全在一起。目前是可用的，
   但如果要继续长大，值得按职责再分。
   （Redis 的 store 已经是按职责组织的，可以当参照。）

### 下一步做模块

按用户定的顺序：**PostgreSQL/MySQL → SSH → MongoDB**。

### ⚠️ 加 SSH / 数据库之前必须解决的

**凭据存储。** 现在 Redis 的连接密码是**明文**存进 `redis.json`（桌面端）
或 localStorage（浏览器版）——用户明确选了这条路（沿用工作区路径那套「先明文、标记待改」）。

读写收敛在一处：`src/modules/redis/services/credentials.ts`，那里的注释写了迁移到
系统钥匙串的三步。**真正开始存服务器密码/库密码之前必须换成钥匙串**
（Windows 凭据管理器 / macOS Keychain / Linux Secret Service），否则等于把密码摊在
文件系统上——任何能读你文件的进程都能拿到。

另外记一下现在的安全边界：工作区沙箱是硬边界，唯一例外是 `write_export`
（导出到用户在系统对话框里选的路径），理由写在 `src-tauri/core/src/export.rs` 的模块文档里。

### 已知但没动的

- **`Platform.listTree` 的 tauri 实现忽略注入的 `listedExtensions`**：前端
  `configurePlatform` 已经按模块汇总了扩展名，浏览器版 `web.ts` 照此过滤，
  但 `tauri.ts` 的 `listTree` 调 `list_tree(root)` 不传扩展名，Rust 侧硬编码 `.seq.json`。
  这是**当前就存在的配置与实现不一致**，只有顺序图一个模块时不可见。
  等真有第二个会用文件树的模块时一起做（和上面「文件类型通用化」是同一件事）。
- **CI 只跑 Rust 测试**。`npm test` 和 `npm run test:e2e` 都不在 workflow 里 ——
  这是既有状态，不是这次引入的。前端测试目前靠本地跑。

---

## 踩过的坑（省得你再踩）

### 环境

- **`@playwright/test` 的版本必须精确锁定**，不能写 `^`。它和本地已下载的浏览器构建号强绑定，
  升级会去找一个不存在的构建然后失败。升级时同步跑 `npx playwright install chromium`。
- **AppImage 打包会卡死**（不是慢，是挂住）：它要从 GitHub 下载几个辅助工具，
  这个容器网络受限。要打包就用 `--bundles deb` 绕开。
- **改完前端要 `cargo build` 才生效**（Tauri 把 `dist/` 编进二进制了）。
  但 cargo 可能发现不了 `dist/` 变了 —— 会秒完事什么都没做。`touch src-tauri/src/lib.rs` 强制失效。
- **`cargo test | tail` 会把退出码吃掉**：管道最后一个命令的退出码才是 `$?`。
  编译失败时你会看到 `exited with code 0`，然后误以为测试过了。
  用 `set -o pipefail`，或者 `echo "真实退出码: ${PIPESTATUS[0]}"`。
- **`pkill -f '某个模式'` 会匹配到它自己的命令行**，把自己那条 shell 一起杀掉
  （表现为莫名其妙的退出码 144、没有任何输出）。写成 `pkill -f 'devtoolk[i]t'` 让模式不自匹配。
- **机器级 cargo 镜像在 `/root/.cargo/config`（注意没有 `.toml` 后缀）**，
  它**优先于** `config.toml`。往 `config.toml` 里写东西会被静默忽略，
  还会附带一条 deprecation 警告。现成配的是阿里云镜像，可用，别动。

### 代码

- **`.seq.json` 硬编码散落在 7 处**（Rust / TS / 组件三层）。前端那几处已经收敛到
  `modules/diagram/core/fileType.ts`，Rust 侧那 4 处还没动（见上面的待办）。
- **`rd-` 这个 CSS 类名前缀是历史遗留**（原 rustDraw）。改名时故意没动 ——
  500 多处引用，改了纯属制造 diff。当它是个命名空间就行。
  ⚠️ **加新样式前先 grep 一下类名**：`.rd-dot` 已经被文件树占用了（而且带了
  `margin-left: auto`），直接复用会撞车。Redis 的连接状态点因此叫 `.rd-conn-dot`。
- **CSS 里 `.rd-content` / `.rd-body` 必须是"布局透明"的**。
  外壳和模块之间那两层容器如果忘了 `flex: 1; min-height: 0`，工具栏和主区域的尺寸就变了。
- **`.rd-app` 是纵向 flex**，图标栏必须先包进一个横向容器（`.rd-body`），
  否则它会变成"顶部的一行"而不是"左侧的一列"。这个错犯过一次。

### Rust / Redis 那摊

- **`redis` crate 只能用 0.32.x，不能用 1.x**：1.x 的 MSRV 是 1.88，
  会顶破本仓库声明的 `rust-version = "1.83"`。0.32 的 MSRV 是 1.80。
- **`Value::ServerError` 不是 `Err`**。`send_packed_command` 返回的是**原始回复树**，
  服务器错误在里面是一个 `Value`；而 `query_async` 会调 `extract_error()` **递归**
  把嵌在数组/Map 里的错误也提成 `Err`。命令台要的是前者。
- **`ServerError` 没有从 crate 根导出**（`types` 模块是私有的），命名不了它。
  要构造这种值就在测试里 `redis::parse_redis_value(b"-ERR x\r\n")`。
- **`MultiplexedConnection` 在 `redis::aio` 下**，不在 crate 根。
- **`MutexGuard` 跨 await 会编译不过**（future 不是 `Send`，Tauri 的 async command 要求是）。
  做法是 `clone_conn()` 把连接复制一份出来、guard 当场释放 —— `MultiplexedConnection`
  的 clone 很廉价。这条规则靠结构保证，别改成 `self.conns.lock()?.get(id)?.send().await`。
- **带 `--requirepass` 起 redis-server 时，用客户端库发 PING 探活会永远失败**：
  服务器回 `-NOAUTH`，客户端把它当失败。就绪探测走裸 TCP、只看「有没有字节回来」。
- **`Omit<联合类型, K>` 会把各分支的独有字段全丢掉**，只剩公共字段。
  要 `T extends unknown ? Omit<T, K> : never`（见 `modules/redis/core/types.ts` 的 `WithoutSeq`）。
- **`noUncheckedIndexedAccess` 开着**，`arr[i]` 一律是 `T | undefined`。
  字符串用 `charAt()`（越界返回 `''`，类型也是 `string`）；数组老老实实判空。

### 前端

- **模块级 store 单例的生命周期**：它随页面加载创建，所以「切模块再切回」状态还在
  （这是 e2e 的一条架构断言），但**刷新页面就没了**。想在 e2e 里验证「重启后还在」，
  别用 `page.reload()` —— `beforeEach` 里的 `addInitScript` 会在**每次导航**时执行，
  把 localStorage 一起清掉。开一张新 page（`page.context().newPage()`）才是对的。
- **`renderReply` / 分词这些纯逻辑放 `core/`**，能在 node 下穷举边界用例，
  而且 tauri 和浏览器两个实现共用同一份。别把分词挪到 Rust —— 那样浏览器版还得再写一遍。

---

## 环境变更（这台机器）

这一轮改动了几处系统状态：

1. **装了 `redis-server`（7.0.15）** —— `devtoolkit-redis` 的集成测试要用。
   `apt-get install -y redis-server`。测试自己起随机端口的实例，不依赖常驻服务。
   > 顺带一提：**6379 上已经有一个进程在跑**（`redis-server *:6379`，可能是容器里带出来的）。
   > 集成测试不碰它（全用随机端口），你手动冒烟时倒是可以直接连它。
2. **cargo 镜像不用配** —— 检查时发现 `/root/.cargo/config` 早就配好阿里云镜像了。
   一开始往 `~/.cargo/config.toml` 写了一份，发现被静默忽略（无后缀的那个优先），
   已经删掉。**没有留下多余改动。**
3. 上一轮改的（仍然有效）：Tauri 构建依赖（`libwebkit2gtk-4.1-dev` 等）、
   code-server 换成 HTTPS（`~/.config/code-server/rustdraw.crt`）、
   **⚠️ code-server 密码还是 `123456` 且端口公网可达** —— 建议换掉或只监听 127.0.0.1。

---

## 重要的设计决定（以及为什么）

`README.md` 的「几个不那么显然的设计决定」一节里有完整展开，这里只挑最容易踩的：

- **激活条锚定消息 id，不是坐标** —— 拖消息时自动跟随，删消息时自动清理
- **没有显式终点的激活条 = 还在执行中** —— 此时到达的消息算重入，会嵌进去
- **`participants` 按 x 有序、`messages` 按 y 有序是强制不变量**
- **缩放改 `viewBox` 不用 CSS transform** —— 后者会把矢量文字变成位图
- **内联编辑用 HTML `<textarea>` 浮层，不用 `foreignObject`** —— macOS 输入法候选框问题
- **Redis 客户端放 Rust 侧** —— CSP 的 `connect-src` 敞不开，前端直连会被拦
- **命令台的服务器错误内联在日志里，不弹外壳错误条** —— 它是命令的结果，不是执行失败
- **命令参数逐个塞进 `Cmd`，绝不拼字符串** —— 否则就是 RESP 注入

---

## 一句话总结当前状态

**两个模块（顺序图 + Redis）都可用，模块化架构被第二个真实模块验证过了：
加 Redis 时外壳和共享层一行都没改。**

卡在：文件类型那几处通用化仍然悬着（**有意推迟，触发条件已改成「第一个需要列
别的文件类型的模块出现时」**）；凭据存储是明文，加 SSH/数据库之前必须换钥匙串。
