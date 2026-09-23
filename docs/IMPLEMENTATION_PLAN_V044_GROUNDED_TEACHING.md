# V0.4.4 子方案：资料驱动的可追溯教学闭环

> 文档状态：**阶段 A/B 已实现，阶段 C 已完成最小编排 MVP，阶段 D 待开始**  
> 本轮目标：把已经完成的文件解析、父子切片和文本 Embedding 接入课程与形成性题目；本地资料闭环稳定后，再增加联网资料补充。  
> 当前原则：暂不以提高召回率或教学效果为主目标，先保证来源、教学、出题和评分之间的数据关系真实、可回放、可失败。
> 编排决策：目标资料绑定和本地检索 Tool 完成后，先以 LangGraph + Pydantic AI 迁移“目标准备—诊断等待—证据检索—课程生成—质量修复—发布”主流程，再修改 Tutor 为证据驱动生成；不再把框架迁移整体延后到课程闭环完成之后。

## 1. 版本结论

当前项目已经能够完成：

```text
用户上传 TXT / PDF / DOCX / 文本
→ MinerU 或本地解析器提取内容
→ 恢复标题、段落、列表、代码、表格等结构
→ 生成不可变 Parent / Child ChunkSet
→ 对 Child 生成 Embedding
→ 在单份资料内执行向量检索并展开 Parent
→ 为目标自动纳入、排除或严格指定资料
→ 跨目标资料范围返回固定 EvidenceBundle
```

但上述能力尚未进入学习闭环。现在的课程、教学方法、题目、参考答案和评分标准主要由 LLM 根据目标与能力描述生成，系统无法稳定回答：

- 这一段知识来自哪份资料；
- 这道题是否只考查已经教过的内容；
- 参考答案和评分标准依据什么；
- 资料后来重新上传或重新切片后，旧评分依据是否发生变化；
- 资料不足时，系统是否偷偷使用了模型自身知识。

本子方案要形成的核心链路是：

```text
学习目标
→ 绑定资料
→ 检索固定证据
→ 基于证据生成教学块
→ 基于已教学块生成题目
→ 固定题目、答案、rubric 和来源快照
→ 按固定快照评分
→ 写回能力证据与后续课程状态
```

联网搜索不是另一套 RAG。它只负责发现并收录新的 Source，收录后必须重新进入统一的解析、切片、Embedding、检索和引用链路。

---

## 2. 三种内容必须分开

### 2.1 知识依据

知识依据回答“教的内容和正确答案从哪里来”，来源可以是：

1. 用户上传或粘贴的个人资料；
2. 用户明确选择后收录的网页；
3. Agent 在资料不足时搜索并经过用户确认或来源策略允许后收录的网页；
4. 未来预置的官方文档、标准、教材或题库。

事实、规则、定义、代码行为、边界和参考答案中的知识性结论必须由固定来源片段支持。

### 2.2 教学策略

教学策略回答“怎么教”，不应伪装成知识来源。首版使用版本化的本地策略目录，由能力类型确定允许使用的结构：

| 能力类型 | 默认教学结构 |
|---|---|
| 概念理解 | 解释 → 关系 → 正反例 → 边界 → 主动回忆 |
| 程序技能 | 演示 → 分步实践 → 常见错误 → 独立实现 → 验证 |
| 问题解决 | 问题建模 → 方案选择 → 完整案例 → 迁移问题 |
| 表达沟通 | 结构示范 → 要点组织 → 教回 → 反馈修订 |
| 记忆辨析 | 对比 → 易混点 → 回忆 → 辨析 → 间隔复测 |
| 综合创作 | 约束分析 → 方案 → 产物 → 评审 → 迭代 |

LLM 可以选择、组合和填充策略，但不能把自己选择的教学方法声明成资料事实。

### 2.3 题目组织

LLM 负责把已经教学的内容组织成题目。不同题型的来源约束不同：

| 题型 | 来源要求 |
|---|---|
| 事实题、规则题、代码行为题 | 必须绑定支持结论的来源片段 |
| 概念解释题 | 参考答案必须受已教学来源约束 |
| 辨析题 | 正确项、错误项和判断依据必须有来源 |
| 迁移应用题 | 场景可以由 LLM 构造，但不得引入未教学事实 |
| 实践任务、反思题 | 可以没有直接事实引用，但完成标准必须来自课程目标和已教学方法 |

---

## 3. 统一来源模型

所有来源都进入同一条主链：

```text
KnowledgeSource
└─ SourceVersion
   ├─ ParseRun
   │  └─ DocumentNode
   └─ ChunkSet
      ├─ ParentChunk
      │  └─ ChildChunk
      └─ ChunkEmbedding
```

来源方式与内容格式必须保持正交：

```text
origin_type: upload / pasted_text / user_url / web_search / curated
content_format: text / markdown / html / pdf / docx
```

当前 `knowledge_sources.kind` 仍兼容 `text / txt / pdf / docx`。增加 URL 和搜索入口时，应补充来源方式字段，不能把 `web` 当作一种内容格式。

### 3.1 来源可信等级

首版只用于展示和筛选，不宣称自动判断绝对正确：

| trust_level | 含义 |
|---|---|
| user_provided | 用户自己上传或粘贴，系统只保证可追溯 |
| official | 官方文档、标准、机构网站 |
| reviewed | 用户或维护者确认过的普通网页 |
| unverified | 已收录但尚未确认可信度 |

`grounded` 只表示课程能回到固定来源，不等于来源本身绝对正确。

---

## 4. 目标与资料范围

同一份 Source 可以绑定多个学习目标，不复制原文、版本、切片或向量。

Schema V11 的首个 MVP 不把资料强制分组，而是让每个目标选择范围策略：

```text
goal_learning_profiles.source_scope_mode = auto / selected

auto
→ 默认纳入当前用户全部非删除资料
→ goal_source_links 只保存 status=disabled 的显式排除项

selected
→ goal_source_links 只保存 status=active 的严格纳入项
```

原设计中的扩展字段继续作为后续目标结构，不阻塞首个 Tool：

```text
goal_id
source_id
user_id
status                  active / disabled
purpose                 对该目标的用途
scope_note              使用范围或排除章节
priority                资料优先级
added_via               user / planner / tutor / web_search
created_at
updated_at
```

权限规则：

- Goal 和 Source 必须属于同一登录用户；
- API 不接受客户端提交的 `userId`；
- 资料软删除后不能参与新检索，但历史 RetrievalRun 继续保留快照；
- 解除绑定只改变未来检索范围，不删除 Source；
- 每次检索必须重新验证 Goal、Source、active SourceVersion 和 active ChunkSet。

### 4.1 UI

当前已实现一个必要入口：

1. 长期目标卡片中的“资料范围”，用于选择自动范围、排除资料或严格指定资料。

个人资料库中的“用于哪些目标”反向关系暂未实现，不影响目标检索范围成立。

创建目标弹窗暂不强制同时上传资料，避免把目标创建和耗时解析耦合在一个请求中。目标创建完成后，若没有可用资料，课程区展示“添加资料后生成来源课程”。

---

## 5. Agentic RAG Tool

RAG 继续作为 Tool，不增加第五个 Agent。

### 5.1 `search_knowledge_base`

```ts
type SearchKnowledgeBaseInput = {
  query: string;
  topK?: number;
  maxEvidenceTokens?: number;
  mode?: "auto" | "fts5" | "vector";
  model?: "bge-m3" | "qwen3-embedding-0.6b";
};

type SearchKnowledgeBaseContext = {
  userId: string;
  goalId: string;
  lessonId?: string;
  skillId?: string;
  purpose: "lesson_generation" | "classroom_qa";
};

type SearchKnowledgeBaseOutput = {
  retrievalRunId: string;
  retrievalMode: "fts5" | "vector_exact" | "fts5_fallback";
  status: "sufficient" | "insufficient";
  evidence: RetrievedEvidence[];
  totalEvidenceTokens: number;
  insufficiencyReason: string;
};
```

Agent 可见输入和服务端注入上下文必须分开。Tool 从工作流上下文取得 `userId / goalId / lessonId / skillId / purpose`，模型不能提交任意 Source ID、Chunk ID 或文件路径。当前 `/api/rag/search` 是登录保护的调试/BFF 入口，会从登录会话取得 `userId`；未来 Agent 注册应直接使用服务端 Tool wrapper。

### 5.2 检索模式

首版 `auto` 路由：

```text
所有 active Source 都有指定模型的完整向量
→ vector

否则
→ FTS5
```

当前 `auto` 已按上述规则实现；显式 `vector` 在范围内向量不完整时返回可解释冲突，自动向量查询失败则降级为 `fts5_fallback`。混合检索和 reranker 不属于本轮阻塞条件，后续加入时不能改变 Tool 输出和 EvidenceBundle 契约。

### 5.3 EvidenceBundle

每条证据至少保存：

```text
source_id / source_version_id / chunk_set_id
parent_chunk_id / child_chunk_id
source_title / origin_type / trust_level
section_path / page_start / page_end
child_snapshot_text / child_snapshot_hash
expanded_parent_snapshot / parent_snapshot_hash
retrieval_score / rank
```

检索分数只表示排序相似度，不表示真实性。

### 5.4 `check_source_coverage`

```ts
type SourceCoverageInput = {
  goalId: string;
  lessonId?: string;
  requiredConcepts: string[];
  retrievalRunId?: string;
};

type SourceCoverageOutput = {
  status: "sufficient" | "partial" | "insufficient";
  coveredConcepts: string[];
  missingConcepts: string[];
  evidenceByConcept: Record<string, string[]>;
  recommendation: "continue" | "add_source" | "search_web";
};
```

首版覆盖判断允许使用确定性规则加一次结构化 LLM 判断，但 LLM 只能判断现有证据是否支持概念，不能补写缺失证据。

---

## 6. 课程生成如何接入证据

### 6.1 生成顺序

```text
读取 Goal、Skill、Lesson 和掌握证据
→ 构造本课知识查询
→ search_knowledge_base
→ check_source_coverage
→ 来源不足则停止正式生成
→ 根据教学策略和 EvidenceBundle 生成 LearningBlock[]
→ 确定性检查块级引用
→ 教学语义质量复核
→ 保存不可变内容版本和块级来源
```

### 6.2 Tutor 输入

Tutor 新增受控字段：

```ts
type GroundedTutorContext = {
  retrievalRunId: string;
  evidence: RetrievedEvidence[];
  coverage: SourceCoverageOutput;
  pedagogyStrategyVersion: string;
};
```

LLM 收到的是带编号、边界和来源元数据的证据，不接收整份文件。来源正文必须被标记为不可信数据，不能覆盖系统指令。

### 6.3 LearningBlock 来源规则

每个需要事实支持的教学块必须输出 `sourceChunkIds`。服务端只接受当前 RetrievalRun 中存在的 Child ID，并写入 `lesson_block_sources`。

以下内容必须有来源：

- explanation、concept_relation、comparison；
- worked_example、case_study、demonstration 中的事实、规则和代码行为；
- common_mistake、boundary 中的知识性判断；
- summary 中对知识内容的总结。

以下内容允许只绑定教学目标：

- reflection；
- 纯过程型 guided_practice；
- 用户自选主题的综合创作任务。

### 6.4 发布状态

```text
source_insufficient   来源不足，不发布正式课
quality_failed        来源足够，但教学质量失败
partially_grounded    只有部分必要教学块有来源，只可预览
grounded              来源硬门禁和教学质量门禁均通过
```

`grounded` 必须由服务端计算，LLM 不能自行声明。

---

## 7. 题目、答案和评分快照

### 7.1 题目生成输入

Tutor 只能读取：

- 当前已发布的 LearningBlock；
- 这些 LearningBlock 已绑定的来源证据；
- 当前能力和形成性考核目标；
- 允许使用的题型与难度。

它不能重新搜索未教学资料，也不能使用课程生成之外的新事实。

### 7.2 题目契约

```ts
type GroundedCourseQuestion = {
  id: string;
  skillId: string;
  contentVersionId: string;
  taughtBlockIds: string[];
  sourceChunkIds: string[];
  retrievalRunId: string;
  kind: "理解" | "辨析" | "迁移" | "教回" | "实践";
  difficulty: number;
  prompt: string;
  hint: string;
  referenceAnswer: string;
  rubric: string;
  expectedConcepts: string[];
  maxScore: number;
};
```

硬规则：

- `taughtBlockIds` 必须属于当前不可变内容版本；
- `sourceChunkIds` 必须属于这些教学块来源的并集；
- 每个事实型问题至少有一个来源；
- 参考答案和 rubric 只能使用固定来源快照；
- 客户端不返回参考答案、完整 rubric 或内部检索分数。

### 7.3 固定评分

用户提交答案时：

```text
读取题目快照
→ 读取生成时的参考答案、rubric 和来源快照
→ Tutor 评分
→ 保存逐题评分与反馈
→ 更新 skill_mastery
→ 决定通过、补课或重试
```

评分期间禁止：

- 新建 RetrievalRun；
- 读取资料的新版本；
- 联网搜索；
- 临时改写参考答案或 rubric；
- 因为截止日期临近而降低通过标准。

---

## 8. 联网搜索作为资料补充

联网搜索排在本地资料教学闭环之后实现。

### 8.1 触发条件

只有以下条件之一满足时才能触发：

- 用户主动点击“联网补充资料”；
- `check_source_coverage` 返回 `insufficient`，用户允许联网；
- 目标明确要求官方最新文档，而资料库不存在对应版本。

### 8.2 Tool 链

```ts
search_web({ goalId, query, maxResults })
→ WebSearchCandidate[]

preview_url({ url })
→ UrlPreview

ingest_url({ goalId, url, intent, description })
→ IngestionJobView
```

### 8.3 搜索结果不能直接教学

```text
搜索标题和摘要
→ 只作为候选展示
→ 选择少量来源
→ 抓取正文
→ 建立 SourceVersion
→ 解析、切片、Embedding
→ 绑定 Goal
→ search_knowledge_base
→ 才能进入课程和题目
```

搜索摘要、搜索引擎生成答案和网页片段不能直接写入正式课程。

### 8.4 来源选择策略

默认优先级：

```text
官方文档 / 标准 / 原始论文
→ 高校、研究机构、成熟技术社区
→ 作者明确且可追溯的技术文章
→ 普通博客和论坛仅作补充
```

如果来源冲突，系统保存冲突证据并展示，不允许 LLM 静默选择对自己生成最方便的一方。

### 8.5 网页更新

网页只在收录时抓取一次。打开课程、检索或评分时不自动更新。用户主动重新抓取时创建新的 SourceVersion，旧课程继续引用旧快照。

---

## 9. API 设计

### 9.1 目标资料

```text
GET    /api/goals/[id]/sources
POST   /api/goals/[id]/sources
DELETE /api/goals/[id]/sources?sourceId=
```

POST 请求只接受：

```json
{
  "sourceId": "source-id",
  "purpose": "用于掌握 Agent 工具调用",
  "scopeNote": "重点使用第 3-6 章",
  "priority": 80
}
```

### 9.2 检索和覆盖

Agent 内部优先调用 TypeScript Tool，不把任意 Chunk ID 暴露给普通客户端。调试阶段可增加登录保护的预览接口：

```text
POST /api/goals/[id]/retrieval-preview
POST /api/goals/[id]/source-coverage
```

### 9.3 联网资料

```text
POST /api/web-search
POST /api/web-search/[runId]/results/[resultId]/ingest
POST /api/knowledge-sources/url
GET  /api/knowledge-sources/[id]/ingestion-status
```

---

## 10. 数据库变更建议

下一次 Schema 版本只增加当前闭环需要的字段，不提前创建完整联网平台。

### 10.1 扩展 `goal_source_links`

```text
purpose TEXT NOT NULL DEFAULT ''
scope_note TEXT NOT NULL DEFAULT ''
priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100)
added_via TEXT NOT NULL DEFAULT 'user'
updated_at TEXT NOT NULL DEFAULT ''
```

### 10.2 扩展 RetrievalRunItem 快照

现有 `snapshot_text` 应明确保存展开后的 Parent 快照，并补充：

```text
parent_chunk_id
chunk_set_id
child_snapshot_text
child_snapshot_hash
parent_snapshot_text
parent_snapshot_hash
section_path_json
page_start
page_end
```

不能只保存一个语义不明确的 `snapshot_text`。

### 10.3 课程和题目关系

优先复用：

- `lesson_block_sources`
- `question_source_links`
- `lesson_content_versions`
- `lesson_assessment_attempts`

只有现有 JSON 题目结构阻碍固定快照和独立查询时，才在后续迁移为 `course_questions` 独立表；本轮不为“表结构看起来更规范”而提前重构。

### 10.4 联网阶段再增加

```text
web_search_runs
web_search_results
ingestion_jobs
```

搜索候选与正式 Source 分表保存，只有成功抓取的结果才能创建 Source。

---

## 11. 失败状态与恢复

用户界面不能把所有问题都显示成“课程生成失败”。至少区分：

```text
no_bound_source             目标没有绑定资料
source_processing           资料仍在解析或向量化
source_insufficient         资料无法覆盖本课知识
retrieval_failed            检索服务失败
grounding_validation_failed LLM 引用了检索集合外片段
quality_failed              教学质量门禁失败
question_grounding_failed   题目超出已教学范围
grading_snapshot_missing    固定评分快照损坏
web_search_failed           联网候选发现失败
web_ingestion_failed        网页抓取或解析失败
```

恢复原则：

- 重试不能覆盖旧 RetrievalRun、课程版本或题目快照；
- 同一幂等键重复请求不能生成两套有效课程；
- 资料不足是可解释业务状态，不是系统异常；
- 联网失败后仍保留已有本地资料和课程；
- 评分快照损坏时停止评分，不允许临时重新生成答案。

---

## 12. 安全边界

- 用户资料、网页和搜索结果全部视为不可信数据，不能改变系统Prompt或调用Tool；
- 所有 Tool 的用户身份来自服务端Session；
- Source、Goal、Chunk、RetrievalRun和课程版本每次读取都验证用户归属；
- URL 收录禁止 localhost、内网地址、云元数据地址、`file://` 和非 HTTP/HTTPS 协议；
- 每次重定向后重新验证地址；
- 不自动登录、不绕过付费墙、不提交网页表单；
- 日志不记录 LLM API Key、本地模型路径和不必要的整份资料正文；
- 上传资料发送给外部 LLM 前，页面必须明确提示模型提供方与数据用途。

---

## 13. 可观测性

统一记录：

```text
资料绑定耗时
检索模式与降级原因
Query Embedding / FTS / Vector / Parent Expand 耗时
候选数、返回数、Evidence Token
来源覆盖状态与缺失概念
课程生成与质量修复次数
教学块来源覆盖率
题目来源覆盖率
评分模型、Prompt版本、Token和耗时
联网搜索、抓取、解析与收录耗时
```

本轮不要求形成正式召回率结论，但所有 RetrievalRun 必须可回放，给后续固定集评测保留数据。

---

## 14. 测试与验收

### 14.1 数据与权限

- 用户 A 不能绑定、检索或查看用户 B 的 Source；
- 同一 Source 可绑定多个 Goal，不复制 Chunk 和 Embedding；
- 解除绑定后未来检索排除该 Source；
- Source 软删除后历史课程引用仍可回放；
- 新 ChunkSet 激活后，旧课程仍使用原 RetrievalRun 快照。

### 14.2 本地来源闭环

使用一份固定 PDF 验证功能正确性，不据此宣称通用召回率：

1. 目标绑定资料；
2. 生成一节 grounded 课程；
3. 每个必要教学块都有合法来源；
4. 三道形成性题目只考已教学内容；
5. 提交答案时不会产生新的 RetrievalRun；
6. 更新或重新切片资料后，旧评分结果保持可回放；
7. 移除资料后，新课程进入 `no_bound_source` 或 `source_insufficient`。

### 14.3 联网来源闭环

- 搜索候选不会直接进入知识索引；
- 只有选中且抓取成功的网页创建 Source；
- URL 来源经过统一解析、切片和 Embedding；
- 网页重新抓取创建新版本，不覆盖旧版本；
- 内网和非法协议测试全部拒绝；
- 搜索或抓取失败不会破坏本地课程。

---

## 15. 实施顺序

当前 `prepareGoalLoop → generateCourseForGoal → buildQualityCheckedLesson` 已经手动实现了分支、等待、质量检查、修复循环和进度回调。若先把检索、覆盖门禁和来源绑定继续写入这组函数，再迁移 LangGraph，会重复拆分同一条课程生成链。因此顺序固定为：

```text
目标资料绑定
→ 本地 Agentic RAG Tool
→ LangGraph / Pydantic AI 最小编排层
→ 证据驱动课程
→ 证据驱动题目与固定评分
→ 联网资料补充
```

### 阶段 A：目标—资料范围（已完成 MVP）

1. 已增加 `goal_learning_profiles.source_scope_mode`，并复用 `goal_source_links` 保存自动排除项或严格纳入项；
2. 已增加数据库读写与范围解析函数；
3. 已增加登录保护的目标资料范围 API；
4. 已在长期目标卡片增加“资料范围”入口；
5. 已覆盖跨用户、排除、严格纳入和旧目标画像补齐测试。

完成情况：用户既可以不分组、默认让目标自动检索全部个人资料，也可以排除不相关资料或切换为严格白名单。

### 阶段 B：本地检索 Tool（已完成核心）

1. 已实现目标范围的 `search_knowledge_base`；
2. `auto` 已在范围内向量完整时使用 vector，否则使用 FTS5，并支持查询向量失败时降级；
3. 已实现 Parent 去重、单资料上限、Token 预算和固定 RetrievalRun/Item；
4. 已实现基础覆盖状态：无可用资料、无命中、课节生成证据过少；按 required concepts 的独立语义覆盖与冲突检查后续补充；
5. 已增加登录保护的 `/api/rag/search` 和隔离数据库冒烟测试。

完成情况：给定 Goal、用途和查询，可以稳定返回合法、可回放的 EvidenceBundle。当前 Tool 尚未注册给 Tutor，也未被课堂提问 UI 调用。

### 阶段 C：LangGraph / Pydantic AI 最小编排层

1. 建立 Python FastAPI workflow service，浏览器仍只访问 Next.js；
2. LangGraph 只负责编排目标准备、诊断等待、资料覆盖、课程生成、质量修复和发布；
3. Pydantic AI 负责节点内 Planner、Tutor、Examiner 与质量复核的结构化模型调用；
4. 将现有 `prepareGoalLoop`、`generateCourseForGoal` 和 `buildQualityCheckedLesson` 拆为可单测节点；
5. 使用持久化 checkpointer 和稳定 `thread_id`，图状态只保存 Goal、Diagnostic、RetrievalRun、CourseVersion 等 ID、小型路由状态和错误摘要；
6. 为“等待诊断回答”和“资料不足，等待上传或授权联网”建立显式 `interrupt`；
7. 每个可能产生副作用的节点使用幂等键、输入哈希和已完成结果复用；
8. 前端进度事件来自已持久化节点状态，不再只依赖当前 HTTP 请求里的临时百分比。

完成条件：创建目标或生成课程的请求中断、浏览器刷新或服务重启后，可以从最近完成的节点继续；相同 `thread_id + node + attempt` 不会重复创建课程版本、检索快照或题目。

完成情况（2026-09-01）：已完成最小主图和跨服务边界。`services/workflow` 使用 FastAPI、LangGraph SQLite checkpointer、稳定 `thread_id`、外部动作 interrupt、诊断 interrupt 与资料不足 interrupt；Next.js 使用 Schema V12 `workflow_runs / workflow_events` 持久化进度与幂等动作结果，并继续拥有用户身份、业务数据库事务和 Tool 调用权。检索动作额外把工作流键写入 RetrievalRun 过滤快照，可覆盖“检索已提交、动作结果尚未缓存”这一进程退出窗口。Pydantic AI 当前只负责结构化检索计划，未配置模型时走同一输出模型校验的确定性回退。

本阶段仍有两个刻意保留的拆分点：课程质量检查/修复循环目前作为 `generate_course` 内部的 TypeScript 子流程执行，还不是独立 Graph 节点；Planner/Tutor/Examiner/Guard 现有结构化调用尚未全部迁移到 Pydantic AI。它们不阻塞断点恢复 MVP，但在阶段 D 做 GroundedTutorContext 时应继续拆分，不能把“已接框架”写成“全部 Agent 已迁移”。

本阶段不是全项目重写。文件解析、切片、Embedding、检索计算、权限校验、评分归一化、掌握度更新和业务数据库事务继续由确定性服务负责。

### 阶段 D：证据驱动课程

2026-09-07 首轮实现：GroundedTutorContext 接入生成、语义复核和修订；工作流首课复用检索快照，独立入口及后续课节按本节目标检索。逐块引用白名单校验，保存实际关联及 snapshotHash；页面默认收起有限来源视图。复用 Schema V12，不回填旧课程。

grounded 由服务端在引用、质量和带证据的语义复核通过后计算，规则回退不能通过来源验证。无资料 auto Demo 保留 unverified；selected 范围或已有候选资料不足返回 source_insufficient。后续课节资料不足目前为可重试错误，未扩展成图 interrupt。

本轮来源工具回归、typecheck、lint、生产构建和原有三类规则课程 API 回归通过。策略版本目录、逐概念覆盖、真实 LLM 教学质量验证仍待完成，因此阶段 D 尚未全部完成。Tutor SubAgent 按用户决定延期。

1. Tutor 输入增加 GroundedTutorContext；
2. 版本化教学策略目录；
3. LearningBlock 输出受控 `sourceChunkIds`；
4. 保存 `lesson_block_sources`；
5. 增加来源硬门禁和 `source_insufficient`；
6. 课程页展示有限来源视图。

完成条件：每个必要教学块都能回到生成时实际使用的资料片段。

### 阶段 E：证据驱动题目与固定评分

1. 题目只读取已教学块和其来源；
2. 保存 `question_source_links`；
3. 固定题目、答案、rubric 和来源快照；
4. 评分期间禁止检索；
5. 完成后写回 SkillMastery 和下一课状态。

完成条件：资料更新后旧题目的评分标准不变化。

### 阶段 F：联网资料补充

2026-09-07 三层编排增量：Schema V14。Pydantic AI 输出 QueryPlan 与候选推荐；LangGraph 控制最多两轮外部搜索请求、无合适结果分支、用户选择 interrupt、收录与完成。Next.js 负责执行搜索/收录 Tool 与动作缓存、权限和索引。UI 通过研究 ID 恢复当前轮，每轮选一份资料。默认 DeepSeek Responses 原生搜索，正文提取仍为 Tavily。外层预算不约束 DeepSeek 内部搜索次数。当前只缓存完成动作，外部成功但落库前崩溃可能重发，不保证付费调用恰好一次；多实例锁及直接 URL 导入仍待完善。研究员未配置模型时明确返回 rules，无模型推荐。

2026-09-07：按用户要求提前实现手动联网补充 MVP。资料范围面板 → Tavily 搜索候选 → 用户选中候选 ID → Extract 正文 → 原有 ingestion → SourceVersion/ChunkSet → 绑定目标 → 尝试 Qwen3 Embedding。向量不可用时保留 FTS5。Schema V13 保存候选归属和 URL 收录映射。API 为 POST /api/web-sources，action=search/import；Tool 上下文由服务端注入。搜索、抓取、解析、向量化均计时。

重复 URL 不重新抓取；删除资料后允许重新收录。应用只访问固定提供商 API，网页跳转由提供商处理；不是本地任意 URL 抓取器。UI 预览标题和摘要，不宣称已验证来源可信度。模拟提供商隔离回归、构建和 Schema 校验通过，真实联网质量尚待有效 Key 联调。正文预览、直接 URL 导入、Agent 自主调用搜索与自动恢复课程尚待后续，因此本阶段未全部完成。

1. `search_web` 只返回候选；
2. 来源预览和可信等级展示；
3. 用户选择后 `ingest_url`；
4. URL 进入统一 Source 主链；
5. 绑定 Goal 并重新执行覆盖检查；
6. 增加 URL 安全测试。

完成条件：本地资料不足时，用户可以补充少量网页并生成同样可追溯的课程。

---

## 16. Definition of Done

- [ ] 用户可以为目标绑定、停用和解除资料；
- [ ] 检索只访问当前用户、当前目标、active Source 和 active ChunkSet；
- [ ] Agent 不能提交任意 userId、Source ID 或 Chunk ID；
- [ ] RetrievalRun 同时保存 Child 命中和 Parent 展开快照；
- [ ] 所有必要教学块均绑定当前 RetrievalRun 中的证据；
- [ ] 资料不足时停止正式课程生成；
- [x] 目标准备主流程由持久化 LangGraph checkpoint 恢复，不再只依赖单个长 HTTP 请求；
- [x] 等待诊断回答和资料不足均使用显式 `interrupt`，恢复时继续同一个 `thread_id`；
- [x] 图状态只保存业务实体 ID、小型路由状态和错误摘要，不复制全文、完整 Chunk 或课程正文；
- [x] 外部副作用动作具有幂等键和结果复用，节点重放不会重复创建诊断、RetrievalRun 或课程；
- [x] 节点进度和等待状态写入 `workflow_events / workflow_runs`，HTTP 流仍可实时转发当前进度；
- [ ] 形成性题目只考查已发布教学块；
- [ ] 题目、参考答案、rubric 和来源快照不可变；
- [ ] 评分不会重新检索或联网；
- [ ] 课程页面能够查看来源标题、章节、页码和有限摘录；
- [ ] 搜索结果只有经过抓取、解析和入库后才能用于教学；
- [ ] URL 不会在检索和评分时自动更新；
- [ ] 关键阶段记录耗时、Token、失败原因和降级路径；
- [ ] 数据库、权限、课程、题目、评分和联网安全回归通过；
- [ ] README、V0.4.4、RAG、Roles 和项目亮点同步更新。

---

## 17. 编排框架的当前边界

框架接入时点已经提前到证据课程改造之前，但必须保持窄范围：

- Pydantic AI 用于替换课程主流程中的手写 JSON 解析，收紧 Tool 与模型结构化输出；
- LangGraph 用于目标创建、等待诊断、资料不足中断、课程生成重试、质量修复循环和 checkpoint 恢复；
- Next.js 继续负责页面、登录、外部 API、业务数据库唯一权威写入和事务门禁；
- Python workflow service 不直接信任浏览器提交的 `userId`、Source ID、Chunk ID 或任意文件路径；
- 普通课堂提问是独立 Tutor 子流程，不应为了回答一次问题而重跑课程创建主图；
- 框架迁移不能改变 SourceVersion、ChunkSet、RetrievalRun、课程版本和评分快照的不可变关系；
- checkpoint 只能恢复到节点边界；模型调用中途失败时允许重放当前节点，因此副作用和落库必须幂等；
- 权限、评分归一化、掌握度、完成门禁和业务事务不能交给模型决定。

只要坚持“来源统一入库、检索固定快照、教学绑定来源、题目只考已教、评分不再检索”这五条，LangGraph 就只是可恢复编排层，不会成为新的业务数据权威。
