# Android APK 调试说明（人和 AI 通用）

这套工程使用 Capacitor 承载 Android WebView。APK 的业务页面默认从电脑上的
`http://10.0.2.2:3000/` 加载，因此调试时要同时确认：Android Emulator、Next.js 服务、APK 和 WebView 调试协议。

## 最短路径

在项目根目录打开 PowerShell：

```powershell
# 1. 启动本地生产服务（另开一个终端）
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000

# 2. 检查工具、APK、后端和模拟器
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action doctor

# 3. 构建、安装并启动
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action run -Build

# 4. 对 WebView 做自动 smoke 检查
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action smoke

# 5. 查看关键错误
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action logs
```

也可以使用 npm 快捷命令：

```powershell
npm.cmd run android:debug:doctor
npm.cmd run android:debug:inspect
```

## 调试动作

| 动作 | 作用 |
|---|---|
| `doctor` | 检查 SDK、APK、后端 HTTP、ADB 设备和前台 Activity |
| `build` | 执行 Next 构建、Capacitor sync 和 Gradle `assembleDebug` |
| `install` | 安装现有 debug APK；加 `-Build` 可先重新构建 |
| `run` | 启动模拟器、安装 APK 并打开 `com.growthloop.agent` |
| `smoke` | 转发 WebView CDP 9222 端口，检查 v4 一屏 AI 首页、四个 Tab、记录抽屉、宽度和成长页 |
| `logs` | 读取最近 logcat，筛选 AndroidRuntime、Chromium 和 JS 错误 |

清空应用的 localStorage 原型数据后再启动：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action run -ClearData
```

`-ClearData` 会在清空 localStorage 后自动重新拉起应用，不会停留在模拟器桌面。

## AI 调试顺序

AI 或自动化代理接手 APK 问题时，按下面顺序执行，避免把“后端没启动”误判成“APK 页面坏了”：

1. 执行 `doctor`，确认 APK 文件存在、SHA-256 可记录、`emulator-5554` 为 `device`，以及 `127.0.0.1:3000` 返回 HTTP 200。
2. 如需重现安装问题，执行 `run -Build`；如需保持用户数据，避免使用 `-ClearData`。
3. 执行 `smoke`。重点看 `ok`、`home.hasHomeV4`、`home.homeScrollFits`、`home.bodyWidth`、`home.documentWidth`、`composer.textareas` 和各 Tab 的 `active` 字段。
4. 如果 smoke 失败，先执行 `logs`；优先处理 `FATAL EXCEPTION`、`AndroidRuntime`、`chromium`、`Uncaught`、`TypeError` 和 `ReferenceError`。
5. 如果页面是旧版本，重启 `next start` 服务后再 reload APK；当前调试壳默认读取 `10.0.2.2:3000`，APK 二进制本身不会包含最新远程页面。
6. 修改页面后至少重新执行 `typecheck`、`lint`、`build`、`android:debug` 和 `smoke`，再记录 APK SHA-256。

## 常见边界

- 电脑浏览器使用 `http://127.0.0.1:3000/`；Android Emulator 使用 `http://10.0.2.2:3000/`。不要在电脑浏览器里用 `10.0.2.2`。
- `smoke` 需要 Node.js 22+ 的 WebSocket 全局对象，并要求 ADB 已经把 WebView 转发到 `tcp:9222`。
- 当前 APK 是 debug 签名，数据仍是本机原型状态；正式发布还需要 HTTPS 后端、数据库、release keystore、通知授权和真机回归。
- 不要把 `.env.local`、LLM API Key、微信 Token、`android/local.properties` 或 Android build 目录提交到公开仓库。
