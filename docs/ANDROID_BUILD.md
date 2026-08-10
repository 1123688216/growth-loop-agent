# Android 构建与电脑模拟器调试

项目使用 Capacitor 包装 Android 工程，包名为 `com.growthloop.agent`。业务页面和 Agent 接口仍由 Next.js 提供，但 Android WebView 会进入独立的移动产品壳（底部导航、下一步行动卡、记录抽屉和安全区），不再渲染桌面网页工作台。完整移动产品设计见 [ANDROID_MOBILE_PRODUCT_DESIGN.md](ANDROID_MOBILE_PRODUCT_DESIGN.md)。

## 先分清两个访问地址

- 电脑浏览器打开：`http://127.0.0.1:3000/`（或 `http://localhost:3000/`）
- Android Emulator 内的 APK 使用：`http://10.0.2.2:3000/`

`10.0.2.2` 是模拟器映射到电脑 localhost 的专用地址，不能直接拿到电脑浏览器地址栏里打开。

## 已配置的电脑环境

- Android SDK：`F:\Codex\growth-loop-android-sdk`
- AVD：`GrowthLoopDesktop`（Google APIs、Android API 36、x86_64）
- AVD 文件：`F:\Codex\growth-loop-avd\GrowthLoopDesktop.avd`
- Android Studio 可直接打开项目中的 `android/`；`android/local.properties` 已指向上面的 SDK。
- 模拟器通过 `10.0.2.2` 访问电脑的 `localhost`，APK 默认后端为 `http://10.0.2.2:3000`。

如果把 SDK 或 AVD 移到其他目录，可在当前 PowerShell 会话覆盖默认路径：

```powershell
$env:GROWTH_LOOP_ANDROID_SDK = "D:\Android\sdk"
$env:GROWTH_LOOP_ANDROID_AVD = "D:\Android\avd"
```

## 一键命令

先在一个终端启动 Next.js：

```powershell
npm.cmd run dev
```

再在项目根目录执行：

```powershell
# 构建 Web、同步 Capacitor、构建 debug APK、启动模拟器、安装并打开应用
npm.cmd run android:debug

# 不重新构建，直接启动模拟器、安装当前 APK 并打开应用
npm.cmd run android:run

# 查看 SDK、AVD 和 adb 状态
npm.cmd run android:status

# 请求关闭模拟器
npm.cmd run android:stop
```

脚本会以可见窗口启动 `GrowthLoopDesktop`，首次开机可能需要 1–3 分钟。若 ADB 显示 `offline`，执行 `npm.cmd run android:stop` 后再执行 `npm.cmd run android:debug`；也可以手动运行 `adb kill-server` 和 `adb start-server`。

## Android Studio 调试

1. 用 Android Studio 打开 `F:\Codex\自我成长AI\android`。
2. 在 Device Manager 中选择 `GrowthLoopDesktop` 并启动。
3. 运行配置选择 `app`，设备选择 `GrowthLoopDesktop`，点击 Run/Debug。
4. Chrome DevTools 可通过 `chrome://inspect` 查看 WebView；Android Studio 的 Logcat 可查看原生容器日志。

## 后端地址

电脑模拟器调试保持默认地址即可。如果改用部署环境，在执行 `npx.cmd cap sync android` 前设置：

```powershell
$env:CAPACITOR_SERVER_URL = "https://your-domain.example"
npx.cmd cap sync android
```

真机需要局域网可达地址或 HTTPS；本说明的验收目标是电脑模拟器，因此不要求手机或 USB 调试。

## 当前 APK 与发布边界

当前 debug APK：[growth-loop-debug.apk](../artifacts/android/growth-loop-debug.apk)。它使用 debug 签名，适合电脑模拟器安装验收，不适用于应用商店发布。正式发布还需要 HTTPS 后端、release keystore、AAB/release 构建、隐私合规、微信授权和断网/恢复回归。
