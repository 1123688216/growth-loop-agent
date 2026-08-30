# V0.4.3 实施方案：通用课程内容引擎与教学质量门禁

> 状态：**核心工程 MVP 与基础课件阅读器已实现；高级课堂交互、真实模型性能优化与人工质量评测待继续**  
> 更新日期：2026-08-30  
> 适用范围：桌面端 Web；移动端继续暂停  
> 上游约束：[V1 实施方案](IMPLEMENTATION_PLAN_V1.md)、[V0.4.2 当前实现基线](IMPLEMENTATION_PLAN_V042.md)、[Agent 角色与信息边界](AGENT_ROLES.md)

## 0. 2026-08-30 实现快照

本轮已经把本文的核心契约落到现有 Next.js 工作流中：动态 3–12 节路线、六类能力、结构化教学块、双层质量门禁、最多两次定向修复、失败可见、内容版本、题目到教学块追溯、旧课兼容读取和数据库 V6 均已实现。移动端、RAG、Pydantic AI、LangGraph、阶段大考仍保持在本版本范围外。

与设计稿相比有两个需要明确的实现边界：

1. 当前仍以“一次调用生成整节结构化正文”为主，尚未拆成按块后台生成。真实模型实测单节正文可达约 108–116 秒，完整质量链在进入修复时可能接近 5 分钟；因此本轮证明了契约和门禁可运行，但没有解决生产级响应时延。
2. 未配置 LLM 时保留显式的“本地演示”课程，标记为 `unverified`；配置 LLM 后，通用回退若被语义复核判定不具体，会进入 `quality_failed`，不会伪装成 AI 正式课程。

自动回归已覆盖 Java 并发、技术分享演讲和中国近代史辨析，验证三种不同能力/练习策略；尚未进行真实学习者对照实验，因此不能宣称学习效率或成绩提升。

2026-08-30 已落地 **V0.4.3.1 的基础课件阅读器**：结构化新课一次只渲染一个教学块，支持页码、进度点、按钮/键盘翻页、交付物页、独立考核页，以及按 `lessonId + contentVersionId` 在浏览器恢复最后阅读页。考核页关闭导师问答，避免一边答题一边直接索要讲解。

本次实现没有把整份冻结设计冒充成已完成：当前 Tutor 请求仍只携带课节上下文，没有携带当前 `blockId`；困惑标注、重点收藏、选区校验、交互块作答、`open_book`、历史标注回放和长代码全屏仍未实现。V0.4.3 核心数据模型在数据库 V6 落地；项目后续学习作息改动已占用数据库 V7，V0.4.4 的可信来源/RAG 将使用 V8，因此本文尚未实现的课堂标注迁移统一顺延为 V9。

## 1. 版本结论

V0.4.3 只解决一个核心问题：

> **先让系统生成一节真正可学、可练、可检查的课，再基于这节课进行形成性考核。**

当前 V0.4.2 已经打通“目标 → 初始诊断 → 课程骨架 → 首课 → 小测 → 证据 → 下一课”的最小闭环，但课程正文仍可能只是围绕标题扩写的通用文本。若教学内容本身没有覆盖目标、示例、边界和练习，即使评分流程完整，得到的证据也不能说明用户真正学会了。

因此 V0.4.3 的交付物不是更多 Agent，也不是框架迁移，而是：

1. 一套通用能力分类和教学策略；
2. 一套结构化课程内容契约；
3. 一套可复核的课程质量门禁；
4. 一套“题目必须能追溯到已教学内容”的形成性考核契约；
5. 一套版本化、可回放、可统计的课程内容数据；
6. 一组能证明“比旧课程更具体、更完整、更可考”的固定回归样例。

V0.4.3 **不引入 LangGraph、Pydantic AI、RAG、联网搜索、阶段大考或毕业门禁**。这些能力分别放在 V0.4.4、V0.4.5 和 V0.5，避免在教学质量尚未稳定时同时更换知识来源、运行框架和考核体系。

---

## 2. 当前问题与根因

### 2.1 当前课程“有流程、缺教学”

现有课程可以按周期生成若干章节，但章节正文容易出现以下问题：

- 标题具体，正文却是通用建议；
- 解释了“是什么”，没有解释“为什么”和“什么时候不适用”；
- 没有完整例子，或例子无法迁移到用户目标；
- 没有引导练习和独立练习；
- 题目只围绕章节标题生成，无法证明正文真的教过；
- LLM 失败后使用看似正常的本地模板，使前端误以为课程已生成成功；
- 不同目标周期可能仍得到近似数量、近似深度的课程。

### 2.2 根因之一：缺少结构，扩写 Prompt 解决不了

单纯扩写 Tutor Prompt 无法形成稳定质量，因为当前缺少：

- 明确的教学输入；
- 结构化的教学产物；
- 按能力类型选择教学方法的规则；
- 生成后的确定性检查；
- 独立于生成者的语义复核；
- 失败状态与定向修复流程；
- 题目到教学块的追溯关系；
- 内容版本和质量报告。

V0.4.3 要把“写一段课程正文”改造成“生成、检查、修复、发布一份结构化课程资产”。

### 2.3 根因之二：单次调用已经贴着超时闸门（2026-08-30 实测）

上面的结构问题是真的，但它不是当前静默回退的直接原因。用 `npm.cmd run learning:probe` 跨六个主题实测 `agent_runs`：

| 观测项 | 数值 |
|---|---|
| 出题单次调用耗时中位数 | 约 36 s |
| 成功调用的最慢一次 | 约 57 s |
| 超时闸门（`LLM_TIMEOUT_MS`） | 60 s |
| 回退中由超时造成的比例 | 100 %（`timeout_60000ms`） |
| 同一批次里 `build_skill_map` 耗时 | 4–20 s，从未回退 |

**闸门设在了耗时分布的正中间。** 回退与主题难度无关——同一个主题在不同批次里时而成功时而超时；Planner 因为输出小所以从不回退，Examiner 因为要同时产出题干、提示、参考答案和 rubric 而贴边。

这对本版本有直接影响：`LessonContentOutput` 要求一次返回一组结构化教学块、证据要求和摘要，**输出规模是当前已经贴边的出题调用的数倍**。若沿用“一次调用生成整课”的形状，阶段 B 很可能得到大量超时，而现象会被误读成“模型产不出结构化内容”。

因此本版本必须同时满足两件事：

1. **按块或块组分多次生成**，让单次输出回到可完成的规模，这也正好与 §9.4 的定向修复同构——修哪块就重生成哪块；
2. **每个节点有明确的耗时预算，且失败原因可见**。`AgentResult.fallbackReason` 与 `agent_runs.error_message` 已于 2026-08-30 补上，回退原因按 `timeout_* / http_* / unparsable_json / empty_completion / validation_failed / llm_disabled` 归类；`llm_disabled` 单独标记，避免把“故意关掉模型跑规则回归”混进静默 fallback 率。

---

## 3. 目标与非目标

### 3.1 本版本目标

- 课程数量和深度由目标范围、剩余时间、每周投入、能力依赖和诊断证据共同决定，不再固定为 5 节；
- 每节课以结构化 `LearningBlock` 保存，而不是只保存一段 Markdown；
- 不同能力类型使用不同教学策略；
- 软件开发领域先提供较完整的领域策略，但底层契约保持通用；
- 每个正式发布的课程版本都必须经过质量门禁；
- 质量不合格时定向修复，达到重试上限后明确失败，不允许静默伪装成功；
- 形成性题目只能考已发布课程版本中明确教过的内容；
- 所有题目保存教学块引用、证据类型、难度和评分依据；
- 旧课程仍可读取，但不会被伪造为结构化新课程；
- 记录质量、Token、耗时、重试和人工接受率，为后续量化项目亮点准备基线。

### 3.2 本版本不做

- 不实现 PDF、Word、TXT、手动文本导入；
- 不实现向量检索、混合检索或联网搜索；
- 不宣称模型知识已经过权威来源验证；
- 不引入 FastAPI、Pydantic AI 或 LangGraph；
- 不实现阶段大考、模拟面试、毕业门禁；
- 不实现完整补课—重测循环；
- 不实现所有学科的专用策略；
- 不实现音频、图片、视频、口语发音等多模态评分；
- 不重做当前 UI 视觉体系；
- 不恢复移动端开发；
- 不用未经真实实验的数据宣称提升了学习效果。

---

## 4. 不可破坏的业务约束

1. **Planner 负责决定学什么，Tutor 负责教和进行课内形成性考核。**
2. **Examiner 只负责初始诊断及未来的阶段/毕业考核，不负责课后小测。**
3. **产品中的 Reviewer 仍负责每日/周期复盘。**课程质量复核称为 `LessonQualityReviewer`，它只是内部质量操作，不新增第五个产品角色。
4. **参考答案和 rubric 永远只保存在服务端。**浏览器只接收公开题面和提交后的必要反馈。
5. **课程任务不能通过普通任务 PATCH 绕过考核完成。**
6. **权威学习状态只由 Next.js 在数据库事务内更新。**LLM 只能返回建议和结构化产物。
7. **生成失败必须可见。**禁止把通用本地模板标记为 AI 正式课程。
8. **旧数据只做兼容读取。**不能把旧 Markdown 按标题机械切分后冒充通过质量门禁的 `LearningBlock`。
9. **V0.4.3 仍使用 TypeScript 契约。**所有函数保持节点化边界，为 V0.4.5 迁移 Pydantic AI/LangGraph 做准备，但本版本不提前迁移。

---

## 5. 端到端流程

```text
读取目标、画像、能力和诊断证据
        ↓
Planner 生成课程骨架与课时目标
        ↓
选择通用教学策略 + 可选领域策略
        ↓
Tutor 生成结构化课程版本
        ↓
确定性质量门禁
        ↓
LessonQualityReviewer 语义复核
        ↓
不合格：按失败项定向修复（最多 2 次）
        ↓
合格：发布 ready 课程版本
        ↓
Tutor 基于已发布教学块生成形成性题目
        ↓
确定性检查题目—教学块追溯关系
        ↓
用户学习、答题、评分、写入证据
        ↓
更新暂定掌握度并生成下一课
```

建议的课程生成状态：

```text
planned
  → generating
  → quality_review
  → ready

失败分支：
  → generation_failed
  → quality_failed
  → source_insufficient
```

其中 `source_insufficient` 是为 V0.4.4 预留的正式状态：只有领域策略明确要求外部可信来源但当前没有来源时才使用。普通 V0.4.3 Demo 课程可以标记为 `unverified`，不能因为没有 RAG 而全部失败。

---

## 6. 通用能力模型

课程不能默认所有学习都等同于“理解一个编程概念”。V0.4.3 先定义六种通用能力类型：

```ts
export type CapabilityType =
  | "conceptual_understanding"
  | "procedural_skill"
  | "problem_solving"
  | "expression_communication"
  | "retrieval_discrimination"
  | "integrated_creation";
```

| 能力类型 | 用户最终要证明什么 | 主要教学方法 | 主要证据 |
|---|---|---|---|
| `conceptual_understanding` | 能解释概念、关系、边界和反例 | 解释、关系图、对比、误区、边界 | 解释、辨析、概念迁移 |
| `procedural_skill` | 能按步骤独立完成操作 | 示范、引导练习、独立练习、检查表 | 过程记录、操作结果、交付物 |
| `problem_solving` | 能分析未知问题并选择方案 | 完整例题、推理过程、变式、迁移题 | 判断依据、解题过程、验证结果 |
| `expression_communication` | 能按对象和标准清晰表达 | 范例、结构、rubric、练习、反馈 | 文本、演讲稿、回答、改写 |
| `retrieval_discrimination` | 能准确回忆并区分易混内容 | 组织、对比、主动回忆、间隔复习 | 回忆题、分类题、辨析题 |
| `integrated_creation` | 能综合多个能力交付成果 | 成果定义、里程碑、示例、检查表、迭代 | 项目、作品、报告、演示 |

一个能力点必须有一个主类型，可以有多个辅助类型。例如“Java 并发安全排障”的主类型可以是 `problem_solving`，辅助类型为 `conceptual_understanding` 和 `procedural_skill`。

---

## 7. 结构化课程契约

### 7.1 课程骨架

```ts
export interface LessonOutline {
  lessonId: string;
  skillId: string;
  title: string;
  objective: string;
  capabilityType: CapabilityType;
  supportingCapabilityTypes: CapabilityType[];
  prerequisites: string[];
  estimatedMinutes: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  completionEvidence: string[];
}
```

`completionEvidence` 描述用户完成本节课后必须能展示什么，不能只写“理解”“掌握”等无法检查的动词。

### 7.2 教学块联合类型

```ts
interface LearningBlockBase {
  id: string;
  type: string;
  objectiveIds: string[];
  title?: string;
}

export type LearningBlock =
  | ExplanationBlock
  | ConceptRelationBlock
  | ComparisonBlock
  | WorkedExampleBlock
  | CaseStudyBlock
  | DemonstrationBlock
  | CommonMistakeBlock
  | BoundaryBlock
  | GuidedPracticeBlock
  | RetrievalPracticeBlock
  | ReflectionBlock
  | SummaryBlock
  | CodeLabBlock
  | SpeakingPracticeBlock;
```

通用块含义：

| 教学块 | 必须包含的核心信息 |
|---|---|
| `Explanation` | 定义、作用、因果、适用情境 |
| `ConceptRelation` | 与前置/相邻概念的关系 |
| `Comparison` | 对比维度、相同点、差异、选择条件 |
| `WorkedExample` | 明确输入、逐步推理、结果、验证 |
| `CaseStudy` | 真实感场景、约束、决策、结果 |
| `Demonstration` | 操作步骤、关键观察点、完成标准 |
| `CommonMistake` | 错误做法、为什么错、如何发现、如何修复 |
| `Boundary` | 不适用情况、例外、反例、风险 |
| `GuidedPractice` | 分步提示、检查点，不直接泄露最终答案 |
| `RetrievalPractice` | 主动回忆、辨析或短迁移，不使用纯重复阅读 |
| `Reflection` | 让用户解释选择和判断依据 |
| `Summary` | 用目标和能力组织本节结论，不复读目录 |
| `CodeLab` | 环境、初始代码、任务、约束、测试方法 |
| `SpeakingPractice` | 对象、场景、时间限制、表达标准、复盘点 |

### 7.3 课程版本输出

```ts
export type SourceStatus =
  | "unverified"
  | "partially_grounded"
  | "grounded";

export interface LessonContentOutput {
  schemaVersion: "1";
  lessonId: string;
  skillId: string;
  title: string;
  objective: string;
  capabilityType: CapabilityType;
  estimatedMinutes: number;
  blocks: LearningBlock[];
  evidenceRequirements: EvidenceRequirement[];
  sourceStatus: SourceStatus;
  sourceRefs: string[];
  modelSummary: string;
}
```

`modelSummary` 只用于课程列表和 Planner 后续规划，不能代替完整教学块。

### 7.4 教学输入

Tutor 生成正文时至少接收：

```ts
export interface LessonGenerationInput {
  goal: {
    title: string;
    description: string;
    completionCriteria: string[];
    targetDate: string | null;
    weeklyHours: number;
  };
  learner: {
    selfLevel: string;
    background: string;
    mastery: number;
    confidence: number;
  };
  skill: {
    id: string;
    name: string;
    description: string;
    capabilityType: CapabilityType;
    prerequisites: string[];
  };
  diagnosticEvidence: DiagnosticEvidenceSummary[];
  outline: LessonOutline;
  previousLessonEvidence: PreviousLessonEvidence[];
  sourceExcerpts: SourceExcerpt[];
  domainStrategy: DomainTeachingStrategy | null;
  existingCourseSummary: string;
}
```

不再允许 Tutor 只拿到“章节标题 + 难度”就生成课程。

---

## 8. 教学策略注册表

V0.4.3 使用“通用能力策略 + 可选领域策略”的两层结构。

### 8.1 通用策略

| 能力类型 | 最低必需教学块 |
|---|---|
| 概念理解 | Explanation、ConceptRelation 或 Comparison、WorkedExample、Boundary 或 CommonMistake、RetrievalPractice |
| 程序性技能 | Demonstration、GuidedPractice、独立任务、检查标准、CommonMistake |
| 问题解决 | WorkedExample、显式推理、变式、独立迁移题、验证方法 |
| 表达沟通 | 范例、结构或 rubric、GuidedPractice、独立表达、反馈标准 |
| 记忆辨析 | 组织框架、Comparison、RetrievalPractice、易混项、间隔复习提示 |
| 综合创作 | 交付物定义、里程碑、质量检查表、样例或反例、迭代任务 |

### 8.2 首个领域策略：软件开发

软件开发策略至少区分：

- **概念类**：例如事务隔离、并发安全、依赖注入；
- **操作类**：例如配置数据库、编写 API、排查日志；
- **问题解决类**：例如定位并发 Bug、分析慢查询、设计缓存；
- **项目交付类**：例如实现一个带测试和验收标准的接口。

代码课不能只给代码片段，必须包含：

- 运行前提；
- 输入和预期输出；
- 关键代码解释；
- 至少一个失败示例；
- 验证方法或测试；
- 用户要独立完成的改动。

### 8.3 通用性回归样例

为避免系统退化为“代码专用 Agent”，固定回归集至少覆盖：

1. Java 并发中的竞态条件；
2. 数据库事务隔离与排错；
3. 英文面试自我介绍；
4. 摄影曝光三要素或一个非代码概念；
5. 历史事件的因果关系与易混辨析。

---

## 9. 课程质量门禁

### 9.1 两层检查

课程发布前执行两层质量检查：

1. **确定性规则门禁**：字段、数量、引用、覆盖、状态、安全等可以由代码精确判断的规则；
2. **LessonQualityReviewer 语义复核**：检查解释是否具体、示例是否有效、难度是否适配、教学是否自洽。

语义复核是辅助，不能覆盖确定性规则的失败结论。

### 9.2 质量报告

```ts
export interface LessonQualityIssue {
  code: string;
  severity: "error" | "warning";
  blockIds: string[];
  message: string;
  repairInstruction: string;
}

export interface LessonQualityReport {
  lessonContentVersionId: string;
  deterministicPassed: boolean;
  semanticPassed: boolean;
  score: number;
  issues: LessonQualityIssue[];
  checkedAt: string;
  checkerVersion: string;
  model: string | null;
}
```

### 9.3 硬性门禁

正式 `ready` 的课程至少满足：

- 所有课程目标至少被一个教学块覆盖；
- 被考核的概念在题目前已经教学；
- 至少包含一个具有明确输入、过程和结果的具体例子；
- 至少包含一个常见错误或适用边界；
- 程序性、问题解决和综合创作类课程必须有引导练习与独立练习；
- 每个练习都能关联到课程目标；
- 课程预计时长与内容量处于合理范围；
- 不出现“请结合实际”“给出一个具体场景”等未填充模板句；
- 不出现和目标无关的通用鼓励性段落充当教学正文；
- 块 ID 唯一，目标和来源引用有效；
- 参考答案、rubric、内部质量报告未进入公开课程 DTO；
- 生成模式和来源状态已明确保存；
- 没有任何静默 fallback。

### 9.4 定向修复

质量失败后不整课盲目重写，而是把以下内容传回 Tutor：

- 原课程版本；
- 失败规则；
- 涉及的教学块；
- 修复要求；
- 禁止改动的已合格块。

最多执行 2 次定向修复。仍不合格则保存 `quality_failed`，前端显示原因和“重新生成”入口，不创建正式小测，不推进课程任务。

---

## 10. 形成性考核必须与教学内容对齐

### 10.1 题目契约

```ts
export type EvidenceType =
  | "explanation"
  | "discrimination"
  | "procedure"
  | "problem_solution"
  | "transfer"
  | "artifact";

export interface LessonCheckQuestion {
  id: string;
  lessonContentVersionId: string;
  skillId: string;
  taughtBlockIds: string[];
  evidenceType: EvidenceType;
  difficulty: 1 | 2 | 3 | 4 | 5;
  prompt: string;
  expectedConcepts: string[];
  maxScore: number;
  rubric: RubricItem[];
  referenceAnswer: string;
}
```

发给浏览器的公开类型必须移除 `rubric` 和 `referenceAnswer`。

### 10.2 出题约束

- Tutor 只能读取已发布的 `ready` 课程版本出题；
- 每题至少绑定一个 `taughtBlockId`；
- `expectedConcepts` 必须能在绑定教学块中找到；
- 题目应覆盖回忆、理解、应用或迁移，不能全部是复述；
- 题目不能考课程未讲过的专有事实；
- 题目不能直接复制示例中的数字和答案；
- 评分使用生成时固定下来的题目、答案和 rubric 快照；
- 重新生成课程后，旧题仍绑定旧课程版本，保证历史回放可复核。

### 10.3 来源状态与证据解释

V0.4.3 尚未接入 RAG，因此允许：

- `sourceStatus = unverified` 的课程进入 Demo 学习闭环；
- 其形成性评测更新“暂定掌握度”；
- UI 和数据中保留来源状态，不将结果解释为权威认证；
- 未验证证据不能在未来直接解锁阶段考试或毕业门禁。

当某个领域策略声明“必须有可信来源”而来源为空时，课程进入 `source_insufficient`，不能生成正式题目。V0.4.4 接入私有资料和联网来源后，再把证据提升为 `partially_grounded` 或 `grounded`。

---

## 11. 数据库 V6（已实现）

> 本节是实施设计，不表示当前数据库已经升级。

### 11.1 `lesson_content_versions`

每次生成或修复都创建不可变版本，不覆盖旧内容。

| 字段 | 含义 |
|---|---|
| `id` | 内容版本 ID |
| `lesson_id` | 所属课程章节 |
| `version` | 章节内递增版本号 |
| `schema_version` | 结构化契约版本 |
| `content_json` | 完整 `LessonContentOutput` |
| `status` | generating / quality_review / ready / failed |
| `source_status` | unverified / partially_grounded / grounded |
| `generation_mode` | llm / repaired / imported / legacy |
| `provider`、`model` | 生成模型快照 |
| `prompt_version` | Prompt 版本 |
| `input_hash` | 生成输入摘要，用于幂等与比较 |
| `prompt_tokens`、`completion_tokens` | Token 统计 |
| `latency_ms` | 生成耗时 |
| `created_at` | 创建时间 |

### 11.2 `lesson_quality_reports`

| 字段 | 含义 |
|---|---|
| `id` | 报告 ID |
| `lesson_content_version_id` | 被检查版本 |
| `deterministic_passed` | 硬规则是否通过 |
| `semantic_passed` | 语义复核是否通过 |
| `score` | 归一化质量分，仅用于分析 |
| `issues_json` | 失败项与修复建议 |
| `checker_version` | 规则版本 |
| `provider`、`model` | 语义复核模型，可为空 |
| `tokens`、`latency_ms` | 成本与耗时 |
| `created_at` | 检查时间 |

### 11.3 `lesson_block_sources`

V0.4.3 只预留来源引用，V0.4.4 再实现完整资料、分块和检索表。

| 字段 | 含义 |
|---|---|
| `lesson_content_version_id` | 内容版本 |
| `block_id` | 教学块 ID |
| `source_ref` | 来源引用 |
| `source_snapshot_hash` | 来源快照摘要 |
| `support_type` | supports / contradicts / example |

### 11.4 现有表调整原则

- `program_lessons` 保留当前列表、排序和激活状态；
- 增加当前发布内容版本指针，而不是把完整 JSON 重复写入主表；
- 形成性题目增加 `lesson_content_version_id` 与 `taught_block_ids_json`；
- 历史尝试永远保留原题、原 rubric 和原内容版本关联；
- 旧正文按 `generation_mode = legacy` 读取；
- 旧正文可以展示和继续完成，但不显示“已通过 V0.4.3 质量门禁”；
- 数据迁移必须幂等，并同步更新 `db:validate`。

---

## 12. 服务与 API 行为

### 12.1 节点化函数

即使本版本仍在 Next.js/TypeScript 内实现，也建议拆成以下纯边界：

```text
buildLessonContext
selectTeachingStrategy
generateLessonContent
runDeterministicLessonGate
reviewLessonSemantics
repairLessonContent
publishLessonVersion
generateLessonCheck
validateLessonCheckGrounding
```

每个函数使用明确输入输出，禁止直接依赖整个数据库对象。V0.4.5 可以把这些边界一一迁移为 Pydantic 模型和 LangGraph 节点，而不重写业务契约。

### 12.2 进度事件

沿用现有 NDJSON 进度窗口，但对用户只展示可验证阶段，不展示模型内部思维链：

```text
正在整理本节目标
正在选择教学方法
正在生成讲解与练习
正在检查课程质量
正在修复未通过内容（如发生）
课程已准备完成
```

进度事件必须来自真实节点开始/完成状态，不能用定时器伪造。

### 12.3 幂等与恢复

- 相同 `lessonId + inputHash` 的进行中请求不得重复创建多个版本；
- 页面刷新后可以从数据库恢复当前生成状态；
- 生成失败后保留失败报告和已消耗 Token；
- 用户主动重试时创建新版本，不覆盖失败版本；
- 只有 `ready` 版本可以成为当前发布版本；
- 发布内容版本、创建题目和更新课程状态需要明确事务边界。

---

## 13. UI 范围

### 13.1 V0.4.3 已实现的基础

沿用当前字体、字号、间距、卡片和弹窗视觉，不重做视觉体系。课程页已经能够：

- 按 `LearningBlock` 渲染不同教学内容；
- 展示当前课程生成、质量和来源状态；
- 在质量失败时显示说明和重新生成入口；
- 在课程通过质量门禁前隐藏正式答题入口；
- 为旧课程显示“旧版内容”标识，不伪装成新结构化课程。

基础阅读器已经解决“全部教学块和全部课后题同时纵向展开”的主要问题，并能恢复当前内容版本的最后阅读页。当前剩余问题收敛为：不同教学块仍有部分共用渲染骨架，长代码缺少复制/展开能力，导师提问没有携带当前块上下文，用户也还不能留下与具体内容版本绑定的困惑和收藏。

质量分、内部失败规则、参考答案和 rubric 继续不向普通用户暴露。开发环境可以提供受控调试视图。

### 13.2 V0.4.3.1：从长页面改为课件阅读器（基础版已实现，扩展设计待完成）

当前实现与冻结设计的对应关系：

- **已经实现**：一个 `LearningBlock` 一页、页码与块类型、进度点目录、上一页/下一页、键盘方向键、交付物页、独立考核页、减少动态效果、输入时不抢方向键、按内容版本恢复页码；
- **部分实现**：不同块已有标签、图标和基础分区，但 `Comparison` 表格、`Summary` 回跳、代码复制/全屏和三种交互块的完整揭示规则尚未完成；
- **尚未实现**：右侧上下文提问抽屉、`blockId + selectedText` 服务端校验、困惑/收藏持久化、历史版本标注回放和考核 `open_book` 记录。

以下内容继续作为 V0.4.3.1 完整形态的冻结设计；其中未完成项不得写入“当前能力”或项目量化结果。

本子版本采用“类似 PPT 的逐页学习”，但不照搬演示软件。核心原则是：

> **一页只承载一个教学意图；课程导航始终可见；长代码和案例只在当前卡片内部滚动；提问、困惑和收藏始终触手可及。**

不采用滚轮劫持、自动翻页或只能横向滑动的轮播。用户必须可以通过明确按钮、键盘和目录定位页面；动画只做轻微淡入/位移，并尊重 `prefers-reduced-motion`。

桌面端信息架构：

```text
┌──────── 学习路线 ────────┐  ┌────────── 当前学习卡片 ──────────┐  ┌── 学习工具 ──┐
│ 第 1 课  已完成           │  │  03 / 09 · 完整示例              │  │ 向导师提问   │
│ 第 2 课  当前             │  │                                  │  │ 标记困惑     │
│ 第 3 课  待解锁           │  │  一页只显示一个 LearningBlock    │  │ 收藏重点     │
│                           │  │  长代码/案例在卡片内部滚动或展开  │  │ 查看本课标记 │
└──────────────────────────┘  │                                  │  └─────────────┘
                              │  ← 上一页              下一页 →  │
                              └──────────────────────────────────┘
```

每节课默认按以下顺序组装页面，而不是修改课程内容本身：

1. 本节目标、完成证据与概念概览；
2. 按服务端顺序逐页展示 `LearningBlock`；
3. 本节交付物与加入今日计划；
4. 课后考核入口；
5. 三道形成性题目逐题作答；
6. 评分结果与下一步。

页面总数由当前 `contentVersionId` 对应的教学块和题目动态计算，具体页面类型与转移规则见 §13.11。每种教学块的页面骨架见 §13.9，三种交互块的揭示规则见 §13.10。正文翻页不会被写成“已掌握”；只有原有形成性考核合格后，课节和关联任务才能完成。

### 13.3 翻页与阅读状态

- 顶部固定显示 `当前页 / 总页数`、当前教学块类型和细进度条；
- 底部提供“上一页 / 下一页”，第一页和最后一页有明确边界；
- 支持键盘 `← / →`，但输入框、文本域或对话抽屉获得焦点时不触发翻页；
- 支持点击小型目录或进度点直接回到已经浏览过的页面；
- 不要求用户浏览完当前页才能翻页，也不把浏览行为当成考核证据；
- 代码和长案例允许当前卡片内部滚动、复制、展开和全屏，不能为了固定高度截断正文；
- 按 `userId + lessonId + contentVersionId` 记录最后阅读页。首版可以只把阅读位置保存在客户端；正式跨设备恢复再写入服务端；
- 课程生成新版本后，旧版本阅读位置不能直接套用到新版本。

### 13.4 随时向导师提问

现有位于课程底部的提问框改为固定学习工具中的“向导师提问”。点击后从右侧打开抽屉，不离开当前学习卡片。

提问请求至少携带：

```ts
type ContextualTutorQuestion = {
  programId: string;
  lessonId: string;
  contentVersionId: string;
  blockId: string | null;
  selectedText: string;
  question: string;
};
```

交互规则：

- 系统自动显示当前页标题、教学块类型和用户选中的原文，用户不需要重新描述上下文；
- `selectedText` 必须来自当前公开教学块，服务端按 `blockId` 重新校验，不能相信客户端提交的课程正文；
- 导师回答默认只使用当前教学块、必要的相邻块和课程目标，避免每次发送整节正文；
- 抽屉关闭后保持当前页，重新打开可以看到本节最近对话；
- 导师回答可以建议用户标记困惑或去完成练习，但不能直接把课节判为合格；
- 用户笔记默认不发送给模型，只有在用户主动提问并明确附带时才进入 Tutor 输入。

### 13.5 困惑点标注

“标记困惑”支持两种粒度：

1. 没有选择文本：标记整个教学块；
2. 选择了文本：保存选中原文，并允许用户补充一句“具体卡在哪里”。

困惑标记保存后，当前页工具按钮显示已标记状态，并允许修改或取消。它可以用于：

- 向 Tutor 发起带上下文的补充提问；
- 在本课标记列表中集中回看；
- 将“困惑教学块数量、类型和是否已解决”的聚合信息提供给 Planner；
- 后续补课循环选择需要重新解释或增加练习的内容。

困惑属于**主观学习信号**，不是能力证据。仅仅标记“困惑”或之后取消标记，都不能直接改变 `skill_mastery`、目标进度、课节状态或任务完成状态。

建议后续增加 `resolved_at` 或 `status = open/resolved`，但“已解决”也只表示用户自报，不等同于考核合格。

### 13.6 重点收藏

“收藏重点”同样支持整个教学块或选中原文，并允许写下自己的理解。收藏内容需要：

- 在当前页显示已收藏状态；
- 可从课程内的“本课标记”抽屉查看；
- 后续可以汇总到记录页的“学习重点”，但本子版本不要求重做记录页；
- 绑定不可变 `contentVersionId + blockId`，课程重生成后作为旧版本收藏保留，不自动映射到新正文；
- 若原内容版本被归档，收藏仍可回放原文快照和用户笔记。

收藏是用户整理资料的行为，不增加 XP、不更新掌握度，也不替代主动回忆和形成性考核。

### 13.7 标注数据契约（拟定数据库 V9）

V0.4.3.1 拟新增统一的 `lesson_annotations` 表，而不是为困惑和收藏分别建表：

```sql
CREATE TABLE lesson_annotations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  content_version_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('confusion', 'bookmark')),
  quoted_text TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id) REFERENCES learning_programs(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE,
  FOREIGN KEY (content_version_id) REFERENCES lesson_content_versions(id) ON DELETE CASCADE
);
```

建议增加：

- `(user_id, lesson_id, content_version_id, type)` 查询索引；
- 同一用户对同一块同一类型只保留一个“整块标记”；
- 带 `quoted_text` 的选区标记允许同一块存在多条；
- `quoted_text` 和 `note` 设置长度上限，公开 API 不接受任意课程正文；
- 所有读写必须校验课程、课节、内容版本和教学块都属于当前用户；
- 删除标注只删除用户笔记，不删除课程版本或考核证据。

拟定接口：

```text
GET    /api/learning-annotations?programId=&lessonId=&contentVersionId=
POST   /api/learning-annotations        创建或更新困惑/收藏
DELETE /api/learning-annotations?id=    删除当前用户的标注
```

数据库 V9 同时包含 §13.11 决定的开卷标记：

```sql
ALTER TABLE lesson_assessment_attempts ADD COLUMN open_book INTEGER NOT NULL DEFAULT 0;
```

两处新增（`lesson_annotations` 建表、`lesson_assessment_attempts` 加列）走同一次版本升级：新表由 `CREATE TABLE IF NOT EXISTS` 覆盖新旧库，新列必须同时写进建表语句和 `COLUMN_ADDITIONS`，否则老库永远不会有它。`db:validate` 会校验这两处是否一致。

### 13.8 响应式、无障碍和视觉约束

- 保留项目当前 `Manrope / Noto Serif SC / DM Mono` 字体和现有字号，不重新套用另一套设计系统；
- 所有翻页、提问、困惑、收藏按钮使用同一套 Lucide 图标，不使用 Emoji 充当功能图标；
- 点击区域有 hover、active 和清晰的键盘 focus 状态，状态不能只依赖颜色表达；
- 页面切换动画控制在 150–250ms，只动画卡片主体，不让目录、工具栏和页面高度跳动；
- `prefers-reduced-motion: reduce` 时取消位移动画和进度过渡；
- 桌面端工具栏可放在右侧；窄屏改为底部操作条，但移动端产品开发仍按当前决定暂停；
- 提问抽屉和标注弹窗必须有标题、关闭按钮、焦点管理和 `Esc` 关闭能力；
- 当前卡片保持稳定最小高度，异步导师回答和标注保存不能造成主课件明显布局偏移。

### 13.9 教学块渲染规范

§7.2 定义了 14 种教学块，每种都规定了「必须包含的核心信息」。**如果前端把 `block.content` 一律当作一段 Markdown 渲染，这些类型在用户侧等于不存在**，块模型就只剩数据库价值。因此每种块必须有自己的页面骨架。

共同规则：

- 每页顶部显示块类型的中文标签（`完整示例` / `常见误区` / `适用边界` …），让用户先知道这一页要做什么；
- 每页显示「本页对应目标」，即 `objectiveIds` 映射出的课程目标文案。这是质量门禁 §9.3「所有目标至少被一个教学块覆盖」在用户侧的体现；
- 结构化字段必须分区渲染，不允许合并成一段正文后再交给 Markdown；
- 任何区块都不得默认折叠到「看不出还有内容」的程度，折叠只用于超长代码和附加细节。

| 块类型 | 页面主体分区 | 硬约束 |
|---|---|---|
| `Explanation` | 定义 / 作用 / 因果 / 适用情境 四段，带小标题 | 不能是一整坨段落 |
| `ConceptRelation` | 当前概念居中，前置与相邻概念分列，关系写在连接文字上 | 本版本不引入图表库，用缩进和箭头文本表达即可 |
| `Comparison` | **表格**：对比维度为行，被比较项为列；表下单独一行「选择条件」 | 「选择条件」不能省，否则只是罗列差异 |
| `WorkedExample` | 输入 → 编号推理步骤 → 结果 → 验证 | **结果和验证不得默认折叠**，否则退化成「看一段代码」 |
| `CaseStudy` | 场景 / 约束 / 决策 / 结果，决策处标注「为什么这么选」 | 约束必须与场景分开显示 |
| `Demonstration` | 编号操作步骤 + 关键观察点 + 完成标准勾选表 | 完成标准是清单形式，可逐条对照 |
| `CommonMistake` | 错误做法 / 为什么错 / 如何发现 / 如何修复 | 错误与正确做法必须有**图标加文字**的双重区分，不能只靠红绿配色（见 §13.8） |
| `Boundary` | 不适用情况列表 + 反例 + 风险 | 视觉标识必须区别于 `CommonMistake`，两者容易被误读成同一件事 |
| `Summary` | 按课程目标分组的要点 | **每条要点可跳回教学它的那一页**，利用 `objectiveIds` 反查 |
| `CodeLab` | 环境 / 初始代码 / 任务 / 约束 / 测试方法 | 等宽字体、可复制、可展开全屏、行号；长代码在卡片内滚动 |
| `SpeakingPractice` | 对象 / 场景 / 时限 / 表达标准 / 复盘点 | 本版本不做音频（§3.2），只提供文本提示与自评清单，界面必须写明不录音、不采集音频 |
| `GuidedPractice` `RetrievalPractice` `Reflection` | 见 §13.10 | 这三种是交互块，不是阅读块 |

### 13.10 交互式教学块的揭示规则

三种块的教学价值来自「用户先动脑」，纯翻页会让它们退化：

**`RetrievalPractice`**——**先答后显**。用户先写下回忆内容并提交，才展示参考要点。允许「跳过并直接查看」，但必须是一次显式点击并记为 `skipped`。

> 这是整个阅读器里**唯一默认阻挡继续阅读的地方**，理由是 §7.2 明确要求「不使用纯重复阅读」：直接给出答案，这个块就等于一个 `Explanation`。

**`GuidedPractice`**——提示逐条展开，一次一条，用户点「再给一条提示」。最后一条提示之后是「我想好了」进入下一页，**不提供「显示答案」按钮**（§7.2：不直接泄露最终答案）。

**`Reflection`**——一个文本框加引导问题，不评分、可留空翻页。

三者共同约束：

- 产出的是**主观学习信号，不是能力证据**。它们不写入 `skill_mastery`、不解锁课节、不完成关联任务、不计 XP——与 §13.5 的困惑标记同一性质；
- 可以作为聚合信号提供给 Planner（例如「本节 2 个回忆块被跳过」），用于后续补课选材；
- 建议直接复用 §13.7 的 `lesson_annotations`，把 `type` 的取值扩展为 `('confusion','bookmark','practice_response')`，避免为此再建一张表。首版也可以只留在客户端、仅上报计数。

### 13.11 阅读器状态机、生成中与失败态

**页面类型与总数**

```text
overview        本节目标与完成证据            1 页
block           每个 LearningBlock 一页       N 页
deliverable     交付物与加入今日计划           1 页
check_intro     考核说明                     1 页
check_question  每题一页                     M 页
result          评分结果与下一步              1 页
```

总页数 `= N + M + 4`，由当前 `contentVersionId` 动态计算。

**转移规则**

- `overview ↔ block ↔ deliverable` 之间自由前后翻，可从目录跳转；
- `check_question` 之间可前后翻以修改答案，**提交后锁定**；
- `result` 不能翻回 `check_question`；
- 只有一个教学块的课节照常分页，不做特殊处理。

**`deliverable → check_intro` 这道边界：已决定采用开卷可见方案（2026-08-30）**

进入考核后**仍可翻回正文**，但只要在提交前访问过任一正文页，该次尝试即标记 `openBook = true`，随 `lesson_assessment_attempts` 一起落库。评分与掌握度更新照常，不因开卷降分。

理由：形成性考核的目的是加深印象和发现薄弱点（§1.2），不是发证书，禁止查阅与学习自由冲突；但开卷必须**可见**，否则 `mastery_score` 会把「抄回来的」和「想出来的」混为一谈。总结性大考（V0.5）再采用严格闭卷。

实现约束：

- **`openBook` 是客户端上报的信号，服务端无法独立验证**——用户是否翻回正文只有浏览器知道。因此它属于主观信号一类，与困惑标记同级（§13.5），**不得用作任何门禁**；
- 只允许客户端把它从 `false` 置为 `true`，服务端不接受反向修改。falsify 的唯一方向是把自己标成开卷，对用户没有好处，所以这个不可验证性是可接受的；
- 逐次记录，不是逐课节记录：同一节的重测可以是闭卷，两次尝试各自独立标记；
- **本版本不改变掌握度公式**。`openBook` 先作为事实记录下来；要不要给它降权，得先有数据，没有样本就调权重只是换一种拍脑袋。

数据库影响：`lesson_assessment_attempts` 增加一列，与 §13.7 的标注表同属数据库 V9。当前项目的 V7 用于学习作息/容量配置，V8 预留给 V0.4.4 可信来源/RAG；两者都不包含 `lesson_annotations` 或 `open_book`。按[开发者手册 §3.4](DEVELOPER_HANDBOOK.md) 的规则，加列必须**同时**写进 `DATABASE_SCHEMA` 的建表语句和 `COLUMN_ADDITIONS`；且通过 `ALTER` 补的列拿不到 CHECK 约束，取值合法性要在应用层再校验一次。

```sql
-- 建表语句与 COLUMN_ADDITIONS 两处都要有
open_book INTEGER NOT NULL DEFAULT 0    -- 0/1；老库经 ALTER 补列时没有 CHECK
```

**生成中**

课节处于 `generating` 时，阅读器显示 §12.2 的进度事件，不显示空白页。实测生成耗时中位约 36 s（§2.3），复杂课程链可能接近 5 分钟，因此该状态必须：

- 展示当前节点与真实百分比，不伪造进度；
- 提供「先去做别的」的出口，允许离开后从计划页或课程页恢复；
- 不允许在此状态下进入考核。

**失败与降级**

| 状态 | 阅读器行为 |
|---|---|
| `quality_failed` | 不进入阅读器，显示失败说明与重新生成入口（§13.1）。已有的阅读位置与标注保留在旧 `contentVersionId` 上，不迁移到新版本 |
| 部分块回退（`mixed`） | **在回退的那几页单独标注「本页为本地演示内容」**，而不是给整节打一个标；与 §11.4「课程级状态由章节派生」一致 |
| 旧版课程（无 `blocks`） | 不进入阅读器，沿用现有长页面渲染加「旧版内容」标识。**不得把旧 Markdown 机械切分成伪教学块**（§4 约束 8） |


### 13.12 V0.4.3.1 实施顺序与验收

实施顺序：

1. 先把 `LearningBlock[]` 和形成性题目映射为只展示一页的阅读状态机（§13.11 的页面类型与转移规则）；
2. 加入页码、进度、上一页/下一页、目录跳转和键盘操作；
3. **实现每种教学块的页面骨架（§13.9）**，先覆盖软件开发策略实际会产出的块类型，其余按需补齐；
4. **实现三种交互块的揭示规则（§13.10）**；
5. 将现有 Tutor 提问改成上下文抽屉；
6. 数据库升级到 V9：新建 `lesson_annotations`，并给 `lesson_assessment_attempts` 加 `open_book`；
7. 加入选区标注、本课标记列表和历史版本回放；
8. 补充生成中、`quality_failed`、`mixed` 与旧版课程的降级显示（§13.11）；
9. 补充刷新恢复、权限、键盘、减少动态效果和长代码回归。

第 3 步是这个子版本的核心价值所在。**如果时间不够，宁可少做标注功能，也不要退回「所有块渲染成同一种页面」**——那等于把 V0.4.3 在数据层做的类型化工作在用户侧全部作废。

完成标准：

- [x] 页面初始只渲染当前学习卡片，不再纵向展示全部教学块和全部题目；
- [x] 可以通过按钮、目录和键盘完成整节课翻页；
- [x] 刷新后恢复到当前内容版本的最后阅读页；
- [ ] 长代码不会被截断，且不会把整个课程重新变成长页面；
- [ ] **`Comparison` 渲染为表格并含「选择条件」；`WorkedExample` 的结果与验证默认可见；`CommonMistake` 与 `Boundary` 视觉可区分且不只依赖颜色**；
- [ ] **`RetrievalPractice` 必须先提交回忆或显式跳过才展示参考要点；`GuidedPractice` 没有「显示答案」按钮**；
- [ ] **交互块的作答不写入 `skill_mastery`、不解锁课节、不完成任务、不计 XP**；
- [ ] **`Summary` 的每条要点可跳回教学它的块页**；
- [ ] 任意教学页都可以携带当前块上下文提问；
- [ ] 可以创建、修改、取消并重新读取困惑和收藏；
- [ ] 选中文本只能来自当前内容版本的有效教学块；
- [ ] 重生成课程后，旧标注仍绑定旧版本且不会错误贴到新教学块；
- [ ] 困惑和收藏不会更新掌握度或绕过形成性考核；
- [ ] **考核中翻回正文不被阻止，但该次尝试的 `open_book` 落库为 1；重测若未翻回则为 0；`open_book` 不参与任何门禁判断**；
- [ ] **`generating` 显示真实进度且可离开后恢复；部分回退按页标注而非整节标注；旧版课程不进入阅读器也不被伪造成教学块**；
- [x] 普通用户仍看不到参考答案、rubric 和内部质量报告；
- [ ] 桌面端 1024px/1440px、键盘导航和减少动态效果回归通过；
- [ ] README、课程说明、数据库校验和项目亮点在实现后同步更新。

2026-08-30 基础版实测：阅读器初始只存在 1 个当前教学块；按钮从 `01 / 09` 前进到第 2 页，方向键继续进入第 3 页；刷新并重新进入课程后恢复为 `03 / 09`。`typecheck`、`lint`、Schema V7 数据库校验和隔离数据库的 V0.4.3 规则质量回归通过。上述结果只证明基础翻页与既有课程质量契约可运行，不代表本节其余未勾选的高级交互已经实现。

---

## 14. 分阶段实施顺序

### 阶段 A：契约、基线与固定样例

1. 固定 5 个跨领域回归目标；
2. 保存当前 V0.4.2 课程输出作为**内容基线**；
3. 保存当前每节点调用耗时、Token 与回退原因分布作为**性能基线**（`npm.cmd run learning:probe` 已能输出，数据源为 `agent_runs`）；
4. 用一个固定样例做**结构化输出 spike**：手工让模型产出一份完整 `LessonContentOutput`，记录耗时、Token 与联合类型判别、交叉引用是否合法；
5. 定义 `CapabilityType`、`LessonOutline`、`LearningBlock`、`LessonContentOutput`；
6. 定义质量报告、题目追溯和来源状态；
7. 建立旧数据读取规则。

完成条件：契约能覆盖固定样例并通过类型和序列化测试；**且 spike 结果能回答「单次生成整课是否可行」**——若 spike 耗时逼近或超过闸门，阶段 B 必须先落实 §2.3 的分块生成，不能按整课单次调用实现。

第 3、4 项是新增的前置项。第 4 项的意义在于：本版本最大的未知是「模型能否稳定吐出一个 14 分支的可辨识联合类型并保持交叉引用合法」。这是一天的工作量，但它决定阶段 B 的实现形状；先建策略注册表、质量门禁和数据库表再发现产不出来，返工成本高得多。

**当前性能基线（2026-08-30 实测，供阶段 E 对比）：**

```text
build_adaptive_initial_question   中位 36 s，最慢成功 57 s，闸门 60 s
build_skill_map                    4–20 s，无回退
回退原因                            100% timeout_60000ms
```

### 阶段 B：结构化生成与课程渲染

1. Planner 输出能力类型、证据要求和动态课程骨架；
2. 实现通用策略注册表；
3. 实现软件开发领域策略；
4. Tutor 生成结构化课程版本；
5. 数据库升级并保存不可变版本；
6. 课程页渲染教学块。

完成条件：固定样例均能生成和恢复结构化课程，不依赖本地伪课程 fallback。

### 阶段 C：质量门禁与定向修复

1. 实现确定性规则；
2. 实现 `LessonQualityReviewer` 语义复核操作；
3. 实现最多两次定向修复；
4. 实现失败状态、进度事件和重试入口；
5. 保存质量报告、Token 和耗时。

完成条件：未通过硬门禁的课程无法发布，失败可见、可恢复、可分析。

### 阶段 D：考核对齐与证据回写

1. 题目从已发布内容版本生成；
2. 题目绑定教学块和证据类型；
3. 服务端验证题目追溯关系；
4. 保持参考答案和 rubric 隔离；
5. 历史尝试绑定内容版本；
6. 通过后继续使用当前事务更新掌握度与下一课。

完成条件：所有正式题目都能指出“考了哪一块已教学内容”。

### 阶段 E：质量评估与文档

1. 运行固定回归集；
2. 人工盲评新旧课程；
3. 统计质量、成本和失败指标；
4. 更新 README、V1、角色文档和项目亮点；
5. 只记录真实测得的数据，不预填提升百分比。

---

## 15. 测试方案

### 15.1 单元与契约测试

- 所有 `LearningBlock` 能正确解析和序列化；
- 未知块类型和缺失必填字段被拒绝；
- 块 ID、目标引用和题目引用可验证；
- 公开 DTO 不含答案和 rubric；
- 旧课程读取不受影响；
- 数据库 V6 新库、旧库迁移和重复迁移均通过。

### 15.2 质量门禁测试

为每条硬规则准备至少一个失败样例：

- 缺少具体例子；
- 目标未覆盖；
- 只有解释没有练习；
- 练习考查未教学内容；
- 存在空泛模板句；
- 代码示例无法说明输入和预期结果；
- 参考答案泄露到公开对象；
- 生成失败却返回 ready。

### 15.3 LLM 集成测试

- 正常生成一次通过；
- 首次失败、一次定向修复后通过；
- 两次修复仍失败并进入 `quality_failed`；
- 模型超时、非 JSON、字段缺失，且 `agent_runs.error_message` 分别记录为 `timeout_*`、`unparsable_json`、`validation_failed`；
- 多模型/不同 Prompt 版本的产物可追踪；
- 刷新后恢复生成进度；
- 同一输入重复请求保持幂等。

### 15.4 端到端测试

至少覆盖：

1. 创建目标并完成诊断；
2. 生成结构化首课；
3. 通过质量门禁；
4. 学习并完成绑定教学块的小测；
5. 证据、掌握度、任务和下一课在事务中更新；
6. 回放旧课程版本和旧答题尝试；
7. 失败课程不能完成关联任务；
8. 多目标课程切换不串数据。

---

## 16. 评估指标

### 16.1 本版本可以测量

| 指标 | 定义 |
|---|---|
| 质量门禁首轮通过率 | 首次生成即通过全部门禁的课程数 / 总生成数 |
| 最终发布率 | 在允许修复次数内成为 ready 的课程数 / 总生成数 |
| 静默 fallback 率 | 失败后仍伪装为正式课程的比例，目标为 0 |
| 目标覆盖率 | 被教学块覆盖的课程目标数 / 总目标数 |
| 题目追溯率 | 绑定有效教学块的正式题目数 / 正式题目总数，目标为 100% |
| 练习对齐率 | 与课程目标和教学内容一致的练习数 / 总练习数 |
| 空泛模板率 | 命中通用占位或无信息表达的课程比例 |
| 定向修复率 | 需要至少一次修复的课程数 / 总生成数 |
| 人工接受率 | 盲评者认为可直接学习的课程数 / 被评课程数 |
| 成本 | 每节 ready 课程的 Token、调用次数、耗时与失败成本 |
| 单次调用超时率 | `agent_runs.error_message` 命中 `timeout_*` 的调用数 / 总调用数。基线见 §14 阶段 A |
| 回退原因分布 | 按 `timeout_* / http_* / unparsable_json / empty_completion / validation_failed` 分类计数，用于判断该调超时、加重试还是改契约 |

### 16.2 本版本不能宣称

在没有真实用户、对照组、前后测和足够样本前，不能声称：

- 学习效率提高了多少；
- 成绩提高了多少；
- 记忆保持率提高了多少；
- AI 教学优于真人或其他产品。

可以写入简历的是工程结果，例如“正式题目教学块追溯率达到 100%”“静默 fallback 降为 0”“固定回归集人工接受率从 A 提升到 B”，前提是这些数字由固定评测真实产生。

---

## 17. Definition of Done

V0.4.3 只有同时满足以下条件才算完成：

- [x] 课程节数不再固定为 5，并能体现周期和投入差异；
- [x] 所有新课程使用版本化 `LearningBlock`；
- [x] 六种通用能力类型和最低教学块策略已落地；
- [ ] 软件开发领域的概念、操作、排错和项目交付四类固定样例尚未全部补齐；
- [x] 技术演讲与历史辨析 2 个非代码固定样例通过规则回归；
- [x] 所有 ready 新课程通过确定性门禁；
- [x] 语义复核和定向修复写入 Agent 运行及版本质量记录；
- [x] 超过修复上限后明确失败，不返回伪课程；
- [x] 所有正式形成性题目绑定有效教学块；
- [x] 参考答案和 rubric 不下发客户端；
- [x] 课程任务仍不能绕过形成性考核；
- [x] 历史字符串课程兼容读取，历史尝试绑定题目与内容版本快照；
- [x] 生成、质量检查和修复均记录 Token、耗时与回退原因；
- [x] `typecheck`、`lint`、数据库校验、生产构建和闭环 E2E 全部通过；
- [x] README、V1、Roles、数据库说明和项目亮点同步更新；
- [x] 没有把 RAG、LangGraph、Pydantic AI 或阶段大考混入本版本范围；
- [x] 没有未经实验支撑的学习效果百分比。

---

## 18. 已确定决策与待实现时再决定的细节

### 18.1 已确定

- V0.4.3 先解决教学质量，不迁移框架；
- 课程使用通用能力模型，而不是代码专用结构；
- 软件开发是第一个领域策略，不是唯一领域；
- Tutor 负责课内形成性考核；
- Examiner 不读取课程正文，继续负责初始诊断和未来大考；
- LessonQualityReviewer 是内部质量操作，不是新的产品 Agent；
- 质量硬规则由代码执行，LLM 语义复核不能推翻硬失败；
- 课程版本不可变，题目和历史证据绑定具体版本；
- V0.4.3 允许 `unverified` Demo 内容，但必须明确标记；
- 失败可见、可重试、可统计，禁止静默 fallback。

### 18.2 实现后仍待决定

- 数据库版本已确定为 V6，质量阈值与能力类型最低教学块由 `lib/learning-program/quality.ts` 统一执行；
- 一次修复处理同一报告中的相关问题，最多两次；
- `LearningBlock` 首版已经采用 TypeScript 判别联合，UI 已展示来源与质量标签；
- `unverified` 形成性证据对掌握度的长期权重仍待 V0.4.4 来源链完成后决定；
- 固定回归集的人工评分 rubric 与真实用户盲评仍待补充；
- 单节生成需要继续拆为可恢复的块级后台任务，解决当前真实模型约 5 分钟的最坏链路。

这些细节不得改变本方案的角色边界、质量硬门禁和版本化原则。

---

## 19. 与后续版本的边界

| 版本 | 重点 | 与 V0.4.3 的关系 |
|---|---|---|
| V0.4.3 | 通用课程内容引擎与质量门禁 | 本文范围 |
| V0.4.4 | [私有资料 RAG 与可追溯教学来源](IMPLEMENTATION_PLAN_V044.md) | 先用 FTS5 为教学块和题目补充固定来源；Embedding、URL 与联网按子版本加入 |
| V0.4.5 | Pydantic AI + LangGraph | 迁移已经稳定的结构化契约和节点边界 |
| V0.5 | 补课循环、阶段大考、模拟面试、毕业门禁 | 使用高质量课程和可信证据推进正式考核 |

正确顺序是：

```text
先稳定教什么和怎么教
→ 再稳定知识从哪里来
→ 再迁移工作流框架
→ 最后增加高风险正式考核
```

若后续实现与本文冲突，应先修订本文、V1 和 Roles，再改代码，避免代码先行导致角色、证据和版本边界再次混乱。
