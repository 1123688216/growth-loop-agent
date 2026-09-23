# Agent 角色与信息边界

## 2026-09-22 · RAGFlow 检索适配

RAG Tool 可直接检索按学习助手账号绑定的 RAGFlow 文档，并沿用目标范围、证据审核和来源快照。BGE-M3 查询编码在 RAGFlow 内执行；本项目只镜像原始片段供查看/引用，不再对绑定资料切片或向量化。课程生成与课堂答疑共用适配入口，原有上传/联网入库未迁移；其他角色和 LangGraph/Pydantic AI 分工不变。详见 `RAGFLOW_DEPLOYMENT.md` 第 7 节。

## 2026-09-16 · RAG 底层选型更新

RAG Tool 保留，目标底层改用 RAGFlow；LlamaIndex 旧路径在验收前保留，不增加 RAGFlow 教学 Agent，也不改变下文角色信息隔离。当前只增加独立部署配置，尚未迁移业务检索或接入 MinerU/Qwen。见 [部署与迁移边界](RAGFLOW_DEPLOYMENT.md)。

## 2026-09-15 · 框架职责约束

**跨步骤的状态、分支和恢复统一交给 LangGraph；节点内部的模型调用、工具执行和结构化输出交给 Pydantic AI。** 完整职责、权限、幂等和迁移检查规则见 [框架职责与编排边界](ARCHITECTURE_BOUNDARIES.md)，后续框架分工以该文档为准。

Tutor 等是业务角色，Pydantic AI 是承载模型调用和输出契约的框架，不自动提供教学或资料充分性判断能力。目前 Tutor/证据审核仍有 TypeScript 直接调用，LlamaIndex 也尚未接管全部检索链路；以上为已确认的目标架构，不代表迁移完成。下方历史记录描述对应时间的实现。

2026-09-07 研究流程：Pydantic AI 研究员只读取用户研究需求和最多五份候选标题/URL/摘要，生成结构化查询及推荐理由；无法决定用户身份、任意资料落库或突破搜索轮数。LangGraph 执行有限流程并等待用户选资料。Next.js 通过受控动作实际调用搜索及入库 Tool。研究员不读取用户完整资料库、答案标准或其他目标上下文。

2026-09-07：Tutor 新增可选 GroundedTutorContext，由服务端按用户/目标读取固定检索证据；生成和修订输出逐块 sourceChunkIds，来源状态由服务端计算。独立质量复核读取相同证据检查支持关系，模型回退不得放行来源课程。公开课程不包含证据全文。Tutor SubAgent 待功能完善后实施，课堂问答 RAG 留到下一步。

本文定义系统里各个 Agent 的职责、**能看到什么、明确看不到什么**，以及结构化输出契约。它跨版本有效，是各版实施方案的共同前提。

现有契约用 TypeScript 定义。V0.4.4 的课程主流程引入 Pydantic AI 时，字段一一对应转成 Pydantic 模型；Next.js 调用方和业务数据库契约不因框架迁移而改变。

## 1. 核心原则：导师负责“为了学会而测”，考官负责“证明已经会了”

系统需要同时保留两种用途完全不同的评测：

- **形成性评测 `formative`**——发生在学习过程中，题目必须紧扣导师刚教过的内容和用户当前卡点，目的是复习、加深印象、发现下一步该补什么。
- **总结性评测 `summative`**——发生在初始诊断、阶段验收、模拟面试和最终毕业时，题目依据目标能力和统一标准，目的是独立证明真实水平。

因此角色边界不是简单的“所有题都归考官”：

> **导师负责课程讲解、课内巩固题、课后小测和补充讲解；考官只负责初始诊断、阶段大考、模拟面试和毕业门禁。**

导师可以读取学习者画像和本节上下文，因为个性化本身就是小测价值的一部分。考官需要的参数由规划员或确定性学习策略传入（能力范围、难度、题量、题型），不读取日常提问、努力程度或历史小测反馈。盲评只能减少偏差；真正可复核还需要固定题目/rubric 快照、模型与 prompt 版本、归一化规则和重复评分回归。

## 2. 四个角色

### 规划员 Planner

掌握全局，做所有涉及学习者的判断。

| | |
|---|---|
| **可见** | 目标（标题、完成标准、目标日期、每周投入）、自评层级、背景描述、能力清单与掌握度、章节进度、历次评分的分数与能力标签 |
| **不可见** | 不需要课程正文全文（只需标题与能力点）。这是为省 token，不是信息隔离 |
| **产出** | `SkillMapOutput`、`CourseOutlineOutput`、`PlanReviewOutput`、`ProgressAdjustmentOutput` |

**复用场景**：① 创建目标时拆能力 ② 可行性审查 ③ 排课程骨架 ④ 学完一节后调整后续难度 ⑤ 后期周期性监督进度

### 导师 Tutor

把一个能力点讲清楚，通过紧扣当前教学内容的小测帮助学习者回忆、迁移和发现薄弱点，并在学习者卡住时接住他。

| | |
|---|---|
| **可见** | 当前章节能力点、目标、讲解正文、学习者在本节的提问历史、该能力掌握度；出题/评分操作可见本节巩固题的参考答案与 rubric |
| **不可见** | **考官的诊断题、阶段大考、模拟面试题及其参考答案与 rubric** |
| **产出** | `LessonContentOutput`、`LessonCheckSetOutput`、`LessonCheckGradeOutput`、`TutorReplyOutput` |

**为什么仍要拆分导师操作输入**：导师拥有巩固题答案不代表每次答疑都应携带答案。普通答疑使用不含题目答案的 `TutorReplyInput`；只有出题和提交后评分操作读取完整快照，避免用户在作答前通过普通追问直接套出答案。

**复用场景**：① 生成章节讲解正文 ② 章节内答疑 ③ 生成课内巩固题 ④ 评估课后答案 ⑤ 不合格后的补充讲解与重测

### 考官 Examiner

对目标能力标准负责，不参与日常教学。产品文案可称为“考官”或“面试官”。

| | |
|---|---|
| **可见** | 目标完成标准、待验证能力范围、统一评价蓝图、难度、题量和题型；评分时另加固定大考/面试题快照、参考答案、rubric、学习者答案或交付物 |
| **不可见** | **日常课程正文、本节提问历史、导师小测反馈、学习者身份、自评、掌握度、历史分数、目标日期、进度压力、剩余工时** |
| **产出** | `DiagnosticSetOutput`、`DiagnosticGradeOutput`、后续的 `MilestoneAssessmentOutput`、`InterviewEvaluationOutput` |

**为什么考官要盲**：它是学习成果的最终检验。一旦它知道「这是第三次重测」或「距离 deadline 只剩两周」，评分更容易受无关背景影响。盲评负责减少这种偏差；固定题目/rubric 快照、版本记录和确定性分数归一化共同构成可复核锚点。

**大考不围着课程正文出题**：考官基于「目标要求会什么」和统一能力标准出题，而不是基于「导师刚好教了什么」。这样才能发现课程遗漏，避免用户只会复述教学材料却不会独立应用。

**复用场景**：① 初始诊断出题与评分 ② 阶段大考 ③ 模拟面试 ④ 最终毕业验收。课程课后题和学习记录理解测验不属于考官。

### 复盘员 Reviewer

把一段时间的事实收拢成下一步。

| | |
|---|---|
| **可见** | 行动记录、任务完成情况、评测分数与时间分布 |
| **不可见** | 不需要课程正文与参考答案 |
| **产出** | `DailyReviewOutput` |

**复用场景**：① 晚间回顾 ② 周期性总结。当前由 `lib/agent/provider.ts` 承担。

### RAG 是 Tool，不是第五个角色

资料上传、纯文本提取、分块、索引、权限过滤、Token 预算和来源快照都由确定性服务负责，不新增“RAG Agent”或“资料管理员 Agent”。后续只向需要知识依据的角色注册窄 Tool：

- Planner 可调用 `search_knowledge_base` / `check_source_coverage`，判断资料能否覆盖能力与课程骨架；
- Tutor 可调用 `search_knowledge_base` / `read_source_chunks`，为当前教学块和形成性题目取得固定证据；
- Examiner 默认不读取日常课程检索结果；未来来源型大考只读取评价蓝图明确允许的固定资料快照；
- Reviewer 不调用资料检索 Tool。

Tool 从服务端会话和工作流上下文确定 `userId / goalId`，Agent 只能提交受限查询，不能读任意数据库、文件路径或其他用户的 chunk。每次调用写入检索运行，Agent 的产出只能引用该次运行返回的 chunk。这种边界允许 Agent 自主判断“何时检索”，但不把身份校验和数据库操作交给 LLM。

当前 Schema V9、个人资料库和结构化父子切片已落地，上述 Tool 尚未注册给任何角色；因此现阶段角色仍不能声称使用了用户资料。

## 3. 信息边界总表

| 数据域 | 规划员 | 导师 | 考官 | 复盘员 |
|---|:---:|:---:|:---:|:---:|
| 目标、完成标准 | ✓ | ✓ | ✓ | ✓ |
| 目标日期、每周投入、剩余工时 | ✓ | ✗ | **✗** | ✓ |
| 自评层级、背景描述 | ✓ | ✓ | **✗** | ✗ |
| 能力清单 | ✓ | ✓ | 仅当前能力 | ✗ |
| 掌握度 `skill_mastery` | ✓ | ✓ | **✗** | ✓ |
| 历次评分与尝试次数 | ✓ | ✗ | **✗** | ✓ |
| 章节正文 | 仅标题 | ✓ | **✗** | ✗ |
| 导师巩固题答案/rubric | ✗ | 仅出题与评分操作 | **✗** | ✗ |
| 考官大考答案/rubric | ✗ | **✗** | ✓ | ✗ |
| 学习者小测答案 | 仅分数 | ✓ | **✗** | 仅分数 |
| 学习者大考/面试答案 | 仅结果 | ✗ | ✓ | 仅结果 |
| 行动记录 | 仅统计 | ✗ | ✗ | ✓ |
| 用户资料原文件/任意 chunks | ✗ | ✗ | **✗** | ✗ |
| 当前 Tool 返回的固定证据包 | 仅覆盖分析 | ✓ | 仅来源型大考 | ✗ |

加粗的 ✗ 是**有意的隔离**，不是「暂时用不上」。其余的 ✗ 只是当前不需要，将来可以放开。

## 4. 边界靠类型强制，不靠自觉

延续 V0.4.1 的做法——用公开题目与带答案快照两个类型，让「参考答案下发到客户端」在编译期不可能发生。导师和考官分别再按操作切分输入：

```ts
/** 学习者画像：只有规划员、导师、复盘员的输入类型里能出现。 */
type LearnerContext = {
  selfLevel: SelfLevel;
  background: string;
  masteryBySkillId: Record<string, number>;
  recentScores: number[];
};

/** 导师生成巩固题：允许根据本节教学和学习者当前状态调整。 */
type TutorLessonCheckInput = {
  learner: LearnerContext;
  lesson: { skillId: string; objective: string; explanation: string; concepts: string[] };
  questionCount: number;
};

/** 普通答疑没有任何题目的参考答案。 */
type TutorReplyInput = {
  learner: LearnerContext;
  lesson: CourseLesson;
  question: string;
  history: TutorMessage[];
};

/** 导师提交后评分：完整快照只进入这个操作，不进入普通答疑。 */
type TutorLessonCheckGradeInput = {
  lesson: { skillId: string; objective: string };
  questions: LessonCheckQuestion[];
  answers: Record<string, string>;
};

/** 考官的输入类型里没有 LearnerContext，传不进去。 */
type ExaminerQuestionInput = {
  skill: { id: string; name: string; description: string };
  scope: { completionStandard: string; competencies: string[] };
  difficulty: 1 | 2 | 3 | 4 | 5;    // 规划员定的参数，不是判断
  questionCount: number;
  kinds: CourseQuestionKind[];
};

type ExaminerGradeInput = {
  questions: SummativeQuestion[];        // 固定大考/面试快照，含参考答案与 rubric
  answers: Record<string, string>;
};
```

配套的三条规则：

1. **组装考官输入的函数不接受 `LearnerContext` 参数**——没有入口就不会误传。
2. **导师普通答疑只接收公开题目类型**；带参考答案的快照只能进入导师的出题/评分操作。
3. **导师不能读取考官题库，考官不能读取课程正文和导师小测历史**。

`lib/db/programs.ts` 里的 `toPublicLesson()` 已经是这个模式，导师侧直接复用。

## 5. 谁做决策，谁做执行

沿用 [V1 实施方案 §3](IMPLEMENTATION_PLAN_V1.md)「普通函数承担规则」的原则，进一步细分：

| 事项 | 承担方 |
|---|---|
| 能力拆解、课程骨架、讲解内容、巩固题、大考题、评语 | **对应角色的模型操作** |
| 课程骨架怎样重排、需要补什么能力 | 规划员模型，仅在规则触发时调用 |
| 日常难度档位、导师题量、掌握度更新、课程合格阈值、工时求和 | **确定性 LearningPolicy** |
| 大考范围、面试题型与毕业标准 | 规划员给出能力范围，考官按统一评价蓝图执行 |
| 题目数量/字段/难度分布/能力覆盖校验 | **普通函数** |
| 用户归属、状态机、幂等键、数据库事务 | **普通函数** |

模型不做算术，不做权限判断，不写数据库。

## 6. 结构化输出契约

```ts
// —— 规划员 ——
type SkillCandidate = {
  key: string; name: string; why: string;
  targetLevel: 1 | 2 | 3 | 4 | 5;
  estimatedHours: number;
  prerequisiteKeys: string[];
};
type SkillMapOutput = { skills: SkillCandidate[]; notes: string[] };

type OutlineLesson = {
  title: string; objective: string;
  skillId: string;                   // goal_skills 落库后得到的稳定 id
  difficulty: 1 | 2 | 3 | 4 | 5;     // 传给考官的参数
  durationMinutes: number;
};
type CourseOutlineOutput = {
  title: string; summary: string; outcomes: string[]; cadence: string;
  instructor: { name: string; role: string; style: string; openingMessage: string };
  lessons: OutlineLesson[];
};

type PlanReviewOutput = { reason: string; adjustments: string[] };
type ProgressAdjustmentOutput = { note: string; actions: string[] };

// —— 导师 ——
type LessonContentOutput = {
  opening: string; explanation: string; example: string;
  practice: string; deliverable: string;
};                                    // 注意：不含 questions
type TutorReplyOutput = { reply: string; followUp: string };

type LessonCheckQuestion = {
  skillId: string;
  kind: CourseQuestionKind;
  prompt: string; hint: string;
  referenceAnswer: string; rubric: string;
  maxScore: number;
};
type LessonCheckSetOutput = { questions: LessonCheckQuestion[]; reinforcementGoal: string };
type LessonCheckGradeOutput = {
  score: number; summary: string; nextStep: string;
  feedback: QuestionGrade[];
};

// —— 考官 ——
type SummativeQuestion = {
  skillId: string;                    // 持久化能力 id；诊断、大考和面试证据都以它归属
  kind: CourseQuestionKind;
  prompt: string; hint: string;
  referenceAnswer: string; rubric: string;
  maxScore: number;
};
type DiagnosticSetOutput = { questions: SummativeQuestion[]; coverageNotes: string[] };

type QuestionGrade = { questionId: string; score: number; maxScore: number; feedback: string; reference: string };
type DiagnosticGradeOutput = { score: number; summary: string; skillScores: Record<string, number>; feedback: QuestionGrade[] };

// 阶段大考和模拟面试在后续版本补充独立契约，不能复用导师小测结果充当毕业证明。
type MilestoneAssessmentOutput = { /* V0.5 */ };
type InterviewEvaluationOutput = { /* V0.5 */ };

// —— 复盘员 ——
type DailyReviewOutput = { summary: string; highlights: string[]; nextStep: string };
```

`QuestionGrade.score` 是该题原始得分，必须满足 `0 <= score <= maxScore`；导师和考官输出中的总分都由服务端按固定公式重新计算为 0–100，不能直接信任模型自己给出的总分。模型输出、标准化得分、证据类型和题目快照都要保留。

诊断题契约与 [V1 实施方案 §2](IMPLEMENTATION_PLAN_V1.md) 的 `DiagnosticQuestion` / `DiagnosticSet` 对齐；导师巩固题使用相近字段，但必须保留不同的输出类型和 `formative` 证据标签。

## 7. 复用矩阵

| Agent | 复用场景 | 变化的只是输入参数 |
|---|---|---|
| 规划员 | 拆能力 / 可行性审查 / 排骨架 / 学完调整 / 周期监督 | 触发时机与已有掌握度 |
| 导师 | 生成正文 / 答疑 / 课内出题 / 课后评分 / 补充讲解 | 当前章节、学习状态、操作阶段 |
| 考官 | 初始诊断 / 阶段大考 / 模拟面试 / 毕业验收 | 目标能力范围、统一标准、难度、题型 |
| 复盘员 | 晚间回顾 / 周期总结 | 时间窗口 |

一个角色共享同一套职责、信息边界和公共 policy prompt；不同操作可以有各自的 operation prompt 与输出类型。导师的“讲课/答疑/小测”和考官的“诊断/大考/面试”必须是两个角色；同一角色内部则不为每个操作创建新的 Agent 身份。

## 8. 与编排框架的关系

角色划分和信息边界**与是否使用 LangGraph 无关**。它们由输入类型的形状决定，在任何编排方式下都成立：手写函数调用、LangGraph 节点、或将来别的框架。

LangGraph 解决的是另一类问题——需要停下来等用户、按状态分支、循环修复和断点恢复。V0.4.2 的初始诊断已经包含等待用户，V0.4.3 已经形成课程质量修复循环；V0.4.4 又增加资料覆盖分支和来源不足等待。图编排的收益条件已经满足，因此在目标范围 RAG Tool 完成后、Tutor 接入 EvidenceBundle 之前，先把目标准备与课程生成主流程迁移为 `interrupt` 与 checkpoint：

- 创建目标时让用户勾选能力模块
- 初始诊断出题后等待作答
- 资料不足时等待用户上传资料或授权联网
- 课程质量未通过时执行有限修复并保留每次结果
- 不合格 → 补充讲解 → 重测的循环

### 各角色最终落在哪一侧

服务边界已定（2026-08-27，见 [V1 实施方案 §4](IMPLEMENTATION_PLAN_V1.md)）：

| 关注点 | 归属 |
|---|---|
| 图、状态、分支、`interrupt`、checkpoint | Python · LangGraph |
| 节点内的模型调用与 `output_type` 校验 | Python · Pydantic AI |
| 图内路由、分支条件和重试选择 | Python 普通函数 |
| **分数归一化、掌握度、合格阈值、完成门禁** | **Next.js 普通函数**，与数据库写入处于同一事务 |
| **数据库写入、事务、归属校验** | **Next.js**，Python 节点只提交结构化模型证据 |
| 页面、登录、会话 | Next.js |

四个 Agent 最终都定义在 Python 侧。V0.4.2 先在 Node 实现，是为了让 prompt 与输出契约先被真实流程验证——它们是语言无关的资产，迁移时复制即可。

为此，**Node 侧的 Agent 一律写成纯函数**：`buildSkillMap(input): Promise<SkillMapOutput>`，内部不碰数据库、不读会话。将来它整体变成一个 Python 节点，调用点只换一行。这条约束比它看起来重要——一旦 Agent 函数里混进落库或鉴权，迁移就从「换调用点」变成「拆函数」。
