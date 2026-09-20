# Devtoolkit

一个**开发者工作台**：把平时要开好几个软件才干完的事收进一个桌面应用。

模块化架构，每个模块自包含。目前有：

| 模块 | 状态 |
|---|---|
| **顺序图**（UML sequence diagram） | 可用。选一个本地文件夹当工作区，左侧显示目录树（右键可以**移动到别的目录**），图以 `.seq.json` 存在里面——和 VS Code 打开文件夹的体验类似，没有云端、没有数据库。**格式写在 [`docs/seq-format.md`](docs/seq-format.md)**：手写或让 AI 生成都照那一份，里面有能直接粘的提示词 |
| **Redis** | 可用。左侧「**分组 → 连接 → 库 → key**」（连接能归到自己建的分组里，也能搜），主区看 key 列表和值；命令台是一个页签 |
| **数据库**（PostgreSQL / MySQL / ClickHouse / MongoDB） | 可用。连接配置里选引擎，侧栏**先按引擎分、再按你自己建的分组分**（引擎 → 分组 → 连接 → 库 / 表），主区写 SQL 看结果表格；**MongoDB 是文档浏览器**（库 → 集合 → JSON 查询），不走 SQL 那条路 |
| **SSH 终端** | 可用。多标签的真终端（xterm.js），**本地终端**（PowerShell / cmd）和远端连接并列、侧栏同样能分组和搜索，密码 / 私钥认证，**首次连接要核对主机密钥指纹**；终端左边**命令块色条**：一条命令一块、交替配色，单击复制命令 + 输出，双击折叠收起 |
| **智能体会话** | 可用。分屏跑多个 Claude Code / Codex，**一个工作目录就是一个窗口**（各有各的分屏布局），侧栏点哪条右边就换哪一套；**谁在等你一眼看出来**（窗格边框 + 侧栏队列 + 模块图标角标）。「新建会话」可以一次填几个、建完自动铺成网格，最下面能设**全局启动参数**（如 `--dangerously-skip-permissions`）；父窗口右键可以一次收掉它里面全部会话。状态检测要往 Claude Code / Codex 的配置里装一个钩子，向导里能看到改了什么、随时撤销 |
| **任务** | 可用。一件事从「待办」到「完成」的账本：标题 / 描述 / 状态 / 备注，外加**进度记录**（一条条带时间戳的「什么时候干了什么」）和**归档**（做完的从列表里收起来，一条不删，回顾时看得到全程）。卡片式列表 + 搜索 + 状态筛选，存在本机一个 SQLite 文件里。**下一轮**才接 agent（把任务派给会话、把结果回写） |

> 连接档案、工作目录这些**键值类**的存储也都在 SQLite 上（一个 `devtoolkit.db`，
> 老的 JSON 文件第一次启动时自动搬进去、原文件改名成 `.bak` 留着）。

技术形态是 [Tauri 2](https://v2.tauri.app/) 桌面应用：Rust 后端负责所有系统操作（文件、
网络连接），前端是 React + TypeScript + Vite 渲染的 WebView。

## 加一个模块

模块化架构的检验标准就一句话：**加一个模块 = 写一个目录 + 注册表加一行**。

```ts
// src/shell/registry.ts
export const MODULES = [
  diagramModule, redisModule, sqlModule, sshModule, agentsModule, tasksModule,
  devPlaceholderModule,
];
```

> ⚠️ 注册表顺序 = 图标栏顺序 = `Ctrl+1..7` 的顺序，**是面向用户的**；
> 而且 `main.tsx` 取 `MODULES[0]` 当默认模块，**顺序图必须留在第一位**。
> 加模块会让 `tests/e2e/shell.spec.ts` 里「有几个模块」的断言失败 —— 那是故意的。

模块要实现的接口在 `src/shell/types.ts`（`Module`）。外壳不认识任何具体模块，
只认这个接口——它只管把当前模块的槽位摆出来、显示状态和错误。
每个模块自己持有自己的 store，模块之间不通过外壳通信。

接口里除了四个槽位（`Sidebar` / `Main` / `Inspector` / `StatusItems`），还有两个可选的：
`Toolbar`（跨内容区的工具栏）和 **`badge`**（模块图标上的角标，是个**组件**而不是数字，
这样模块能在自己的角标里订阅自己的状态，外壳依然不认识它）。目前只有智能体会话模块
用了 `badge`——用户在别的模块里画图时，「有 agent 停下来等你」只剩这一个地方能看见。

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
│       ├── sql/             数据库模块（PostgreSQL / MySQL / ClickHouse / MongoDB）
│       ├── ssh/             SSH 终端模块（多标签 + 本地终端）
│       ├── agents/          智能体会话模块（一屏多个 agent）
│       ├── tasks/           任务模块（SQLite）
│       └── devplaceholder/  占位模块（验证「加模块 = 一个目录 + 一行」）
├── src-tauri/               Rust 后端
│   ├── src/
│   │   ├── main.rs          程序入口
│   │   ├── lib.rs           Tauri 应用组装：注册插件、挂载 command
│   │   ├── commands.rs      工作区文件相关的 #[tauri::command] 薄封装
│   │   ├── redis_commands.rs Redis 相关的 command
│   │   ├── sql_commands.rs  SQL 相关的 command
│   │   ├── ssh_commands.rs  SSH 相关的 command
│   │   └── agent_commands.rs 智能体会话相关的 command
│   ├── core/                纯逻辑内核：路径安全边界 + 文件操作
│   ├── redis/               Redis 内核：连接管理、命令执行、回复解析
│   ├── sql/                 SQL 内核：PostgreSQL / MySQL / ClickHouse / MongoDB
│   ├── ssh/                 SSH 内核：连接、认证、主机密钥校验、PTY 会话
│   ├── agents/              智能体会话内核：本机进程、状态事件目录、集成配置读写
│   ├── store/               键值存储内核：SQLite + 从旧 JSON 一次性搬迁
│   ├── tasks/               任务内核：SQLite 存储 + 查询
│   ├── capabilities/        权限配置
│   ├── icons/               图标（logo.svg 是源文件）
│   └── tauri.conf.json      窗口、打包配置
├── docs/                    格式说明（`seq-format.md` 是给人和 AI 看的图格式契约）
├── .github/workflows/       CI 打包
└── package.json
```

七个内核 crate（`core` / `redis` / `sql` / `ssh` / `agents` / `store` / `tasks`）都被刻意拆成独立 crate：
它们**不依赖 tauri**，所以那几套逻辑都不需要装 WebKit / GTK 就能单独跑测试。
集成测试还会**自己拉起真的服务端**（随机端口、不落盘、跑完就收拾干净）：
`devtoolkit-redis` 起 `redis-server`，`devtoolkit-sql` 起 pg / mysqld，
`devtoolkit-ssh` 起一个**进程内的 russh 服务端**（零系统依赖），
另有一组打真 `sshd` 的。没装对应的服务端时会**明确报错并给安装命令，不静默跳过**。

> ClickHouse / MongoDB 那两组走 **Docker**（官方分发就是容器，让人为了跑测试往本机
> 装一个 clickhouse-server 不现实），所以还要有可用的 Docker。容器由一条读 stdin 的
> shell 挂着，测试进程一退出（正常、panic、被杀都算）就 `docker rm -f -v` 收掉 ——
> **`-v` 不能省**：镜像声明了 `VOLUME`，漏下的匿名卷会把磁盘吃满。

`devtoolkit-agents` 是唯一**不需要任何服务端**的连接类内核 —— 它起的是本机进程，
所以它的测试在任何机器上都能跑（包括真起 `sh` / `cmd.exe` 然后断言进程树被杀干净）。
Windows 上那部分（ConPTY 行为、Job Object 收尸）只能在 Windows 上验，
CI 里专门有一个 `windows-latest` 的 job 盯它。

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
    ├── ssh/
    │   ├── core/       纯逻辑：档案校验、已知主机、尺寸兜底、假 shell、
    │   │               **终端实例的持有者**（terminalHub）
    │   ├── services/   平台桥：tauri 走 Command + IPC Channel，web 走内存假实现
    │   ├── panels/     连接树、标签栏 + 终端、连接表单、首次信任弹窗
    │   └── state/      模块自己的 store（只装元数据，**不装终端字节**）
    ├── agents/         智能体会话（cmux 那种「一屏多个 agent」的工作台）
    │   ├── core/       纯逻辑：**分屏树**（layout）、**状态机**（status）、
    │   │               **OSC 扫描**（osc）、事件文件解析（events）、假 agent
    │   ├── services/   平台桥：tauri 走 Command + IPC Channel，web 走假 agent；
    │   │               还有集成向导（往用户配置里装钩子）
    │   ├── panels/     工作目录树、需要你队列、分屏、窗格、检查器、集成向导
    │   └── state/      模块自己的 store
    ├── tasks/          任务（SQLite 账本）
    │   ├── core/       纯逻辑：筛选、排序、格式化
    │   ├── services/   平台桥：tauri 走 invoke，web 走内存假实现
    │   ├── panels/     卡片列表、详情卡、检查器
    │   └── state/      模块自己的 store
    └── devplaceholder/ 占位模块
```

`agents` 的三块纯逻辑（分屏树、状态机、OSC 扫描）特意做成了不含 DOM、不含 React、
不含服务层的函数 —— 它们是这个模块最容易出错、也最值得被单测盖满的地方。

`src/shared/platform/` 是**所有模块共用**的运行时适配层，它只提供「文件操作 +
系统对话框」这类通用能力：tauri 实现走 `invoke()`，web 实现把工作区放在 localStorage 里。

具体模块自己的网络能力**不放进共享层** —— 那会让共享层认识具体模块。Redis 模块
自己带一套 `services/`（接口 + tauri 实现 + 浏览器实现），结构和 `shared/platform/`
一样，只是归模块所有。

### 全局外观

三档：**跟随系统 / 浅色 / 深色**。入口在图标栏最底下那个半明半暗的圆点（点开是个菜单，
不是直接切换）—— 外壳自己的东西，和模块无关。

存的是**用户选的那一档**，不是解析出来的「深色」：存成后者的話，选了「跟随系统」的人
以后换了系统主题，应用还停在旧配色上，而且再也找不回那一档。

CSS 只认 `<html data-theme>` 一个属性，**刻意不写 `@media (prefers-color-scheme)`** ——
纯 CSS 表达不了「用户明确选了浅色但系统是深色」，两套机制并存的话深色那套变量就得
写两遍，迟早对不上。由 `src/shell/theme.ts` 解析好再写上去。

> 注意区分：**顺序图模块有自己的主题**，那份存在每个 `.seq.json` 里（图发给别人
> 配色也不变，见 `modules/diagram/core/theme.ts`）。全局外观管的是应用外壳，
> 不动图里的配色。

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
| 纯逻辑 | `npm test` | 布局不变量、命令级联、撤销栈、schema 容错、Mermaid 导出、各模块的假实现；**智能体会话的分屏树 / 网格铺屏、状态机、OSC 扫描、事件文件解析**；**SSH 命令块的边界推断、色条几何、字节日志** |
| 界面交互 | `npm run test:e2e` | 在真实 Chromium 里驱动界面：滚动、拖拽、中文输入、导出下载、文件管理、连接与查询、**SSH 终端与首次信任**、**SSH 命令块（一键复制要真读剪贴板、折叠要验展开后内容原样回来）**、**智能体会话的分屏与状态流转** |
| Rust 后端 | `cd src-tauri && cargo test` | 路径逃逸攻击向量、文件操作、导出；三个连接内核打真服务端；**本机进程与事件目录** |
| 原生窗口 | 见下 | 真 Tauri 应用启动 + 读写落盘 + **IPC Channel 那条流式路径** |

数量（会随开发变动，看实际输出为准）：前端单测 ~990、e2e ~185、Rust ~330。

**为什么 SSH 要额外做原生验证**：浏览器版走的是内存假实现，
**完全不经过 `tauri::ipc::Channel`** —— 那条流式路径在前端测试里一次都没被跑过。
所以终端必须在真窗口里连一次真 `sshd` 才算验过（见下面「在无显示器环境里跑原生窗口」）。

**智能体会话的假实现是多走一步的**：浏览器里那个假 agent（`core/fakeAgent.ts`）
报状态时**也走事件文件那条路**（web 客户端把它变成「目录里出现了一个文件」，
前端照常取走、解析、进状态机）。图省事直接改 store 的话，「文件名格式、
取走即删除、对不上号的会话要丢掉」这几条在浏览器里一条都不会被走到 ——
而它们恰恰是外部程序唯一能影响界面的入口。`tests/unit/agents-fake.test.ts`
把这条链路单独串了一遍（敲键盘 → 假 agent → 客户端 → store → 状态机），
和 e2e 的分工是「e2e 管画出来没有，那一组管每一环的语义对不对」。

**打真 `sshd` 的那组 Rust 测试要 root**（sshd 要切换用户身份），所以它**不在 CI 里**，
和 `devtoolkit-sql` 那组一样属于本机验证。CI 只跑 SSH 那组进程内的假服务器测试
（零系统依赖）。这一点在 workflow 的注释里也写了。

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
| `ssh_open` | `id`, `config`, `channel` | `OpenOutcome` | 开会话。**见下面「SSH 的五条命令」** |
| `ssh_write` | `id`, `bytes` | — | 往会话发键盘输入（`bytes` 是 base64） |
| `ssh_resize` | `id`, `cols`, `rows` | — | 告诉远端窗口大小变了 |
| `ssh_close` | `id` | — | 关掉一个会话。幂等 |
| `ssh_close_all` | — | — | 收掉所有会话（前端重载后清孤儿用） |
| `agent_open` | `id`, `config`, `channel` | — | 起一个窗格。**见下面「智能体会话的十条命令」** |
| `agent_write` | `id`, `bytes` | — | 往窗格发键盘输入（`bytes` 是 base64） |
| `agent_resize` | `id`, `cols`, `rows` | — | 拖分隔条之后告诉里面的程序 |
| `agent_close` | `id` | — | 关掉一个窗格**和它那棵进程树**。幂等 |
| `agent_close_all` | — | — | 收掉所有窗格（前端重载后清孤儿用） |
| `agent_take_events` | — | `[{ name, at }]` | 读走攒下的状态事件（读完就删） |
| `agent_events_dir` | — | `string` | 事件目录的绝对路径 |
| `agent_integration_status` | `target` | `IntegrationStatus` | 看钩子装了没有。**不改任何东西** |
| `agent_integration_apply` | `target` | `IntegrationOutcome` | 装/更新钩子，幂等 |
| `agent_integration_revert` | `target` | `IntegrationOutcome` | 精确撤掉我们加的那几条 |

`target` 只有 `claude` / `codex` 两个值（见下面「例外之二」）。
`IntegrationStatus` 是 `{ target, path, state, preview }`、
`IntegrationOutcome` 是 `{ target, path, backupPath, preview }`，
`state` 五个值 `missing` / `absent` / `installed` / `modified` / `unusable`
（`missing` 和 `absent` **刻意不合并**：一个是「还没建过配置」，一个是
「配置在但状态检测没开」，用户要做的动作不一样）。

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

### SSH 的五条命令

前四个连接类模块（含 SQL）都是「一次 invoke、一个结果」。SSH 是**第一个流式模块**，
所以它多了一个别的模块没有的东西：**IPC Channel**。

```
ssh_open(id, config, channel)   ← channel 是 tauri::ipc::Channel，单向往前端推
        │
        ├─ Rust：读循环 → 合并 8ms/4KB → channel.send(Data{base64})
        └─ 前端：new Channel() → onmessage → 解码 → xterm.write(bytes)
```

四条容易踩的：

- **`ssh_open` 的返回值有三种 `kind`，主机密钥的两种拒绝走的是 `Ok` 不是 `Err`。**
  前端要区分「这台机器没见过」「密钥变了」「认证失败」，而 `Err` 那条路上只有
  一句字符串 —— `shared/platform/invoke.ts` 会把任何非字符串的 reject 变成
  `String(e)`，结构化信息到不了。判据是 `kind === 'ready'`。
- **一个 Channel 只能用一次。** Rust 侧丢掉 Channel 时会往 JS 发 `{end: true}`，
  JS 收到就把回调注销。所以任何在发消息之前就返回的 `ssh_open`（首次信任必然
  如此）都会把它打死 —— 前端**每次尝试都新建一个 Channel**。
- **字节走 base64。** 不用 `Vec<u8>`（serde 会编成数字数组，每个字节三四个字符），
  也不在前端拼字符串（SSH 的数据边界会切断多字节 UTF-8，中文会变 U+FFFD）。
- **前端必须串行调用 `ssh_write`。** 每次是独立的 invoke，两次未 await 的调用
  到达顺序不保证，打字会乱序成 `sl`。串行化在 `modules/ssh/services/tauri.ts` 里。

`ssh_resize` 的尺寸在发出去之前会用 `modules/ssh/core/fit.ts` 的 `clampSize`
夹一遍 —— 容器没布局时 `FitAddon` 会给出 `undefined` 或者个位数，直接发出去
远端会真的按 2 列换行，而且之后因为尺寸「没变」再也不会重排。

**`ssh_close` 必须显式调 `eof` + `close` + `disconnect`。** russh 的 `Handle`
的 `Drop` 是个空操作（源码里就一句 `debug!`），丢下它不会断开连接 ——
远端 shell 和 PTY 会一直挂着，keepalive 还在每 30 秒发一次。

### 智能体会话的十条命令

形状和 SSH 那条**故意一样**（Channel 流式、字节 base64、`write` 要串行），
因为要解决的问题是同一类。只有一处不同：这里的进程**在本机**，
所以「关掉的时候不能留孤儿」成了这一层最重的一件事。

```
agent_open(id, config, channel)   ← config = { cwd, shell, command, cols, rows, env }
        │
        ├─ Rust：起一个 shell（不是起 claude）→ 把 command 当输入敲进去
        │        读线程 → mpsc → 转发任务 → channel.send(Data{base64})
        └─ 前端：onmessage → 解码 → xterm.write(bytes)
```

- **命令不在 argv 里。** 起的是一个**正常 shell**，`command` 是开好之后当输入
  敲进去的（自动补一个 `\r`）。三个理由：Windows 上 npm 装的 CLI 是 `.cmd`，
  `CreateProcess` 直接起不来、名字还要靠 `PATHEXT` 补；用户 profile 里的
  PATH / 别名 / 版本管理器要生效；**agent 退出之后用户该剩一个能用的 shell**。
- **`agent_open` 的返回值只有「起来了没有」。** 起不来（工作目录不存在、shell
  找不到）走 `Err`，文案是「起不来：工作目录不存在：…」那种形状 ——
  前端直接拿它当 `exited` 的 `detail` 显示。
- **关窗格 = 杀整棵进程树。** `claude` 底下还有 node；`npm start` 底下还有 npm。
  Unix 上杀**两个进程组**（tty 的前台组 + 会话首进程组 —— 只杀一个会留下另一半），
  Windows 上用 Job Object。这件事有专门的测试盯着（起一个会 fork 的脚本，
  断言孙进程也没了），因为「用户以为关掉了、其实还在跑」是最难发现的一类问题。
- **应用退出时必须 `close_all`。** 别人点「关闭窗口」之后，那屏进程不会自己死 ——
  它们还在调 API、还在改文件。它在 `lib.rs` 的 `RunEvent::Exit` 里，
  Windows 上还有 Job Object 兜底（连 Devtoolkit 崩了都收尸）。
- **钩子用 exec 形式**（`command` 是脚本绝对路径 + `args: ["waiting"]`），
  两个平台都是 —— 不过 shell、不分词。shell 形式在 Windows 上会踩
  「用 bash 还是 PowerShell 取决于装没装 Git Bash」这个变量。



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

### 例外之一：`write_export`

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

### 例外之二：装状态钩子

智能体会话模块要往**用户主目录**里写两个文件（`~/.claude/settings.json` 的 `hooks`、
`~/.codex/config.toml` 的 `notify`），还要在应用数据目录里放一个包装脚本。
这同样套不上工作区沙箱。

和 `write_export` **不一样**的是，这一次把机制做硬了 —— 靠的是**参数表里没有路径**：

```rust
#[tauri::command]
async fn agent_integration_apply(app: AppHandle, target: IntegrationTarget) -> ... {
    //                         ↑ 只有 claude / codex 两个值，是个枚举，不是字符串
    let paths = AgentPaths {
        home: app.path().home_dir()?,        // ← 路径全程在 Rust 手里
        data_dir: app.path().app_data_dir()?, //   前端一个字都插不进来
    };
    integration::apply(&paths, target)
}
```

`IntegrationTarget` 只有 `claude` / `codex` 两个变体，`match` 之后各自拼到 `home`
上。也就是说，**「去写哪个文件」这件事由 Rust 侧的表决定**，前端能表达的只是
「我要 Claude 那个」。WebView 里就算能执行任意 JS，它能做到的最坏情况是
「把钩子装到 Codex 上」，而不是「以本程序权限写任意文件」。
反序列化也在边界上收紧：`"Claude"`（大小写不对）和 `"/etc/passwd"` 都直接失败，
不会悄悄落到某个默认路径上（`agents/src/contract.rs` 有测试钉着）。

读写这个文件本身还有三条纪律，都在 `agents/src/integration.rs` 里：

- **改之前先备份**（原文件旁边一份带时间戳的 `.bak`），`apply` 把备份路径返回给前端；
- **预览**：`status` 和 `apply` 都返回一段「改了什么」的可读文本，用户点「启用」
  之前能看见；用户手改过我们那几条时会认出来（`state === 'modified'`），
  不会假装「已装好」；
- **撤销是精确摘除**，不是「从备份恢复」—— 用户很可能在启用之后又改过自己的配置，
  拿一份旧备份整个盖回去会把他后来的改动一起抹掉。

另外，Codex 那边有个 TOML 的坑值得单独记一笔：**根键必须写在任何 `[表]` 之前**。
往文件尾追加一行 `notify = [...]` 会被当成最后那张表里的键，Codex 读的是根上的
`notify` —— 结果是「写进去了、永远不生效、从文件上看不出来」。所以逻辑是
「已有的 `notify` 行就替换，没有就插到根键区最前面」，测试用**真的 TOML 解析器**
读一遍来验证（`tests/integration.rs` 的 `notify_必须在任何表之前`）。

### 第二个例外：往 Claude Code / Codex 的配置里装钩子

智能体会话模块的状态检测要改用户主目录里的两个文件（`~/.claude/settings.json`、
`~/.codex/config.toml`）—— 也在工作区外面，那条沙箱同样不适用。

它和 `write_export` 的差别在于：**这里的路径完全由 Rust 侧算出来**，前端只能传
一个枚举值（`"claude"` / `"codex"`）。所以它不是靠约定，是**机制上就写不了别的地方**。
`write_export` 那条已知边界的教训，在这个模块里是直接按解法做的。

向导里做到的事：写入前**备份**、把要改的内容原样**预览**、可以**撤销**、
文件不是合法的 JSON/TOML 时**拒绝写入**并说明原因（而不是把用户的配置搞坏）。
合并用的是真的 JSON 解析，用户其它字段原样保留。

另外记一笔这个模块**扩大了攻击面**：它会起用户本机进程（`claude` / `codex` /
一个 shell）。能改会话启动命令的人就能在这台机器上以用户身份执行命令 ——
但那个人本来就能开一个终端，所以这不算新增能力，只是要写下来别让人以为
「Devtoolkit 只会读文件」。

### 主机密钥：TOFU，而且默认拒绝

SSH 的信任全建立在「这台机器的公钥是它本人」上，而第一次连接时程序**没有任何依据**
判断这一点。做法和 OpenSSH 一致：

- **首次连接**弹窗把指纹摆出来，让用户去和服务器管理员核对。不点「信任」就连不上。
- **指纹变了硬停** —— 把新旧并排列出来、拒绝连接，界面上**没有**「就这样继续」的按钮。
  用户确认服务器确实重装过之后，去右键菜单「忘记主机密钥」再重连。
  指纹变更恰恰是中间人的信号，把「继续」做成一键可达会削弱这道防线。
- 记录按 **host + port** 存：同一台机器的 22 和 2222 是两个信任对象，
  只按 host 存会让它们互相冒充。

「静默接受任何主机密钥」这个状态在代码里**不存在**，不是靠约定避免的：
russh 的 `check_server_key` 默认就返回 `false`（拒绝一切），
只有「指纹对得上」或者「用户刚点过信任」两种情况才放行。

信任状态（`known_hosts`）归**前端**持有并持久化，判定在 Rust 侧现场做 ——
和「连接档案归前端、Rust 只存活连接」是同一条分工。

> ⚠️ 这意味着 `known_hosts` 文件被改的话防护就失效了。但能改它的进程，
> 同样能改下面那份明文存的密码 —— 威胁模型里没有新增什么。

### ⚠️ 凭据目前是明文存储

三个连接类模块（Redis / SQL / SSH）的密码都以**明文**落在本机存储里
（桌面端是应用数据目录下 SQLite 的 `kv` 表，浏览器版是 localStorage）。
SSH 还多一个**私钥口令**，是同一张表里的另一个键。这是明确知情的妥协，
沿用工作区路径那套「先明文、标记待改」的做法。

代价说清楚：**任何能读到那份存储的进程都能拿到你的数据库和服务器密码** —— 同机器上的
其他程序、备份软件、误传的配置目录快照，都算。共用电脑上不要填生产密码。

读写收敛在一处：**`src/shared/connections/profiles.ts`**（`TODO(security)` 就在那个文件的头部）。
三个模块共用这一份，所以换成系统钥匙串（Windows 凭据管理器 / macOS Keychain /
Linux Secret Service）时**一次覆盖全部三个**，而不是改三遍 —— 这是当初把这层抽出来的主要理由。
那个文件的注释里写了迁移的三步。

顺带一提，Redis 命令台的回显对 `AUTH` 做了脱敏（`core/redact.ts`）—— 那解决的是**另一个**问题：
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
