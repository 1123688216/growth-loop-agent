# AI 学习程序

这个模块把“我想学会什么”变成一条可执行学习路径，而不是只返回一张课程目录。它适用于技术、人文、语言、创作、职业技能和生活技能等主题；课程的深度仍取决于用户给出的目标、已有基础和每周投入。

## 用户流程

1. 在桌面端打开“课程”；手机端从“路线”进入二级入口。
2. 填写学习主题、想达到的结果、已有基础和每周投入。
3. 系统生成 3–5 节课程。每节都有关键讲解、主题案例、动手练习、交付物和“理解 / 迁移 / 教回”三道开放题。
4. 学习中可以直接问 AI 讲师；讲师基于当前章节解释、举例并留下一个追问。
5. 提交答案后，LLM 逐题评分并给出下一步；模型不可用时会明确使用本地规则评分。
6. 需要行动时，可把当前章节加入今日计划，沿用已有任务 XP/积分结算规则。

内置的 Agent 示例目标是：理解任务闭环、上下文/工具/状态、工具契约、失败边界，并完成一个能处理学习记录的最小 Agent 原型。

## 生成方式和边界

`POST /api/learning-program` 的 `generate` 动作让 LLM 先返回紧凑的主题专属教学骨架：课程目标、学习结果、讲师设定、章节目标、概念、关键讲解和微型案例。系统再补足章节的练习、交付物和课后题，避免一次要求模型生成超长教案导致超时。

所以，模型负责因主题而变的课程编排、关键说明、案例、讲师回答和评分；课程框架负责稳定的学习行为设计和模型不可用时的可用回退。它不是专业执照考试、医疗/法律/金融建议，也不应把分数当作正式资格认定。

当前课程和完成标记存放在浏览器 `localStorage`。课程内容、提问和作答会发送给配置的模型服务；不要在原型环境中录入不应发给该服务的个人敏感信息。项目尚未具备多用户隔离、云端学习档案、跨设备同步或抗作弊考试能力。

## API

### 状态

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/learning-program
```

只返回 `configured`、`provider` 和 `fallbackAvailable` 等非敏感状态。

### 生成课程

```powershell
$body = @{
  action = 'generate'
  subject = 'Agent 系统设计与自己的 Agent 原型'
  goal = '理解任务闭环、工具调用和状态管理，并做出能处理学习记录的最小 Agent。'
  background = '会基础 TypeScript 和 Next.js。'
  weeklyHours = 4
  lessonCount = 5
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3000/api/learning-program `
  -ContentType 'application/json' `
  -Body $body | ConvertTo-Json -Depth 12
```

成功时返回 `{ program }`。`program.mode=llm` 表示 LLM 已编排课程；`rules` 表示模型不可用而使用本地通用课程。两种模式都会返回可学习的章节和题目。

### AI 讲师与评分

`tutor` 和 `grade` 都要携带刚生成的 `course` 与目标 `lessonId`。这是本地原型避免引入数据库的做法；生产版应改为服务器持久化的课程 ID、用户身份和授权校验。

```text
tutor: { action, course, lessonId, message }
grade: { action, course, lessonId, answers: { [questionId]: "..." } }
```

评分结果中的 `gradedBy=llm` 是模型逐题评分；`gradedBy=rules` 是可解释的本地兜底。前端会显示总分、逐题反馈和下一步，而不会把“LLM 可用”误当成学习效果证明。

## 回归

基础代码检查：

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

需要真实模型时，先按 [网页服务配置手册](WEB_SERVICE_SETUP.md) 配好不入库的 `.env.local`，启动 Next.js 服务后运行：

```powershell
npm.cmd run learning:smoke -- --require-llm
```

该 smoke 会为 Agent 目标检查：至少 5 节课程、每节至少 3 道题、AI 讲师回复、课后评分和所有 `mode/gradedBy` 均为 `llm`。没有模型时可去掉 `--require-llm`，用于检查规则回退是否仍可用。
