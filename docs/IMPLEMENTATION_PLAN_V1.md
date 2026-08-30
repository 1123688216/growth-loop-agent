# Growth Loop V1 实施方案（教学质量优先修订版）

> 修订日期：2026-08-30
>
> 当前状态：V0.4.3 的工程 MVP 与基础课件阅读器已完成，已经具备结构化课程、质量门禁、定向修复、内容版本、题目追溯和分页阅读；V0.4.4 私有资料 RAG 已完成设计冻结但尚未修改业务代码。
> 相关文档：[V0.4.2 当前实现基线](IMPLEMENTATION_PLAN_V042.md)、[V0.4.3 详细实施方案](IMPLEMENTATION_PLAN_V043.md)、[V0.4.4 详细实施方案](IMPLEMENTATION_PLAN_V044.md)、[Agent 角色与信息边界](AGENT_ROLES.md)、[开发者手册](DEVELOPER_HANDBOOK.md)。

## 1. V1 的产品目标没有变化

V1 要验证的不是 Agent 数量，也不是是否使用了某个框架，而是系统能否依据用户的真实学习证据持续安排下一步：

```text
创建目标
→ 识别需要掌握的能力
→ 建立初始能力基线
→ 生成有依据、有教学价值的课程
→ 用户学习并提交可观察证据
→ 形成性考核
→ 更新能力画像
→ 调整后续课程和任务
→ 阶段性独立考核
→ 达标后进入下一阶段或完成目标
```

V0.4.2 已经证明这条链路在工程上能够闭合，但当前课程正文仍然过薄，不能稳定承担“学习”这一核心环节。V1 接下来的首要目标不是增加更多考核，而是先保证用户确实获得了足以被考核的教学内容。

### 1.1 当前最重要的产品原则

```text
没有合格教学内容
→ 就没有公平的课后考核
→ 更不能产生可信的掌握度和阶段通过结论
```

因此 V1 增加一条不可绕过的顺序约束：

```text
知识来源可用
→ 课程内容通过质量门禁
→ 才允许生成正式课后题
→ 课后形成性证据充分
→ 才允许进入阶段考核
```

## 2. 当前实现与已确认问题

### 2.1 V0.4.2 已完成的能力

- 创建目标时选择 `beginner / familiar / intermediate`；
- Planner 拆分 `goal_skills`；
- `familiar / intermediate` 进入逐题自适应初始诊断；
- 初始诊断逐题评分、升降难度并保存证据；
- 诊断完成后初始化 `skill_mastery`；
- Planner 生成课程骨架，Tutor 生成第一节正文和三道形成性题目；
- 用户答题后更新掌握度、课节状态和关联任务；
- 通过后按最新证据调整并生成下一课；
- SQLite 支持刷新恢复、幂等提交和多目标课程切换；
- 数据库当前为 V7，已包含课程内容版本、质量报告、教学块来源骨架和学习作息；V0.4.4 将使用 Schema V8 写入真实资料、片段和检索快照。

完整现状以 [V0.4.2 当前实现基线](IMPLEMENTATION_PLAN_V042.md) 为准。

### 2.2 V0.4.3 立项时的教学质量基线（历史问题）

以下问题用于解释 V0.4.3 为什么立项，当前结构化课程、质量门禁和动态课时已经修复其中的核心工程缺口；不能再把这段历史基线描述成当前实现。

当前课程质量低主要来自以下确定事实：

1. `buildCourseOutline` 将课程限制在 3–5 节，正常路径固定生成 5 节；目标周期和每周投入没有真正决定课程容量。
2. 单课内容只有 `opening / explanation / example / practice / deliverable / concepts` 几个字符串，没有分段教学结构。
3. Tutor 输入主要是目标标题、能力一句话描述、章节骨架和掌握度数字，没有可靠资料、诊断错因、前置依赖和充分上下文。
4. 模型调用失败时会静默落到通用模板，用户无法知道当前看到的是 LLM 正文还是规则占位。
5. 即使 LLM 调用成功，当前 Prompt 也倾向输出约百字讲解，而不是完整教学单元。
6. 课程没有来源引用、内容覆盖校验、具体性校验和教学质量门禁。

最近一次本地 Java 目标中，Planner 使用 LLM 成功生成骨架，但 Tutor 正文和课后题均回退到本地规则；第一课讲解约 135 个字符、示例约 43 个字符。这证明当前系统完成的是“课程记录生成”，还不是“高质量教学内容生成”。

### 2.3 当前结论

```text
工程闭环：已完成
教学内容引擎：原型级
正式阶段考核：不应现在推进
```

阶段考核、模拟面试和毕业门禁必须等待课程质量与来源链建立后再开发，否则系统只是在精确评估一段没有充分教学价值的内容。

## 3. 通用学习 Agent，而不是代码课程生成器

产品面向通用学习，编程只是第一套深入实现和验证的领域。课程不按“编程/英语/历史”写死，而是先判断每个能力需要怎样学习。

### 3.1 通用能力类型

```ts
type CapabilityType =
  | "conceptual_understanding"
  | "procedural_skill"
  | "problem_solving"
  | "expression_communication"
  | "retrieval_discrimination"
  | "integrated_creation";
```

| 能力类型 | 常见领域 | 合适的教学方法 |
|---|---|---|
| 概念理解 | 历史、经济学、计算机原理 | 解释、概念关系、对比、案例 |
| 操作流程 | Git、软件操作、摄影、实验 | 示范、步骤、模仿、错误排查 |
| 问题求解 | 数学、算法、物理、逻辑 | worked example、脚手架练习、变式题 |
| 表达与交流 | 外语、写作、演讲、面试 | 范例、模仿、输出、反馈、重写 |
| 记忆与辨析 | 考证、术语、规则条款 | 提取练习、间隔复习、辨析题 |
| 综合创作 | 编程项目、论文、设计作品 | 里程碑、成果提交、rubric 评估 |

一个能力可以同时包含多种类型。例如 Java 并发可以是“概念理解 + 问题求解 + 综合创作”，英语面试可以是“表达交流 + 记忆辨析”。

### 3.2 通用领域策略

V1 不为每个学科复制一套 Agent，而是保留通用内核并使用领域策略：

```text
通用学习内核
├─ 能力类型分类
├─ 教学内容块
├─ 来源与引用
├─ 学习证据
├─ 形成性评分
└─ 掌握度更新

领域策略
├─ software_development（首个完整实现）
├─ language_learning（后续）
├─ exam_preparation（后续）
├─ academic_learning（后续）
└─ creative_skill（后续）
```

编程策略可以增加代码示例、调试案例、测试与项目交付，但这些字段不能进入所有课程都必须填写的通用顶层结构。

## 4. 通用课程内容模型

### 4.1 课程的三个层级

```text
LearningProgram：完整目标路线和周期
  └─ CourseModule：一组相互依赖的能力阶段
       └─ CourseLesson：一次可完成、可练习、可验证的教学单元
```

课程周期不能再等同于固定 5 节课。Planner 必须依据：

- 目标日期；
- 每周投入；
- 能力数量和依赖；
- 每项能力估时；
- 初始诊断结果；
- 每节合理学习时长；

计算模块、预计课时和每周节奏。数据库可以先保存完整骨架，但仍然只按需生成最近一节正文。

### 4.2 LessonOutline

```ts
type LessonOutline = {
  title: string;
  moduleId: string;
  primarySkillId: string;
  capabilityTypes: CapabilityType[];
  prerequisites: string[];
  objectives: string[];
  estimatedMinutes: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  expectedEvidenceTypes: EvidenceType[];
};
```

### 4.3 LearningBlock

单课不再是一段 `explanation`，而是一组可以组合的内容块：

```ts
type LearningBlock =
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
  | SummaryBlock;
```

通用字段示意：

```ts
type BaseLearningBlock = {
  id: string;
  type: string;
  title: string;
  content: string;
  sourceRefs: SourceReference[];
  teachesObjectives: string[];
};
```

领域扩展示例：

```ts
type CodeLabBlock = BaseLearningBlock & {
  type: "code_lab";
  language: string;
  starterCode: string;
  expectedBehavior: string;
  testCases: string[];
};

type SpeakingPracticeBlock = BaseLearningBlock & {
  type: "speaking_practice";
  prompt: string;
  targetFeatures: string[];
};
```

### 4.4 LessonContentOutput

```ts
type LessonContentOutput = {
  lessonId: string;
  prerequisitesCheck: string[];
  objectives: string[];
  blocks: LearningBlock[];
  guidedPractice: PracticeSpec;
  independentPractice: PracticeSpec;
  observableOutcome: EvidenceRequirement;
  summary: string;
  nextLessonBridge: string;
  sourceRefs: SourceReference[];
};
```

`observableOutcome` 是通用的“学会了的可观察证据”，不等于代码项目：

- 编程：代码、测试结果、调试说明；
- 历史：时间线、因果分析；
- 英语：短文、口语录音；
- 数学：推导和变式题；
- 摄影：照片及参数说明；
- 面试：结构化回答或录音。

### 4.5 EvidenceType

```ts
type EvidenceType =
  | "text_answer"
  | "quiz"
  | "code"
  | "file"
  | "image"
  | "audio"
  | "video"
  | "project"
  | "interview";
```

第一阶段只要求完整实现 `text_answer` 和 `code`，但数据契约不得阻塞后续文件、图片、音频和面试证据。

## 5. 教学质量门禁

### 5.1 课程状态必须区分“已生成”和“可教学”

建议扩展课节内容状态：

```text
planned
→ retrieving_sources
→ generating
→ quality_review
→ ready

失败分支：
source_insufficient / quality_failed / generation_failed
```

只有 `ready` 的课程才允许用户开始正式学习并生成计入掌握度的课后考核。

### 5.2 最低质量要求

一节正式课程至少必须满足：

1. 聚焦少量明确目标，而不是堆叠多个名词；
2. 每个目标都有对应教学内容块；
3. 包含具体解释或示范，不能只给学习建议；
4. 至少包含一个完整 worked example、案例或操作示范；
5. 包含常见误区、失败表现或适用边界；
6. 练习必须能够由本课内容支持；
7. 学习证据和成功标准必须可观察；
8. 内容必须绑定可靠来源，或明确标记为未验证的 LLM 通用知识；
9. 不得出现“请自己找一个场景”“写一份结论、依据、步骤”之类与主题无关的通用占位；
10. 模型或来源失败时不得静默把模板当成正式课程。

字数只能作为异常检测信号，不能单独代表质量。质量门禁需要同时检查结构完整性、目标覆盖、具体性、来源覆盖和练习对齐。

### 5.3 LessonQualityReport

```ts
type LessonQualityReport = {
  passed: boolean;
  objectiveCoverage: number;
  sourceCoverage: number;
  specificityScore: number;
  practiceAlignment: number;
  genericPatternHits: string[];
  missingBlocks: string[];
  reasons: string[];
};
```

第一版由确定性规则完成硬门禁，LLM 只负责补充语义审查；不能让生成课程的同一次模型调用直接自行宣布通过。

### 5.4 回退必须可见

课程页面和 Agent 运行记录必须把生成方式、来源状态和教学质量分开记录：

- 生成方式：`llm / rules / mixed / manual`；
- 来源状态：`unverified / partially_grounded / grounded`；
- 教学质量：`pending / passed / failed`。

`rag_grounded` 不作为生成方式：有来源只说明内容可追溯，不能说明由谁生成，也不能自动证明教学质量通过。

如果 Tutor 失败，页面应显示“课程生成失败/内容质量未通过，可以重试”，不能继续展示一段通用模板并让用户参加正式考核。

## 6. 知识来源与 RAG

RAG 解决“教什么、依据是什么”；课程内容模型解决“怎么教、怎么练、怎么确认学会”。二者缺一不可。

### 6.1 来源优先级

```text
用户上传资料
→ 用户指定网页
→ 官方文档/标准/论文
→ 可信第三方资料
→ 公开网络补充
→ LLM 通用知识回退
```

用户可以为目标设置：

```ts
type SourcePolicy =
  | "private_only"
  | "private_first"
  | "official_web"
  | "open_web";
```

V0.4.4 核心版固定使用 `private_only`，资料不足时提示用户补充资料，不自动联网。`private_first / official_web / open_web` 只有在后续子版本提供明确联网开关、抓取快照和来源质量门禁后才启用。

### 6.2 分阶段输入范围

V0.4.4 核心版支持：

- PDF；
- Word（DOCX）；
- TXT；
- 用户直接粘贴文本；

后续再支持：

- V0.4.4.2：用户指定 URL；
- V0.4.4.3：由系统发起的官方来源定向搜索；
- 开放网络搜索继续保持显式可选，不作为默认来源。

扫描版 PDF 在没有 OCR 时必须标记为 `ocr_required`，不能把空文本当成解析成功。

### 6.3 处理链路

```text
上传/抓取
→ 文件安全与类型检查
→ 文本提取
→ 章节、页码和段落保留
→ 清洗与去重
→ 分块
→ FTS5 关键词索引（V0.4.4）
→ Embedding 语义索引（V0.4.4.1）
→ 按 userId / goalId / 文档版本过滤
→ 混合检索（V0.4.4.1）
→ 来源质量筛选
→ 生成课程或题目
→ 固化引用快照
```

### 6.4 来源快照原则

课程和题目生成时必须保存实际使用的 `sourceChunkIds`。评分时不能重新联网搜索或重新检索后改变标准，而应读取生成时的固定快照：

```text
来源片段快照
→ 教学内容
→ 题目
→ 参考答案
→ rubric
→ 用户答案
→ 评分证据
```

用户更新或删除原始资料时，已发生的课程与考核记录仍保留当时的证据快照；新课程使用新版本来源。

### 6.5 联网搜索不是搜索摘要直喂模型

正确流程：

```text
判断本地证据不足
→ 生成检索查询
→ 搜索结果召回
→ 筛选可信页面
→ 抓取正文
→ 保存 URL、时间、哈希和正文快照
→ 分块进入统一来源库
→ 再参与课程和题目生成
```

搜索结果必须经过域名、来源类型、发布日期、内容可访问性、冲突和提示词注入检查。社区问答和个人博客可以补充，但不得作为高风险结论或正式考核答案的唯一依据。

## 7. Agent 职责与信息边界

### 7.1 PlannerAgent

负责：

- 将目标拆分为能力和依赖；
- 为每项能力标注 `CapabilityType[]`；
- 根据目标日期、投入和能力估时生成模块与课时骨架；
- 选择每节预期学习证据；
- 在长期证据变化较大时重排尚未生成的课程。

不负责：

- 编写完整课文；
- 直接评分；
- 修改掌握度；
- 自行完成数据库权威写入。

### 7.2 TutorAgent

负责：

- 根据当前能力、诊断证据、来源片段和教学策略生成单课内容；
- 生成与实际教学内容一致的形成性练习；
- 对课后答案给出反馈和补充讲解；
- 生成不合格后的针对性重学材料。

不负责：

- 阶段通过或毕业结论；
- 改写已经固化的题目 rubric；
- 在内容质量失败时强行推进课程。

### 7.3 ExaminerAgent

初始诊断和后续独立考核由同一个 Examiner Agent 负责，不拆成新的“诊断 Agent”。它拥有不同操作：

```text
initial_diagnostic
milestone_exam
mock_interview
graduation_assessment
```

初始诊断用于寻找学习起点，可以自适应升降难度；阶段考核用于验证是否达到固定标准，不能因为用户答错就不断降低通过标准。

Examiner 不读取完整导师日常对话，只读取目标能力、正式考核蓝图、题目快照、答案和最小必要证据，以保持独立性。

### 7.4 LearningPolicy

LearningPolicy 是确定性业务规则，不是 Agent。它负责：

- 归一化得分；
- 更新掌握度与置信度；
- 选择下一课难度；
- 判断是否补课、复测或进入阶段考核；
- 执行任务完成门禁。

这些权威状态仍由 Next.js 在数据库事务内写入，不能交给 LLM 直接修改。

## 8. 教学和考核的顺序

### 8.1 初始诊断

初始诊断发生在课程前，用于决定起点。当前 V0.4.2 的逐题自适应实现继续保留，不因为课程引擎改造而重写。

### 8.2 形成性考核

形成性考核由 Tutor 负责，前置条件是：

```text
lesson.generation_status = ready
AND lesson_quality_report.passed = true
```

题目必须逐项绑定：

- 本课目标；
- 实际教学块；
- 固定参考答案；
- rubric；
- 来源快照；
- 预期证据类型。

### 8.3 阶段考核

阶段考核暂不开发，直到满足：

1. 该阶段所有必修能力都有合格教学内容；
2. 每项能力至少有规定数量的形成性证据；
3. 来源覆盖达到门槛；
4. 不存在未处理的 `quality_failed` 课程；
5. Examiner 考核蓝图和通用考核数据结构确定。

阶段考核由 Examiner 负责，属于总结性证据；Tutor 的高分不能直接作为阶段通过或毕业证明。

### 8.4 不合格分支

```text
课后考核不合格
→ 定位未满足的 rubric 和能力点
→ Tutor 生成针对性补充讲解
→ 生成新的变式练习
→ 用户重新提交
→ 保存新的 attempt，不覆盖历史
```

V0.4.3 先为该分支预留数据契约；完整循环在课程内容引擎稳定后实现。

## 9. 数据结构演进

### 9.1 当前数据库

当前 `DATABASE_SCHEMA_VERSION = 5`，已包含：

- `goal_learning_profiles`；
- `goal_skills` / `skill_mastery`；
- `learning_programs` / `course_modules` / `course_lessons`；
- `task_lesson_links`；
- `diagnostic_assessments` / `diagnostic_questions` / `diagnostic_responses` / `diagnostic_attempts`；
- `lesson_assessment_attempts`；
- `workflow_runs` / `agent_runs`。

### 9.2 V0.4.3 预计增加

课程内容块可以先作为版本化 JSON 保存，必须查询和统计的质量状态使用普通字段。

建议增加：

```text
lesson_content_versions
lesson_quality_reports
lesson_block_sources
```

关键字段：

- 内容版本；
- 生成模式；
- Prompt/策略版本；
- 质量状态和质量分项；
- 失败原因；
- 当前正式版本；
- 与目标、课节、能力和来源的关联。

### 9.3 V0.4.4 预计增加

```text
knowledge_sources
source_versions
source_chunks
source_chunks_fts
goal_source_links
retrieval_runs
retrieval_run_items
question_source_links
```

其中来源必须包含：用户归属、目标关系、来源类型、原始文件名、不可变内容哈希、版本、解析状态、可信等级和时间。课程继续复用 `lesson_block_sources`，但 `source_ref` 必须指向真实 chunk 并保存非空快照哈希，不能把课节全部来源复制给每个教学块。详细契约见 [V0.4.4 实施方案](IMPLEMENTATION_PLAN_V044.md)。

### 9.4 Examiner 通用考核结构

当前 `diagnostic_*` 继续服务初始诊断。真正开发阶段考核时，再迁移或泛化为：

```text
assessments
assessment_questions
assessment_responses
assessment_results
```

并使用：

```ts
type AssessmentType =
  | "initial_diagnostic"
  | "milestone_exam"
  | "mock_interview"
  | "graduation_exam";
```

现在不为未来表名重构已稳定工作的初始诊断。

## 10. LangGraph 与 Pydantic AI 的目标分工

目标架构不变，只调整接入顺序。

- LangGraph：共享状态、条件分支、循环、等待用户输入、断点恢复和 checkpoint。
- Pydantic AI Agent：节点内模型调用、依赖注入和结构化 `output_type`。
- 普通 Python 函数：确定性路由、重试选择和不需要数据库事务的计算。
- Next.js：页面、认证、业务 API、数据库唯一权威写入方和事务门禁。

```text
Next.js
├─ UI、登录与外部 API
├─ SQLite/PostgreSQL 业务数据唯一写入方
├─ 所有权、幂等和事务校验
└─ 调用 Python workflow service

Python FastAPI
├─ LangGraph 工作流
├─ Pydantic AI Agents
├─ 文档解析、Embedding 和检索计算
└─ 返回结构化结果，不直接修改业务权威状态
```

暂缓框架迁移的理由：当前 Node 工作流已经能够运行，迁移不会自动提升课程质量。先稳定课程契约、来源契约和质量门禁，再迁移这些已验证节点，可以避免把错误的数据形状固化到 Python 服务。

迁移时必须保留：

- Next.js 数据库主权；
- 当前诊断和课程 API 的幂等语义；
- 固定题目与来源快照；
- 形成性/总结性证据边界；
- 不暴露模型内部思维链；
- 图状态只保存 ID 和小型状态，不复制完整正文和文档。

## 11. 修订后的版本路线

### V0.4.2：工程最小闭环——已完成并冻结

- 三档基础；
- 能力拆分；
- 自适应初始诊断；
- 课程骨架和首课；
- Tutor 形成性小测；
- 掌握度、任务和下一课回边；
- 数据库恢复与幂等。

后续只修缺陷，不再在 V0.4.2 内加入 RAG、框架迁移或阶段考核。

### V0.4.3：通用课程内容引擎

详细实施契约、质量门禁、数据设计与验收标准见 [V0.4.3 实施方案](IMPLEMENTATION_PLAN_V043.md)。

截至 2026-08-30，以下核心项已经落地；真实模型完整链路在复杂修复分支下可能接近 5 分钟，块级后台生成和人工质量盲评仍待继续。

1. 建立 `CapabilityType` 和通用 `LearningBlock` 契约；
2. 让周期、投入、能力估时决定模块和课时，不再固定 5 节；
3. 以软件开发学习作为第一套领域策略；
4. 重写 Tutor 单课生成输入输出；
5. 建立内容版本和质量门禁；
6. 模型失败或质量不足时停止推进并明确提示；
7. 课后题必须在课程通过质量门禁后生成；
8. 保留旧课程读取兼容，不强制把旧字符串内容伪装成新内容块。

### V0.4.4：私有资料 RAG 与可追溯教学来源

详细范围、Schema V8、数据契约、安全边界和验收标准见 [V0.4.4 实施方案](IMPLEMENTATION_PLAN_V044.md)。核心版只做：

1. 支持 PDF、DOCX、TXT 和粘贴文本；
2. 建立不可变资料版本、确定性分块和 FTS5；
3. 课程必要教学块绑定真实来源片段；
4. 题目、参考答案和 rubric 绑定同一来源快照；
5. 评分不重新检索，历史标准不随资料更新改变；
6. 资料不足时进入 `source_insufficient`；
7. 页面展示来源标题、页码/章节和引用片段。

Embedding、用户指定 URL 和联网可信来源分别延后到 V0.4.4.1–V0.4.4.3，避免个人项目在一个版本同时实现解析、向量检索、联网抓取和来源安全。

### V0.4.5：Pydantic AI 与 LangGraph 迁移

1. 建立 FastAPI、Pydantic AI 和 LangGraph 工程；
2. 先迁移 `goal_onboarding` 和逐题诊断；
3. 再迁移课程生成和补课循环；
4. 使用持久化 checkpointer、`thread_id`、幂等键、超时和重试；
5. Next.js 继续作为数据库唯一业务写入方；
6. 浏览器不直接访问 Python 服务。

### V0.5：补课循环与独立考核

1. Tutor 不合格后的补充讲解和变式重测；
2. 间隔复习和长期薄弱能力回收；
3. Examiner 阶段大考；
4. 模拟面试；
5. 毕业门禁；
6. 形成性证据和总结性证据分开统计；
7. Examiner 通用考核数据结构。

## 12. V0.4.3 的实施顺序

### 12.1 先定义契约，不先改页面

1. `CapabilityType`；
2. `LessonOutline`；
3. `LearningBlock` 联合类型；
4. `LessonContentOutput`；
5. `EvidenceRequirement`；
6. `LessonQualityReport`；
7. 旧课节到新课节的兼容读取规则。

### 12.2 重写 Planner 骨架

- 按能力依赖生成模块；
- 按目标周期和可用时间生成预计课时；
- 每课限制合理目标数量；
- 标注能力类型和证据类型；
- 只安排骨架，不生成正文。

### 12.3 重写 Tutor 内容生成

Tutor 输入必须至少包含：

- 完整目标描述；
- 当前能力及依赖；
- 能力类型；
- 诊断中的具体强弱证据；
- 当前 LessonOutline；
- 可用来源片段接口；
- 领域策略；
- 已生成课程摘要，避免重复。

Tutor 输出为结构化内容块，不再输出单段 `explanation`。

### 12.4 增加质量门禁

- 结构硬校验；
- 目标覆盖校验；
- 通用模板命中校验；
- 内容具体性校验；
- 练习与教学内容对齐；
- 来源接口预留；
- 失败后保留草稿和原因，不标记 `ready`。

### 12.5 最后修改 UI

- 按内容块渲染；
- 展示生成模式和质量状态；
- 失败时提供重试；
- 展示预计时长和课程阶段；
- 不在 `quality_failed` 时展示正式课后考核入口。

## 13. V0.4.3 完成标准

### 13.1 结构与调度

- 课程节数不再固定为 5；
- 一周目标和三个月目标在模块、课时或节奏上产生可解释差异；
- 每节课最多聚焦少量明确目标；
- 后续课节继续按需生成，不提前生成全部正文。

### 13.2 内容质量

- 正式课节使用结构化 `LearningBlock[]`；
- 每个目标至少被一个教学块覆盖；
- 每课至少有一个具体示范/案例/worked example；
- 每课包含常见错误或适用边界；
- 练习能够由实际教学内容支持；
- 通用占位模板不能通过质量门禁；
- LLM 失败不能静默保存为正式课程；
- 软件开发领域至少验证概念课、调试课和项目课三种策略。

### 13.3 考核门禁

- `quality_failed` 或来源不足的课节不能生成正式课后题；
- 题目绑定本课目标和教学块；
- 参考答案和 rubric 不下发浏览器；
- 普通任务 PATCH 仍不能绕过答题完成门禁；
- 重测保留历史 attempt。

### 13.4 工程质量

- 数据库迁移同时覆盖新库和旧库；
- `typecheck`、`lint`、`db:validate`、生产构建通过；
- 端到端回归同时覆盖 LLM 成功、规则回退、质量失败和课程通过；
- README 与本文档同步更新；
- 课程生成记录 provider、model、Token、耗时、策略版本和质量结果。

## 14. 质量指标与项目亮点

当前不能宣称提升了学习效果百分比。V1 先建立可以持续统计的过程指标：

| 指标 | 含义 |
|---|---|
| `lesson_quality_pass_rate` | 初次生成即可通过质量门禁的课节比例 |
| `silent_fallback_rate` | 应为 0；模型失败不能静默成为正式课程 |
| `source_coverage` | 教学目标被可靠来源覆盖的比例 |
| `objective_block_coverage` | 每个目标是否有对应教学块 |
| `practice_alignment` | 练习与实际教学块的对应程度 |
| `generic_pattern_rate` | 课程中通用模板命中的比例 |
| `lesson_regeneration_rate` | 因质量不足重新生成的比例 |
| `formative_pass_rate` | 形成性小测通过率，需结合难度解释 |
| `mastery_gain` | 相同能力在可比前后测中的变化，后续建立 |

项目亮点应表述为：

> 构建一个证据驱动的通用学习内核：系统根据能力类型选择教学策略，以私有资料和可信网络来源生成结构化课程；课程只有通过目标覆盖、来源、具体性和练习对齐门禁后才能进入考核，并根据答题证据持续更新能力画像和后续计划。

## 15. 当前非目标

- V0.4.3 不实现所有学科领域策略；
- V0.4.3 不实现音频、视频和图片评分；
- V0.4.3 不引入 LangGraph/Pydantic AI；
- V0.4.3 不实现阶段大考和毕业门禁；
- V0.4.3 不宣称教育效果已经被真实用户实验验证；
- V0.4.3 不把本地通用模板扩写成新的伪课程；
- 移动端继续暂停。

## 16. 后续维护者必须保持的约束

1. 教学质量问题不能通过增加 Prompt 字数或更换更大模型简单宣布解决。
2. RAG 提供知识依据，教学内容模型提供教学结构，两者不能互相替代。
3. 课程未通过质量门禁时不能产生计入掌握度的正式考核。
4. Tutor 形成性证据不能直接充当阶段通过或毕业证明。
5. Examiner 初始诊断和后续考核是同一个角色的不同操作，不新增重复 Agent。
6. 参考答案、rubric 和受保护来源片段不能提前下发浏览器。
7. 掌握度、难度、任务完成和阶段门禁仍由确定性规则和 Next.js 事务控制。
8. 任何框架迁移都不得破坏现有幂等、恢复和数据库主权。
9. 编程是第一套领域策略，不得把代码字段写死进通用课程顶层契约。
10. 每次功能、接口、数据库或运行方式变化必须同步更新 README 和本文档。

## 17. 参考资料

- [V0.4.2 当前实现基线](IMPLEMENTATION_PLAN_V042.md)
- [Agent 角色与信息边界](AGENT_ROLES.md)
- [开发者手册](DEVELOPER_HANDBOOK.md)
- [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [Pydantic AI Structured Output](https://pydantic.dev/docs/ai/core-concepts/output/)
