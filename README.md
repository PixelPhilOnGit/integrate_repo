# 鞭子 · 气球 随礼登记

统计大家给堂哥出的鞭子钱、气球钱，以及气球署名。前后端分离：后端 FastAPI + SQLite，前端 React（Vite）。

## 目录结构

```
backend/     FastAPI 服务，数据存在 backend/data.db（SQLite，自动创建）
frontend/    React 前端（Vite）
```

## 首次准备

后端依赖用 [uv](https://github.com/astral-sh/uv) 管理。如果公司内网镜像连不上（`mirrors.sangfor.org`），装包时加 `--no-config` 绕开全局配置，走公网源。

```bash
cd backend
uv venv
uv pip install --no-config -r requirements.txt
```

前端：

```bash
cd frontend
npm install
```

## 日常启动

开两个终端窗口，分别启动后端和前端。

**后端**（默认监听 8000 端口）：

```bash
cd backend
uv run --no-config uvicorn main:app --reload --port 8000
```

API 文档：http://localhost:8000/docs

**前端**（固定监听 5173，且监听 `0.0.0.0`，同一局域网/公网可以直接用机器 IP 访问，方便以后部署到服务器）：

```bash
cd frontend
npm run dev
```

打开终端提示的地址（`http://localhost:5173`，或终端打印出的 `Network` 地址）即可使用。开发模式下前端会把 `/api/*` 请求代理到后端 8000 端口（见 `frontend/vite.config.js`），不需要额外配置。

## 管理密码

删除 / 编辑记录需要管理员权限，默认密码是 `1234`。

启动后端前可以用环境变量覆盖：

```bash
ADMIN_PASSWORD=你的密码 uv run --no-config uvicorn main:app --reload --port 8000
```

页面顶部有个"登录"入口，输入密码后本次浏览器会话内可以编辑、删除记录。

## 气球单价

气球默认单价 50 元，用于和"出资登记"里的气球总额对账（对不上会在页面上标红提示）。可通过环境变量调整：

```bash
BALLOON_UNIT_PRICE=60 uv run --no-config uvicorn main:app --reload --port 8000
```

## 导出

页面统计卡片下方有"导出 Excel"“导出 PDF”按钮，导出内容包含出资记录表、气球署名表以及合计/对账数字。

## 发链接给大家填写

前端只在本机监听，要让手机也能访问，需要用内网穿透（如 `ngrok http 5173`，注意还要让后端 8000 端口也能被前端代理到，或者干脆把两个服务都部署到有公网 IP 的机器上），或者直接部署到服务器：

- 后端：`uv run --no-config uvicorn main:app --host 0.0.0.0 --port 8000`（生产环境建议去掉 `--reload`，并设置好 `ADMIN_PASSWORD`）
- 前端：`npm run build` 生成静态文件（`frontend/dist`），用 nginx 之类的静态服务器托管，并将其中的 `/api` 请求反向代理到后端地址
