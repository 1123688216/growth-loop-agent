# 成长回路（Growth Loop）

一个把“今天做了什么”变成下一步行动的自我提升 Agent。用户可以直接和 AI 对话，记录学习、运动、生活和休息；Agent 负责整理、安排、复盘，并把可验证的行动记入成长轨迹。

> 当前版本是可运行的本地原型，不是生产 SaaS。项目已经包含 Next.js Web、Capacitor Android 工程、确定性 demo 数据、OpenAI-compatible LLM 接口、微信公众号明文回调、理解测验和电脑 Android Emulator 调试链路。

## 变更记录

后续每次功能、接口、数据结构或运行方式发生变化，都必须同步更新本节。标记含义：`新增` 表示新能力，`修改` 表示既有行为变化，`修复` 表示缺陷修正，`暂未实现` 表示已经确定但尚未落地的边界。

### 2026-08-26 · 数据库与账号系统（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 使用 username 和密码注册、登录、退出，不再依赖邮箱 | `app/login/`、`app/api/auth/` |
| **新增** | 密码属于 User，但仅保存经过 scrypt 处理的 `password_hash`，不保存明文 | `lib/auth/password.ts`、`lib/db/schema.ts` |
| **新增** | 数据库 Session 和 HttpOnly Cookie；默认会话有效期为 30 天 | `lib/auth/session.ts`、`sessions` 表 |
| **新增** | SQLite 用户数据层及迁移机制 | `lib/db/`、`data/growth-loop.sqlite` |
| **新增** | 首批表：`users`、`sessions`、`goals`、`tasks`、`activity_logs`、`ledger_entries` | `lib/db/schema.ts` |
| **修改** | 首页改为受保护页面；未登录访问 `/` 会跳转到 `/login` | `app/page.tsx` |
| **修改** | 工作台从数据库读取当前用户、目标、任务、记录、积分和近七天统计 | `/api/dashboard`、`lib/db/dashboard.ts` |
| **修改** | 任务完成状态、学习记录、XP、Coin 和连续有效行动天数刷新后仍会保留 | `/api/tasks/[id]`、`/api/activity-logs` |
| **修改** | 桌面端与移动端均提供退出登录入口 | `app/dashboard-client.tsx`、`app/mobile-shell.tsx` |
| **修改** | `.env.example` 增加 SQLite 路径和本地 HTTP Cookie 配置；数据库文件不提交 Git | `.env.example`、`.gitignore` |
| **暂未实现** | LLM 可以提出目标进度，但“服务端校验后写入 `goals.progress_percent`”尚未接入 | 后续目标进度接口 |

本次端到端验证覆盖：创建账号、账号密码登录、退出、未登录访问保护、任务状态持久化、学习记录持久化、积分流水和连续行动天数更新。验收使用的临时账号及数据已删除。

## 现在能做什么

| 能力 | 当前实现 | 入口 |
|---|---|---|
| 本地账号 | username 注册/登录、密码哈希、数据库会话、用户数据隔离 | `/login`、`/api/auth/*` |
| AI 今日对话 | 记录事实、识别意图、给出下一步；无模型配置时使用规则回退 | `/api/agent`、首页 |
| 学习闭环 | 学习记录 → 生成 2–3 道理解题 → LLM 或规则评分 → XP 回写 | `/api/quiz`、记录页 |
| 今日行动 | 用户目标、计划、待办和任务完成状态持久化 | `/api/dashboard`、`/api/tasks/[id]`、首页/计划 |
| 成长记录 | 学习记录、连续有效行动、XP 与 Coin 流水持久化 | `/api/activity-logs`、记录页/成长页 |
| 晚间回顾 | 统一总结当天记录，并依次追问最重要行动、真正理解和明日一步 | 首页晚报入口、Agent `review` 意图 |
| 微信入口 | 微信公众号首次验证、明文 XML 文本回调、签名校验、LLM 超时回退 | `/api/wechat` |
| Android App | 独立移动壳 v4；首页一屏 AI 会面，不堆功能、不产生首页纵向滚动 | `android/`、APK |
| 可复现调试 | doctor、build、install、run、smoke、logs；面向人和 AI | `scripts/debug-apk.ps1` |

## 产品形态

首页只做一件事：让用户马上告诉 AI 今天发生了什么。首页默认只显示 AI 状态、一个下一步行动、一个记录框和晚报状态；路线、记录、成长和完整测验放在二级入口，由 AI 在需要时引导用户进入。

```mermaid
flowchart LR
  User[用户] --> Home[今日首页 / 微信对话]
  Home --> Agent[/api/agent]
  Agent --> Parse[规则解析与会话状态]
  Agent --> Model[可选 OpenAI-compatible LLM]
  Home --> Quiz[/api/quiz]
  Quiz --> Model
  WeChat[微信公众号] --> WechatAPI[/api/wechat]
  WechatAPI --> Agent
  Home --> Demo[/api/demo]
  Demo --> Seed[确定性 demo 数据]
```

## 快速开始

### 环境要求

- Node.js 22 或更高版本（Android WebView CDP smoke 需要 Node 22 的 `WebSocket` 全局对象）
- npm
- Windows PowerShell（Android 电脑模拟器脚本按 Windows 环境编写）
- Android 调试需要本机 Android SDK、AVD 和 Java 21；详见 [Android 构建说明](docs/ANDROID_BUILD.md)

### 本地 Web

```powershell
git clone https://github.com/redmaplewww/growth-loop-agent.git
Set-Location growth-loop-agent
npm.cmd install
Copy-Item -LiteralPath .env.example -Destination .env.local
npm.cmd run dev
```

打开 [http://127.0.0.1:3000/login](http://127.0.0.1:3000/login)，先创建本地账号。默认 `LLM_PROVIDER=demo`，不需要 API Key；新账号会初始化一个入门目标和三项入门行动。生产式本地回归可以使用：

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000
```

### 检查项目

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

## 配置 LLM

服务端通过 OpenAI-compatible `/chat/completions` 调用模型。没有完整配置时，Agent 和测验会自动回退到本地规则，不会因为模型不可用阻塞页面或微信文本回复。

复制 `.env.example` 为 `.env.local` 后，按实际供应商填写以下变量：

```dotenv
LLM_PROVIDER=demo
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

也支持按 provider 读取对应变量，例如 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，以及 `OPENAI_*`、`GLM_*`。密钥只放在本机环境变量、部署平台 Secret 或受管配置工具中，不能提交到 GitHub。

服务状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/agent
```

返回值只包含模式、供应商和是否配置 endpoint/model 等非敏感状态，不返回 API Key。

## API 速查

### 账号与用户数据

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` | 使用 username、password 和可选 displayName 创建账号 |
| `POST` | `/api/auth/login` | 使用 username 和 password 登录 |
| `POST` | `/api/auth/logout` | 删除当前数据库会话并清除 Cookie |
| `GET` | `/api/auth/me` | 获取当前登录用户的非敏感信息 |
| `GET` | `/api/dashboard` | 获取当前用户的目标、任务、记录、积分和统计 |
| `PATCH` | `/api/tasks/[id]` | 切换当前用户所属任务的完成状态 |
| `POST` | `/api/activity-logs` | 调用 Agent 整理输入，并保存行动记录和奖励流水 |

SQLite 默认保存在 `data/growth-loop.sqlite`。可通过 `.env.local` 中的 `SQLITE_DATABASE_PATH` 修改位置。数据库文件、WAL 和 SHM 文件均已加入 Git 忽略。

### Agent 对话

```powershell
$body = @{
  message = '今天学习了 Agent 的工具调用，终于理解它和普通聊天的区别'
  conversationId = 'demo-user'
  context = '当前路线：学习 Agent 并开发自己的 Agent'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/api/agent `
  -ContentType 'application/json' `
  -Body $body
```

`POST /api/agent` 接收 `message`（必填）、`conversationId`、`output`、`context`。返回 `reply`、`intent`、`extracted`、`mode`、`provider` 和 `replySource`。`GET /api/agent` 返回当前非敏感配置状态。

### 理解测验

生成题目：

```powershell
$body = @{
  action = 'generate'
  topic = 'Agent 工具调用'
  content = 'Agent 会先理解目标，再选择工具并根据结果继续行动。'
  output = '我理解了工具调用是让模型连接外部能力的桥梁。'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/quiz -ContentType 'application/json' -Body $body
```

评分时提交 `action=grade`、原题目、学习底稿和 `answers`。如果模型已配置，返回 `gradedBy=llm`；否则返回 `gradedBy=rules`，并明确给出回看建议。

### Demo 数据

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/demo
```

该接口继续提供确定性 seed，主要用于无账号 demo 和原型验收。登录后的工作台数据以 `/api/dashboard` 和 SQLite 为准，不再把 `/api/demo` 当作真实用户数据层。

## 微信公众号接入

当前实现的是“服务端回调 + 明文文本模式”，不是小程序登录或微信支付。配置步骤：

1. 准备公网 HTTPS 域名和可访问的 Next.js 部署。
2. 在部署 Secret 中配置 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_TOKEN`。
3. 微信公众平台服务器地址填写 `https://你的域名/api/wechat`。
4. 选择明文模式，完成首次 GET 签名验证。
5. 用文本消息 POST 回归；模型超时会自动使用本地回退话术。

详细签名规则、XML 字段、状态接口和当前边界见 [微信公众号接入说明](docs/WECHAT_INTEGRATION.md)。当前 MVP 未启用安全模式/兼容模式的密文解密，正式上线前必须补齐加密回调、重放保护、限流和生产监控。

## Android APK

当前仓库已包含 Android 工程和 debug APK：

- 工程：[android/](android/)
- APK：[artifacts/android/growth-loop-debug.apk](artifacts/android/growth-loop-debug.apk)
- 电脑浏览器：`http://127.0.0.1:3000/`
- Android Emulator：`http://10.0.2.2:3000/`

启动本地服务后，在项目根目录执行：

```powershell
npm.cmd run android:debug   # build + sync + Gradle + install + launch
npm.cmd run android:run     # 使用现有 APK 安装并启动
npm.cmd run android:status
npm.cmd run android:stop
```

面向 AI 的完整调试顺序：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action doctor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action run -Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action smoke
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action logs
```

详见 [Android APK 调试手册](docs/ANDROID_APK_DEBUG_AI.md) 和 [Android 移动端产品设计](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md)。APK 是 debug 签名，并默认从电脑模拟器读取远程 Next.js 服务；正式发布还需要 HTTPS、release keystore、AAB、真机回归和隐私合规。

## 文档地图

| 文档 | 内容 |
|---|---|
| [开发者与 AI 手册](docs/DEVELOPER_HANDBOOK.md) | 从 clone、配置、开发、测试到发布的完整交接手册 |
| [产品设计方案](docs/PRODUCT_DESIGN_V1.md) | 产品目标、用户闭环、Agent、游戏化和微信路线 |
| [微信公众号接入](docs/WECHAT_INTEGRATION.md) | 微信服务器配置、签名校验和文本回调 |
| [Android 构建](docs/ANDROID_BUILD.md) | SDK、AVD、Capacitor 和 Android Studio |
| [Android APK 调试](docs/ANDROID_APK_DEBUG_AI.md) | doctor/build/install/run/smoke/logs 调试链路 |
| [移动端产品设计](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md) | 一屏 AI 首页、底部导航和移动交互约束 |
| [.project-to-act](.project-to-act/PROJECT_OVERVIEW.md) | 项目目标、范围、进度、版本和验收证据 |

## 数据、安全与发布边界

- 已有 SQLite 数据库和基于 Session 的本地多用户隔离；当前仍没有后台定时任务、数据导出、忘记密码或管理员系统。
- 密码字段保存在 `users.password_hash`，使用 scrypt 加盐处理；任何代码和文档都不得记录用户明文密码。
- `action_streak_days` 表示连续产生有效行动记录的天数，不是单纯点击按钮的签到天数。
- `goals.progress_percent` 已持久化；LLM 自动调整进度仍需增加服务端范围、证据和变化幅度校验。
- LLM 只负责理解、建议、出题和评分；任务、XP、积分等写操作应继续由规则和受控服务端处理。
- 不要提交 `.env.local`、API Key、微信 Token、`android/local.properties`、Android build 目录、模拟器镜像或本机 SDK 路径。
- 微信回调当前只支持明文文本；不要在未补齐加密、重放保护、限流和审计前接收生产敏感消息。
- 仓库目前没有单独的开源许可证文件；如需对外允许复用，请先补充许可证和第三方依赖声明。

## 常见问题

| 现象 | 处理 |
|---|---|
| 电脑能打开，APK 打不开 | 确认 Next 服务监听 `127.0.0.1:3000`，APK 使用的是 `10.0.2.2:3000`；先跑 `doctor` |
| 页面显示旧版本 | 重启 `next start` 或重新执行 `npm.cmd run dev`，再重新打开 APK；当前 APK 默认加载远程页面 |
| `smoke` 找不到页面 | 确认应用已启动、ADB 设备为 `device`，然后重新执行 `run` 再 `smoke` |
| LLM 没有返回 | 查看 `/api/agent` 状态和环境变量；没有完整配置时预期会走 demo/rules 回退 |
| 微信首次验证失败 | 检查公网 HTTPS、`WECHAT_TOKEN`、服务器 URL 和服务器时间；不要把 token 写进源码 |
| Android ADB `offline` | `npm.cmd run android:stop` 后重新 `npm.cmd run android:debug`，必要时重启 adb server |

## 贡献与提交

1. 从 `main` 创建短分支，修改前先阅读 `AGENTS.md` 和相关 `.project-to-act` 文档。
2. 只提交本次任务范围内的文件，避免把密钥、构建产物和模拟器缓存带入提交。
3. 至少运行 `typecheck`、`lint`、`build`；涉及 Android 时再运行 `android:debug`、`doctor`、`smoke`、`logs`。
4. 每次功能、接口、数据库结构或运行方式发生变化，都要在 README 的“变更记录”中标注 `新增`、`修改`、`修复` 或 `暂未实现`。
5. 提交信息说明意图，PR 描述列出变更、验证命令和已知边界。

## 当前版本

`0.2.0-prototype` · Android 移动壳 v4 · 已加入本地 SQLite、username 账号、数据库 Session 与首批用户数据持久化。生产级数据库、后台调度、微信加密模式、release 签名和真实用户验收属于后续版本范围。
