# 成长回路（工作名）

一个通过微信陪伴用户持续行动、记录学习并形成可解释成长反馈的自我提升 Agent。

当前是可运行的本地原型：工作台内置确定性测试数据，服务端已通过受管 LLM profile 调用模型，并提供微信公众号明文文本回调接口。核心方案见：

- [完整产品设计方案](docs/PRODUCT_DESIGN_V1.md)
- [项目事实源](.project-to-act/PROJECT_OVERVIEW.md)
- [微信公众号接入说明](docs/WECHAT_INTEGRATION.md)
- [Android 构建说明](docs/ANDROID_BUILD.md)
- [Android 移动端产品设计](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md)
- [Android APK 调试说明（人和 AI 通用）](docs/ANDROID_APK_DEBUG_AI.md)

当前推荐形态是“微信服务号对话入口 + 微信小程序结构化工作台 + 独立 Agent 后端”。经验值用于呈现长期成长，积分用于兑换用户自己设定的现实奖励，两者分账，防止短期激励污染长期成长评价。

当前首页采用对话优先入口：随手记下今天发生的事，白天不被问题打断，晚间按 21:30 偏好由 AI 统一回顾；计划、成长、账本和完整测验退到二级入口。Android 工程位于 `android/`，debug APK 会输出到 `artifacts/android/growth-loop-debug.apk`；APK 调试脚本提供 `doctor / build / install / run / smoke / logs` 动作。

本机网页请打开 `http://127.0.0.1:3000/`；只有 Android Emulator 内的 APK 使用 `http://10.0.2.2:3000/`。
