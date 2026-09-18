# Devtoolkit 交接文档

> 起初写于 2026-09-17，2026-09-18 加入 SSH 模块后重写。
> 接手前先读这一份，比读代码快。
>
> README 讲「是什么、怎么用」，这一份讲「为什么是这样、哪里会坑」。

---

## 一句话状态

**四个模块（顺序图 / Redis / 数据库 / SSH 终端）都可用。**
SSH 是第一个**流式**模块，也是第一个带安全决策（TOFU）的模块。
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

### SSH 终端（新）

侧栏「连接 → 会话」，主区标签栏 + **真终端**（xterm.js）。
密码 / 私钥文件认证，**多标签**（一个连接可以同时开好几个终端，各自一条 TCP）。
切模块不关会话，回来画面还在。

**安全部分是这个模块的重心**：首次连接弹窗核对指纹（TOFU），
指纹变了**硬停**、必须手动「忘记主机密钥」才能重连。

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
npm test             # 620 个纯逻辑单测（秒级）
npm run test:e2e     # 131 个端到端测试（真实 Chromium）
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
│   └── connections/   四个连接类模块共用的连接层
│                      ★ 不 import 任何模块
├── shell/         外壳：模块注册表、图标栏、状态栏、错误条
│                  ★ 不认识任何具体模块，只认 Module 接口
└── modules/
    ├── diagram/   顺序图
    ├── redis/     Redis
    ├── sql/       数据库
    ├── ssh/       SSH 终端
    └── devplaceholder/  占位（验证「加模块 = 一个目录 + 一行」）
```

```
src-tauri/
├── src/         commands.rs（文件）/ redis_commands.rs / sql_commands.rs / ssh_commands.rs
├── core/        devtoolkit-core：路径安全 + 文件操作
├── redis/       devtoolkit-redis：连接管理、命令执行、回复解析
├── sql/         devtoolkit-sql：MySQL / PostgreSQL 连接与查询
└── ssh/         devtoolkit-ssh：连接、认证、主机密钥、PTY 会话
```

四个 crate 都**不依赖 tauri**，所以能脱离 WebKit/GTK 跑测试（含打真服务端的集成测试）。

### 加一个模块要做什么

**写一个目录 + `src/shell/registry.ts` 加一行。**

```ts
export const MODULES = [diagramModule, redisModule, sqlModule, sshModule, devPlaceholderModule];
```

接口在 `src/shell/types.ts` 的 `Module`。**四个真实模块都是这么加上去的**。

> ⚠️ 注册表顺序 = 图标栏顺序 = `Ctrl+1..5` 的顺序，**是面向用户的**。
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
