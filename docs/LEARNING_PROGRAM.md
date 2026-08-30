# AI 学习程序

这个模块把“我想学会什么”变成一条可执行学习路径，而不是只返回一张课程目录。它适用于技术、人文、语言、创作、职业技能和生活技能等主题；课程的深度仍取决于用户给出的目标、已有基础和每周投入。

## 用户流程

1. 在计划页创建目标，填写完成标准、当前基础和每周投入；目标与自评档案会一起落库。
2. 系统按 `goalId`、目标期限、每周投入和能力数量生成 3–12 节路线，并写入 `learning_programs` / `course_modules` / `course_lessons`。
3. 每节正文使用版本化 `LearningBlock[]` 保存，至少包含目标讲解、具体示例、错误或边界和练习；通过质量门禁后才生成“理解 / 迁移 / 教回”三道开放题。
4. 结构化新课使用课件阅读器逐页展示：一次只渲染一个教学块，支持进度点、按钮/键盘翻页，并按 `lessonId + contentVersionId` 在当前浏览器恢复最后阅读页。
5. 学习中可以直接问 AI 讲师；讲师目前基于当前章节解释、举例并留下一个追问，尚未携带当前教学块或选中文本上下文。
6. 提交答案后，LLM 逐题评分并给出下一步；模型不可用时会明确使用本地规则评分。每次评分写入 `lesson_assessment_attempts`，重测只新增记录，不覆盖历史尝试。
7. 需要行动时，可把当前章节加入今日计划；任务通过 `task_lesson_links` 与章节关联，沿用已有任务 XP/积分结算规则。

内置的 Agent 示例目标是：理解任务闭环、上下文/工具/状态、工具契约、失败边界，并完成一个能处理学习记录的最小 Agent 原型。

## 生成方式和边界

`POST /api/learning-program` 的 `generate` 动作先让 Planner 返回主题专属教学骨架，再由 Tutor 按需生成当前课节的结构化正文。正文必须经过确定性规则和独立语义复核；失败时最多定向修复两次，超过上限则保存 `quality_failed` 并提供重试，不生成正式课后题。

模型负责因主题而变的课程编排、教学块、绑定教学块的题目、讲师回答和评分；课程框架负责能力类型、质量硬规则、版本、权限和事务。未配置模型时可以运行明确标注为 `unverified` 的本地演示；配置模型后若回退内容未通过语义质量门禁，则不会被标记为正式 ready 课程。它不是专业执照考试、医疗/法律/金融建议，也不应把分数当作正式资格认定。

课程正文的唯一来源是服务端数据库，浏览器只缓存当前的 `programId`；清空 `localStorage` 或换设备后重新登录，课程与进度仍可完整恢复。每道题的参考答案和评分 rubric 只存在服务端，不随课程下发，也不接受客户端提交。课程内容、提问和作答会发送给配置的模型服务；不要在原型环境中录入不应发给该服务的个人敏感信息。项目尚未具备云端学习档案、跨设备实时同步或抗作弊考试能力。

课件阅读位置目前只保存在当前浏览器，不属于掌握度证据，也不跨设备同步。困惑标注、重点收藏、选区引用、交互块作答和考核 `open_book` 仍是后续设计，当前数据库与 API 不提供这些能力。

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

成功时返回 `{ program }`，其中 `program.programId` 是落库后的课程 ID。`program.mode=llm` 表示本次课程关键生成节点均由模型完成；`rules` 表示至少一个节点使用了本地演示回退。只有 `qualityStatus=passed` 的新课节才会返回可答题的正式内容；失败课节保留质量报告并可使用 `retry-lesson` 重试。同一目标重复生成会让 `version` 递增，旧版本转为 `archived`。

新课节还会返回 `contentVersionId`、`sourceStatus`、`qualityStatus`、`capabilityType` 和公开教学块。`sourceStatus=unverified` 表示 V0.4.3 尚未接入可信 RAG，不等于内容已经经过外部权威来源校验。

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
npm.cmd run learning:quality
```

需要真实模型时，先按 [网页服务配置手册](WEB_SERVICE_SETUP.md) 配好不入库的 `.env.local`，启动 Next.js 服务后运行：

```powershell
npm.cmd run learning:smoke -- --require-llm
```

`learning:smoke` 检查诊断、动态课程、任务、评分、下一课、幂等、多目标切换与删除闭环；`learning:quality` 专门检查结构化教学块、质量状态、题目版本/教学块追溯、答案隔离，以及 Java、表达和历史辨析能力策略。没有模型时去掉 `--require-llm` 可检查本地演示分支；使用真实模型时应同时关注 `agent_runs` 中的耗时和回退原因。当前模型配置在复杂课程链上可能接近 5 分钟，尚未达到生产级响应时间。
