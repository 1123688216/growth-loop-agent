# V0.4.1 交接说明

本文记录 2026-08-26 对仓库现状的核对结果，以及 V0.4.1 的实施顺序与结果。路线图见 [实施方案](IMPLEMENTATION_PLAN_V1.md)，本文只补充「计划之外、代码里读不出来」的部分。

**当前状态：V0.4.1 六个步骤已全部落地并通过验收，下一步是 V0.4.2 的三档自评与诊断分支。**

## 1. 现状核对

数据库 V2 schema 已完成并通过校验：

```powershell
npm.cmd run db:validate
# V0.4.1 完成时：{"schemaVersion":2,"tableCount":20,"requiredTableCount":16,"integrity":"ok"}
# 现在为 schemaVersion 3（goals.target_date 与幂等加列机制，见开发者手册 §3.4）
```

V0.4.1 开工时**新增的 12 张表零写入**，只有 `users`、`sessions`、`goals`、`tasks`、`activity_logs`、`ledger_entries` 有实际读写。本轮之后：

| 能力 | 状态 | 说明 |
|---|---|---|
| V2 表结构与校验脚本 | 已完成 | `lib/db/schema.ts`、`scripts/validate-database-schema.mjs` |
| 用户、会话、目标、任务、流水 | 已完成 | 已落库 |
| `/api/goals` 接收 `selfLevel`、`weeklyHours`、`background` | 已完成 | 与 `goals` 同事务写 `goal_learning_profiles`，响应回读 profile |
| 课程写入 `learning_programs` / `course_modules` / `course_lessons` | 已完成 | `lib/db/programs.ts` 单事务写入，`phase` 归并出模块 |
| `task_lesson_links` 关联任务与课程 | 已完成 | `POST /api/tasks` 接收 `lessonId`，`/api/dashboard` 回读关联 |
| `lesson_assessment_attempts` 记录课后评分 | 已完成 | `attempt_number` 递增，合格后章节状态落库为 `passed` |
| `goal_skills` / `skill_mastery` | 未开始 | 表已建，无引用；随 V0.4.2 诊断评分一起写入 |
| 三档自评与诊断分支 | 未开始 | 属 V0.4.2。数据契约已就位：`self_level` 已落库，`diagnostic_required` / `diagnostic_status` 由自评推导 |
| Python / LangGraph / Pydantic AI | 未开始 | 按修订路线属 V0.4.5，依赖中尚未引入 |

## 2. 关键问题：课程快照握在客户端（已解决）

V0.4.1 开工时课程的唯一真相在浏览器。`app/dashboard-client.tsx` 生成课程后写入 localStorage，`app/learning-studio.tsx` 从 localStorage 读取；而 `/api/learning-program` 的 `tutor` 和 `grade` 两个 action 是从**请求体**取课程的：

```ts
// 改造前的 app/api/learning-program/route.ts
const course = courseFrom(body.course);            // 客户端回传整份课程
if (serialized.length > 180_000) throw ...         // 上限 180KB
```

由此产生三个后果：

1. 换设备或清缓存后课程全部丢失，数据库中查不到任何痕迹。
2. 每次提问、每次交卷都要重传最多 180KB 的课程 JSON。
3. **参考答案与评分 rubric 保存在客户端，可被修改后提交给评分 Agent。**

第 3 点与[实施方案第 2 节](IMPLEMENTATION_PLAN_V1.md)的约定直接冲突——「用户提交答案后，考核 Agent 只能读取这份固定快照进行评分」。快照必须由服务端持有，不能由客户端提交。

这是 V0.4.1 的核心目标：**不是把课程「也」存一份到库里，而是让服务端成为课程的唯一来源。**

现在 `courseFrom` 已删除，`tutor` 与 `grade` 只接收 `programId + lessonId`。类型系统承担了这条边界：`CourseQuestion` 只有题干和提示，`AuthoredCourseQuestion` 才带 `referenceAnswer` 和 `rubric`，而后者只出现在服务端模块里。

## 3. 实施顺序与结果

| 步骤 | 内容 | 落点 |
|---|---|---|
| 1 | 新增 `lib/db/programs.ts`：单事务写入与读取 `learning_programs` → `course_modules` → `course_lessons`，含每节的 `reference_answer` 与 rubric | 参考答案与 rubric 存在 `course_lessons.questions_json`；`toPublicLesson` 负责下发前剥离 |
| 2 | `/api/goals` POST 增收 `selfLevel`、`weeklyHours`、`background`，同事务写 `goals` 与 `goal_learning_profiles` | `lib/db/goals.ts`；`selfLevel` 缺省为 `beginner`（页面控件属 V0.4.2） |
| 3 | `/api/learning-program`：`generate` 落库并返回 `programId`；`tutor` 与 `grade` 入参改为 `programId + lessonId`，删除 `courseFrom` | `generate` 只收 `goalId`，主题与每周投入从目标和自评档案读取 |
| 4 | 生成首批任务时写入 `task_lesson_links`，替换现有的按标题匹配 | 任务标题、时长、合格线由服务端取自章节；`course-` 前缀 id 与标题模糊匹配已删除 |
| 5 | `grade` 结果写入 `lesson_assessment_attempts`，`attempt_number` 递增，不覆盖历史尝试 | 合格后写 `course_lessons.status = 'passed'`；已合格的章节重测分数偏低不会撤销 |
| 6 | 前端将 localStorage 降级为「当前 programId 缓存」，课程正文改为从服务端拉取 | 只剩 `growth-loop.learning-program.program-id.v1`；缓存失效时回退 `?program=current` |

## 4. 完成标准与验收结果

`npm.cmd run db:validate`、`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build` 全部通过。

端到端验收用改写后的 smoke 完成，它会注册临时账号、创建目标、生成课程、加入今日计划、提问并连续评分两次：

```powershell
npm.cmd run learning:smoke -- --require-llm
# {"ok":true,...,"courseMode":"llm","tutorMode":"llm","gradingMode":"llm","attempts":[1,2],"lessonStatus":"passed"}
```

它逐条覆盖了完成标准：

- 创建目标后 `goal_learning_profiles` 有记录——`POST /api/goals` 回读 profile，断言 `selfLevel`、`weeklyHours`、`background` 与提交值一致。
- `learning_programs`、`course_lessons` 有记录——`generate` 返回 `programId`，之后用独立请求按该 ID 读回 5 节课程。
- `task_lesson_links` 有记录——`POST /api/tasks` 只传 `lessonId` 即建成关联，再由 `/api/dashboard` 回读校验。
- 完成一次课后评测新增一条 `lesson_assessment_attempts`，重测再新增一条——断言两次 `attemptNumber` 依次为 1 和 2。
- 清空 localStorage 后课程与进度仍可恢复——smoke 全程不使用浏览器存储，仅凭 `?program=<programId>` 与 `?program=current` 就能读回课程与 `passed` 状态。
- `/api/learning-program` 请求体中不再出现课程正文——`tutor` 与 `grade` 只发送 `programId + lessonId`；同时断言下发的题目不含 `rubric` 与 `referenceAnswer`。

### 一个运行环境注意事项

`lib/db/index.ts` 把 SQLite 连接缓存在 `globalThis` 上，建表只发生在打开连接的那一刻。因此**改动 `DATABASE_SCHEMA` 之后必须重启 `next dev`**，否则长期运行的开发服务器会继续用旧连接，新表在文件里根本不存在，接口会以 500 空响应失败。本轮就先遇到过 `no such table: goal_learning_profiles`。判断方法：

```powershell
Get-Content .next\dev\logs\next-development.log -Tail 20
```

改数据库结构的完整规则（含加新列必须同时改两处）已整理到[开发者手册 §3.4](DEVELOPER_HANDBOOK.md)。
