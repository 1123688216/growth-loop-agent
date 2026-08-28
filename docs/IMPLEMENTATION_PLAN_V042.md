# V0.4.2 实施方案：诊断证据驱动的最小学习闭环

> **给后续维护者和其他 LLM 的阅读提示（2026-08-28）**：V0.4.2 已经落地，并在原始方案上继续完成了“逐题自适应初始诊断”。本文描述的是当前代码事实。早期方案中「一次生成 5–8 道题」「统一提交整套答案」「数据库版本 V4」等已过期的操作步骤和验收清单已删除，不再保留；当前实现以本文、源码和 README 顶部变更记录为准。

## 0. 当前实现基线（其他 LLM 应先读本节）

### 0.1 当前结论

V0.4.2 当前已经支持以下最小闭环：

```text
创建目标并选择基础档位
  → Planner 拆分目标能力
  → 初学者直接生成课程 / 其他档位进入初始诊断
  → Examiner 每次生成一道具体题
  → 用户回答当前题
  → Examiner 对当前题独立评分
  → 更新该能力的上下边界
  → 根据证据生成更难、更简单或相近难度的问题
  → 边界收敛或达到题数上限
  → 固化诊断基线并初始化 skill_mastery
  → Planner 生成课程骨架
  → Tutor 只生成第一节正文和形成性测验
  → 用户学习并答题
  → Tutor 评分
  → Next.js 在同一事务内更新掌握度、课节、任务和下一课难度
  → 按需生成下一课
```

当前仍然没有引入 LangGraph 和 Pydantic AI。工作流由 Next.js/Node 编排，结构化模型调用由本地轻量 Agent 层完成，SQLite 是暂停、恢复和幂等的事实来源。LangGraph/Pydantic AI 仍属于后续迁移目标，不能在说明项目现状时写成已经接入。

### 0.2 三档基础与实际分支

| UI 选项 | 存储值 | 当前处理 |
|---|---|---|
| 初学者 | `beginner` | 跳过初始诊断；能力记录为“尚无证据”，直接生成课程骨架和首课 |
| 一知半解 | `familiar` | 进入逐题自适应诊断；基础难度 2；最少 5 题，最多 10 题 |
| 小有所成 | `intermediate` | 进入逐题自适应诊断；基础难度 3；最少 6 题，最多 12 题 |

正常创建目标时 `selfLevel` 是必填项。`confidence = 0` 的含义只能是“尚无证据”，不能解释为“已经确认掌握度为 0”。

### 0.3 当前诊断题从哪里来

当前没有人工维护的正式题库。题目来源分为两层：

1. **LLM 动态生成**：配置了可用的 OpenAI-compatible 模型时，Examiner 根据学习目标、Planner 拆出的当前能力、目标难度、上一题答案/得分/反馈以及最近已出题干，实时生成一道题。
2. **本地具体题回退**：`LLM_PROVIDER=demo/rules/local`，或者模型不可用、输出解析失败、输出仍然空泛时，使用 `lib/agents/examiner.ts` 中的本地具体题。

本地回退目前重点覆盖：

- Agent、工具调用、状态管理和工作流；
- SQL、索引、事务与数据库；
- 并发编程、线程安全、锁和竞态；
- 其他主题使用带输入、约束、交付物和验收要求的通用具体题。

出题约束：

- 一次只生成一道题；
- 题目必须自包含，题干自身提供数据、代码、约束、故障现象或明确交付物；
- 禁止使用“围绕某知识点，请给出一个具体场景”之类要求用户自己编题的模板；
- 同一次诊断不得重复最近题干；
- 每题必须绑定唯一 `skillId`，同时生成固定 `referenceAnswer`、`rubric`、`maxScore = 10`；
- 参考答案和 rubric 只保存在服务端，不下发浏览器。

数据库保存的是**题目快照和证据**，不是题目来源。生成后的题干、答案标准和 rubric 一旦落库，之后评分必须读取该固定快照，不能临时重新生成评分标准。

核心代码：

- `lib/agents/examiner.ts#buildAdaptiveQuestion`
- `lib/agents/examiner.ts#gradeAdaptiveAnswer`
- `lib/agents/examiner.ts#summarizeAdaptiveDiagnostic`

### 0.4 自适应上下探规则

每个能力维护一份 `AdaptiveSkillBoundary`：

```ts
type AdaptiveSkillBoundary = {
  passMax: number;       // 已有证据支持的最高通过难度，初始为 0
  failMin: number;       // 已有证据表明未通过的最低难度，初始为 6
  attempts: number;
  lastDifficulty: number;
  lastScore: number;
  resolved: boolean;
};
```

当前单题满分为 10，规则如下：

| 本题得分 | 边界更新 | 下一步 |
|---|---|---|
| `8–10` | `passMax = max(passMax, 当前难度)` | 同一能力优先提高一级，继续探测上限 |
| `0–4` | `failMin = min(failMin, 当前难度)` | 同一能力优先降低一级，确认基础下界 |
| `5–7` | 记录为边界附近证据 | 在当前附近难度复核；连续出现稳定中间证据后允许收敛 |

调度规则：

1. 当前能力尚未收敛且尝试少于 3 次时，优先继续探测当前能力；
2. 当前能力收敛后，优先覆盖尚未测试的高权重能力；
3. 所有能力至少有一次证据后，继续处理未收敛且权重较高的能力；
4. 达到最少题数且没有值得继续探测的边界时提前结束；
5. 达到最多题数时强制结束，避免无限消耗 Token；
6. 难度始终限制在 `1–5`。

边界收敛条件当前包括：

- 已通过难度 5；
- 难度 1 仍未通过；
- `failMin - passMax <= 1`；
- 同一能力至少两次处于稳定的中间分区间；
- 或者题数达到上限。

核心代码在 `lib/learning-loop/adaptive.ts`。这是一套确定性业务规则，不交给 LLM 自由决定；LLM 负责出题和基于固定 rubric 评分，系统规则负责选择下一难度和是否结束。

### 0.5 单题诊断工作流和真实进度

前端逐题调用：

```http
POST /api/diagnostics
Content-Type: application/json

{
  "action": "answer-stream",
  "assessmentId": "...",
  "questionId": "...",
  "answer": "..."
}
```

响应为 NDJSON，包含三种事件：

```json
{"type":"progress","progress":{"stage":"grade_answer","percent":14,"message":"..."}}
{"type":"result","result":{"complete":false,"assessment":{},"questionResult":{}}}
{"type":"error","error":"..."}
```

实际阶段为：

```text
load_evidence
  → grade_answer
  → update_bounds
  → generate_question → persist
或者
  → summarize → persist → course
```

这些是工作流节点、输入产物和持久化进度，不是模型的内部思维链。界面不得展示或伪造 chain-of-thought。

未结束时返回：

```ts
{
  complete: false;
  assessment: DiagnosticAssessment; // 已包含刚生成的下一题
  questionResult: {
    questionId: string;
    score: number;
    maxScore: number;
    feedback: string;
    direction: "harder" | "easier" | "same";
    nextDifficulty?: number;
  };
}
```

结束时返回：

```ts
{
  complete: true;
  grade: DiagnosticGrade;
  program: LearningProgram;
  questionResult: { direction: "complete"; ... };
  replayed?: boolean;
}
```

核心代码：

- `app/api/diagnostics/route.ts`
- `lib/learning-loop/adaptive-diagnostic.ts`
- `app/dashboard-client.tsx#submitDiagnostic`

### 0.6 前端当前交互

诊断 UI 当前行为：

- 使用视口居中的固定宽度弹窗；
- 始终只显示最后生成且尚未回答的一道题；
- 显示已完成题数、最多题数和整体进度；
- 提交当前题后锁定该题证据，不能在本地随意回到上一题覆盖；
- 评分期间叠加独立的居中“考官正在评估本题”窗口；
- 评分窗口显示动画、真实百分比、当前阶段和最近执行节点；
- 下一题出现后展示上一题分数、反馈和“难度上调 / 难度下调 / 切换能力继续确认”；
- 用户关闭诊断弹窗后，可以从目标卡片恢复；刷新页面后从数据库中最后一道未答题继续。

创建目标本身也使用独立的流式进度窗口。目标准备流为 `prepare-stream`，会展示读取目标、拆能力、生成首道诊断题或生成课程、持久化等阶段。

相关文件：

- `app/dashboard-client.tsx`
- `app/globals.css`
- `app/api/learning-program/route.ts`

### 0.7 数据库 V5

当前 `DATABASE_SCHEMA_VERSION = 5`。

`diagnostic_assessments` 在旧字段基础上增加：

| 字段 | 含义 |
|---|---|
| `min_questions` | 本次诊断允许提前结束前的最低题数 |
| `max_questions` | 本次诊断硬上限 |
| `answered_count` | 已成功评分并持久化的题数 |
| `adaptive_state_json` | 各能力上下边界的可恢复快照 |

新增 `diagnostic_responses`：

| 字段 | 含义 |
|---|---|
| `assessment_id` / `question_id` / `user_id` / `skill_id` | 证据归属 |
| `answer` | 用户当前题答案 |
| `score` / `max_score` | 本题固定量纲得分 |
| `feedback` | Examiner 对本题的证据反馈 |
| `grader_mode` | `llm` 或规则回退 |
| `provider` / `model` | 实际评分来源 |
| `answered_at` | 作答落库时间 |

`UNIQUE(assessment_id, question_id)` 防止同一道题被重复累计证据。

此外：

- `diagnostic_questions` 继续保存题干、参考答案、rubric、难度和 `skill_id` 快照；
- `diagnostic_attempts` 保存整次诊断的最终汇总；
- `skill_mastery` 保存由证据派生的当前能力画像；
- `agent_runs` 保存角色、节点、provider、model、token、耗时和结果信息；
- 新库直接按完整 schema 创建，旧库启动时通过 `COLUMN_ADDITIONS` 幂等补列；
- 旧版尚未完成的整套诊断不会强行转成自适应状态，重新准备目标时会把旧记录置为过期并创建新的逐题诊断；
- 已经完成的诊断保持幂等回放，不重复增加证据次数。

相关文件：

- `lib/db/schema.ts`
- `lib/db/index.ts`
- `lib/db/learning-loop.ts`
- `scripts/validate-database-schema.mjs`

### 0.8 角色和信息边界

当前角色边界不能因为引入自适应诊断而混淆：

| 角色 | 当前职责 | 不负责 |
|---|---|---|
| Planner | 拆目标能力、生成课程骨架 | 不负责逐题教学，不直接修改掌握度 |
| Examiner | 初始诊断出题、单题评分、最终基线总结；未来负责阶段大考和模拟面试 | 不读取日常教学对话，不负责课内小测和补课 |
| Tutor | 当前课正文、巩固题、形成性评分、讲解与反馈 | 不做独立毕业判定，不改变已固化 rubric |
| LearningPolicy/Next.js | 选择难度、聚合证据、更新掌握度、执行任务完成门禁 | 不是新 Agent，不把确定性规则交给 LLM |

Examiner 当前允许看到：目标标题/描述、能力点、当前题固定快照、当前题答案、同次诊断的最小必要证据。它不应接收完整 `LearnerContext` 或导师日常聊天，以维持独立诊断的公平性。

### 0.9 课程闭环当前实现

完成诊断或初学者跳过诊断后：

1. Planner 持久化完整课程时间线骨架；
2. 只有第一节为 `ready`，其余课节为 `planned`；
3. Tutor 为当前课生成正文、练习/交付物和 3 道形成性题目；
4. 题目、参考答案和 rubric 在生成时固化；
5. 用户必须完成答题并达到合格线，关联课程任务才允许完成；
6. 普通 `PATCH /api/tasks/[id]` 不能绕过课程答题门禁；
7. 课后评分、掌握度更新、课节通过、任务完成和下一课解锁在同一 SQLite 事务内执行；
8. 下一课根据最新掌握度调整难度，并在通过上一课后才生成正文。

课程页支持在多个学习目标对应的课程之间立即切换；计划页的目标卡片可以恢复未完成的诊断。长期目标也支持带二次确认的删除，删除时清理该目标的课程任务和级联业务数据，但不影响其他目标。

### 0.10 关键代码索引

| 能力 | 文件 |
|---|---|
| Planner / Tutor / Examiner | `lib/agents/` |
| 自适应边界与选题策略 | `lib/learning-loop/adaptive.ts` |
| 逐题诊断编排 | `lib/learning-loop/adaptive-diagnostic.ts` |
| 目标准备和课程生成 | `lib/learning-loop/service.ts` |
| 诊断 API | `app/api/diagnostics/route.ts` |
| 学习程序 API / 进度流 | `app/api/learning-program/route.ts` |
| 诊断与课程持久化 | `lib/db/learning-loop.ts`、`lib/db/programs.ts` |
| 数据库 schema / 迁移 | `lib/db/schema.ts`、`lib/db/index.ts` |
| 页面交互 | `app/dashboard-client.tsx`、`app/learning-studio.tsx` |
| 样式 | `app/globals.css` |
| 端到端回归 | `scripts/learning-program-smoke.mjs` |

### 0.11 已验证的行为

当前完成过以下验证：

- `npm.cmd run typecheck`；
- `npm.cmd run lint`；
- `npm.cmd run db:validate`，schemaVersion 为 5；
- `npm.cmd run build`；
- 隔离 SQLite 端到端回归 `npm.cmd run learning:smoke -- --base=<测试服务>`。

端到端回归覆盖：

- 三档目标分支；
- 未诊断前禁止生成课程；
- 初次只生成一道诊断题；
- 高质量回答触发更高难度；
- “不知道”回答触发更低难度；
- 每次只新增并持久化一道下一题；
- 逐题进度包含评分和边界更新并最终到达 100%；
- 题目不向客户端泄露参考答案和 rubric；
- 完成诊断后重复提交返回同一持久化结果；
- 课程只生成首课正文，后续课节保持 `planned`；
- 课后测验通过后原子完成关联任务并生成下一课；
- 多目标课程切换；
- 删除目标时清理关联课程任务且不影响其他目标。

最近一次规则模式回归结果为 `ok: true`；诊断同时观察到 `harder` 和 `easier` 分支，最终生成 5 节课程骨架，首节形成性评测为 85 分。临时数据库已删除，没有写入日常数据库。

### 0.12 当前明确未实现或仍有限制

| 项目 | 当前状态 |
|---|---|
| LangGraph checkpoint / interrupt | 未接入；当前由 SQLite 状态和幂等 API 恢复 |
| Pydantic AI Python 服务 | 未接入；当前是 Node 轻量结构化 Agent 层 |
| 正式人工题库 | 未实现；目前是 LLM 动态生成 + 本地具体题回退 |
| RAG、官方资料引用和联网取材 | 未实现 |
| 回退题的广泛学科覆盖 | 有限，当前技术主题覆盖更好 |
| 阶段大考、模拟面试、毕业门禁 | 未实现，仍属于 Examiner 后续能力 |
| 不合格后的专门补课 → 重测图循环 | 未完整实现 |
| 大规模真实用户效果指标 | 尚无数据，不能宣称提升了学习效果百分比 |
| 移动端同步适配 | 当前暂停，不属于本阶段范围 |

### 0.13 后续 LLM 修改时必须保持的约束

1. 不得把 LLM 内部推理原文当作“进度流”返回；只返回可验证节点、状态和产物。
2. 不得把参考答案和 rubric 下发到浏览器。
3. 不得让 Examiner 读取完整导师对话后再声称是独立测评。
4. 不得让模型直接写 `mastery_score`、完成课程任务或决定数据库权威状态。
5. 不得使用标题匹配代替 `goalId`、`programId`、`lessonId`、`skillId` 等稳定关联。
6. 不得破坏逐题幂等：同一 assessment/question 只能产生一份有效响应证据。
7. 不得重新一次性生成整套诊断题；逐题生成和边界反馈是当前产品行为。
8. 不得把后续 `planned` 课节提前全部生成，否则形成性评测无法影响未来内容。
9. 新增功能、接口、数据库字段或运行方式后必须同时更新 README 和本文档的当前实现基线。
10. 接入 LangGraph/Pydantic AI 时应迁移编排和结构化模型调用，不应重写已经验证的业务规则、数据库主权和 API 幂等约束。

### 0.14 相比最初 V0.4.2 方案已经发生的关键变化

| 最初方案 | 当前实现 |
|---|---|
| 一次生成 5–8 道诊断题 | 首次只生成一道，之后逐题动态生成 |
| 用户填完全部题目后统一评分 | 每题回答后立即评分并更新能力边界 |
| 固定题量 | `familiar` 为 5–10，`intermediate` 为 6–12，可提前收敛 |
| 只得到每项能力总分 | 保存每题答案、分数、反馈和能力边界快照 |
| 诊断界面只展示答题进度 | 增加独立 Examiner 评分进度窗口和难度变化反馈 |
| 数据库 V4 | 数据库 V5，新增 `diagnostic_responses` 及自适应字段 |
| 题目来源描述不清 | 明确为 LLM 动态生成、本地具体题回退、数据库保存快照 |
| 旧活动诊断直接复用 | 旧版未完成诊断过期后创建新的自适应诊断 |


本文是 V0.4.2 的实施记录。Agent 的角色划分与信息边界见 [Agent 角色与信息边界](AGENT_ROLES.md)，上游路线见 [V1 实施方案](IMPLEMENTATION_PLAN_V1.md)，上一版交接见 [V0.4.1 交接说明](HANDOFF_V041.md)。

以下记录这一版要解决的三个连续问题：**用户缺什么、课程里有什么、一次评测怎样改变后续课程**。它解释了当前设计为什么是这样，与 §0 的实现基线对照阅读。

## 1. 为什么改这些

### 1.1 改造前：课程正文是「LLM 出骨架 + 模板填肉」

这是本轮最需要修的问题。改造前的生成 prompt 里有一句：

> 不要输出 questions、开场白、练习、交付物或 Markdown

于是 `normalizeProgram`（`lib/learning-program/service.ts`）把 LLM 输出和本地模板这样合并：

| 字段 | 实际来源 |
|---|---|
| 课程标题、简介、学习成果、节奏、讲师人设 | LLM |
| 每节的 phase、标题、时长、目标、概念 | LLM |
| 每节讲解的第一句（`focus`）、案例的第一句 | LLM，拼接在模板正文**前面** |
| 开场白、讲解正文主体、案例主体 | 模板写死 |
| **练习、交付物** | 模板写死 |
| **全部课后题** | 模板写死 |

模板只有两套：主题命中 `/agent|智能体|代理系统|工具调用/` 走 `agentLessons`，其余一律走 `genericLessons`。学摄影、学法语、学 Kubernetes 拿到的是同一组练习与交付物。课后题更彻底，`questionSet()` 是三个固定句式，只把概念名填进占位符——**每一门课、每一节，都是这三道题**。

当初这样设计是为了「避免一次要求模型生成超长教案导致超时」。取舍在原型期成立，但它把最影响学习效果的部分留在了最不个性化的一侧。**根治办法不是把 prompt 写长，而是把一次大请求拆成每节一次小请求**——现在由 `lib/agents/tutor.ts` 逐节生成，见 §0.9。

> **遗留清理**：`lib/learning-program/service.ts` 里的 `generateLearningProgram`、`genericLessons`、`agentLessons`、`isAgentSubject` 已经没有任何调用方（该文件仅剩 `askCourseInstructor`、`getLearningProgramStatus`、`providerLabel` 被引用）。它们既不在正常路径上，也没有被接成逐节回退，属于待删除的死代码。

### 1.2 形成性小测和独立大考尚未区分

现在没有稳定的角色边界：`generateLearningProgram`、`askCourseInstructor`、`gradeCourseLesson` 共用一份配置和一套 prompt 拼装，课程小测既没有明确归属，也没有和将来的阶段大考区分证据等级。

V0.4.2 明确两种不同目的的考核：

- **导师形成性小测**：导师知道本节教过什么、学习者问过什么、当前卡点在哪里，根据刚学内容出题、评分并给出补充讲解。目的不是发证书，而是加深印象并决定下一步怎么教。
- **考官独立大考**：考官不参与日常教学，只负责初始诊断、后续阶段考核、模拟面试和最终毕业门禁。题目基于目标能力与统一标准，不依赖某节课恰好讲了什么。

导师小测可以更新日常 `mastery_score` 和完成课程任务，但不能单独证明用户已经达到最终目标；只有考官的大考证据才能承担阶段通过或毕业结论。V0.4.2 落地初始诊断和导师小测，阶段大考/模拟面试留到后续版本。

### 1.3 掌握度没有写入方，闭环没有闭上

`goal_skills`、`skill_mastery` 两张表 V2 就建好了，至今零写入。课后评分写进了 `lesson_assessment_attempts`，但没有任何东西读它去调整后续安排。学完一节，系统对学习者的判断不发生任何变化——环是断的。

### 1.4 默认初学者会污染后续所有自适应判断

当前创建目标接口在没有收到 `selfLevel` 时回退为 `beginner`，前端创建目标成功后立即生成五节课程；`skill_mastery` 又计划统一从 `mastery_score = 0` 开始。这三个行为组合后，系统无法区分「没有证据」和「确实不会」，后续课程难度、能力权重和进度建议都会建立在错误基线上。

V0.4.2 改为：

- 创建目标时必须选择 `beginner`、`familiar`、`intermediate`，不再由正常 UI 静默缺省；
- 规划员先拆能力，诊断题才有明确的能力覆盖范围；
- `familiar`、`intermediate` 必须完成初始诊断，诊断完成前禁止生成课程；
- `beginner` 按产品约定可以跳过测验，但 `confidence = 0` 表示「尚无证据」，不能把 `mastery_score = 0` 当成一次零分；
- 课程骨架在基线确定后生成，章节正文与题目按学习进度逐节生成，使后续评测真的能改变下一节。

## 2. 与 V0.4.3 的关系

服务边界已定（2026-08-27）：**Python 承担 LangGraph 工作流与 Pydantic AI 模型调用，Next.js 是数据库唯一写入方**，节点通过内部接口回调落库。详见 [V1 实施方案 §4](IMPLEMENTATION_PLAN_V1.md)。

据此，本轮在 Node 侧写的东西分成三类：

| 类别 | 内容 | V0.4.3 时 |
|---|---|---|
| **不搬** | 前端 UI、数据库 schema、`lib/db/` 落库与事务、登录会话、权威掌握度/完成门禁计算 | 原样保留，Python 通过内部接口提交模型证据 |
| **资产迁移** | system prompt 文本、输入输出契约、校验规则、黄金输入输出样例 | 转成 Pydantic 模型和 Python 测试 |
| **删除** | `requestStructured` 封装、Node 侧的编排代码 | Pydantic AI 与 LangGraph 取代 |

Node 侧的 Agent 层刻意做得薄——不自建重试策略、多 provider 收敛和 Token 解析器，因为 Pydantic AI 都有——就是为了压缩第三类的体积。真正贵的东西是语言无关的：system prompt 的措辞、输出该有哪些字段、校验该拦什么。这些是反复试出来的资产，`const SYSTEM = "..."` 变成 `SYSTEM = """..."""` 是复制粘贴，Pydantic 的 `Field(ge=1, le=5)` 比手写校验还短。

初始诊断的业务状态和 API 已在 V0.4.2 落地；V0.4.3 只是把它接入 LangGraph 的 `interrupt` 与 checkpoint。能力勾选、可行性确认和不合格后的补课重测加入后，图才同时承担多分支、暂停恢复和循环控制。

Python 节点不得把掌握度最终值直接写给数据库。它返回结构化评分证据；Next.js 在同一事务里校验题目归属、重新归一化分数、更新掌握度并执行完成门禁，避免跨服务读—算—写造成丢失更新。

[Agent 角色与信息边界](AGENT_ROLES.md) 定义的角色、边界和输出契约跨版本不变：`SkillMapOutput`、`LessonContentOutput`、`LessonCheckSetOutput`、`DiagnosticSetOutput` 转成 Pydantic 模型，落库函数不动，`goal_skills`、`skill_mastery` 已经在写。

## 3. 联网取材（独立增量，未排期）

较新的主题不一定在模型语料里。建议先做**用户提供资料**，不做盲搜：主题新通常意味着有明确的官方文档，让用户贴一条链接比模型盲搜更准也更便宜；中文技术内容盲搜质量参差，容易引入二手博客反而污染课程。

实现形状：创建目标时可填 1–3 个 URL；服务端抓取正文、截断后作为拆能力与逐节生成的素材；新增 `course_lessons.sources_json` 记录来源，前端在讲解下方展示。抓取边界：仅 http/https、拒绝内网地址、超时 10 秒、正文上限约 20000 字符、失败不阻断生成。

这正好落实 [V1 实施方案 §2](IMPLEMENTATION_PLAN_V1.md) 已经写下的约定：

> 优先使用官方文档、可信题库或 RAG 材料生成和校验；没有可靠来源时，题目应明确标记为 `llm`。

搜索 API 留待后续，接口按同一个「素材 → 生成 → 记录来源」的形状预留，届时只增加素材来源，不改下游。
