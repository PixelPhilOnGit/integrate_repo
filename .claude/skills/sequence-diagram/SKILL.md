---
name: sequence-diagram
description: 画或修改 UML 顺序图（时序图），生成/更新 `.seq.json` 文件给 Devtoolkit 的顺序图模块打开。用户说「画个时序图 / 顺序图」「把这段流程画出来」「改一下那张图」，或者提到 `.seq.json` 时用这个。
---

# 画一张顺序图

一张顺序图 = **一个 `.seq.json` 文件**（UTF-8 JSON）。Devtoolkit 的顺序图模块打开一个
文件夹当工作区，树里列的就是这些文件 —— 你写好文件，用户切回那个模块就能看到
（模块每次切回来会重读目录），不用重启。

## 先找到文件该写在哪

1. 先找**已经有的** `.seq.json`（在当前目录或用户指定的工作区里）：
   `Get-ChildItem -Recurse -Filter *.seq.json`（Windows）/ `find . -name '*.seq.json'`。
   有的话，**新图就跟它们放同一个目录**，别另起一处。
2. 一个都没有 → 问用户「图想存在哪个文件夹」，别自己挑一个（他得在 Devtoolkit 里
   把这个文件夹当工作区打开才看得到）。
3. 目标文件**已经存在**时：先读它、在它的基础上改，不要整个覆盖 —— 用户可能已经
   在界面上编辑过了（界面改完也会写回同一个文件）。

## 格式

```json
{
  "schemaVersion": 1,
  "title": "登录流程",
  "participants": [
    { "id": "user", "kind": "actor", "name": "用户", "x": 120 },
    { "id": "web", "kind": "boundary", "name": "浏览器", "x": 320 },
    { "id": "api", "kind": "control", "name": "服务端", "x": 520 },
    { "id": "db", "kind": "database", "name": "数据库", "x": 720 }
  ],
  "messages": [
    { "id": "m1", "kind": "sync", "from": "user", "to": "web", "label": "输入账号密码", "y": 140 },
    { "id": "m2", "kind": "sync", "from": "web", "to": "api", "label": "POST /login", "y": 200 },
    { "id": "m3", "kind": "sync", "from": "api", "to": "db", "label": "查用户", "y": 260 },
    { "id": "m4", "kind": "return", "from": "db", "to": "api", "label": "用户记录", "y": 320 },
    { "id": "m5", "kind": "return", "from": "api", "to": "web", "label": "200 + token", "y": 380 }
  ],
  "activations": [
    { "id": "a1", "participant": "api", "startMessageId": "m2", "endMessageId": "m5" }
  ],
  "notes": [
    { "id": "n1", "text": "token 有效期 2 小时", "x": 560, "y": 420 }
  ]
}
```

**参与者**：`id`（必填、全文件唯一）、`kind`、`name`、可选 `alias`（消息里显示的短名）、
`x`（生命线横坐标）。

- `kind` 六选一：`actor`（人形）/ `object` / `boundary` / `control` / `entity` / `database`。

**消息**：`id`、`from`、`to`（都是参与者 id）、`kind`、`label`、`y`（箭头纵坐标）。

- `kind` 四选一：`sync`（实线箭头，默认）/ `async`（开口箭头）/ `return`（虚线）/
  `self`（自调用，`from` 和 `to` 写同一个 id）。
- `seq` 不写就按纵向顺序自动编号 —— 一般不用写。

**激活条**（可选，就是生命线上那条窄竖条）：`participant` + `startMessageId`
（哪条消息触发）+ 可选 `endMessageId`（不写 = 延伸到下一个激活条或图底，语义是「还在执行中」）。

**注释**（可选）：`text` + `x` + `y`。

`theme` 可以整个不写（用默认浅色）。`schemaVersion: 1` 照写。

## 四条要守的规矩（违反的后果都写在这儿）

1. **坐标必须给，而且要拉开**：`x` / `y` 缺省是 **0**，全填 0 就全叠在左边缘
   （图打得开，但看着像坏了）。排版**不做自动布局**，坐标就是文件里的值。
   - 参与者 `x`：从左往右 **+180**（120 / 300 / 480…）
   - 消息 `y`：从上往下 **+60**，第一条从 **140** 开始
   - 自调用（`self`）的间距给大一点（+80 以上），它要画一个折回来的小框
2. **`from` / `to` 必须指向存在的参与者 id** —— 指向不存在的，**那条消息会被静默丢掉**
   （不报错，就是没了）。改完数一下消息条数对不对。
3. **`messages` 的数组顺序要和 `y` 从小到大一致**（参与者按 `x` 同理）。顺序 = 逻辑顺序
   = 视觉顺序；反着写虽然会被自动排序，但读起来费劲。
4. **id 不能重复**（参与者内部、消息内部各自唯一）。重名的参与者会被丢掉，
   连带引用它的消息一起消失。

## 画完之后

1. 用 JSON 解析器过一遍（确认没写坏）：`python -c "import json;json.load(open('x.seq.json',encoding='utf-8'))"`
   或者 `Get-Content x.seq.json -Raw | ConvertFrom-Json`。
2. **数一遍**：文件里有多少条 `messages`，就应该是你想画的消息条数（对不上说明有悬空引用被丢了）。
3. 告诉用户：切到 Devtoolkit 的顺序图模块就能看到（工作区要是还没打开过那个文件夹，
   先在模块里选一下那个文件夹）。要是模块正开着，**点一下文件树底部的「刷新」**。

## 别做的事

- 别把 `x` / `y` 省掉（第 1 条）。
- 别在 `label` 里塞换行 —— 消息文字是单行的。
- 别为了"好看"乱给坐标：**顺序靠 `y` 递增**，横向位置靠参与者的 `x`，别让一条消息
  的 `y` 比它前面那条还小。
- 用户只是想改一张现成的图时，**别重画一遍** —— 读进来改那几个字段就行，
  他可能在界面上摆过位置了。
