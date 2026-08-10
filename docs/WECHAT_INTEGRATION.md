# 微信公众号接入

当前版本提供微信公众号服务号/订阅号的文本消息回调接口，入口为：

```text
GET  /api/wechat   微信后台首次验证 URL
POST /api/wechat   微信文本消息回调
GET  /api/wechat/status   查看非敏感配置状态
```

## 配置

在本机使用受管控的 LLM 配置工具注入模型配置，不要把密钥写入源码或提交到 Git：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\zzg\.codex\skills\llm-api-config\scripts\llm_config.ps1" -Action Inject -Profile deepseek -TargetPath "F:\Codex\自我成长AI" -EnvStyle generic
```

微信侧需要把以下配置放入部署平台的环境变量或本地受管控配置中：

```text
WECHAT_APP_ID
WECHAT_APP_SECRET
WECHAT_TOKEN
WECHAT_ENCODING_AES_KEY（当前 MVP 使用明文模式，可暂不填写）
```

其中 `WECHAT_TOKEN` 必须与微信公众平台“服务器配置”中的 Token 完全一致。应用必须有一个公网 HTTPS 地址，例如 `https://your-domain.example.com`，后台 URL 填写：

```text
https://your-domain.example.com/api/wechat
```

首次提交时，微信会发送带 `signature/timestamp/nonce/echostr` 的 GET 请求；接口会按官方 SHA-1 规则校验并原样返回 `echostr`。正式消息使用 POST，接口校验签名后解析 XML，将文字内容交给 LLM，并返回 XML 文本回复。

## 当前边界

- 当前 MVP 使用微信公众号“明文模式”，已实现签名校验与 XML 文本消息回复。
- 如果微信后台选择“安全模式/兼容模式”，接口会明确返回未启用加密模式，避免把密文误当成用户消息。
- LLM 请求有 3.8 秒超时；模型不可用时会自动使用本地回退话术，保证微信消息不会无限等待。
- `/api/wechat/status` 只返回布尔配置状态，不返回 AppSecret、Token 或任何模型密钥。

