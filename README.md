# 成长回路（Growth Loop）

一个把“今天做了什么”变成下一步行动的自我提升 Agent。用户可以直接和 AI 对话，记录学习、运动、生活和休息；Agent 负责整理、安排、复盘，并把可验证的行动记入成长轨迹。

> 当前版本是可运行的原型，可部署为邀请制公网 Demo，但不是生产 SaaS。项目已经包含 Next.js Web、Capacitor Android 工程、确定性 demo 数据、OpenAI-compatible LLM 接口、微信公众号明文回调、理解测验和电脑 Android Emulator 调试链路。

## 变更记录

后续每次功能、接口、数据结构或运行方式发生变化，都必须同步更新本节。标记含义：`新增` 表示新能力，`修改` 表示既有行为变化，`修复` 表示缺陷修正，`暂未实现` 表示已经确定但尚未落地的边界。

### 2026-08-30 · V0.4.4 私有资料 RAG（设计冻结，尚未实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 编写 V0.4.4 独立实施方案，冻结“私有资料导入 → 不可变版本 → 确定性分块 → FTS5 检索 → 教学块/题目来源绑定 → 固定快照评分”的最小闭环 | `docs/IMPLEMENTATION_PLAN_V044.md` |
| **修改** | Schema V8 留给资料、版本、片段、目标资料关系、检索运行和题目来源；V0.4.3.1 尚未实现的课堂标注与 `open_book` 顺延到 V9 | `docs/IMPLEMENTATION_PLAN_V043.md`、`docs/IMPLEMENTATION_PLAN_V044.md` |
| **暂未实现** | 本文目前只有设计，不代表已经支持上传 PDF/DOCX/TXT、FTS5、来源引用或联网搜索；Embedding、URL 与联网来源分别放到 V0.4.4.1–V0.4.4.3 | `docs/IMPLEMENTATION_PLAN_V044.md` |

### 2026-08-30 · V0.4.3 通用课程内容引擎（工程 MVP 已实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修改** | 课程不再固定为 5 节，由目标期限、每周投入和能力数量动态生成 3–12 节路线；能力点增加概念理解、程序技能、问题解决、表达沟通、记忆辨析和综合创作六类教学策略 | `lib/agents/planner.ts`、`lib/agents/types.ts` |
| **新增** | 新课正文改为版本化 `LearningBlock[]`，统一保存讲解/关系/对比、完整示例/演示/代码实验、错误/边界和引导/回忆/表达练习，并为每节定义可观察的完成证据 | `lib/learning-program/types.ts`、`lib/agents/tutor.ts` |
| **新增** | 发布前执行确定性质量门禁和独立语义复核；未通过时最多定向修复 2 次，仍失败则保存 `quality_failed` 并在课程页提供重试，不再把通用回退伪装成正式 AI 课程 | `lib/learning-program/quality.ts`、`lib/learning-loop/service.ts`、`app/learning-studio.tsx` |
| **新增** | 形成性题目只在正文通过质量门禁后生成，每题绑定不可变内容版本、已教学块、证据类型和预期概念；评分尝试同时保存题目快照，公开接口继续剥离参考答案和 rubric | `lib/agents/tutor.ts`、`lib/db/programs.ts`、`app/api/learning-program/route.ts` |
| **新增** | 数据库升级到 V6，新增 `lesson_content_versions`、`lesson_quality_reports`、`lesson_block_sources`，并为能力、课节和评测补充内容版本、来源、质量、能力类型和题目快照字段 | `lib/db/schema.ts`、`scripts/validate-database-schema.mjs` |
| **修改** | 课程页按教学块渲染，展示能力类型、来源状态和质量状态；失败课节不展示正式答题入口，可通过“重新生成本节”再次进入质量链 | `app/learning-studio.tsx`、`app/globals.css`、`app/api/learning-program/route.ts` |
| **修复** | 模型节点支持 75–120 秒的分级等待并把超时、空响应、解析和校验失败写入 `agent_runs.error_message`；示例步骤单项上限从通用列表的 180 字符放宽到 2400 字符，避免完整代码被清洗层截断 | `lib/agents/shared.ts`、`lib/agents/planner.ts`、`lib/agents/tutor.ts` |
| **新增** | 新增 V0.4.3 质量回归，覆盖 Java 并发、技术演讲和近代史辨析三类目标、动态课时、教学块完整性、题目追溯、答案隔离、质量阶段和非代码能力策略 | `scripts/v043-quality-smoke.mjs`、`scripts/learning-program-smoke.mjs` |
| **新增** | V0.4.3.1 基础课件阅读器已落地：结构化新课一次只渲染一个教学块，支持页码/进度点、按钮与键盘翻页、交付物页、独立考核页和按内容版本恢复阅读位置；考核页关闭导师问答 | `app/learning-studio.tsx`、`app/globals.css` |
| **修改** | 对齐课件阅读器文档与当前实现，明确上下文块提问、困惑/收藏、交互块作答、长代码工具和 `open_book` 仍未实现；当前 Schema V7 已被学习作息占用，V8 留给 V0.4.4 可信来源/RAG，未来课堂标注迁移顺延为 V9 | `docs/IMPLEMENTATION_PLAN_V043.md` |

验证结果：`typecheck`、`lint`、`db:validate` 和隔离数据库规则模式 E2E 已通过；V0.4.3 核心引入 Schema V6，当前项目后续已升级到 Schema V7（25 张表、17 项增量字段、`integrity_check=ok`）。规则回归中 Java/演讲/历史三个固定样例均通过质量门禁，所有正式题目绑定当前内容版本和有效教学块，公开响应中的参考答案与 rubric 为 0。浏览器实测阅读器只渲染当前教学块，按钮和方向键可连续翻页，刷新后能从 `03 / 09` 恢复。真实模型完整课程链仍可能接近 5 分钟；当前不能据此宣称学习效果提升，也不能把尚未实现的课堂标注写成现有能力。

### 2026-08-28 · 逐题自适应初始诊断与考官评分进度（已实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修改** | 初始诊断不再一次生成整套模板题，而是先生成一道带固定数据、代码、约束、故障现象或明确交付物的具体题；LLM 输出若仍包含“请给出一个具体场景”等空泛模板，会自动退回到本地具体题 | `lib/agents/examiner.ts`、`lib/learning-loop/service.ts` |
| **新增** | 每回答一题立即由 Examiner 独立评分，并维护各能力的“已通过最高难度 / 未通过最低难度”边界；高分优先上探、低分优先下探、中间分在相近难度复核，同一能力边界收敛后再切换能力 | `lib/learning-loop/adaptive.ts`、`lib/learning-loop/adaptive-diagnostic.ts` |
| **修改** | 一知半解采用最少 5、最多 10 题，小有所成采用最少 6、最多 12 题；达到最少题数且能力边界已收敛时提前结束，否则在题数上限处停止，避免固定题量既浪费 Token 又测不出上下限 | `lib/learning-loop/service.ts` |
| **新增** | `POST /api/diagnostics` 增加 `answer-stream` 逐题 NDJSON 协议，真实返回“读取证据 → 本题评分 → 更新边界 → 生成下一题 / 汇总基线 → 生成课程”进度；只展示工作流阶段和产物，不暴露模型内部思维链 | `app/api/diagnostics/route.ts`、`lib/learning-loop/adaptive-diagnostic.ts` |
| **修改** | 诊断弹窗始终只显示当前题；提交后叠加独立的居中考官评估窗口、动画、进度条和最近节点，完成后展示本题得分、反馈及难度上调/下调提示 | `app/dashboard-client.tsx`、`app/globals.css` |
| **新增** | 数据库升级到 V5：诊断记录保存最少/最多题数、已答数和自适应边界快照；`diagnostic_responses` 逐题保存答案、分数、反馈、评分模式与模型信息，刷新后可以从最后一道未答题继续 | `lib/db/schema.ts`、`lib/db/learning-loop.ts` |
| **修改** | 旧版尚未完成的整套诊断不会被误当作自适应诊断继续使用，重新开始时会过期旧记录并创建新的逐题诊断；已完成诊断仍保持幂等回放 | `lib/db/learning-loop.ts`、`lib/learning-loop/service.ts` |
| **新增** | 端到端回归同时注入高质量答案与“不会”答案，断言出现难度上调和下调、每轮只新增一题、逐题证据落库、评分进度到达 100%、诊断幂等回放及后续课程闭环 | `scripts/learning-program-smoke.mjs` |
| **修改** | `V0.4.2 实施方案` 增加面向其他 LLM 的当前实现基线，集中记录题目来源、自适应算法、NDJSON 协议、数据库 V5、UI 行为、角色边界、代码索引、验证结果、未实现项和后续修改约束，并明确标注下文早期固定题量方案为历史记录 | `docs/IMPLEMENTATION_PLAN_V042.md` |
| **修改** | 全面修订 V1 路线图：将教学质量提升为正式考核的前置门禁，增加通用能力类型、结构化 `LearningBlock`、课程质量报告、私有资料/联网 RAG 来源链和可见回退；V0.4.3 先实现通用课程内容引擎，V0.4.4 接入可信 RAG，V0.4.5 再迁移 Pydantic AI/LangGraph，V0.5 才推进补课、阶段考核与毕业门禁 | `docs/IMPLEMENTATION_PLAN_V1.md` |
| **新增** | 编写独立 V0.4.3 实施方案，冻结“结构化课程生成 → 双层质量门禁 → 定向修复 → 教学块对齐小测 → 版本化证据”的范围，补充通用能力模型、拟定数据库 V6、测试指标与 Definition of Done；本行记录的是 8 月 28 日当时状态，后续实现见上方 V0.4.3 记录 | `docs/IMPLEMENTATION_PLAN_V043.md` |
| **修改** | 对齐跨文档版本边界：V0.4.3 负责教学质量，V0.4.4 负责可信 RAG，Pydantic AI/LangGraph 框架迁移统一调整到 V0.4.5；同步修正 V0.4.1 交接、V0.4.2 交接与 Roles 说明 | `docs/HANDOFF_V041.md`、`docs/IMPLEMENTATION_PLAN_V042.md`、`docs/AGENT_ROLES.md`、`docs/IMPLEMENTATION_PLAN_V1.md` |
| **新增** | 增加邀请制公网 Demo 部署方案，固定支持 `node:sqlite` 的 Node.js 22/24 运行时，并记录 Zeabur GitHub 部署、`/data` 持久化卷、HTTPS Cookie、LLM Secret、上线验收和体验反馈边界 | `package.json`、`.node-version`、`docs/DEMO_DEPLOYMENT.md` |

验证结果：`typecheck`、`lint`、`db:validate`、Next.js 生产构建全部通过；隔离 SQLite 端到端回归返回 `ok: true`，自适应诊断在 10 题内完成，高低分分别触发上探和下探，最终生成 5 节课程骨架并完成首课评测闭环。新增 Demo 部署配置后再次通过 Next.js 生产构建。临时测试数据库已删除，未影响日常数据。

### 2026-08-27 · 长期目标删除闭环（已实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 长期目标卡片增加低干扰的删除入口；点击后显示二次确认窗口，明确关联数据范围和不可撤销性，确认期间锁定重复操作 | `app/dashboard-client.tsx`、`app/globals.css` |
| **新增** | `DELETE /api/goals` 按当前登录用户校验目标归属，目标不存在或不属于当前用户时不执行删除 | `app/api/goals/route.ts` |
| **新增** | 删除事务先清理课程关联任务与目标 Agent 运行记录，再删除目标；能力、掌握度、诊断、课程、课节和评测由外键级联清理，普通学习记录保留 | `lib/db/goals.ts` |
| **修改** | 删除成功后前端同步移除目标和被删除的今日任务，并清理已删除课程的本地活动课程指针 | `app/dashboard-client.tsx` |
| **新增** | 端到端回归覆盖目标删除、课程任务清理、课程不可再读取以及其他目标不受影响 | `scripts/learning-program-smoke.mjs` |

验证结果：`typecheck`、`lint`、`db:validate`、Next.js 生产构建均通过；隔离 SQLite 端到端回归返回 `ok: true`、`deletedTaskCount: 1`。临时测试数据库已删除。

### 2026-08-27 · 居中单题诊断与独立进度窗口（已实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修复** | 初始诊断不再沿用靠右展开的测验抽屉，改为视口居中的固定宽度弹窗，避免题目窗口偏斜和整页滚动 | `app/dashboard-client.tsx`、`app/globals.css` |
| **修改** | 诊断题采用渐进式单题作答：显示题号、总题数、已答数量和进度条，支持上一题、下一题与最终提交，回答内容在题间切换时保留 | `app/dashboard-client.tsx` |
| **修改** | 创建目标提交后不再从表单下方衍生进度区域，而是将表单切换为独立的小型进度窗口，集中展示当前节点、百分比和最近执行记录 | `app/dashboard-client.tsx`、`app/globals.css` |
| **新增** | 进度窗口增加轨道旋转、中心图标呼吸和节点光点动画；为 `prefers-reduced-motion` 用户自动关闭动画和过渡 | `app/globals.css` |

验证结果：`typecheck`、`lint`、Next.js 生产构建均通过；本轮只调整前端交互与样式，原有流式 API 和诊断提交协议未变。

### 2026-08-27 · 创建目标真实进度流（已实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 为目标准备闭环增加真实阶段回调：读取档案、Planner 拆能力、Examiner 生成初始诊断、Planner 编排课程、Tutor 生成首课与巩固题、持久化，每个节点在实际调用前后报告进度 | `lib/learning-loop/service.ts` |
| **新增** | `POST /api/learning-program` 增加 `prepare-stream` 动作，以 NDJSON 流持续返回 `progress / result / error` 事件，并关闭代理缓冲 | `app/api/learning-program/route.ts` |
| **修改** | 创建目标弹窗增加百分比进度条、当前阶段、最近节点和失败详情；创建期间禁止误关弹窗。界面只展示可验证的工作流节点与产物进度，不暴露模型内部推理原文 | `app/dashboard-client.tsx`、`app/globals.css` |
| **新增** | 端到端冒烟测试覆盖流式诊断分支，并断言能力地图、诊断节点、单调递增百分比和最终 100% 结果 | `scripts/learning-program-smoke.mjs` |

验证结果：`typecheck`、`lint`、`db:validate`、Next.js 生产构建均通过；隔离 SQLite 端到端回归返回 `ok: true`，进度节点为 `load_goal → skill_map → diagnostic → persist`，百分比单调递增并以 `100%` 结束。临时测试数据库已删除。

### 2026-08-27 · 初始诊断可见性与多目标课程切换（已实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修复** | 浏览器宽度小于 820px 时不再误进入尚未接入诊断弹层的旧移动壳；当前阶段浏览器统一使用桌面闭环，移动端继续暂停开发 | `app/dashboard-client.tsx` |
| **修复** | 一知半解/小有所成目标创建后，诊断弹层使用最高层级展示；目标卡片同步显示「待初始诊断 / 开始诊断」，关闭弹层后仍有明确恢复入口 | `app/dashboard-client.tsx`、`app/globals.css` |
| **修改** | 创建目标或准备学习路径失败时展示服务端具体错误，不再只显示“没有任何提示”的泛化结果 | `app/dashboard-client.tsx` |
| **新增** | 仪表盘为每个目标返回 `selfLevel`、`diagnosticStatus`、活动 `learningProgramId`；课程页增加学习目标切换栏，可在多门课程之间立即切换，也可从课程页恢复待完成诊断 | `lib/db/dashboard.ts`、`lib/demo-data.ts`、`app/learning-studio.tsx` |
| **修改** | 按用户要求对本地账号执行一次性学习目标重置：删除 4 个历史目标、3 个关联引导任务和 8 条关联 Agent 调用，并由外键级联清理课程、能力和诊断数据；其他账号和学习记录未动 | 本地 `data/growth-loop.sqlite`，不属于源码提交 |
| **新增** | 闭环测试增加多目标断言，确认同一账号下诊断目标与初学者目标都返回独立课程切换信息 | `scripts/learning-program-smoke.mjs` |

验证结果：`typecheck`、`lint`、Next.js 生产构建均通过；隔离 SQLite 端到端回归返回 `ok: true`、`switchableGoals: 2`。临时测试数据库已删除。

### 2026-08-27 · V0.4.2 诊断证据驱动最小闭环（已实现）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 创建目标必须选择「初学者 / 一知半解 / 小有所成」；初学者直接进入首课，后两档分别进入 5 / 8 题初始诊断 | `app/dashboard-client.tsx`、`app/api/goals/route.ts` |
| **新增** | Planner 只拆能力和课程骨架，Tutor 负责当前课正文、巩固题与形成性评分，Examiner 只接收目标能力与诊断蓝图，不读取日常学习背景 | `lib/agents/`、`lib/learning-loop/service.ts` |
| **新增** | 能力点与未知基线真实写入 `goal_skills` / `skill_mastery`；`confidence = 0` 表示尚无证据，不把占位 0 当作一次零分 | `lib/db/learning-loop.ts` |
| **新增** | 诊断题、固定答案/rubric 快照、答案、逐能力得分和基线结论持久化；重复准备复用活动诊断，重复提交已完成诊断回放同一结果 | `app/api/diagnostics/route.ts`、`lib/db/learning-loop.ts` |
| **修改** | 课程先保存完整 3–5 节路线，但只生成第一节正文与 3 道巩固题；其余章节为 `planned`，上一节通过后按最新掌握度和难度生成下一节 | `lib/learning-loop/service.ts`、`lib/db/programs.ts`、`app/learning-studio.tsx` |
| **修改** | 课后评分、掌握度更新、章节通过、课程任务完成、目标进度与下一课解锁放进同一个 SQLite 事务；普通任务 PATCH 遇到课程任务返回 409 | `lib/db/programs.ts`、`app/api/tasks/[id]/route.ts` |
| **新增** | 数据库升级到 V4，为课节增加 `generation_mode`、`generation_status`、`difficulty`，同时记录角色调用的 provider、model、Token 与耗时 | `lib/db/schema.ts`、`lib/db/learning-loop.ts` |
| **修改** | `LLM_PROVIDER=demo/rules/local` 明确关闭外部模型并使用本地规则回退，便于无 Key 运行和确定性回归 | `lib/agents/shared.ts`、`lib/learning-program/service.ts` |
| **新增** | 闭环冒烟测试覆盖：诊断门禁与幂等、初学者分支、首课按需生成、参考答案隔离、课程任务防绕过、评测证据更新、下一课生成 | `scripts/learning-program-smoke.mjs` |
| **暂未实现** | LangGraph checkpoint / interrupt、Pydantic AI Python 服务、导师不合格后的专门补课循环、阶段大考/模拟面试/毕业门禁 | V0.4.5–V0.5 |

验证结果：`typecheck`、`lint`、`db:validate`、Next.js 生产构建全部通过；在独立 SQLite 数据库上完成多次端到端回归，最终结果为 `ok: true`，诊断 100 分、首节形成性评测 85 分、尝试次数按 1 → 2 递增、关联任务自动完成、第二节难度上调并由 `planned` 转为 `ready`。临时数据库已删除，未污染日常数据。

### 2026-08-27 · V0.4.2 初始诊断前置（方案修订记录）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修改** | V0.4.2 不再按“默认初学者、掌握度为 0、立即生成整套课程”推进；改为创建目标时必选三档基础，先拆能力，再决定是否进入诊断 | `docs/IMPLEMENTATION_PLAN_V042.md` |
| **修改** | `familiar`、`intermediate` 必须完成 5–8 道初始诊断题，诊断完成是课程生成门禁；`beginner` 可跳过，但 `confidence = 0` 只表示尚无证据 | `docs/IMPLEMENTATION_PLAN_V042.md` |
| **修改** | 课程在基线确定后只生成完整骨架与第一节内容，后续章节在上一节产生评测证据后按需生成，使难度调整真正影响未来题目 | `docs/IMPLEMENTATION_PLAN_V042.md` |
| **修改** | V0.4.2 使用数据库状态和幂等 API 实现诊断暂停/恢复，不提前引入 LangGraph；按修订路线在 V0.4.5 再迁移到 `interrupt` 与 checkpoint | `docs/IMPLEMENTATION_PLAN_V042.md` |
| **修改** | 明确评分证据、章节通过和关联任务完成必须由 Next.js 在同一事务中处理，课程任务不能通过普通 PATCH 绕过评测门禁 | `docs/IMPLEMENTATION_PLAN_V042.md` |
| **修改** | 同步收紧 Roles 与 V1 契约：盲评不再宣称绝对确定性；角色共享 policy、不同操作使用独立 prompt；题目绑定 `skillId` 和 `maxScore`；权威学习状态在 Next.js 事务内计算 | `docs/AGENT_ROLES.md`、`docs/IMPLEMENTATION_PLAN_V1.md` |
| **修改** | 重新划分考核职责：导师根据实际教学内容负责课内巩固题、课后小测和补充讲解；考官/面试官只负责初始诊断、阶段大考、模拟面试与毕业门禁，两类证据分开解释 | `docs/IMPLEMENTATION_PLAN_V042.md`、`docs/AGENT_ROLES.md`、`docs/IMPLEMENTATION_PLAN_V1.md` |
| **修改** | 本节保留为当时的方案修订记录；实际落地情况以上方「V0.4.2 诊断证据驱动最小闭环」为准 | 当前实现 |

### 2026-08-27 · 目标周期可编辑与数据库 V3（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修改** | 创建目标的「大致周期」和「每周投入」由写死的下拉改为日期选择器和 1–40 小时输入框 | `app/dashboard-client.tsx` |
| **新增** | `goals.target_date` 保存可计算的目标日期（可为 NULL 表示不设期限）；`horizon` 改为由它在服务端派生，不再由客户端提交 | `lib/db/schema.ts`、`lib/goal-schedule.ts`、`app/api/goals/route.ts` |
| **新增** | 幂等加列机制 `COLUMN_ADDITIONS`：新库走建表语句、老库走 `ALTER TABLE`，补上 `CREATE TABLE IF NOT EXISTS` 覆盖不到的新列 | `lib/db/index.ts`、`lib/db/schema.ts` |
| **修改** | 数据库版本由 2 升级到 3；`db:validate` 增加两项校验——每个待补列必须已写进建表语句，以及在模拟老库上验证 ALTER 生效且重复执行会被拒绝 | `scripts/validate-database-schema.mjs` |
| **新增** | 创建目标弹窗显示「还剩 N 周 · 约 N 小时可投入」，由代码按剩余周数 × 每周投入算出 | `lib/goal-schedule.ts`、`app/globals.css` |
| **修改** | 填了目标日期但不是将来的合法日期时返回 400，不再静默丢弃 | `app/api/goals/route.ts` |
| **暂未实现** | 规划师 Agent 的可行性审查（`estimatedHours`、`verdict`、一键采纳建议）与后续进度监督 | V0.4.2，依赖 `goal_skills` 能力拆解先落地 |

### 2026-08-27 · 项目亮点与量化账本（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 建立持续更新的项目亮点文档，区分当前可证明成果、未来能力、关键风险和简历表述 | `项目亮点.MD` |
| **新增** | 定义有效完成率、学习增益、规划命中率、结构化输出成功率、工作流恢复率、Token 成本和 P95 延迟等量化口径 | `项目亮点.MD` |

### 2026-08-26 · V0.4.1 课程数据持久化（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修改** | 课程正文的唯一来源改为服务端数据库；浏览器只缓存当前 `programId`，清缓存或换设备后课程与进度仍可恢复 | `lib/db/programs.ts`、`app/learning-studio.tsx` |
| **修改** | `/api/learning-program` 的 `tutor` 与 `grade` 改为 `programId + lessonId` 入参，请求体不再携带课程正文，移除 180KB 上限 | `app/api/learning-program/route.ts` |
| **修复** | 参考答案与评分 rubric 不再下发到客户端，评分只读取服务端持有的固定快照 | `lib/db/programs.ts`、`lib/learning-program/types.ts` |
| **新增** | 每节课后题增加 `referenceAnswer`，与 rubric 一起随课程落库 | `lib/learning-program/service.ts` |
| **修改** | `POST /api/goals` 增收 `selfLevel`、`weeklyHours` 和 `background`，与 `goals` 同事务写入 | `lib/db/goals.ts`、`app/api/goals/route.ts` |
| **修改** | `generate` 只接收 `goalId`，主题与每周投入从目标和自评档案读取，落库后返回 `programId` | `app/api/learning-program/route.ts` |
| **修改** | 课程任务改用 `task_lesson_links` 关联，替换原先的按标题匹配和 `course-` 前缀 id | `app/api/tasks/route.ts`、`lib/db/dashboard.ts` |
| **新增** | 课后评分写入 `lesson_assessment_attempts`，重测让 `attempt_number` 递增，不覆盖历史尝试；合格后章节状态落库为 `passed` | `lib/db/programs.ts` |
| **新增** | `GET /api/learning-program?program=current|<programId>` 读取登录用户的课程正文 | `app/api/learning-program/route.ts` |
| **暂未实现** | 三档自评控件、诊断分支和 `goal_skills` / `skill_mastery` 写入 | V0.4.2 |

实施顺序与完成标准见 [V0.4.1 交接说明](docs/HANDOFF_V041.md)。

### 2026-08-26 · 学习闭环数据库 V2（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 目标自评档案：初学者、一知半解、小有所成，以及诊断状态和基线结果 | `goal_learning_profiles` |
| **新增** | 能力拆解和用户掌握度，支持后续按能力权重计算目标进度 | `goal_skills`、`skill_mastery` |
| **新增** | 课程、模块、课节及正式任务课程关联，准备替换 localStorage 和标题匹配 | `learning_programs`、`course_modules`、`course_lessons`、`task_lesson_links` |
| **新增** | LLM 诊断题快照、诊断尝试和课后考核历史，保留每次答案与评分 | `diagnostic_*`、`lesson_assessment_attempts` |
| **新增** | LangGraph 工作流索引和 Agent 调用记录，包括模型、Token、耗时与错误 | `workflow_runs`、`agent_runs` |
| **新增** | 内存 SQLite schema 校验命令 `npm.cmd run db:validate` | `scripts/validate-database-schema.mjs` |
| **修改** | 数据库版本由 1 升级到 2；现有 SQLite 启动时使用 `CREATE TABLE IF NOT EXISTS` 增量建表 | `lib/db/schema.ts` |
| **暂未实现** | 新表已创建，但创建目标 API、自评页面、诊断工作流和 Python Agent 服务尚未接入 | V0.4.1–V0.4.3 |

题库生成、LangGraph 分支、Pydantic AI 节点契约和分阶段实施顺序见 [V1 实施方案](docs/IMPLEMENTATION_PLAN_V1.md)。

### 2026-08-26 · 桌面端信息架构与学习闭环（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修改** | 桌面端统一为“导航栏 + 主内容”的两栏结构，移除所有页面右侧信息栏 | `app/dashboard-client.tsx`、`app/globals.css` |
| **修改** | 保留原项目 `Manrope`、`Noto Serif SC`、`DM Mono` 字体栈及既有字号尺度；本轮只调整结构和交互 | `app/globals.css` |
| **修改** | 计划、课程、记录、成长页移除与顶部大标题重复的页内标题，只保留一层页面标题 | `app/dashboard-client.tsx`、`app/learning-studio.tsx` |
| **新增** | 今日页按 05:00–18:59 / 19:00–04:59 自动展示白天或晚上内容，同时允许手动切换 | `app/dashboard-client.tsx` |
| **新增** | “随手一记”改为按钮和弹窗输入，不再长期占据今日页 | `app/dashboard-client.tsx`、`app/globals.css` |
| **修改** | 今日任务点击后进入课程；课程答题达到 60 分才自动完成关联任务，结果分为不合格、合格、良、优 | `app/dashboard-client.tsx`、`app/learning-studio.tsx` |
| **新增** | 从课程加入今日计划的任务写入数据库，刷新后仍保留 | `POST /api/tasks` |
| **修改** | 计划页只保留互斥的“本周任务 / 长期任务”视图，并用时间线展示任务路径 | `app/dashboard-client.tsx`、`app/globals.css` |
| **新增** | 计划页可以创建长期目标并写入数据库 | `POST /api/goals` |
| **修改** | 课程目标表单合并到“创建目标”：同时收集完成标准、当前基础和每周投入，创建目标后直接生成并进入课程 | `app/dashboard-client.tsx`、`app/learning-studio.tsx` |
| **修改** | 记录页默认展开今天、折叠更早记录；成长页移除单纯等级指标，改为行动、投入和掌握证据 | `app/dashboard-client.tsx` |
| **暂未实现** | 课程内容和评分仍保存在当前浏览器 localStorage；数据库任务与课程的正式关系表、多端同步以后补充 | 后续课程持久化版本 |

本次验证通过 `typecheck`、`lint` 和生产构建；另在隔离 SQLite 数据库中完成桌面端页面回归，确认两栏布局、原字体/字号、昼夜切换、随手一记弹窗、计划切换、创建目标弹窗和任务跳转课程均正常。隔离测试数据已删除。

### 2026-08-26 · 数据库与账号系统（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **新增** | 使用 username 和密码注册、登录、退出，不再依赖邮箱 | `app/login/`、`app/api/auth/` |
| **新增** | 密码属于 User，但仅保存经过 scrypt 处理的 `password_hash`，不保存明文 | `lib/auth/password.ts`、`lib/db/schema.ts` |
| **新增** | 数据库 Session 和 HttpOnly Cookie；默认会话有效期为 30 天 | `lib/auth/session.ts`、`sessions` 表 |
| **新增** | SQLite 用户数据层及迁移机制 | `lib/db/`、`data/growth-loop.sqlite` |
| **新增** | 首批表：`users`、`sessions`、`goals`、`tasks`、`activity_logs`、`ledger_entries` | `lib/db/schema.ts` |
| **修改** | 首页改为受保护页面；未登录访问 `/` 会跳转到 `/login` | `app/page.tsx` |
| **修改** | 工作台从数据库读取当前用户、目标、任务、记录、积分和近七天统计 | `/api/dashboard`、`lib/db/dashboard.ts` |
| **修改** | 任务完成状态、学习记录、XP、Coin 和连续有效行动天数刷新后仍会保留 | `/api/tasks/[id]`、`/api/activity-logs` |
| **修改** | 桌面端与移动端均提供退出登录入口 | `app/dashboard-client.tsx`、`app/mobile-shell.tsx` |
| **修改** | `.env.example` 增加 SQLite 路径和本地 HTTP Cookie 配置；数据库文件不提交 Git | `.env.example`、`.gitignore` |
| **暂未实现** | LLM 可以提出目标进度，但“服务端校验后写入 `goals.progress_percent`”尚未接入 | 后续目标进度接口 |

本次端到端验证覆盖：创建账号、账号密码登录、退出、未登录访问保护、任务状态持久化、学习记录持久化、积分流水和连续行动天数更新。验收使用的临时账号及数据已删除。

### 2026-08-26 · fork 功能兼容迁移（未发布）

| 标记 | 改动 | 主要位置 |
|---|---|---|
| **修改** | 将数据库与账号功能迁入个人 fork，同时保留 fork 已有的 AI 学习程序 | `app/dashboard-client.tsx`、`app/mobile-shell.tsx` |
| **修改** | 登录后的桌面端和移动端继续提供“课程”入口，课程可加入今日计划 | `app/learning-studio.tsx`、`/api/learning-program` |
| **修复** | 避免直接覆盖 fork 中已经修改的 README、页面、移动端外壳和样式 | 三方合并迁移 |
| **修复** | 排除 IntelliJ IDEA 的本机项目配置，避免误提交 `.idea` | `.gitignore` |

## 现在能做什么

| 能力 | 当前实现 | 入口 |
|---|---|---|
| 本地账号 | username 注册/登录、密码哈希、数据库会话、用户数据隔离 | `/login`、`/api/auth/*` |
| 今日昼夜工作台 | 白天看今日任务和随手一记，晚上看完成情况并进行三问收束 | 首页 |
| 学习闭环 | 目标能力拆解 → 可选初始诊断 → 首课 → 导师形成性评测 → 原子更新掌握度/任务 → 按需生成下一课 | `/api/diagnostics`、`/api/learning-program`、课程页 |
| AI 学习程序 | 保存完整路线但逐节生成内容；每节包含导师讲解、练习、交付物和 3 道巩固题，合格后才解锁并生成下一节 | `/api/learning-program`、`POST /api/tasks`、课程页 |
| 目标与计划 | 创建长期目标时必选三档基础；未完成诊断可从目标卡片继续；支持本周/长期视图、任务时间线和目标拆解 | `/api/goals`、`/api/learning-program`、计划页 |
| 成长记录 | 学习记录、连续有效行动、XP 与 Coin 流水持久化 | `/api/activity-logs`、记录页/成长页 |
| 晚间回顾 | 统一总结当天记录，并依次追问最重要行动、真正理解和明日一步 | 首页晚报入口、Agent `review` 意图 |
| 微信入口 | 微信公众号首次验证、明文 XML 文本回调、签名校验、LLM 超时回退 | `/api/wechat` |
| Android App | 独立移动壳 v4；首页一屏 AI 会面，不堆功能、不产生首页纵向滚动 | `android/`、APK |
| 可复现调试 | doctor、build、install、run、smoke、logs；面向人和 AI | `scripts/debug-apk.ps1` |

## 产品形态

今日页按时间自动收纳内容。白天只显示今天要做的事和“随手一记”按钮；点击任务进入对应课程。晚上显示同款完成情况卡片和三问每日收束，不再同时堆叠白天与晚上的全部模块。

桌面端使用“导航栏 + 主内容”两栏结构，计划、课程、记录、成长保持独立入口，并且每页只保留顶部的一层大标题。计划页把本周任务和长期任务分开显示，创建目标时一并收集课程编排信息；课程页只负责学习和评测，不再重复创建目标。记录页默认展开今天并折叠更早记录；成长页只展示可验证的行动、投入和掌握证据。

当用户有一个明确学习目标时，可从“课程”工作台（手机端位于“路线”的二级入口）进入 AI 学习程序。它不是一张静态课表：先由模型为主题编排教学骨架，再补成可执行的章节内容；每节都可向 AI 讲师追问、完成开放题并得到逐题反馈。课程正文、参考答案和每次评测记录都保存在服务端数据库，浏览器只缓存当前课程 ID，因此清空缓存或换设备重新登录后仍能继续学习；但它还不是多端实时同步或正式学习档案。

```mermaid
flowchart LR
  User[用户] --> Home[今日首页 / 微信对话]
  Home --> Agent[/api/agent]
  Agent --> Parse[规则解析与会话状态]
  Agent --> Model[可选 OpenAI-compatible LLM]
  Home --> Quiz[/api/quiz]
  Quiz --> Model
  Home --> Course[/api/learning-program]
  Course --> Model
  WeChat[微信公众号] --> WechatAPI[/api/wechat]
  WechatAPI --> Agent
  Home --> Demo[/api/demo]
  Demo --> Seed[确定性 demo 数据]
```

## 快速开始

### 环境要求

- Node.js 22 或更高版本（Android WebView CDP smoke 需要 Node 22 的 `WebSocket` 全局对象）
- npm
- Windows PowerShell（Android 电脑模拟器脚本按 Windows 环境编写）
- Android 调试需要本机 Android SDK、AVD 和 Java 21；详见 [Android 构建说明](docs/ANDROID_BUILD.md)

### 本地 Web

```powershell
git clone https://github.com/redmaplewww/growth-loop-agent.git
Set-Location growth-loop-agent
npm.cmd install
Copy-Item -LiteralPath .env.example -Destination .env.local
npm.cmd run dev
```

打开 [http://127.0.0.1:3000/login](http://127.0.0.1:3000/login)，先创建本地账号。默认 `LLM_PROVIDER=demo`，不需要 API Key；新账号会初始化一个入门目标和三项入门行动。生产式本地回归可以使用：

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000
```

网页必须通过 Next.js 服务访问，不能直接双击 HTML 或部署到纯静态托管。第一次在另一台电脑配置服务，请先看 [网页服务配置手册](docs/WEB_SERVICE_SETUP.md)。

### 检查项目

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
# 有受管 LLM 配置时，实际生成一门 Agent 课程并完成讲师追问、课后评分
npm.cmd run learning:smoke -- --require-llm
```

## 配置 LLM

服务端通过 OpenAI-compatible `/chat/completions` 调用模型。没有完整配置时，Agent 和测验会自动回退到本地规则，不会因为模型不可用阻塞页面或微信文本回复。

复制 `.env.example` 为 `.env.local` 后，按实际供应商填写以下变量：

```dotenv
LLM_PROVIDER=demo
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

也支持按 provider 读取对应变量，例如 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，以及 `OPENAI_*`、`GLM_*`。密钥只放在本机环境变量、部署平台 Secret 或受管配置工具中，不能提交到 GitHub。

服务状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/agent
```

返回值只包含模式、供应商和是否配置 endpoint/model 等非敏感状态，不返回 API Key。

## API 速查

### 账号与用户数据

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` | 使用 username、password 和可选 displayName 创建账号 |
| `POST` | `/api/auth/login` | 使用 username 和 password 登录 |
| `POST` | `/api/auth/logout` | 删除当前数据库会话并清除 Cookie |
| `GET` | `/api/auth/me` | 获取当前登录用户的非敏感信息 |
| `GET` | `/api/dashboard` | 获取当前用户的目标、任务、记录、积分和统计 |
| `POST` | `/api/goals` | 创建当前用户的长期目标；接收 `title`、`description`、可选 `targetDate`（`YYYY-MM-DD`，须为将来日期）、`weeklyHours`（1–40）、`background` 和 `selfLevel`，同事务写入 `goals` 与 `goal_learning_profiles` |
| `POST` | `/api/tasks` | 创建当前用户任务；传 `lessonId` 时按课程章节建任务并写入 `task_lesson_links` |
| `PATCH` | `/api/tasks/[id]` | 切换当前用户所属任务的完成状态 |
| `POST` | `/api/activity-logs` | 调用 Agent 整理输入，并保存行动记录和奖励流水 |

SQLite 默认保存在 `data/growth-loop.sqlite`。可通过 `.env.local` 中的 `SQLITE_DATABASE_PATH` 修改位置。数据库文件、WAL 和 SHM 文件均已加入 Git 忽略。

### Agent 对话

```powershell
$body = @{
  message = '今天学习了 Agent 的工具调用，终于理解它和普通聊天的区别'
  conversationId = 'demo-user'
  context = '当前路线：学习 Agent 并开发自己的 Agent'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/api/agent `
  -ContentType 'application/json' `
  -Body $body
```

`POST /api/agent` 接收 `message`（必填）、`conversationId`、`output`、`context`。返回 `reply`、`intent`、`extracted`、`mode`、`provider` 和 `replySource`。`GET /api/agent` 返回当前非敏感配置状态。

### 理解测验

生成题目：

```powershell
$body = @{
  action = 'generate'
  topic = 'Agent 工具调用'
  content = 'Agent 会先理解目标，再选择工具并根据结果继续行动。'
  output = '我理解了工具调用是让模型连接外部能力的桥梁。'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/quiz -ContentType 'application/json' -Body $body
```

评分时提交 `action=grade`、原题目、学习底稿和 `answers`。如果模型已配置，返回 `gradedBy=llm`；否则返回 `gradedBy=rules`，并明确给出回看建议。

### AI 学习程序

课程状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/learning-program
```

生成课程、AI 讲师追问和课后评分都通过同一条 API 的 `generate`、`tutor`、`grade` 动作完成，三者都需要登录：`generate` 只接收 `goalId`，`tutor` 和 `grade` 只接收 `programId + lessonId`，请求体中不出现课程正文。登录后可用 `GET /api/learning-program?program=current` 读回当前课程。默认的 Agent 示例会生成 5 节课程，每节含讲解、练习、交付物和 3 道开放题。完整调用契约、回退语义与实际 LLM 回归命令见 [AI 学习程序说明](docs/LEARNING_PROGRAM.md)。

### Demo 数据

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/demo
```

该接口继续提供确定性 seed，主要用于无账号 demo 和原型验收。登录后的工作台数据以 `/api/dashboard` 和 SQLite 为准，不再把 `/api/demo` 当作真实用户数据层。

## 微信公众号接入

当前实现的是“服务端回调 + 明文文本模式”，不是小程序登录或微信支付。配置步骤：

1. 准备公网 HTTPS 域名和可访问的 Next.js 部署。
2. 在部署 Secret 中配置 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_TOKEN`。
3. 微信公众平台服务器地址填写 `https://你的域名/api/wechat`。
4. 选择明文模式，完成首次 GET 签名验证。
5. 用文本消息 POST 回归；模型超时会自动使用本地回退话术。

详细签名规则、XML 字段、状态接口和当前边界见 [微信公众号接入说明](docs/WECHAT_INTEGRATION.md)。当前 MVP 未启用安全模式/兼容模式的密文解密，正式上线前必须补齐加密回调、重放保护、限流和生产监控。

## Android APK

当前仓库已包含 Android 工程和 debug APK：

- 工程：[android/](android/)
- APK：[artifacts/android/growth-loop-debug.apk](artifacts/android/growth-loop-debug.apk)
- 电脑浏览器：`http://127.0.0.1:3000/`
- Android Emulator：`http://10.0.2.2:3000/`

启动本地服务后，在项目根目录执行：

```powershell
npm.cmd run android:debug   # build + sync + Gradle + install + launch
npm.cmd run android:run     # 使用现有 APK 安装并启动
npm.cmd run android:status
npm.cmd run android:stop
```

面向 AI 的完整调试顺序：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action doctor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action run -Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action smoke
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/debug-apk.ps1 -Action logs
```

详见 [Android APK 调试手册](docs/ANDROID_APK_DEBUG_AI.md) 和 [Android 移动端产品设计](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md)。APK 是 debug 签名，并默认从电脑模拟器读取远程 Next.js 服务；正式发布还需要 HTTPS、release keystore、AAB、真机回归和隐私合规。

## 文档地图

| 文档 | 内容 |
|---|---|
| [项目亮点与量化记录](项目亮点.MD) | 当前可证明成果、后续差异化能力、量化指标与简历表述账本 |
| [开发者与 AI 手册](docs/DEVELOPER_HANDBOOK.md) | 从 clone、配置、开发、测试到发布的完整交接手册 |
| [网页服务配置](docs/WEB_SERVICE_SETUP.md) | 从干净 clone、环境变量到 Web/Node 服务验收；解释静态托管、API 和 Android 地址边界 |
| [公网 Demo 部署](docs/DEMO_DEPLOYMENT.md) | Zeabur GitHub 部署、SQLite 持久化、LLM Secret、验收步骤与邀请测试边界 |
| [AI 学习程序](docs/LEARNING_PROGRAM.md) | 通用课程编排、AI 讲师、课后评分、API 契约与 LLM smoke |
| [V1 实施方案](docs/IMPLEMENTATION_PLAN_V1.md) | 教学质量优先总路线、可信来源、框架迁移与正式考核的版本边界 |
| [V0.4.2 实施方案](docs/IMPLEMENTATION_PLAN_V042.md) | 诊断证据驱动的最小学习闭环：能力拆解、初始诊断、按需生成课程、盲评与掌握度回边 |
| [V0.4.3 实施方案](docs/IMPLEMENTATION_PLAN_V043.md) | 结构化课程内容引擎、教学质量门禁、题目追溯，以及基础课件阅读器与待完成交互边界 |
| [V0.4.4 实施方案](docs/IMPLEMENTATION_PLAN_V044.md) | 私有资料导入、Schema V8、FTS5 检索、块级/题目级来源快照与 RAG 验收标准 |
| [Agent 角色与信息边界](docs/AGENT_ROLES.md) | 规划员/导师/考官/复盘员的职责、能看到什么、输出契约与复用矩阵 |
| [产品设计方案](docs/PRODUCT_DESIGN_V1.md) | 产品目标、用户闭环、Agent、游戏化和微信路线 |
| [微信公众号接入](docs/WECHAT_INTEGRATION.md) | 微信服务器配置、签名校验和文本回调 |
| [Android 构建](docs/ANDROID_BUILD.md) | SDK、AVD、Capacitor 和 Android Studio |
| [Android APK 调试](docs/ANDROID_APK_DEBUG_AI.md) | doctor/build/install/run/smoke/logs 调试链路 |
| [移动端产品设计](docs/ANDROID_MOBILE_PRODUCT_DESIGN.md) | 一屏 AI 首页、底部导航和移动交互约束 |
| [.project-to-act](.project-to-act/PROJECT_OVERVIEW.md) | 项目目标、范围、进度、版本和验收证据 |

## 数据、安全与发布边界

- 已有 SQLite 数据库和基于 Session 的本地多用户隔离；当前仍没有后台定时任务、数据导出、忘记密码或管理员系统。
- 密码字段保存在 `users.password_hash`，使用 scrypt 加盐处理；任何代码和文档都不得记录用户明文密码。
- `action_streak_days` 表示连续产生有效行动记录的天数，不是单纯点击按钮的签到天数。
- `goals.progress_percent` 已持久化；LLM 自动调整进度仍需增加服务端范围、证据和变化幅度校验。
- LLM 只负责理解、建议、出题和评分；任务、XP、积分等写操作应继续由规则和受控服务端处理。
- 不要提交 `.env.local`、API Key、微信 Token、`android/local.properties`、Android build 目录、模拟器镜像或本机 SDK 路径。
- 微信回调当前只支持明文文本；不要在未补齐加密、重放保护、限流和审计前接收生产敏感消息。
- 仓库目前没有单独的开源许可证文件；如需对外允许复用，请先补充许可证和第三方依赖声明。

## 常见问题

| 现象 | 处理 |
|---|---|
| 电脑能打开，APK 打不开 | 确认 Next 服务监听 `127.0.0.1:3000`，APK 使用的是 `10.0.2.2:3000`；先跑 `doctor` |
| 页面显示旧版本 | 重启 `next start` 或重新执行 `npm.cmd run dev`，再重新打开 APK；当前 APK 默认加载远程页面 |
| `smoke` 找不到页面 | 确认应用已启动、ADB 设备为 `device`，然后重新执行 `run` 再 `smoke` |
| LLM 没有返回 | 查看 `/api/agent` 状态和环境变量；没有完整配置时预期会走 demo/rules 回退 |
| 微信首次验证失败 | 检查公网 HTTPS、`WECHAT_TOKEN`、服务器 URL 和服务器时间；不要把 token 写进源码 |
| Android ADB `offline` | `npm.cmd run android:stop` 后重新 `npm.cmd run android:debug`，必要时重启 adb server |

## 贡献与提交

1. 从 `main` 创建短分支，修改前先阅读 `AGENTS.md` 和相关 `.project-to-act` 文档。
2. 只提交本次任务范围内的文件，避免把密钥、构建产物和模拟器缓存带入提交。
3. 至少运行 `typecheck`、`lint`、`build`；涉及 Android 时再运行 `android:debug`、`doctor`、`smoke`、`logs`。
4. 每次功能、接口、数据库结构或运行方式发生变化，都要在 README 的“变更记录”中标注 `新增`、`修改`、`修复` 或 `暂未实现`。
5. 提交信息说明意图，PR 描述列出变更、验证命令和已知边界。

## 当前版本

`0.2.0-prototype` · Android 移动壳 v4 · 已加入本地 SQLite、username 账号、数据库 Session 与首批用户数据持久化。生产级数据库、后台调度、微信加密模式、release 签名和真实用户验收属于后续版本范围。
