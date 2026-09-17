# Devtoolkit

一个**开发者工作台**：把平时要开好几个软件才干完的事收进一个桌面应用。

模块化架构，每个模块自包含。目前有：

| 模块 | 状态 |
|---|---|
| **顺序图**（UML sequence diagram） | 可用。选一个本地文件夹当工作区，左侧显示目录树，图以 `.seq.json` 存在里面——和 VS Code 打开文件夹的体验类似，没有云端、没有数据库 |
| **Redis** | 可用。左侧「连接 → 库 → key」，主区看 key 列表和值；命令台是一个页签 |
| **数据库**（MySQL / PostgreSQL） | 可用。连接配置里选引擎，侧栏「连接 → 库 / 表」，主区写 SQL 看结果表格 |
| MongoDB | 待做 |
| SSH 终端 | 待做 |

技术形态是 [Tauri 2](https://v2.tauri.app/) 桌面应用：Rust 后端负责所有系统操作（文件、
网络连接），前端是 React + TypeScript + Vite 渲染的 WebView。

## 加一个模块

模块化架构的检验标准就一句话：**加一个模块 = 写一个目录 + 注册表加一行**。

```ts
// src/shell/registry.ts
export const MODULES = [diagramModule, redisModule, sqlModule, devPlaceholderModule];
```

模块要实现的接口在 `src/shell/types.ts`（`Module`）。外壳不认识任何具体模块，
只认这个接口——它只管把当前模块的槽位摆出来、显示状态和错误。
每个模块自己持有自己的 store，模块之间不通过外壳通信。

`src/modules/devplaceholder/` 是一个活体检验：它只用了一个目录 + 注册表一行，
没有改动外壳的任何内部实现。

---

## 目录结构

```
Devtoolkit/
├── src/                     前端源码（React + TypeScript）
│   ├── shared/              通用层：几何、id、文字测量、撤销栈、平台桥、通用组件
│   │   └── connections/     三个连接类模块（Redis / SQL / SSH）共用的连接层
│   │                        ★ 不 import 任何模块
│   ├── shell/               外壳：模块注册表、图标栏、状态栏、错误条
│   │                        ★ 不认识任何具体模块，只认 Module 接口
│   └── modules/
│       ├── diagram/         顺序图模块
│       ├── redis/           Redis 模块（浏览式：库树 + key 列表 + 值）
│       ├── sql/             数据库模块（MySQL + PostgreSQL）
│       └── devplaceholder/  占位模块（验证「加模块 = 一个目录 + 一行」）
├── src-tauri/               Rust 后端
│   ├── src/
│   │   ├── main.rs          程序入口
│   │   ├── lib.rs           Tauri 应用组装：注册插件、挂载 command
│   │   ├── commands.rs      工作区文件相关的 #[tauri::command] 薄封装
│   │   └── redis_commands.rs Redis 相关的三个 command
│   ├── core/                纯逻辑内核：路径安全边界 + 文件操作
│   ├── redis/               Redis 内核：连接管理、命令执行、回复解析
│   ├── sql/                 SQL 内核：MySQL / PostgreSQL 的连接与查询
│   ├── capabilities/        权限配置
│   ├── icons/               图标（logo.svg 是源文件）
│   └── tauri.conf.json      窗口、打包配置
├── .github/workflows/       CI 打包
└── package.json
```

`src-tauri/core` 和 `src-tauri/redis` 都被刻意拆成独立 crate：它们**不依赖 tauri**，
所以路径安全那套逻辑和 Redis 协议那套逻辑，都不需要装 WebKit / GTK 就能单独跑测试。
`devtoolkit-redis` 的集成测试还会**自己拉起一个真 `redis-server`**（随机端口、不落盘、
`Drop` 时杀掉）—— 所以机器上要装了 `redis-server` 才会过，没装会明确报错并给安装命令。

---

## 开发环境准备

### 1. Rust 与 Node

```bash
# Rust（推荐用 rustup 装 stable）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node 20 或更高
node --version
```

### 2. 各平台系统依赖

Tauri 不是纯 Rust 的，它要链接系统 WebView。

**Linux（Debian / Ubuntu）**

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  libssl-dev \
  patchelf \
  build-essential curl wget file
```

> 注意版本：Tauri 2 要的是 **4.1** 版 WebKitGTK。Ubuntu 22.04 及以上才有
> `libwebkit2gtk-4.1-dev`；20.04 只有 4.0，装不上。

**Linux（Arch）**

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file \
  openssl appmenu-gtk-module libappindicator-gtk3 librsvg
```

**Linux（Fedora）**

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
sudo dnf group install "C Development Tools and Libraries"
```

**macOS**

```bash
xcode-select --install
```

**Windows**

装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
（勾选「使用 C++ 的桌面开发」），WebView2 运行时 Win10 1803+ / Win11 已经自带。

### 3. 拉取前端依赖

```bash
npm install
```

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run tauri:dev` | 启动开发模式（Vite + Tauri 窗口，前端改动热更新） |
| `npm run tauri:build` | 打包当前平台的安装包 |
| `npm run dev` | 只起 Vite 开发服务器（浏览器里调 UI 用，没有 Tauri API） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 前端单元测试（vitest，纯逻辑） |
| `npm run test:e2e` | 端到端测试（Playwright 驱动真实界面） |

> 首次跑 e2e 前如果提示缺浏览器，执行 `npx playwright install chromium`。
> `@playwright/test` 的版本是**精确锁定**的，不要随手升级——它和本地已下载的
> 浏览器构建号强绑定，换版本会去找一个不存在的构建。升级时同步跑
> `npx playwright install chromium`。

### 只跑后端测试

后端的核心逻辑在 `src-tauri/core` 和 `src-tauri/redis`，**不需要 WebKit / GTK** 就能测：

```bash
cd src-tauri
cargo test --package devtoolkit-core    # 路径安全 + 文件操作
cargo test --package devtoolkit-redis   # Redis 协议层
```

`devtoolkit-core` 覆盖路径穿越（`../`、`../../etc/passwd`、`sub/../../`）、绝对路径、
符号链接逃逸、Windows 风格分隔符混用，以及原子写、目录树排序、增删改移等文件操作。

`devtoolkit-redis` 的集成测试**会自己拉起一个真 `redis-server`**（随机端口、不落盘、
`Drop` 时杀掉），所以本机要先装：

```bash
sudo apt-get install -y redis-server    # macOS: brew install redis
```

没装的话测试会**明确失败并给出安装命令**，不会静默跳过 —— 静默跳过等于这些测试
永远不跑，而没有任何人会发现。这几个测试覆盖的是：服务器返回错误必须是一条「回复」
而不是执行失败、二进制值要被标记出来、选库真的生效、连不上的主机要在超时内报错、
服务中途被杀要变成传输层错误并把连接摘掉。

> 在 `src-tauri` 下直接敲 `cargo test` 会跑**全部** crate 的测试
> （`Cargo.toml` 里的 `default-members` 管这件事）。加新 crate 时记得同步加进去，
> 否则它的测试会静默不跑。

### 只编译后端

```bash
cd src-tauri
cargo check          # 快速语法/类型检查
cargo build          # 完整编译（首次会比较慢）
```

内存小的机器上并行 codegen 容易 OOM，建议限制并行度：

```bash
CARGO_BUILD_JOBS=2 cargo build
```

### 只出某几种安装包

```bash
cd src-tauri
npx tauri build --bundles deb          # 只要 .deb
npx tauri build --bundles appimage     # 只要 .AppImage
npx tauri build --bundles msi nsis     # Windows
npx tauri build --bundles dmg          # macOS
```

---

## 前端架构

一句话：**外壳 / 模块 / 共享层三层，每一层只认识下面那层**。

```
src/
├── shared/      通用层：几何、id、文字测量、撤销栈、平台桥、通用组件
│                ★ 不 import 任何模块
├── shell/       外壳：模块注册表、图标栏、状态栏、错误条
│                ★ 不认识任何具体模块，只认 Module 接口
└── modules/
    ├── diagram/        顺序图
    │   ├── core/       纯 TypeScript：数据模型、布局、命令、撤销、导出
    │   │               ★ 不 import React，不碰 DOM，不碰 Tauri
    │   ├── render/     SVG 渲染 + 画布交互
    │   ├── panels/     工具栏、文件树、属性面板
    │   └── state/      模块自己的 store
    ├── redis/
    │   ├── core/       纯逻辑：分词、回复渲染、历史、校验、假 Redis
    │   ├── services/   平台桥：tauri 走 invoke，web 走内存假实现
    │   ├── panels/     连接列表、命令台、连接表单
    │   └── state/      模块自己的 store
    └── devplaceholder/ 占位模块
```

`src/shared/platform/` 是**所有模块共用**的运行时适配层，它只提供「文件操作 +
系统对话框」这类通用能力：tauri 实现走 `invoke()`，web 实现把工作区放在 localStorage 里。

具体模块自己的网络能力**不放进共享层** —— 那会让共享层认识具体模块。Redis 模块
自己带一套 `services/`（接口 + tauri 实现 + 浏览器实现），结构和 `shared/platform/`
一样，只是归模块所有。

### 为什么要有浏览器实现

`shared/platform/web.ts` 和 `modules/redis/services/web.ts` 不是"顺便支持一下浏览器"，
它们承担一个具体职责：**让前端能在普通浏览器里完整跑起来**。编辑器里所有交互逻辑
（拖拽、内联编辑、撤销、导出）、命令台的完整链路（连接 → 执行 → 展示结果）
都因此能用 Playwright 驱动和断言，而不依赖启动原生窗口。

Redis 那份假实现做得足够真：`SET a 1` 之后再 `GET a` 真的能拿回 `1`。
对着写死的假数据做断言等于自欺，那样 e2e 绿了也说明不了什么。

平台判定用 `window.__TAURI_INTERNALS__`，不是 `__TAURI__` ——
后者只有开了 `withGlobalTauri` 才存在。

### 几个不那么显然的设计决定

**激活条锚定「消息 id」而不是坐标**（`core/model.ts` 的 `Activation`）。
拖动消息时激活条自动跟随，删除消息时自动清理，不需要任何同步代码。
如果存的是坐标，每次拖动都要手工同步两端，必然出现错位。

**`participants` 按 x 升序、`messages` 按 y 升序是强制不变量**，数组顺序即逻辑顺序。
拖拽改变位置后由 `commands.normalize()` 重新排序。这样消除了「逻辑顺序」和
「视觉位置」两份真相，Mermaid 导出和自动编号都直接依赖数组顺序。

**缩放靠改 `viewBox`，不用 CSS transform**。CSS 缩放会把矢量文字变成位图，
放到 4 倍就糊了；改 viewBox 时 SVG 按新尺寸重新排版，任意倍数都是锐利的。

**内联编辑用 HTML `<textarea>` 浮层，不用 `<foreignObject>`**。两个硬性原因：
macOS 上 Tauri 跑的是 WKWebView，`foreignObject` 里的中文输入法候选框定位错乱是老问题；
而且 `foreignObject` 在 Illustrator / Inkscape 和 PNG 光栅化时经常被整个忽略。

**文字测量是可注入的接口**（`core/text.ts`）。运行时注入基于 canvas `measureText`
的实现（与实际渲染严格一致），测试里注入确定性估算实现。所以布局逻辑能在 node 下
跑，测试断言的是**不变量**（方框包得住文字、互不重叠）而不是像素值。

**主题以完整对象存进 `.seq.json`**，不是只存一个 id。代价是文件大一点，
换来的是图发给别人、或一年后打开，配色都不会变样。

**注释的坐标只由自己的 `x` / `y` 决定，`attachTo` 不参与定位**，它只是导出
Mermaid 时的语义标注（这条注释挂在谁身上）。曾经写成「有 `attachTo` 就跟随那个
参与者的横坐标」，后果是**拖动注释时横向位移被无声忽略**——用户拖了半天纹丝不动，
只有纵向能挪。注释是唯一一种自由定位的元素，它的坐标必须是唯一真相。

**工具栏动作跟随当前选中，不写死默认值**。选中一个参与者再点「自调用」，消息落在
**它**身上；选中一条消息再点「新增」，新消息插在**它后面**并把后续消息整体下移
（而不是永远追加到图末尾，让用户再手动拖上去）；新建注释跟着选中的元素走，
没选中就落在鼠标刚点过的位置。这些都做成了 `core/commands.ts` 里的纯函数
（`resolveEndpoints` / `insertMessageAfter` / `notePlacement`），可以脱离界面单测。

**画布上的手势全部是直接操作**（对齐 sequencediagram.org 的手势模型）：

| 手势 | 效果 |
|---|---|
| 从生命线/激活条横向拖出 | 画一条消息，松手落在最近的生命线上 |
| 拖拽中按住 `Alt`（macOS 可 `Cmd`） | 改成异步消息 |
| 拖拽中按住 `Shift` | 改成返回消息 |
| 几乎不横向移动就松手 | 落成自调用（不用精确拖回起点） |
| 消息**两端**各 14px 内拖动 | 改 `from` / `to`（拖到别的生命线上） |
| 消息**中间**拖动 | 改纵向位置 |
| 拖激活条**下边缘** | 截断（吸附到该生命线上的消息），拖到底恢复自动延伸 |

> 修饰键用 `Alt` 而不是 `Ctrl`：**macOS 上 `Ctrl`+点按是系统级次要点按**，
> 浏览器会转成 `contextmenu`，拖拽当场被打断。（sequencediagram.org 的文档里
> 那句 "Hold Ctrl **or Cmd for Mac**" 就是踩过这个坑的证据。）
> 已知边界：Linux 的 GNOME/KDE 默认把 `Alt`+拖拽当成移动窗口，会被窗口管理器截获 ——
> 目标平台是 Windows + macOS，所以接受这个取舍。

**同步/异步的颜色是叠加在 UML 形状差异之上的**。规范里两者只靠箭头头的实心/空心区分，
那是个十来像素的差异，正常缩放下基本看不出来（连 PlantUML 都被指出 `->` 和 `->>`
的箭头**都是空心的**）。所以保留合规的箭头形状，再给三种消息各一个颜色；
「黑白打印」主题三色同为黑，纸面上只靠形状区分。

**右键菜单是主力入口，不是补充**（`panels/ContextMenu.tsx`）。
画布上的元素和文件树的条目都有各自的菜单：消息能直接改类型 / 反转方向 / 开关激活条，
条目能新建 / 重命名 / 删除 —— 这些都是高频操作，绕到右侧属性面板或顶部按钮太远。
菜单项右侧显示快捷键（用户学会快捷键的唯一有效途径），单选项用独立的勾选列
而不是把 `✓` 拼进文字 —— 后者会让 testid 里混进空格，测试脆得没法写。

**文件树的选中决定了"新建"建到哪儿**（`store.creationDir()`）。
选中目录就建在里面，选中文件就建在它旁边，什么都没选才建在工作区根目录；
底部常驻显示当前目标。这条以前是坏的：工具栏写死传 `''`（根目录），
于是不管在树里选了哪个文件夹，新建的图全堆在根上 —— **文件夹形同虚设，
整棵树看起来是平的**。另外新建之后会自动展开目标目录，否则新图会消失在
一个折叠的文件夹里，用户以为没建成功。

**Redis 客户端放在 Rust 侧，不放前端。** `tauri.conf.json` 的 CSP 是
`connect-src 'self' ipc:`，前端直连外部网络会被拦；放 Rust 侧还顺带让它能被打真
Redis 的集成测试覆盖。capabilities 也不用动 —— 自定义 `#[tauri::command]`
不受 ACL 约束。

**命令台的「错误」是内联在日志里的，不弹外壳错误条。** 服务器说
`-ERR unknown command` 的时候命令执行**完了**，只是结果是个错误。用户敲错一个命令
就弹一个横贯屏幕的红色横幅，那是用错了语义。只有传输层失败（连不上、断了、超时）
才值得那样打断。规则写在 `modules/redis/state/store.ts` 的文件头注释里，
e2e 里有一条守门测试盯着它。

**连接选中、编辑对象、命令台的目标是同一个概念**（`selectedId`）。
拆成两个状态会立刻产生「侧栏选着 A，命令发给了 B」这种 bug。

**切模块不断开连接。** 连接是廉价且用户预期跨模块存活的资源：去顺序图模块看一眼
再回来，连接还在。`onDeactivate` 里那句注释写清了理由，免得后人以为是漏了。

**命令台的回显对 `AUTH` 打码**（`core/redact.ts`）。命令台会把敲的命令记进日志，
`AUTH mypassword` 就等于把密码写进了界面日志 —— 而日志会被截图、会被贴进 issue。
它解决的不是「明文落盘」那件事（那是凭据存储的问题），而是**别让同一个密码
再泄漏到第二个地方**。

**命令参数逐个塞进 `Cmd`，绝不拼字符串。** `Cmd` 会把每个参数打包成独立的
bulk string，天然免疫 RESP 注入；拼字符串的话 `SET k "a\r\nFLUSHALL"` 这种值
就能挟持连接。Rust 侧有一条测试专门盯这个。

---

## 测试

分四层，每层都真的能跑：

| 层 | 命令 | 覆盖内容 |
| --- | --- | --- |
| 纯逻辑 | `npm test` | 布局不变量、命令级联、撤销栈、schema 容错、Mermaid 导出 |
| 界面交互 | `npm run test:e2e` | 在真实 Chromium 里驱动编辑器：滚动、拖拽、中文输入、导出下载、文件管理 |
| Rust 后端 | `cd src-tauri && cargo test -p devtoolkit-core` | 路径逃逸攻击向量、文件操作、导出 |
| 原生窗口 | 见下 | 真 Tauri 应用启动 + 读写落盘 |

两个值得一提的点：

**Mermaid 导出用官方解析器验证**（`tests/unit/mermaid-valid.test.ts`）。
断言"输出里有 `->>`"证明不了"这段文本能被渲染"，所以这里直接把导出的文本
喂给 `mermaid.parse()`。这个测试抓到过一个真实 bug：参与者的别名如果叫
`end`、`loop`、`alt` 这类 Mermaid 关键字，导出的图会直接解析失败——
而且报错是"Parse error on line N"，用户完全无从下手。现在关键字会被换成安全的 `P1`。

**schema 解析按不可信输入处理**。用户手改过的文件、旧版本文件、被截断的文件都要能打开：
悬空引用（消息指向不存在的参与者）会被清理掉，否则布局会算出 NaN 坐标、整个画布白屏。

### 在无显示器环境里跑原生窗口

headless Linux 上可以用 Xvfb 真跑起来并截图：

```bash
xvfb-run -a --server-args="-screen 0 1440x900x24" \
  env WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  ./src-tauri/target/debug/devtoolkit
```

> 注意：**没有窗口管理器时，WebKitGTK 会抑制表单控件的激活事件** ——
> 工具栏的按钮点了没反应，但画布和侧边栏（非表单元素）正常。
> 这不是程序的 bug。要自动化点击工具栏，先起一个窗口管理器（`openbox &`）。

---

## 后端接口

前端通过 `invoke('命令名', { 参数 })` 调用。Tauri 2 会自动把 JS 的 **camelCase**
参数名映射到 Rust 的 snake_case，所以写 `newName` 而不是 `new_name`。

所有命令都返回 `Result`；失败时 Promise 会 reject，错误字符串是已经中文化好的文案，直接弹给用户即可。

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `list_tree` | `root` | `FileNode[]` | 递归列出目录树 |
| `read_text_file` | `root`, `path` | `string` | 读文本文件 |
| `write_text_file` | `root`, `path`, `contents` | — | 写入，**原子写** |
| `create_diagram` | `root`, `dir`, `name` | `string` | 新建图，返回新相对路径 |
| `create_folder` | `root`, `dir`, `name` | `string` | 新建文件夹，返回新相对路径 |
| `rename_entry` | `root`, `path`, `newName` | `string` | 重命名，返回新相对路径 |
| `delete_entry` | `root`, `path` | — | 删除（目录递归） |
| `move_entry` | `root`, `path`, `newDir` | `string` | 移动，返回新相对路径 |
| `write_export` | `path`, `data` | — | 导出到工作区**外**（用户「另存为」选的绝对路径） |
| `redis_connect` | `id`, `config` | `ServerInfo` | 建立连接。同 `id` 再连是**替换**，不是新建 |
| `redis_disconnect` | `id` | — | 断开。幂等 |
| `redis_exec` | `id`, `args` | `Reply` | 执行一条命令。`args[0]` 是命令名 |

`path` 一律是**相对于工作区根目录**、**正斜杠分隔**的路径（Windows 上也是正斜杠）。

### Redis 的三个命令

`config` 是 `{ host, port, db, username, password }`；`args` 是**已经分好词的**
token 数组（分词在前端的 `modules/redis/core/tokenize.ts` 里做，Rust 侧只收结果）。

**`redis_exec` 的错误语义是最容易搞错的一条：**

- 服务器报错（`-ERR unknown command`）→ 返回 **`Ok(Reply::Error)`**。
  它是命令的**结果**，不是执行失败，前端把它内联显示在命令台日志里，连接不动。
- 只有传输层失败（连不上、超时、连接断了）才返回 `Err(String)`。

实现上靠的是 `send_packed_command` 而不是 `query_async` —— 后者内部会调
`extract_error()`，**递归**把嵌在数组/Map 里的 `ServerError` 也提成 `Err`，
那样 `CONFIG GET` 这类返回嵌套结构的命令会整条变成「执行失败」。

命令参数是**逐个塞进 `Cmd`** 的，不拼字符串：`Cmd` 会把每个参数打包成独立的
bulk string，天然免疫 RESP 注入（否则 `SET k "a\r\nFLUSHALL"` 就能挟持连接）。

`Reply` 的字段名是前后端契约，Rust 侧有单元测试逐个钉死（`redis/src/reply.rs`
的 `json_contract`）。

`FileNode` 的字段：

```ts
interface FileNode {
  name: string                    // 展示名
  path: string                    // 相对工作区的路径，正斜杠分隔
  kind: 'file' | 'dir'
  children: FileNode[] | null     // 只有 dir 才有
}
```

### 几个约定

- **只列 `.seq.json` 文件**。隐藏项（以 `.` 开头，比如 `.git`）和符号链接会被跳过。
- **排序**：目录在前，然后按名称（忽略大小写）排序。空目录会保留——否则刚建的文件夹会立刻从界面上消失。
- **重名自动加序号**：`create_diagram` / `create_folder` / `move_entry` 遇到重名会生成
  `名称 (2).seq.json`、`名称 (3).seq.json`。`rename_entry` 是例外，重名直接报错，不偷偷改名。
- **重命名保留后缀**：把 `a.seq.json` 重命名成 `新名字`，结果是 `新名字.seq.json`，
  不会因为少了后缀就从目录树里消失。
- **`create_diagram` 只建空文件占位**，初始 JSON 内容由前端用 `write_text_file` 写入。
- **`write_export` 会覆盖同名文件**——导出的是派生数据，用户就是想覆盖上一版。
- **偏好持久化**用 `tauri-plugin-store`，**选目录/选文件**用 `tauri-plugin-dialog`，
  两者都从前端通过 JS 插件调用，后端只负责注册。
- **窗口的 `dragDropEnabled` 设成了 `false`**。Tauri 默认会接管拖放事件来做「拖文件进窗口」，
  代价是 WebView 里的 **HTML5 拖放（`draggable` / `dragstart` / `drop`）会失效**。
  画布内部拖拽比拖文件进窗口更常用，所以关掉了原生拖放。
  真需要「拖一个 .seq.json 进窗口打开」的话，把这一项改回 `true`，但画布就得改用指针事件自己实现拖拽。

---

## 安全模型

所有接受路径的命令都会经过同一个校验函数，保证**工作区外的文件绝不能被读写**：

1. 拒绝绝对路径（含 Windows 的 `C:\` 盘符和 `\\server` UNC 形式），
   拒绝任何 `..` 分量，拒绝 NUL 字节。`\` 会先被统一成 `/`，
   否则 `sub\..\..\escape` 在 Linux 上会被当成一个普通文件名而蒙混过关。
2. 用 `canonicalize` 规范化，它会**解析符号链接**——所以在工作区里放一个
   指向 `/etc` 的软链接同样会被拦下。目标文件还不存在时（新建场景），
   规范化它最近的已存在祖先目录，再把剩余部分拼回去。
3. 结果必须落在规范化后的工作区根目录之下。

边界说明：校验和使用之间存在 TOCTOU 窗口（理论上可以在两步之间把目录换成软链接）。
彻底堵死需要 `openat2(RESOLVE_BENEATH)` / `O_NOFOLLOW` 这类平台特定 API，
对单用户本地桌面应用来说不值得。这是已知边界，不是遗漏。

### 唯一的例外：`write_export`

「另存为」要把文件写到工作区外面（用户自己选的桌面、文档目录），这条路径没法也不该
套工作区校验。它单独放在 `devtoolkit-core/src/export.rs`，仍然拒绝空路径、相对路径、
把目录当文件写，并且要求父目录存在、用原子写。

需要注意的是：**这个约束靠约定，不靠机制**。`write_export` 接受前端传来的任意绝对路径，
后端无法验证它真的来自系统对话框。也就是说，任何能在 WebView 里执行 JS 的东西
（XSS、恶意 `.seq.json` 里被渲染的内容）都获得了「以本程序权限写任意文件」的能力。
其余命令仍然是硬沙箱。

想把它也变成硬保证，做法是让**后端自己弹对话框** —— `tauri-plugin-dialog` 有 Rust 侧 API
（`FileDialogBuilder::blocking_save_file`），路径根本不经过 JS，前端只传内容：

```rust
#[tauri::command]
fn export_as(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    let path = app.dialog().file().blocking_save_file();  // 路径全程在 Rust 手里
    // ... write_export(path, &data)
}
```

这样「只能写到用户当面选过的文件」就成了机制上的保证，而不是一句注释。

### ⚠️ 凭据目前是明文存储

Redis 连接的密码以**明文**落在本机配置文件里（桌面端是应用配置目录下的 `redis.json`，
浏览器版是 localStorage）。这是明确知情的妥协，沿用工作区路径那套「先明文、标记待改」的做法。

代价说清楚：**任何能读到那个文件的进程都能拿到你的 Redis 密码** —— 同机器上的其他程序、
备份软件、误传的配置目录快照，都算。共用电脑上不要填生产库密码。

读写收敛在一处：`src/modules/redis/services/credentials.ts`。换成系统钥匙串
（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）时，改动面就是那一个文件
加上 `ConnectionProfile` 类型上的一个字段。那个文件的注释里写了迁移的三步。

顺带一提，命令台的回显对 `AUTH` 做了脱敏（`core/redact.ts`）—— 那解决的是**另一个**问题：
别让同一个密码再泄漏到界面日志里（日志会被截图、会被贴进 issue）。两件事都要做。

---

## 打包与发布

### 本地打包

```bash
npm run tauri:build
```

产物在 `src-tauri/target/release/bundle/` 下，按平台分子目录。

各平台能出的包由 `tauri.conf.json` 的 `bundle.targets` 决定，
写的是全集 `["deb", "appimage", "msi", "nsis", "dmg"]`，
Tauri 会**按当前平台自动过滤**，不需要为每个平台改配置：

| 平台 | 产物 |
| --- | --- |
| Linux | `.deb`、`.AppImage` |
| Windows | `.msi`（WiX）、`.exe`（NSIS） |
| macOS | `.dmg` |

### CI 自动出包

`.github/workflows/release.yml`：

- **触发**：推送 `v*` 标签（`git tag v0.1.0 && git push origin v0.1.0`），
  或在 Actions 页面手动触发（手动触发只出包，不建 Release）。
- **先跑测试**：`devtoolkit-core` 的单元测试作为前置 job，不通过就不打包。
- **矩阵**：`macos-latest`（分别出 Apple Silicon 和 Intel 两个包）、
  `ubuntu-22.04`、`windows-latest`，四份产物汇总到同一个 Release。
- **Release 默认是草稿**，方便先补 release notes 再点发布；
  想推 tag 就直接对外发布，把 `releaseDraft` 改成 `false`。

macOS 目前**不做签名和公证**，用户首次打开需要右键 → 打开。
后续要加签名、公证、自动更新的完整步骤写在 workflow 文件末尾的注释里。

### 图标

图标源文件是 `src-tauri/icons/logo.svg`。改完之后重新生成整套图标：

```bash
npx tauri icon src-tauri/icons/logo.svg -o src-tauri/icons
```

会把 `.png` / `.ico` / `.icns` 全平台需要的尺寸一次生成好。

---

## 许可证

MIT
