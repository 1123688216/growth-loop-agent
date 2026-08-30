# Growth Loop 公网 Demo 部署

> 适用范围：邀请少量可信体验者验证当前 V0.4.2 学习闭环。
>
> 这不是生产发布方案。当前重点是收集创建目标、初始诊断、课程学习和课后评分的真实反馈。

## 1. 为什么选择 Zeabur

当前项目不是纯前端页面，它同时依赖：

- Next.js 服务端路由；
- Node.js `node:sqlite`；
- 可写且重启后仍保留的 SQLite 文件；
- 只在服务端保存的 LLM API Key；
- HTTPS 登录 Cookie。

Zeabur 可以直接从 GitHub 构建 Node.js 服务，并提供环境变量、持久化卷和测试子域名。这样不需要为了 Demo 把 SQLite 重写成云数据库，也不需要改动现有页面和业务接口。

参考：

- [Zeabur Node.js 部署](https://zeabur.com/docs/en-US/guides/nodejs)
- [Zeabur 持久化卷](https://zeabur.com/docs/en-US/data-management/volumes)
- [Zeabur 环境变量](https://zeabur.com/docs/en-US/deploy/config/environment-variables)

## 2. 上线前边界

Demo 可以验证：

- 用户注册、登录和数据隔离；
- 创建多个学习目标；
- 初学者直接生成课程；
- 一知半解、小有所成进入逐题自适应诊断；
- 课程切换、课后答题、评分和下一课解锁；
- Agent 调用模式、Token 与耗时记录。

暂时不要把它宣传为完整学习产品：

- 当前教学正文仍是 V0.4.2 质量，V0.4.3 教学质量门禁尚未实现；
- 暂无注册限流、邀请码和 LLM 费用配额；
- 暂无用户上传资料和 RAG；
- 暂无生产级备份、监控和隐私协议；
- 不要让体验者填写隐私数据或上传敏感资料。

因此链接只发给少量认识的人；LLM 供应商侧应设置余额或调用额度上限。

## 3. 部署步骤

### 3.1 准备代码

把需要展示的本地修改推送到自己的 GitHub fork。不要提交 `.env.local`、SQLite 数据库和任何 API Key。

项目已经固定使用 Node.js 22/24；Zeabur 会根据 `package.json` 自动执行生产构建，并通过 `npm start` 启动 Next.js 服务。

### 3.2 创建服务

1. 登录 Zeabur，创建项目并选择离体验者较近的区域。
2. 选择“Add Service → GitHub”，授权并选择自己的 fork 仓库。
3. 等待首次构建，不需要选择纯静态网站模式。

### 3.3 配置持久化数据库

在该服务的 Volumes 页面添加：

```text
Volume ID: growth-loop-data
Mount Directory: /data
```

然后配置：

```dotenv
SQLITE_DATABASE_PATH=/data/growth-loop.sqlite
```

没有这块持久化卷时，服务重新部署或重启可能导致账号、目标、课程和答题记录丢失。

### 3.4 配置服务端变量

在 Zeabur 的 Variables 页面配置，不要写入 GitHub：

```dotenv
NODE_ENV=production
ALLOW_INSECURE_LOCAL_COOKIE=false
SQLITE_DATABASE_PATH=/data/growth-loop.sqlite

LLM_PROVIDER=你的供应商标识
LLM_BASE_URL=https://你的兼容接口/v1
LLM_API_KEY=你的服务端密钥
LLM_MODEL=你的模型名称
```

`LLM_BASE_URL` 必须是 OpenAI-compatible 接口的 `/v1` 根地址，项目会请求 `${LLM_BASE_URL}/chat/completions`。

若后三项不完整，页面仍能运行，但会进入 `demo/rules` 回退，无法代表真实 LLM 效果。

不要在公网环境把 `ALLOW_INSECURE_LOCAL_COOKIE` 设为 `true`。Zeabur 子域名提供 HTTPS，生产模式下登录 Cookie 应保持 `Secure`。

### 3.5 生成访问地址

在 Domains 页面生成一个免费的 `*.zeabur.app` 测试域名。Demo 阶段不需要购买自定义域名。

## 4. 发布验收

部署完成后依次检查：

1. 打开 `/api/agent`，确认 `mode` 为 `llm`；如果是 `demo`，先修复模型变量。
2. 使用一个全新账号注册、退出并重新登录。
3. 创建“初学者”目标，确认能够生成并进入首课。
4. 创建“一知半解”目标，确认逐题诊断居中显示，并且答题后出现考官评分进度。
5. 在课程页切换两个目标，完成一节课的答题，确认评分和下一课状态能够保存。
6. 重新部署服务后再次登录，确认账号和学习记录仍存在，以验证持久化卷。

## 5. 体验反馈建议

第一轮只邀请 3–5 人，每人完成一次以下路径：

```text
注册
→ 创建真实目标
→ 完成初始诊断或直接进入首课
→ 阅读首课
→ 完成课后题
→ 查看评分与下一步
```

重点收集：

- 哪一步不知道该做什么；
- 目标和能力拆解是否符合预期；
- 题目是否具体、难度调整是否合理；
- 课程中哪些内容像模板或没有帮助；
- 从创建目标到完成首课花了多久；
- 是否愿意第二天继续使用。

这批反馈用于 V0.4.3 的教学内容结构和质量门禁，不根据 Demo 用户数量宣称学习效果提升。
