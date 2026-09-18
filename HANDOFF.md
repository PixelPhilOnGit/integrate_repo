# Devtoolkit 交接文档

> 起初写于 2026-09-17，2026-09-18 加入 SSH 模块后重写，同日加入智能体会话模块后又补了一轮。
> 接手前先读这一份，比读代码快。
>
> README 讲「是什么、怎么用」，这一份讲「为什么是这样、哪里会坑」。

---

## 一句话状态

**五个模块（顺序图 / Redis / 数据库 / SSH 终端 / 智能体会话）都可用。**

- SSH 是第一个**流式**模块，也是第一个带安全决策（TOFU）的模块
- 智能体会话是第一个**起用户本机进程**的模块，也是第一个**改工作区之外的文件**的模块
  （往 `~/.claude/settings.json` 和 `~/.codex/config.toml` 里装状态钩子 ——
  路径由 Rust 侧算，前端只能传枚举值）

凭据是明文存储（用户明确选的），上生产前必须换钥匙串。下一个是 MongoDB。

---

## 现在能做什么

### 顺序图（完整）

选本地文件夹当工作区、目录树（建子目录/重命名/拖拽/右键菜单）、画 UML 顺序图
（六种参与者、四种消息、激活条、注释）、直接操作、撤销重做、主题、导出 SVG / PNG / Mermaid。

### Redis（浏览式）

侧栏「连接 → 库（带 key 数）」→ 主区 key 列表（类型标签、pattern 过滤、滚动加载）
+ 选中 key 的值（按类型换渲染）。命令台收成一个页签。`` `AUTH` `` 的回显会打码。

### 数据库（MySQL + PostgreSQL 合一）

连接配置里选引擎。侧栏「连接 → 库 → 表」（表缩进在当前库底下），
点一张表生成 `SELECT * FROM 表 LIMIT 100`；主区 SQL 编辑器 + 结果表格。

### SSH 终端

侧栏「连接 → 会话」，主区标签栏 + **真终端**（xterm.js）。
密码 / 私钥文件认证，**多标签**（一个连接可以同时开好几个终端，各自一条 TCP）。
切模块不关会话，回来画面还在。

**安全部分是这个模块的重心**：首次连接弹窗核对指纹（TOFU），
指纹变了**硬停**、必须手动「忘记主机密钥」才能重连。

### 智能体会话（新）

一屏跑多个 Claude Code / Codex 的**本机进程**。侧栏「工作目录 → 会话」，
主区是一棵**分屏树**（任意切、拖分隔条、关一格时兄弟顶上）。
新会话默认起一个 shell 再把命令当输入送进去（不是直接 spawn CLI —— 理由见
`core/types.ts` 的 `command` 字段）。

提醒是这个模块的立身之本，四处在动：**窗格边框变琥珀**、**侧栏顶部的「需要你」队列**
（等得最久的排最前，`Ctrl+Shift+U` 跳过去）、**状态栏计数**、
以及**模块图标上的角标**（用户在别的模块里时唯一看得见的地方）。

状态检测要往 Claude Code / Codex 的配置里装一个钩子，向导里能看到改了什么、
随时撤销。**状态有三个来源，可靠程度不同**，这是接这个模块前必须理解的：

| 来源 | 能给什么 | 说明 |
|---|---|---|
| Claude Code 的 hooks | 工作 / 需要你 / 完成 | 最准。**等授权要用 `PermissionRequest`**，见下 |
| Codex 的 `notify` | **只有「完成」** | **v1 用的就是这条**：只有 `agent-turn-complete` 一个事件 |
| Codex 的 hooks | 三态齐全（**下一轮**） | 0.149.0 里有一套和 Claude 对齐的 hooks 引擎（源码里叫 `ClaudeHooksEngine`），事件名一样、含 `permission_request`。**但要用户在 `/hooks` 里审阅信任一次，而且信任按哈希记账 —— 我们改一次他就要重审**。切换前必须先确认两件事：配置写哪个文件（`hooks.json` 还是 `config.toml` 的 `[hooks]`）、信任怎么落盘。这两条只能在真机上确认 |
| 终端通知序列（OSC 9 / 777） | 至少「完成」 | 零配置那条路。⚠️ 别写「Codex 默认会发」，没证实 |
| 用户在窗格里的键盘 | 「需要你」→「正在工作」 | 用户的动作，不是猜测 |
| 进程退出 | 终态 | pty 报的，比脚本可靠 |

**所以 Codex 的「需要你」在 v1 拿不到**（`notify` 只有回合完成），靠 OSC 和键盘兜底。
拿不到就是拿不到，代码里没有编一个假的「等待中」出来 —— 下一轮换 hooks 才补上。

**要命的那条**：「等授权」不能用 `Notification`。官方文档写明它要等约 6 秒、
而且**只在你看起来离开了终端时才发**；即时的信号是 **`PermissionRequest`**
（权限弹窗一出现就触发），官方自己就让你改用后者。

另外两条配置上的坑（都查过文档，不是猜的）：
- **`UserPromptSubmit` / `Stop` 不支持 matcher**（官方表格原文 no matcher support），
  给它们写 matcher 是死配置：不报错也不生效。
- **hook 一律用 exec form**（handler 里写 `args`）：不写 `args` 是 shell form，
  命令串要过 shell 分词，而 Windows 上默认 shell 是 bash（装了 Git Bash）否则
  powershell —— 一条 `C:\路径\hook.cmd waiting` 交给 bash 会很难受。
  写了 `args` 就直接 spawn、不过 shell、不做分词，`shell` 字段也被忽略，
  正好把「用户装没装 Git Bash」这个变量消掉。

**Codex 的 hooks 要用户去 `/hooks` 审阅一次**（信任按 hook 定义的**哈希**记账，
我们改一次它就得重审一次 —— 所以生成的内容要稳定，别塞时间戳）。

---

## 怎么跑起来

```bash
npm install
npm run dev          # 浏览器版（不需要任何系统依赖，最容易跑起来）
npm run tauri:dev    # 桌面版（需要 Rust + 系统 WebView 依赖，见 README）
```

**浏览器版不是玩具**：headless 环境起不了原生窗口，Playwright 全靠它驱动。
所以每个连接类模块都自带一份**足够真的假实现**（假 SSH 有真的行规程、命令历史
和一个内存文件系统：`cd 项目` 之后再 `pwd` 真的会变）。

```bash
npm run typecheck    # 类型检查
npm test             # 792 个纯逻辑单测（秒级）
npm run test:e2e     # 147 个端到端测试（真实 Chromium）
cd src-tauri && CARGO_BUILD_JOBS=2 cargo test   # 182 个 Rust 测试
```

### ⚠️ 跑测试/编译之前必读

```bash
nice -n 19 ionice -c3 env CARGO_BUILD_JOBS=2 cargo test
```

- **这台机器只有 2 核**。cargo 会把两个核吃满，code-server 抢不到 CPU 就会掉线。
  套 `nice` 让交互式会话永远优先。
- **不要并发跑多个构建**。`CARGO_BUILD_JOBS=2` 不是可选项，默认并行度会 OOM。
- 跑完测试**检查有没有残留的数据库/sshd 进程**（见「踩过的坑」里那段惨案）。

### Rust 测试要装服务端

```bash
sudo apt-get install -y redis-server postgresql mysql-server openssh-server
```

集成测试**自己拉起随机端口、不落盘的真实例**，`Drop` 时杀掉。没装会明确报错
并给安装命令，**不会静默跳过**。

> ⚠️ **打真 `sshd` 的那组测试要 root**（sshd 要切换用户身份），所以它**不在 CI 里**，
> 和 `devtoolkit-sql` 那组一样属于本机验证。SSH 另外那两组用**进程内的 russh
> 服务端**，零系统依赖，CI 里跑的就是它们。
>
> SQL 那套还要求测试进程能切到 `postgres` / `mysql` 系统用户 ——
> 这两个引擎拒绝以 root 运行，夹具靠 `CommandExt::uid/gid` 降权。

---

## 架构

```
src/
├── shared/        通用层
│   ├── connections/   连接类模块共用的连接层（Redis / SQL / SSH）
│   ├── platform/      文件、对话框、系统偏好、键值存储
│   └── terminal/      终端实例表（SSH 和智能体会话共用）
│                      ★ 不 import 任何模块
├── shell/         外壳：模块注册表、图标栏、状态栏、错误条
│                  ★ 不认识任何具体模块，只认 Module 接口
└── modules/
    ├── diagram/   顺序图
    ├── redis/     Redis
    ├── sql/       数据库
    ├── ssh/       SSH 终端
    ├── agents/    智能体会话（一屏多个 agent）
    └── devplaceholder/  占位（验证「加模块 = 一个目录 + 一行」）
```

```
src-tauri/
├── src/         commands.rs（文件）/ redis_commands.rs / sql_commands.rs /
│                ssh_commands.rs / agent_commands.rs
├── core/        devtoolkit-core：路径安全 + 文件操作
├── redis/       devtoolkit-redis：连接管理、命令执行、回复解析
├── sql/         devtoolkit-sql：MySQL / PostgreSQL 连接与查询
├── ssh/         devtoolkit-ssh：连接、认证、主机密钥、PTY 会话
└── agents/      devtoolkit-agents：本机进程、状态事件目录、集成配置读写
```

五个 crate 都**不依赖 tauri**，所以能脱离 WebKit/GTK 跑测试（含打真服务端的集成测试）。

### 加一个模块要做什么

**写一个目录 + `src/shell/registry.ts` 加一行。**

```ts
export const MODULES = [
  diagramModule, redisModule, sqlModule, sshModule, agentsModule, devPlaceholderModule,
];
```

接口在 `src/shell/types.ts` 的 `Module`。**五个真实模块都是这么加上去的**。

> ⚠️ 注册表顺序 = 图标栏顺序 = `Ctrl+1..6` 的顺序，**是面向用户的**。
> 另外 `main.tsx` 的 `defaultExtension` 取 `MODULES[0]`，顺序图必须留在第一位。
> 加模块会让 `tests/e2e/shell.spec.ts` 里那两个「有几个模块」的断言挂掉 —— 那是**故意的**。

---

## SSH 模块：为什么和前面三个长得不一样

这是第一个**流式**模块。前三个都是「发一条请求、等一个结果」，SSH 是长连接上的
双向流：远端随时吐字节，写/resize/关闭是三条独立的命令。所以有三处结构差别：

### 1. 终端字节**不走 store**

前三个模块的 store 装「连接状态 + 结果」，更新频率是人手级别。终端是每秒几十次的
字节流，每次过 `set()` 都会让侧栏和标签栏重渲染。所以分两层：

- **store**（`state/store.ts`）：档案、`runtime`（按**档案**）、`sessions`（按**会话**）、
  信任提示、已知主机。
- **`core/terminalHub.ts`**：**拥有 xterm 实例本身**，负责字节投递。React 全程看不见字节。

注意这里有两套粒度：`sessions` 按会话 id、`runtime` 按档案 id。一个档案可以同时开
好几个会话（多标签），而侧栏那个状态点回答的是「这个档案现在连着没有」——
它是**从 sessions 推出来的**（`statusOf`），不另存一份。

### 2. 终端「藏起来」而不是「销毁重建」

切标签、切模块时，终端实例**不销毁**，容器挪到屏幕外的 holder（`position: fixed; left: -20000px`
+ 固定尺寸）。回来时挪回去。

一开始想的是「销毁 xterm、回来用缓冲的字节重放」。**那行不通**：裸字节重建不出终端的
**状态** —— `DECCKM`（vim/less 里方向键发什么序列）、bracketed paste、备用屏幕、滚动区域，
全都是会话早期设置一次的**粘性模式**，不在最近的输出里。重放的结果是全屏程序切回来就
永久花屏，而且因为重排之后尺寸没变**不会发 SIGWINCH**，vim 不会重绘。

> ⚠️ holder **不能用 `display: none`** —— 那样 `clientWidth` 变 0，xterm 量不到尺寸，
> `fit()` 会算出垃圾值（实测踩过：远端按 2 列换行）。

### 3. IPC 上多了一个 Channel

`ssh_open` 收一个 `tauri::ipc::Channel`，读循环把输出合并（8ms / 4KB）后往里推。
**四条容易踩的：**

- **一个 Channel 只能用一次。** Rust 侧丢掉 Channel 会往 JS 发 `{end: true}`，
  JS 收到就把回调**注销** —— 首次信任那一次必然在发消息之前就返回，会把通道打死。
  所以**每次尝试都新建一个 Channel**。
- **`ssh_open` 的三种结局里，主机密钥的两种走 `Ok` 不是 `Err`。**
  前端要区分「没见过」「变了」「认证失败」，而 `Err` 那条路上只有字符串
  （`shared/platform/invoke.ts` 会把非字符串 reject 变成 `String(e)`）。
- **字节走 base64**：不用 `Vec<u8>`（serde 编成数字数组，每个字节三四个字符），
  也不在前端拼字符串（SSH 的数据边界会切断多字节 UTF-8，中文会变 U+FFFD）。
- **`ssh_write` 必须串行**：每次是独立 invoke，到达顺序不保证，打字会乱序成 `sl`。
  串行化在 `services/tauri.ts` 的一条 promise 链里。

---

## 智能体会话：状态是怎么从外面进来的

### 钩子写「事件文件」，不是调我们的程序

约定是：**一个会话一个文件，状态写在文件名里**（`waiting.<会话id>`，
状态只有 `working` / `waiting` / `done`），时间戳用**文件的 mtime**。

为什么这么绕：

- **写它的必须是一段纯 shell 脚本，不能是 Devtoolkit 主程序。**
  Tauri 二进制启动要 200ms+，而 Claude Code 的钩子**同步阻塞 agent** ——
  每回合卡 200ms，用户会以为工具坏了。写个文件是 shell 一句重定向的事。
- **状态放文件名而不是内容**：shell 里生成时间戳要面对 `%TIME%` 的 locale 差异，
  写内容要面对引号和换行 —— 而文件名只需要 `echo. > "%DIR%\%1.%PANE_ID%"`。
- **mtime 当时间戳**：操作系统替我们记，脚本一个字都不用写。

好处顺带有三个：不占端口、Windows 上不弹防火墙、**应用没开着时事件也不丢**
（攒在目录里，下次启动读到；对不上号的会话丢掉）。

**防伪造两道**：目录在应用自己的数据目录下；文件名里的会话 id 必须对得上一个
活着的会话（id 是 `newId` 生成的随机串）。第二道在 store 里，因为会话表在它手里。

### OSC 扫描器是**旁观者**，一个字节都不吃

终端通知序列（`OSC 9` / `OSC 777`）是零配置那一路。⚠️ 别在文档里写「Codex 默认会发
OSC」—— 那个说法（配置键 `tui.notifications`）**没证实**：Codex 0.149.0 的二进制里
grep 不到，官方能核对的只有 `notify`。二手资料里到处都是，但别当事实。
（Claude Code 那边是有文档的：hook 可以返回 `terminalSequence` 代为发射，
白名单是 OSC 0/1/2/9/99/777 和裸 BEL，而且**在 Windows 上可用**。）

扫描器**必须只观察、不删字节**：OSC 这个命名空间里
还有设置窗口标题（0/2）、超链接（8）、终端能力上报，顺手把认出来的序列删掉会把
它们一起弄坏，而且坏法很隐蔽（标题不更新了，没人会想到是通知扫描干的）。

序列**跨字节块**是常态（`ESC` 在一块结尾、`]` 在下一块开头），所以扫描器必须是有状态的。
它按会话分开持有（两个会话的字节流混在一起会拼出谁也认不出来的东西）。

### 「我知道了」只对**这一次**等待有效

规则是「状态一变，确认作废」，**刻意不看时间戳**。原来是「ackAt 比 statusAt 新就算
已确认」，那要求两个时间戳同源 —— 而 statusAt 有一部分来自**事件文件的 mtime**，
那是外部程序写的、可能被复制过来、时钟还可能是偏的。两个时钟对不上时，要么
永远不再提醒你，要么提醒个没完。

### 事件要按时间顺序**逐条**应用

曾经写的是「同一个会话只留最新那条」（为了避开没开机时攒下的一堆）。那有个真漏洞：
`working` 紧接着 `waiting` 这一对会被压成一条 `waiting`，于是「它离开过等待又回来了」
这个事实就没了 —— 而你确认过的会话正要靠它**再次**叫醒你。状态机本身会吃掉重复的
信号（返回同一个对象），所以逐条应用既不会多记流水账，也不会丢信息。

---

## ⚠️ 踩过的坑（省得你再踩）

### 最容易骗到自己的那个

- **跑 release 二进制之前先把 dev server 关掉**，并且**确保没有旧的 Xvfb 占着 `:99`**。
  release 二进制不内嵌前端的话会去连 `devUrl`（localhost:5173），
  开发机上它**永远是"好的"**，装到用户机器上就是一片白。
  ```bash
  pkill -f 'vit[e]'                       # 先关 dev server
  pkill -9 -f 'Xvf[b]'; rm -f /tmp/.X99-lock   # 清掉残留的 Xvfb（它带着 X 授权，会让新起的连不上）
  npx tauri build --no-bundle
  ```
- **没有窗口管理器时 WebKitGTK 会抑制表单控件的激活事件** —— 按钮点了没反应。
  终端和按钮全是表单控件，所以真机验证**必须先起 `openbox`**。
  另外手动起 Xvfb 要加 `-ac`（关掉 X 授权），否则分多次调用进来会拿不到 cookie。

### 三个只有真链路才抓得出来的（都归智能体会话那轮的 e2e）

这三个的**共同点**比它们各自更重要：**store 的单测全绿，因为单测里假客户端的
`write` 不吐字节、hub 是个替身**。凡是「顺序」和「跨对象协作」的问题，替身都会
把它们抹平。所以那个模块另外补了一组 `agents-fake.test.ts`（假实现走完整条链路，
不碰 DOM），分工是「e2e 管画出来没有，那一组管每一环的语义对不对」。

1. **终端在会话进 state 之后才建。** 会话一进 state，React 立刻把那一格渲染出来，
   而那一格的 effect 去 hub 里找终端时还没有 —— `attach` 遇到不存在的会话是
   **静默空操作**（它按「会话可能已经关掉了」处理）。表现：侧栏、状态、退出码全对，
   **只有画面是空的**。现在 `createSession` 先 `await hub.create`，再 `patch` 进 state。
2. **按键的信号落在了进程回话之后。** 原来是先 `await client.write(...)`、再记
   「用户敲了键」。而进程收到 Enter 往往**立刻**输出，输出里带着 OSC 通知 ——
   于是刚收到的「需要你」当场被那条 `user-typed` 改回「正在工作」，通知里那句话也没了。
   因果反了：**用户的那一下发生在先**，改成先记信号、后写进程。
3. **信息少的那条信号覆盖了信息多的那条。** OSC 说了「等待你的确认」，紧接着
   hook 那条不带说明的事件也到了：状态一样，但说明被抹成了空，界面上只剩一个
   光秃秃的「需要你」。现在状态机里区分「明确没有说明」（`null`）和
   「这条没带说明」（`undefined`），后者保留原来的说明。

### 这一轮真机验证抓到的那条（只有它能抓到）

**`#[serde(rename_all = "camelCase")]` 加在枚举上，只改变体名，不改变体内部的字段名。**

```rust
#[serde(tag = "kind", rename_all = "camelCase")]           // ❌ Key → key 生效，private_key_path 不生效
#[serde(tag = "kind", rename_all = "camelCase",
        rename_all_fields = "camelCase")]                   // ✅
```

症状是 `invalid args 'config' for command 'ssh_open': missing field 'private_key_path'`。

**为什么两边测试都没抓到**，这一点比 bug 本身重要：
- 浏览器版 e2e 走 `services/web.ts` 的假实现 —— **根本不经过 serde**；
- Rust 集成测试在 Rust 里构造 `SshConfig` —— **不经过反序列化**。

**教训**：前端和 Rust 之间那条缝，两边各自的测试**结构性地盖不到**。
现在 `ssh/src/session.rs` 底部有一组 `contract` 测试，拿**前端会发出来的那个 JSON 字面量**
去反序列化。以后加 IPC 类型时照抄——而且要手写字段名，别照着 Rust 结构体拼。

### CSS 类名先 grep 再用（又栽了一次）

`.rd-tabs button { flex: 1 }` 是给 Redis/SQL 的「浏览 / 命令台」两格切换器用的。
SSH 的标签栏图省事复用了 `rd-tabs`，结果**标签和那个 × 各占一半宽度**——
实测标签 157px 宽，label 78px、close 78px，**点标签正中间会把标签关掉**。

上一轮已经因为 `.rd-dot` 撞过文件树一次，这次换了个类接着撞。
**规矩：用任何 `rd-` 开头的类之前先 grep 一遍定义。**

### 这台机器的 shell 陷阱

- **`pkill -f '<模式>'` 会匹配到它自己的命令行**，把正在跑的那条 shell 一起杀掉。
  表现是「退出码 144、没有任何输出」，看起来像环境崩了。
  解法：让模式不自匹配 —— `pkill -f 'vit[e]'`、`pkill -f 'devtoolk[i]t'`。
  **要筛进程就把脚本写进文件**（这一轮验证 Xvfb 残留时又用到）。
- **`cmd | tail` 会把退出码吃掉**（`$?` 是管道最后一个命令的）。
  用 `set -o pipefail` 或 `${PIPESTATUS[0]}`。
- **cargo 镜像配在 `/root/.cargo/config`（无扩展名）**，它**优先于** `config.toml`。
  往 `config.toml` 写东西会被静默忽略。现成配的是阿里云稀疏索引，可用，**别动**。

### 数据库测试夹具（血泪）

- **收尾必须杀整个进程组**：数据库是 shell `&` 出来的子进程，只杀 shell 会留孤儿。
  **而且不能写 `kill -KILL -12345`** —— procps 的 kill 把它当选项解析，一个都杀不掉。
  要用 `sh -c "kill -9 -<pgid>"`。
  > 漏过两轮孤儿进程（第二次 12 个 mysqld），把机器吃到只剩 500M，
  > **用户的 code-server 会话被反复踢下线**。
- **启动失败之后不要再重试**：`OnceLock::get_or_init` 在闭包 panic 之后不缓存，
  每个后续用例都会再起一个实例 —— 形成死亡螺旋。夹具里加了原子计数器。
- **两个引擎都拒绝以 root 运行**，要 `CommandExt::uid/gid` 降权 + 先 chown 数据目录。
- **`mysqld --initialize-insecure` 建的 root 只认 unix socket**，直接走 TCP 会报
  `ERROR 1130`。夹具先用 socket 建一个 `root@'%'`。
- **临时目录也要 `Drop` 清理**。`core/tests/export.rs` 当初漏了，每跑一次
  `cargo test` 就往 `/tmp` 漏一批目录，攒到 32 个才发现 —— 已修。

### russh 的三条行为（都读过源码，写错了不报错，只是表现得「说不清哪里不对」）

1. **`Handle` 的 `Drop` 是空操作**（源码里就一句 `debug!("drop handle")`）。
   丢掉它**不断开连接** —— 远端 shell 和 PTY 会一直挂着，keepalive 还在每 30 秒发一次。
   要断必须显式 `eof()` + `close()` + `disconnect()`。
2. **`ChannelMsg::Close` 到不了客户端的接收端**（`encrypted.rs` 里处理成
   `channels.remove()`，不往接收端发消息）。所以 `ChannelReadHalf::wait()` 返回 `None`
   才是**正常的会话结束信号**。按「匹配 Eof/Close」写读循环，要么 panic，
   要么在关掉的 channel 上**空转 100% CPU**。
3. **`request_pty` 的第一个参数是 `want_reply`**。传 `false` 不报错，
   只是静默降级成**没有 PTY 的 shell** —— 没有行规程、没有作业控制、
   `Ctrl+C` 杀不掉前台进程。

另外：`ChannelWriteHalf` **不是 `Clone`**（结构体没 derive），外面要套 `Arc`；
`client::Config` 的 `keepalive_interval` 默认是 `None`（死连接永远发现不了），
要自己设；`Handler::check_server_key` 的**默认实现拒绝一切**，TOFU 正好挂在这上面。

### 智能体会话那一轮踩到的

- **关窗格要杀「两个」进程组，不是一个。** 子进程 spawn 时 `setsid()` 过，
  它是一个会话首进程、自己的组的组长；可它**开了作业控制之后**，跑在前台的
  那个命令（`claude` 本尊）会被放进**另一个**组 —— 那才是 tty 的前台组。
  只杀前者 = shell 死了 claude 还活着；只杀后者 = 反过来。两个都杀才对
  （`pty.rs` 的 `kill_tree`，写成测试钉住了：起一个会 fork 的脚本，
  断言孙进程也没了）。
  > 自己 `setsid()` 逃走的进程（`nohup`、daemon）**故意不覆盖** —— 那正是
  > `setsid` 的用途，所有终端模拟器都是这条边界。Windows 上的 Job Object
  > 反而更彻底（除非显式 `CREATE_BREAKAWAY_FROM_JOB`）。
- **`portable-pty` 的 `Child::kill()` 在 Windows 上只有一句 `TerminateProcess`**
  （源码 `win/mod.rs`，就一行），指望不上。Windows 要靠 Job Object
  （`KILL_ON_JOB_CLOSE`）—— 顺带的好处是**Devtoolkit 自己崩掉也收尸**，
  因为进程一死内核就关句柄。
- **`2>/dev/null` 拦不住重定向失败。** 那种时候说话的是 **shell 自己**，
  不是被执行的命令，所以错误照样打到用户的终端上（实测 dash：钩子脚本在事件
  目录不存在时打出一句 `cannot create ...: Directory nonexistent`）。
  得把重定向放进子 shell：`( : > "$F" ) 2>/dev/null`。
  包装脚本现在还会先 `mkdir -p` —— 用户在自己的终端里跑 claude 时，
  钩子**必须**安静，这条有测试盯着（退出码 0 + 没有输出 + 没有文件）。
- **Windows 上那条钩子命令不能用 shell 形式写。** `"C:\路径\hook.cmd" waiting`
  这种写法只在 cmd 里成立：PowerShell 里带引号的路径必须加 `&` 调用运算符，
  而 Git Bash 里根本跑不了 `.cmd`（而 Claude Code 默认走哪个 shell 取决于
  **机器上有没有装 Git Bash**）。所以 Windows 上用 exec 形式
  （`command` + `args`，参数逐个传、不经过任何 shell），Unix 上才用
  `"<脚本>" <状态>` 那句。见 `integration.rs` 的 `claude_entry`。
- **`claude doctor` 和 `codex doctor` 是现成的 schema 校验器。**
  两边都会读配置文件并把不合法的地方**逐条列出来**（`Invalid settings` /
  `could not be loaded`），而且都认 `HOME` / `CODEX_HOME` 这种临时目录 ——
  所以 `tests/claude_schema.rs` 和 `tests/codex_schema.rs` 就是「用我们自己的
  代码装一遍，再让真的 CLI 去读它」。**写错 schema 是静默失效**（配置躺着、
  界面显示已启用、状态点不动），只有这个能抓到。它们不在 CI 里（runner 上没装
  这两个 CLI），属于本机验证。
- **pty 会把我们敲进去的命令回显出来。** 测试里「等 `KID=` 出现」会先等到
  **回显**里的那个 `KID=$!`（后面跟的不是数字）—— 这类断言最容易假绿。
  `tests/common/mod.rs` 的 `read_pid` 是等「标记后面真的跟着数字」那一次。

### 前端

- **`noUncheckedIndexedAccess` 开着**，`arr[i]` 一律是 `T | undefined`。
- **`Omit<联合类型, K>` 会把各分支的独有字段全丢掉**，要写
  `T extends unknown ? Omit<T, K> : never`（见 `WithoutSeq`）。
- **`justify-content: space-between` 是个陷阱**：子元素个数一变，排布就变。
- **`.rd-content` / `.rd-body` 必须是"布局透明"的**（`flex: 1; min-height: 0`）。
- **`FitAddon` 在容器没布局时会给 `undefined` 或者个位数的尺寸**，直接拿去
  `ssh_resize` 会让远端按 2 列换行。`core/fit.ts` 的 `clampSize` 负责兜住
  （拿不准就返回 null，宁可尺寸停在旧值上）。
- **xterm 走动态 import**：模块注册表在启动路径上把所有模块都拉起来，
  静态 import 会让每个用户无论用不用 SSH 都先下载解析一遍 xterm。

### 驱动原生窗口做真机验证

`xdotool` + `openbox` + ImageMagick 的 `import`：

```bash
export DISPLAY=:99
Xvfb :99 -screen 0 1440x900x24 -ac &   # -ac 关掉 X 授权，分多次调用才连得上
openbox &                              # 不起它的话按钮点不动
WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 ./src-tauri/target/release/devtoolkit &
import -window root shot.png           # 截图，然后按像素坐标点
xdotool mousemove X Y click 1
```

**应用的数据目录是 `~/.local/share/com.devtoolkit.desktop/`**（不是 `~/.config/` ——
tauri-plugin-store 用的是 `app_data_dir`）。那份 `*.json` 可以直接预埋，
省掉一堆表单操作。

---

## 设计决定（几条不那么显然的）

- **激活条锚定消息 id，不是坐标**；**`participants` 按 x 有序、`messages` 按 y 有序是强制不变量**
- **缩放改 `viewBox` 不用 CSS transform** —— 后者把矢量文字变成位图
- **网络客户端放 Rust 侧** —— CSP 的 `connect-src` 敞不开，前端直连会被拦
- **服务器/引擎报错是「一条结果」，不是「执行失败」** —— Redis 的 `-ERR unknown command`、
  SQL 的表不存在、**SSH 的远端 shell 正常退出**，都内联显示，**不弹外壳错误条**。
  四个模块都有守门测试盯着这条。
- **浏览优先，不是命令台优先**；**命令参数逐个塞进 `Cmd` / 走驱动 API，绝不拼字符串**
- **切模块不断开连接** —— 连接是廉价且用户预期跨模块存活的资源
- **SSH 会话在切模块时也不关**（`onDeactivate` 什么都不做）。
  这一条**违背** `shell/types.ts` 里那句「终端之类需要断连接的模块会用到它」的预期，
  理由很具体：切去顺序图看一眼再回来会话没了，那是坏掉的终端客户端。
  真正该收尾的时机是应用退出；webview 重载留下的孤儿由 `init()` 里的 `closeAll()` 收。
- **主机密钥的信任状态归前端持有、判定在 Rust 侧做** —— 和「连接档案归前端、
  Rust 只存活连接」是同一条分工。前端不信任任何东西，只是持久化用户的决定。
- **「忘记主机密钥」是唯一的解信任路径**。指纹变了之后界面上**没有**「就这样继续」
  的按钮 —— 那个按钮恰恰会在真正危险的时候被顺手点掉。
- **切认证方式会清掉另一边的凭据**（切到私钥就清空密码）。用户以为「我改成密钥了，
  密码应该没了吧」而实际没有，那是安全上的意外，不只是洁癖。
- **分屏按钮 = 新开一个同类型的会话**，不是「把某个已有会话放上来」。
  分屏的意图几乎总是「再开一个」；想把已有的摆到旁边，走侧栏的右键菜单。
  新会话也**替换**当前聚焦那一格，而不是把屏幕再切一刀。
- **关一格 ≠ 关会话。** 关掉的是屏幕上的位置，进程留着（侧栏里还在，点一下又上屏）。
  真要把进程收掉是另一个动作（右键「关掉这个会话」），而且它带确认的语义边界很清楚。
- **「需要你」队列只收 waiting，不收 done。** 已完成是结果，需要你才是「现在有事」——
  混在一起的话那个数字会一直亮着，然后被无视。
- **全局外观存的是「选择」不是「结果」。** 三档里的「跟随系统」如果存成解析后的
  深色/浅色，用户以后换了系统主题，应用会停在旧配色上，而且再也找不回那一档。
  同理：**明确选了档位之后，系统主题变化不该动它** —— 用户刚做的选择被系统设置
  悄悄改掉是最让人恼火的一类问题。
- **深色只认 `<html data-theme>` 一个属性，不用 `@media (prefers-color-scheme)`。**
  纯 CSS 表达不了「用户明确选了浅色但系统是深色」；两套机制并存的话，深色那套变量
  得写两遍（媒体查询一份、属性选择器一份），迟早对不上。
- **`portable-pty` 钉死在 `=0.8.1`，不要升 0.9。** 0.9 为了暴露 `signal()` 顺手打开了
  `PSUEDOCONSOLE_INHERIT_CURSOR`：那一会让 ConPTY 往输出里插 `ESC[6n` 问「光标在哪」
  并**在后台线程等应答**，不应答就卡住（MS 文档原话是 "may cause the calling
  application to hang"，上游 wezterm#6783 至今未修）。症状是**终端一片空白且不报错** ——
  对「用来盯 agent」的应用来说这是最糟的失败模式。
  更关键的是：**`signal` 是 Unix 独有的**（portable-pty 只在 `#[cfg(unix)]` 里填它，
  Windows 上永远是 `None`），而 Windows 是第一目标平台 —— 为一个只在最低优先级平台上
  存在的装饰性字段，去换主力平台上的启动风险，不划算。
  真要 `signal()` 的话正确做法是 **vendor Codex 的 Windows PTY 后端**
  （`codex-rs/utils/pty/src/win/`，MIT，约 700 行），它在**创建时**就挂 job object，
  顺带消掉我们那个 assign 竞态窗口。`pty.rs` 是唯一碰 portable-pty 的地方，就是为这天留的。
- **关一格窗格要杀两个进程组**，不是直觉里的一个：子进程 `setsid()` 之后是会话首进程，
  但它开了作业控制、跑在前台的 `claude` 在**另一个**组（tty 的前台组）里。只杀一个必留另一半。
  测试里有一条**回归用例专门证明「只杀直接子进程」确实会留孤儿**。
- **事件目录「取走即删」**（一个事件只用一次）。文件名里的状态只有三个白名单值，
  认出来才消费；认不出来的（编辑器残留、用户手扔的）**静静留着不动** ——
  动它就可能删掉别人的东西，而收益是零。
- **模块图标上的角标是个组件，不是一个数字。** 外壳只摆一个槽位，模块在自己的角标里
  订阅自己的 store（和 `StatusItems` 同一个模式）。这样外壳依然不认识任何具体模块，
  而用户在别的模块里画图时，「有 agent 停下来等你」还剩这一个地方能看见。

---

## 环境变更（这台机器）

1. **装了服务端**：`redis-server` 7.0.15、`postgresql` 16、`mysql-server` 8.0.46、
   `openssh-server`（集成测试要用）。另外 `xdotool` / `openbox` / `imagemagick`
   在真机验证时用得上。
2. **code-server 是 HTTPS**：自签证书在 `~/.config/code-server/rustdraw.crt`。
   原因是 `http://` 不是安全上下文，`navigator.clipboard` 不可用。
   > ⚠️ **密码还是 `123456`，端口公网可达**。建议换掉或只监听 127.0.0.1。
3. **cargo 镜像不用配** —— `/root/.cargo/config` 早就有阿里云镜像了。
4. 系统里跑着一个 apt 装的 `mysqld`（监听 3306）和一个系统 `sshd`（监听 22），
   不是测试起的。测试用的实例都带 `/tmp/devtoolkit-*-test-*` 标记，好区分。

---

## 智能体会话：Windows 真机验证清单

**这台开发机是 headless Linux 容器，跑不了 ConPTY。** 下面这些只能在 Windows 上打勾，
每一项都对应一个「在 Linux 上验不了」的假设：

- [ ] 起一个 **Claude Code** 会话：终端里能看到它的 TUI，光标、颜色、备用屏幕正常
- [ ] 起一个 **Codex** 会话：同上
- [ ] 窗口拉伸/分屏之后 TUI **重绘正确**（不是按旧的列宽排版）—— resize 那条路
- [ ] 连开 3~4 个会话分屏，输入法、中文、粘贴都正常
- [ ] 在一个窗格里 `Ctrl+C`，别的窗格不受影响
- [ ] **关掉一个窗格再打开任务管理器**：没有残留的 `node` / `claude` 进程
- [ ] **直接关掉 Devtoolkit 主窗口**，任务管理器里同样没有残留
- [ ] 装上集成钩子之后，新开一个 Claude Code：随便让它干一件事，
      侧栏状态点应该从「空闲」变成「正在工作」，干完变「已完成」
- [ ] 让它问你要授权（比如让它执行一条命令），应该变「需要你」并进队列
- [ ] Codex 那边**只需要「已完成」能到**（v1 走 `notify`，它只有回合完成一个事件）。
      「需要你」拿不到是**已知缺口**，别当成 bug 报 —— 补法是下一轮换 hooks
      （见上面那张表里「Codex 的 hooks」那一行）
- [ ] **hook 会不会闪出黑框**：有人报过 Windows 上 hook 进程会弹一下控制台窗口
      （claude-code #64688）。如果闪，那是个真烦人的问题 —— 记下来，看能不能
      在包装脚本那边缓解
- [ ] 集成向导点「启用」之后再点「撤销」，`.claude/settings.json` 能还原
      （改之前会备份，备份文件就在旁边）

验不过的时候先看两处：检查器里那张「状态检测」卡片（事件目录路径 + 最近收到状态的时间），
以及 `%APPDATA%\com.devtoolkit.desktop\agents-events\` 里有没有文件出现。

---

## 下一步：MongoDB

用户既定路线里的下一个。可以照着 SQL 那个模块抄：连接配置里选引擎的做法已经跑通，
Mongo 的连接串形态不同但模块骨架（services + core + state + panels）是一样的。

**要注意的不同点**：Mongo 的结果是文档（嵌套的 BSON），不是表格。
「结果表格」那套（`result.rs` 的 `Cell` / `ColumnInfo`）直接套会很难看 ——
先想清楚文档怎么显示（树？JSON？两种切换？）再动手。

### ⚠️ 上生产之前必须解决的：凭据存储

现在**四个模块**的连接密码都是**明文**存进各自的 json 文件（桌面端在
`~/.local/share/com.devtoolkit.desktop/`，浏览器版在 localStorage）。
SSH 还多一个**私钥口令**，存在同一个文件的同一个键下面。

读写收敛在一处：**`src/shared/connections/profiles.ts`**。
那里的注释写了迁移到系统钥匙串的三步。**因为四个模块共用这一份，
迁移一次就覆盖全部** —— 这是当初抽共享层的主要理由。

真正拿它连生产环境之前必须换掉。

---

## 代码规模（参考）

| | 行数 |
|---|---|
| 前端 `src/` | ~17k |
| Rust `src-tauri/` | ~9k |
| 测试 `tests/` | ~10k |

提交历史（`git log --oneline`）按 feature 拆得比较干净，
每个提交的 message 里都写了「为什么这么做」和踩到的坑，值得一读。
