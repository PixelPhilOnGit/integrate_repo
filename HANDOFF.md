# VoiceLingua — 项目交接文档

## 产品概述

VoiceLingua 是一款基于 Tauri 的桌面端实时语音翻译应用，覆盖 macOS 和 Windows。核心功能：

- **对话模式**：按住说话，松手翻译，自动语音播报
- **同声传译模式**：持续监听音频，实时滚动翻译字幕（支持麦克风和系统音频两种输入源）

翻译引擎使用 DeepSeek API，语音识别使用浏览器 Web Speech API（麦克风）或 Whisper API（系统音频），语音合成使用浏览器 SpeechSynthesis。

---

## 快速启动

### 环境要求

- Node.js 22+
- Rust 1.77+
- macOS 14+（Windows 也支持但未充分测试）

### 安装依赖

```bash
cd voice-translation-app
npm install
```

### 开发模式启动

```bash
npm run tauri dev
```

首次编译 Rust 依赖约需 1-2 分钟。后续增量编译 < 10 秒。

### 运行测试

```bash
npm test          # 15 个单元测试
npx tsc --noEmit  # TypeScript 类型检查
```

### 生产构建

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。

---

## 项目结构

```
voice-translation-app/
├── package.json              # 前端依赖和脚本
├── vite.config.ts            # Vite 构建配置（含路径别名 @/）
├── tsconfig.json             # TypeScript 配置
├── index.html                # 入口 HTML
│
├── src/                      # ─── 前端源码 ───
│   ├── main.tsx              # React 入口
│   ├── App.tsx               # 根组件（加载设置、主题、错误边界）
│   ├── index.css             # Tailwind CSS v4 + 亮/暗主题变量
│   │
│   ├── types/index.ts        # 全局类型定义（Message, AppSettings, Subtitle 等）
│   ├── constants/languages.ts # 支持的语言、默认设置、存储键名
│   ├── lib/utils.ts          # cn() 工具函数（clsx + tailwind-merge）
│   │
│   ├── stores/               # Zustand 状态管理
│   │   ├── settingsStore.ts   # 持久化设置（API Key、语言、主题等）
│   │   ├── conversationStore.ts # 对话消息、字幕、录音状态
│   │   └── uiStore.ts         # 临时 UI 状态（侧边栏、引导流程）
│   │
│   ├── services/             # 业务服务层
│   │   ├── translationService.ts   # DeepSeek 翻译 API（请求队列、重试、去重）
│   │   ├── speechRecognitionService.ts # 浏览器 Web Speech API ASR
│   │   ├── speechSynthesisService.ts   # 浏览器 TTS
│   │   ├── audioCapture.ts      # 浏览器 MediaRecorder 录音
│   │   ├── systemAudioCapture.ts # getDisplayMedia 系统音频采集
│   │   ├── whisperService.ts    # Whisper API 语音转文字
│   │   └── usageTracker.ts      # Token 用量统计（localStorage）
│   │
│   ├── hooks/                # React Hooks
│   │   ├── useTranslationPipeline.ts # 🧠 核心编排器：音频→ASR→翻译→TTS
│   │   ├── useAudioRecorder.ts     # 录音 Hook（旧，已被编排器取代）
│   │   ├── useKeyboardShortcut.ts  # 空格键按住说话
│   │   ├── useTheme.ts            # 主题管理
│   │   ├── useToast.ts            # Toast 通知
│   │   └── useAutoScroll.ts       # 自动滚动
│   │
│   ├── components/           # React 组件
│   │   ├── layout/           # AppShell, Sidebar, TitleBar, StatusBar
│   │   ├── conversation/     # RecordButton, ConversationList, ConversationBubble, etc.
│   │   ├── simultaneous/     # SimultaneousControls, SubtitleOverlay, AudioSourceSelector
│   │   ├── settings/         # ApiKeyForm, WhisperApiForm, LanguageSelector, ThemeSelector, etc.
│   │   ├── common/           # ErrorBoundary, OnboardingTour, StatusIndicator, WaveformAnimation
│   │   └── ui/              # shadcn/ui 组件（button, card, dialog, select, tabs, toast...）
│   │
│   └── pages/               # 页面组件
│       ├── ConversationPage.tsx   # 对话模式
│       ├── SimultaneousPage.tsx   # 同声传译
│       ├── SettingsPage.tsx       # 设置
│       └── OnboardingPage.tsx     # 首次引导
│
├── src-tauri/               # ─── Rust 后端 ───
│   ├── Cargo.toml            # Rust 依赖
│   ├── tauri.conf.json       # Tauri 配置（窗口、打包、插件）
│   ├── capabilities/default.json  # Tauri 2 ACL 权限
│   │
│   └── src/
│       ├── main.rs           # 入口
│       ├── lib.rs            # Tauri Builder：插件注册、命令注册、托盘初始化
│       ├── commands.rs       # Tauri 命令（供前端 invoke 调用）
│       ├── audio_capture.rs  # cpal 音频采集（macOS Send 限制，已弃用）
│       ├── audio_format.rs   # PCM 音频格式转换（含单元测试）
│       ├── speech_recognition.rs  # macOS/Windows 系统 ASR 封装
│       ├── speech_synthesis.rs    # 系统 TTS 封装
│       ├── vad.rs            # 语音活动检测
│       ├── tray_manager.rs   # 系统托盘
│       ├── shortcut_manager.rs    # 快捷键管理
│       └── error.rs          # 错误类型定义
│
├── tests/                   # 测试
│   ├── setup.ts              # Vitest 配置
│   ├── conversationStore.test.ts  # Store 单元测试
│   ├── RecordButton.test.tsx      # 组件测试
│   └── translationService.test.ts # 翻译服务测试（含 Mock API）
│
├── plans/
│   └── voice-translation-app.md  # 原始 PRD
│
└── dist/                    # 前端构建产物（Vite 输出）
```

---

## 架构决策

### 为什么前端用浏览器 API 而不是 Rust？

Rust 的 `cpal::Stream` 在 macOS 上不是 `Send`，无法放入 Tauri 的 `State<T>`（Tauri 要求托管状态实现 `Send`）。因此音频采集、ASR、TTS 全部改用浏览器 Web API：

| 功能 | 实现 | API |
|------|------|-----|
| 麦克风录音 | MediaRecorder | `navigator.mediaDevices.getUserMedia()` |
| 系统音频采集 | Screen Capture | `navigator.mediaDevices.getDisplayMedia()` |
| 语音识别（麦克风） | Web Speech API | `window.SpeechRecognition` |
| 语音识别（系统音频） | Whisper API | OpenAI `/audio/transcriptions` |
| 语音合成 | Web Speech API | `window.speechSynthesis` |
| 翻译 | DeepSeek API | `/chat/completions`（OpenAI 兼容格式） |

### 翻译流水线

```
┌─────────────────────────────────────────────────────┐
│                  useTranslationPipeline              │
│                                                     │
│  对话模式（push-to-talk）：                           │
│    Space按下 → SpeechRecognition开始                 │
│    Space松开 → stop → 获取文本 → DeepSeek翻译        │
│    → 添加到Message列表 → TTS播放译文                  │
│                                                     │
│  同声传译-麦克风：                                    │
│    Start → SpeechRecognition连续模式                  │
│    → interim结果实时显示 → final结果翻译 → 字幕追加    │
│    → 静音自动重启                                    │
│                                                     │
│  同声传译-系统音频：                                  │
│    Start → getDisplayMedia弹窗选标签页                │
│    → 每5秒切一个音频块 → Whisper API转文字            │
│    → DeepSeek翻译 → 字幕追加                         │
└─────────────────────────────────────────────────────┘
```

### 状态管理

三个 Zustand store：

- `settingsStore`：持久化到 Tauri plugin-store + localStorage 双写
- `conversationStore`：会话消息列表、字幕列表、录音状态、当前模式
- `uiStore`：侧边栏开关、引导流程、设置标签页（不持久化）

### 设置持久化

优先使用 `@tauri-apps/plugin-store`（加密本地文件），不可用时回退到 `localStorage`。这样在纯浏览器开发时也能工作。

### API 兼容性

翻译 API 使用 OpenAI 兼容格式，用户可自行更换：
- DeepSeek（默认）：`https://api.deepseek.com/v1`
- OpenAI：`https://api.openai.com/v1`
- 任何兼容代理/本地模型

---

## 配置的 API Key

用户需要两个 API Key：

| Key | 用途 | 获取地址 |
|-----|------|---------|
| DeepSeek API Key | 翻译 | https://platform.deepseek.com/api_keys |
| OpenAI/Whisper API Key | 系统音频语音识别 | https://platform.openai.com/api-keys |

Whisper Key 仅在「系统音频」模式下需要，麦克风模式使用浏览器免费内置 ASR。

---

## 已知限制 & 未完成功能

### 限制

1. **系统音频采集**：macOS 需 Safari 17+ 或 Chromium 浏览器，需用户手动选择要共享的窗口/标签页
2. **Web Speech API 兼容性**：部分语言（泰语、阿拉伯语等）可能不被浏览器支持
3. **TTS 音色**：使用系统默认语音，无法自定义音色
4. **离线不可用**：翻译（DeepSeek）和 Whisper 都需要网络

### PRD 中未实现的功能

- V2：内嵌翻译浏览器（网页翻译）
- 全局快捷键注册（Rust 侧有 stub，前端用浏览器键盘事件作替代）
- 实际可用的系统音频回环（需 BlackHole 等虚拟音频驱动）
- 开机自启动
- 系统托盘实际运行（已初始化，但 `npm run tauri dev` 不显示托盘）

---

## 常见问题排查

### 应用启动崩溃
- 检查 `tauri.conf.json` 中 `plugins` 不要写 `"store": {}`
- 检查 Node.js 和 Rust 版本
- 清除 `src-tauri/target/` 后重新构建

### 翻译不工作
- Settings → API → 检查 DeepSeek API Key 是否填写
- 点击 Test Connection 验证
- 检查网络连接，DeepSeek API 需要翻墙/代理

### 系统音频模式不工作
- Settings → API → 检查 Whisper API Key 是否填写
- 选择标签页时必须勾选 "Share audio"
- 浏览器需支持 `getDisplayMedia`（Chrome/Edge/Safari 17+）

### 麦克风不工作
- 检查系统麦克风权限：系统设置 → 隐私与安全性 → 麦克风
- Settings → Speech → 点击 Test Microphone 检查可用性

---

## 技术栈版本

| 技术 | 版本 |
|------|------|
| Tauri | 2.x |
| React | 19.1 |
| TypeScript | 5.8 |
| Vite | 6.4 |
| Tailwind CSS | 4.1 |
| Zustand | 5.0 |
| shadcn/ui | new-york style |
| Rust | 2021 edition |
