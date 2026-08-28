# AI 学习程序

这个模块把“我想学会什么”变成一条可执行学习路径，而不是只返回一张课程目录。它适用于技术、人文、语言、创作、职业技能和生活技能等主题；课程的深度仍取决于用户给出的目标、已有基础和每周投入。

## 用户流程

1. 在计划页创建目标，填写完成标准、当前基础和每周投入；目标与自评档案会一起落库。
2. 系统按 `goalId` 生成 3–5 节课程，并写入 `learning_programs` / `course_modules` / `course_lessons`。
3. 每节都有关键讲解、主题案例、动手练习、交付物和“理解 / 迁移 / 教回”三道开放题。
4. 学习中可以直接问 AI 讲师；讲师基于当前章节解释、举例并留下一个追问。
5. 提交答案后，LLM 逐题评分并给出下一步；模型不可用时会明确使用本地规则评分。每次评分写入 `lesson_assessment_attempts`，重测只新增记录，不覆盖历史尝试。
6. 需要行动时，可把当前章节加入今日计划；任务通过 `task_lesson_links` 与章节关联，沿用已有任务 XP/积分结算规则。

内置的 Agent 示例目标是：理解任务闭环、上下文/工具/状态、工具契约、失败边界，并完成一个能处理学习记录的最小 Agent 原型。

## 生成方式和边界

`POST /api/learning-program` 的 `generate` 动作让 LLM 先返回紧凑的主题专属教学骨架：课程目标、学习结果、讲师设定、章节目标、概念、关键讲解和微型案例。系统再补足章节的练习、交付物和课后题，避免一次要求模型生成超长教案导致超时。

所以，模型负责因主题而变的课程编排、关键说明、案例、讲师回答和评分；课程框架负责稳定的学习行为设计和模型不可用时的可用回退。它不是专业执照考试、医疗/法律/金融建议，也不应把分数当作正式资格认定。

课程正文的唯一来源是服务端数据库，浏览器只缓存当前的 `programId`；清空 `localStorage` 或换设备后重新登录，课程与进度仍可完整恢复。每道题的参考答案和评分 rubric 只存在服务端，不随课程下发，也不接受客户端提交。课程内容、提问和作答会发送给配置的模型服务；不要在原型环境中录入不应发给该服务的个人敏感信息。项目尚未具备云端学习档案、跨设备实时同步或抗作弊考试能力。

## API

### 状态

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/learning-program
```

只返回 `configured`、`provider` 和 `fallbackAvailable` 等非敏感状态。

### 读取课程

以下两个请求都需要登录 Cookie。`current` 返回当前用户最近一份进行中的课程，也可以直接传 `programId`：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/learning-program?program=current
Invoke-RestMethod http://127.0.0.1:3000/api/learning-program?program=<programId>
```

返回的 `program.lessons[].questions` 只包含题干和提示，没有 `referenceAnswer` 与 `rubric`。

### 生成课程

课程主题、目标、基础和每周投入全部从 `goals` 与 `goal_learning_profiles` 读取，请求体只需要 `goalId`：

```powershell
$body = @{ action = 'generate'; goalId = '<goalId>'; lessonCount = 5 } | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3000/api/learning-program `
  -ContentType 'application/json' `
  -Body $body | ConvertTo-Json -Depth 12
```

成功时返回 `{ program }`，其中 `program.programId` 是落库后的课程 ID。`program.mode=llm` 表示 LLM 已编排课程；`rules` 表示模型不可用而使用本地通用课程。两种模式都会返回可学习的章节和题目。同一目标重复生成会让 `version` 递增，旧版本转为 `archived`。

### AI 讲师与评分

`tutor` 和 `grade` 只携带 `programId` 和 `lessonId`，服务端按这两个 ID 读取固定的课程快照。请求体中不再出现课程正文，评分标准也无法被客户端替换。

```text
tutor: { action, programId, lessonId, message }
grade: { action, programId, lessonId, answers: { [questionId]: "..." } }
```

评分结果中的 `gradedBy=llm` 是模型逐题评分；`gradedBy=rules` 是可解释的本地兜底。返回的 `attemptNumber` 是这一节的第几次评测，`passed` 表示是否达到章节的 `requiredScore`。前端会显示总分、逐题反馈和下一步，而不会把“LLM 可用”误当成学习效果证明。

## 回归

基础代码检查：

```powershell
npm.cmd run db:validate
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

需要真实模型时，先按 [网页服务配置手册](WEB_SERVICE_SETUP.md) 配好不入库的 `.env.local`，启动 Next.js 服务后运行：

```powershell
npm.cmd run learning:smoke -- --require-llm
```

该 smoke 会注册一个 `smoke_` 开头的临时账号并创建目标，然后检查：至少 5 节课程、每节至少 3 道题、课程未下发参考答案与 rubric、任务与章节已通过 `task_lesson_links` 关联、AI 讲师回复、两次评分的 `attemptNumber` 依次递增、按 `programId` 重新拉取时进度仍在，以及所有 `mode/gradedBy` 均为 `llm`。没有模型时可去掉 `--require-llm`，用于检查规则回退是否仍可用。
