# V0.4.4 实施方案：私有资料 RAG 与可追溯教学来源

> 最新增量：Schema V14，独立 web-research LangGraph 主流程接入 Pydantic AI 查询规划/候选推荐，Next.js 执行搜索与收录；支持用户选择中断与恢复。默认 DeepSeek 原生搜索，正文提取仍需 Tavily。两轮预算仅限制外层请求。验证为隔离和模拟测试，真实模型质量尚未验证。此状态覆盖下方历史描述。

> 2026-09-07 联网增量：Schema V13，目标资料范围支持 Tavily 搜索候选、用户选中后抓取正文并统一入库/绑定/向量化；具体实现和未完成项见子方案阶段 F。此处更新覆盖下方历史 Schema V12 状态。

> 状态：**个人资料库、Schema V12、解析分块、Embedding、目标级 RAG Tool 与可恢复编排 MVP 已实现；2026-09-07 接入 Tutor 证据生成/复核/修订、逐块引用与来源视图。阶段 D 尚待策略目录、概念覆盖和真实模型质量验证，题目来源链尚未完成。**

> 编码前子方案：目标资料绑定、本地检索 Tool、LangGraph/Pydantic AI 最小编排层、证据驱动课程与题目、固定评分，以及联网资料补充的统一实施顺序，见 [IMPLEMENTATION_PLAN_V044_GROUNDED_TEACHING.md](IMPLEMENTATION_PLAN_V044_GROUNDED_TEACHING.md)。后续阶段 C-H 的实现以该子方案为直接契约，本文件保留 V0.4.4 总体范围和历史设计。
> 更新日期：2026-09-01
> 适用范围：桌面端 Web；移动端继续暂停  
> 数据库版本：**Schema V12**
> 上游约束：[V1 实施方案](IMPLEMENTATION_PLAN_V1.md)、[V0.4.3 当前实现基线](IMPLEMENTATION_PLAN_V043.md)、[Agent 角色与信息边界](AGENT_ROLES.md)
> 总体架构：[RAG.MD](RAG.MD) 冻结上传、URL、联网搜索、结构解析、父子切片、不可变 ChunkSet 与教学证据的统一关系；本文继续负责 V0.4.4 的版本范围和阶段验收。若早期设计与总体架构冲突，以当前代码事实和 `RAG.MD` 的目标关系为准，并先更新文档再实施迁移。

## 0. 版本结论

V0.4.3 已经把课程从“标题扩写”升级为版本化 `LearningBlock[]`，并建立课程质量门禁、定向修复和题目到教学块的追溯关系。但是当前所有新课程仍是：

```text
模型知识 / 本地规则
→ 结构化课程
→ 质量门禁
→ 形成性题目
```

质量门禁能够检查内容是否完整、具体、可练习，却不能证明课程中的知识来自用户认可的材料，也不能回答“这一段讲解和这道题依据哪份资料”。

V0.4.4 只解决一个核心问题：

> **让用户导入自己的资料，并让课程、题目、参考答案和 rubric 固定绑定生成时实际使用的资料片段。**

本版本的最小闭环是：

```text
导入资料
→ 解析与分块
→ 关联学习目标
→ 检索当前课节需要的片段
→ 生成带来源绑定的教学块
→ 生成带来源绑定的形成性题目
→ 页面查看来源
→ 使用同一来源快照评分
```

V0.4.4 不追求“全网知识库”。当前已经完成私有资料、FTS5、文本 Embedding 和资料级向量检索底座；接下来先完成目标范围 Tool 与可恢复课程编排，再完成可追溯教学闭环。用户指定 URL、官方联网搜索和开放网络搜索继续放在本地闭环之后。

### 0.1 2026-09-01 当前实现切片

资料导入阶段先完成了个人资料库；后续阶段已经增加目标范围、RAG Tool 与可恢复编排，但还没有把资料证据正文喂给 Tutor：

```text
用户上传 TXT / PDF / DOCX，或粘贴文本
→ 服务端校验类型与安全边界
→ 统一 ingestion 入口
├─ TypeScript 回退：本地解析和 structure-parent-child-v2
└─ Python 成熟路径：MinerU V2 / Markdown → LlamaIndex HierarchicalNodeParser
→ 统一映射为 ExtractedDocument + SourceChunkSetDraft
→ 生成不可变 ParseRun、ChunkSet、Parent 和 Child
→ 全部成功后原子切换 active ChunkSet
→ FTS5 触发器建立索引
→ 资料库展示状态、重新切片和父子查看器
```

当前已经实现：

- 计划页“个人资料库”入口，不新增一级导航；
- 上传时可填写资料说明，记录资料内容、学习目的和重点范围；
- 粘贴文本，以及 TXT、PDF、DOCX 上传；
- 当前不设固定文件大小、抽取字符数或分块数量上限，同时拦截重复内容；
- TXT 的 UTF-8 与 GB18030 解码；
- PDF 逐页文本提取，文本不足时标记 `ocr_required`；
- DOCX 通过 Mammoth 受控转换为 HTML，再转成规范化 Markdown，保留标题、段落、列表、代码与表格文字，不执行宏或嵌入对象；
- 默认 TypeScript 回退路径中的 PDF 继续使用 `pdf-parse`；本机 MinerU 3.4.5 GPU 服务已完成真实复杂 PDF 链路，配置 `MINERU_API_URL` 后，复杂版面、图片、公式和表格进入成熟路径；
- PDF 普通正文会修复视觉软换行并优先按完整句末递归分割，“实验/示例/案例/练习/任务”等编号行作为子章节边界；仍无法替代 MinerU 对复杂版面的结构恢复；
- 确定性结构分块、父子关系、章节路径、页码/字符范围、边界理由、哈希与 Token 估算；
- 默认 Child 最小/目标/最大约 220/450/700 Token，Parent 最大约 2400 Token，不使用固定重叠；
- Schema V8 的资料、版本、FTS5、目标关系、检索运行和题目来源底座，以及 Schema V9 的 ParseRun、DocumentNode、不可变 ChunkSet、Parent/Child；
- 登录用户隔离的上传、列表和软删除 API；
- “优化切片”创建新 ChunkSet，父/子查看器支持章节路径和切片策略；
- 原文件二进制与抽取文本保存在 SQLite，不使用用户文件名拼接磁盘路径；
- V8 → V9 迁移保留旧 Child ID，为旧资料生成 legacy Parent，并通过外键、完整性和幂等迁移回归。
- 独立 Python ingestion 服务和 MinerU protocol v2 客户端，支持健康检查、异步任务、状态轮询、安全 ZIP 与 `content_list_v2.json` 结构映射；
- LlamaIndex 0.14.24 `HierarchicalNodeParser` 两级 Parent/Child，默认 2048/512 Token 与官方默认 20 Token overlap，配置写入不可变 ChunkSet；
- Next.js 上传与重新切片都可通过 `RAG_INGESTION_URL` 切换成熟路径；未配置或非强制模式失败时保留 TypeScript 回退；
- Python 服务返回值经过 DTO、父子包含关系、位置、字符范围和 Token 门禁后才能写入结构化资料表；
- 6 项 Python 回归覆盖 MinerU V2 结构、ZIP 安全、异步协议和 LlamaIndex 父子完整性，另完成 Python → Next.js HTTP 文本联调。
- Schema V10 已增加 Embedding Profile/Run、Chunk Embedding、PipelineRun 和阶段耗时；
- BGE-M3 与 Qwen3-Embedding-0.6B 已完成本地 GPU 向量化，资料级向量检索能够写入 RetrievalRun 快照。
- Schema V11 已为目标学习画像增加 `auto / selected` 资料范围；长期目标卡片可自动使用全部个人资料、排除资料或严格指定资料；
- 目标级 `search_knowledge_base` 已支持跨资料 FTS5/精确向量路由、Parent 去重、单资料上限、证据 Token 预算、来源不足状态、固定快照和阶段计时；
- 同一 Tool 契约已区分 `lesson_generation / classroom_qa` 用途，Agent 可见输入不包含 `userId`、任意 Source ID 或文件路径。
- Schema V12 已增加 `workflow_events`；Next.js 通过幂等外部动作执行 RAG Tool，LangGraph SQLite checkpoint 保存同一目标工作流的节点和 interrupt；
- Pydantic AI 已用于生成结构化资料检索计划，未配置工作流 LLM 时由同一 Pydantic 模型验证确定性计划。

当前仍未实现：

- EvidenceBundle 作为 GroundedTutorContext 传入 Tutor，以及教学块来源绑定；
- 课堂提问 UI 及其“当前教学块优先、当前课节其次、目标范围兜底”的查询改写；
- 按 required concepts 执行的语义覆盖/冲突检查；当前只实现无资料、无命中和课节证据过少的基础门禁；
- 教学块、题目、参考答案和 rubric 的真实 chunk 绑定；
- 课程页引用抽屉与固定来源快照评分；
- 课程质量修复循环的细粒度 Graph 节点，以及 Planner/Tutor/Examiner/Guard 全部迁为 Pydantic AI；
- OCR 质量验收、LLM 边界辅助、URL 导入和联网搜索。

因此当前版本可以称为“个人资料库、成熟解析/切片、Embedding、目标级 Agentic RAG Tool 与可恢复编排 MVP”。Tool 已在启用 workflow service 时进入课程生成前置检索，但证据尚未进入 Tutor 教学内容和块级引用门禁，仍不能称为“课程已经 grounded”。

---

## 1. 为什么现在做 RAG

### 1.1 当前已经具备的基础

现有代码已经预留：

- `SourceStatus = unverified | partially_grounded | grounded`；
- 内容版本状态 `source_insufficient`；
- `LessonContentOutput.sourceRefs`；
- `lesson_block_sources`；
- `source_snapshot_hash` 和 `support_type`；
- 课程页面的来源状态标签；
- 不可变 `contentVersionId`；
- 题目、参考答案和评分尝试的内容版本快照。

因此 V0.4.4 不是从零增加一个独立聊天知识库，而是把真实来源片段接入现有课程资产流水线。

### 1.2 当前来源骨架仍不可信

现有 `sourceRefs` 是**课节级数组**。保存内容版本时，代码会把课节里的所有 `sourceRef` 关联给所有教学块。这只能表示“这节课可能用过这些来源”，不能证明“这个片段支持这个教学块”。

V0.4.4 必须把来源关系收紧到：

```text
具体 sourceChunk
→ 具体 LearningBlock
→ 具体 CourseQuestion / referenceAnswer / rubric
→ 具体 lesson_assessment_attempt
```

否则即使页面显示了引用，也仍然只是装饰性引用。

### 1.3 RAG 不会自动提升教学质量

RAG 负责“知识依据是什么”，V0.4.3 的结构化课程与质量门禁负责“怎么教、怎么练、怎么确认学会”。

资料检索正确但课程组织很差，仍然不是好课；课程组织完整但没有可靠来源，也不能写成“可信教学”。两个门禁必须同时通过：

```text
来源充分性门禁
AND
教学质量门禁
→ 才能发布 grounded 正式课程
```

---

## 2. 目标与非目标

### 2.1 V0.4.4 核心目标

- 支持用户粘贴文本以及上传 TXT、PDF、DOCX；
- 每份资料归属于当前用户，可关联一个或多个学习目标；
- 保存不可变资料版本、内容哈希、页码/章节位置和解析状态；
- 使用 SQLite FTS5 完成带用户和目标过滤的关键词检索；
- Tutor 只接收经过筛选且受 Token 预算约束的 `RetrievedEvidence[]`；
- 每个需要事实支持的教学块绑定实际使用的 `sourceChunkId`；
- 每道正式题目、参考答案和 rubric 绑定实际使用的来源片段；
- 评分读取生成题目时的固定来源快照，不重新检索；
- 来源不足时进入 `source_insufficient`，不静默切回模型知识；
- 课程页可查看来源名称、页码/章节和引用片段；
- 记录解析、检索、来源覆盖、Token、耗时和失败原因；
- 用固定资料集证明权限隔离、检索命中和引用绑定契约。

### 2.2 V0.4.4 核心版不做

- 不实现扫描 PDF OCR；
- 不支持旧版 `.doc`、PPT、Excel、音频、视频或压缩包；
- 不抓取用户指定 URL；
- 不自动联网搜索；
- 不做开放网络事实核查；
- 不对 Next.js、解析、切片、Embedding、检索、权限或数据库层做全量框架重写；
- LangGraph/Pydantic AI 只迁移目标准备与课程生成主流程，不扩展到所有页面和普通 CRUD；
- 不新增“RAG Agent”或“资料管理员 Agent”；
- 不实现 V0.4.3.1 尚未完成的困惑标注、收藏和 `open_book`；
- 不因为存在引用就宣称资料内容绝对正确；
- 不宣称学习效率、成绩或记忆保持率提高。

### 2.3 V0.4.4 系列后续子版本

| 子版本 | 范围 | 前置条件 |
|---|---|---|
| V0.4.4 基础阶段 | 私有文本/TXT/PDF/DOCX、MinerU、父子切片、FTS5 | 已完成 |
| V0.4.4 向量阶段 | Embedding Profile、BGE/Qwen、本地向量检索和阶段计时 | 已完成 MVP；混合检索、重排和 Recall@K 基线仍待后续 |
| V0.4.4 编排阶段 | 目标资料 Tool、LangGraph checkpoint/interrupt、Pydantic AI 结构化节点 | 目标绑定和 EvidenceBundle 契约稳定 |
| V0.4.4 教学阶段 | 来源课程、来源题目、固定快照评分和引用 UI | 编排主图可以恢复和幂等重放 |
| V0.4.4 联网阶段 | 用户 URL、官方来源定向搜索；开放网络搜索保持可选 | 本地来源闭环与 SSRF/重定向/体积限制完成 |

---

## 3. 核心原则

### 3.1 生成方式与来源可信度正交

不能把 `rag_grounded` 混入 `llm / rules / manual` 生成模式。

```ts
type GenerationMode = "llm" | "rules" | "manual" | "mixed";

type SourceStatus =
  | "unverified"
  | "partially_grounded"
  | "grounded";
```

- `GenerationMode` 回答“内容是谁生成的”；
- `SourceStatus` 回答“内容是否能追溯到固定来源”；
- `qualityStatus` 回答“内容是否通过教学质量门禁”。

三者不得互相替代。

### 3.2 `grounded` 表示可追溯，不表示绝对正确

用户上传资料可能过时、错误或彼此冲突。`grounded` 只能解释为：

> 当前课程中需要来源支持的教学块和正式题目，都能回到生成时固定的资料片段。

页面不使用“权威正确”之类表述。用户资料统一标记为“用户提供”；未来官方网站、标准和论文再使用更高来源等级。

### 3.3 默认不自动联网

V0.4.4 核心版固定：

```ts
type SourcePolicy = "private_only";
```

资料不足时只允许：

1. 提示用户继续添加资料；
2. 让用户缩小学习范围；
3. 用户明确选择后，进入后续联网子版本；
4. 用户明确接受未验证内容时，另行生成 `unverified` 演示课，但不能伪装成来源课。

### 3.4 资料版本和课程版本都不可变

- 用户重新上传同名文件，不覆盖旧 `sourceVersion`；
- 资料正文或解析器变化，创建新版本；
- 新课程只使用当前启用版本；
- 历史课程、题目、答案和评分继续绑定旧来源快照；
- 删除资料默认是“停止后续使用”，不是破坏历史证据。

### 3.5 不把全部资料塞进 Prompt

Tutor 只能收到本课需要的有限片段，必须同时满足：

- 当前用户；
- 当前目标；
- 当前启用资料版本；
- 与当前能力/课节目标相关；
- 去重后处于证据 Token 预算内。

V0.4.3 的完整生成链已经可能接近 5 分钟，RAG 不能通过无限增加上下文继续放大延迟。

---

## 4. 用户流程与 UI

### 4.1 目标资料区

首版不增加新的一级导航。在计划页的长期目标详情中增加“学习资料”区域：

- 上传 PDF、DOCX、TXT；
- 粘贴一段文本；
- 查看资料标题、类型、大小、更新时间和状态；
- 将已有资料关联/取消关联到当前目标；
- 重新解析失败资料；
- 停止在后续课程中使用资料。

资料状态必须真实来自服务端：

```text
正在上传
→ 等待解析
→ 正在提取文本
→ 正在分块与建立索引
→ 可用于课程
```

失败状态至少包含：

```text
格式不支持
文件过大
无法提取文本
需要 OCR
内容为空
解析失败
索引失败
```

进度窗口只能展示节点、百分比、文档数量和失败原因，不展示模型内部思维链。

### 4.2 创建目标时的资料选择

创建目标可以不上传资料。目标保存后，用户可以：

- 直接生成 `unverified` 演示课程；
- 先添加资料，再生成来源课程；
- 从已有个人资料库选择资料。

若用户选择“只根据这些资料学习”，资料未解析完成或覆盖不足时必须阻断正式课程生成。

### 4.3 课程来源展示

课程页保留当前来源状态标签，并增加：

- 教学块右上角显示 `来源 2` 之类的引用入口；
- 点击后打开来源抽屉；
- 抽屉展示资料标题、版本、页码/章节、支持类型和引用片段；
- 引用片段只展示生成时快照，不重新读取后来更新的文件；
- 同一块存在冲突来源时明确显示“资料存在分歧”；
- 旧 `unverified` 课程继续显示“模型知识 · 未验证”。

普通用户不展示内部检索分数、Prompt、完整 rubric 或参考答案。

---

## 5. 资料输入与解析契约

### 5.1 支持格式

| 输入 | 首版行为 |
|---|---|
| 粘贴文本 | 直接保存为不可变文本版本 |
| TXT | 支持 UTF-8（含 BOM）与 GB18030；其他编码失败时明确提示 |
| PDF | 提取文本并保留页码；没有有效文本时标记 `ocr_required` |
| DOCX | 读取段落、标题和表格文本；不执行宏或外部对象 |

`.doc` 与伪装扩展名不得作为 DOCX 处理。

### 5.2 资源与安全边界

按当前 Demo 决策，应用层暂不设置固定文件大小、抽取字符数或分块数量上限；分块参数仍保持确定性：

```text
Child 最小 / 目标 / 最大    约 220 / 450 / 700 Token
Parent 最大                约 2,400 Token
固定重叠                    0；仅超长原子节点按自然边界递归回退
```

“应用不设固定上限”不等于部署环境无限：反向代理、Serverless 平台、Node.js 内存和 SQLite 磁盘仍可能限制实际可处理体积。当前接口通过 `request.formData()` 一次读取文件，特别大的文件会增加内存、解析耗时和数据库体积；公网长期运行前应改成流式上传/对象存储、后台解析、用户配额和并发控制，而不是重新在前端随意写一个很小的数字。

实现要求：

- 不相信浏览器上报的 MIME；
- 同时检查扩展名、实际文件签名和解析器结果；
- 当前原文件 BLOB 保存在 SQLite，不使用原始文件名拼接磁盘路径；
- 原始文件名只作为显示元数据；
- 不执行文档宏、脚本、外部链接或嵌入对象；
- 对 DOCX 校验中央目录、必要 Office 文件、异常压缩比和异常条目数量；这属于恶意压缩结构防护，不是普通文件容量上限；
- 解析超时或进程异常必须标记失败，不能留下永久 `processing`；
- 所有 API 必须先校验用户归属。

### 5.3 解析状态

```ts
type SourceParseStatus =
  | "uploaded"
  | "extracting"
  | "chunking"
  | "indexing"
  | "ready"
  | "ocr_required"
  | "failed"
  | "archived";
```

同一 `contentHash` 的重复文件可以复用当前用户已有解析结果，但不能跨用户共享归属或引用记录。

### 5.4 分块规则

首版使用确定性分块，不让 LLM 决定原始资料如何切分：

1. 优先按标题、页码、段落和列表边界切分；
2. 过长段落按句子边界继续切分；
3. 相邻块保留小范围重叠；
4. 表格保持行列文本和所在页；
5. 每块保存 `sectionPath`、页码、序号和内容哈希；
6. 空白、页眉页脚重复项和纯页码不进入索引；
7. 不因为清洗而改变原文含义。

分块长度、重叠量和 Token 估算统一放在配置模块，不散落到解析器和 Agent Prompt。

---

## 6. 检索契约

### 6.1 检索输入

检索查询不能只使用目标标题。至少包含：

```ts
type RetrievalInput = {
  userId: string;
  goalId: string;
  lessonId: string;
  skillId: string;
  capabilityType: CapabilityType;
  lessonObjective: string;
  concepts: string[];
  diagnosticEvidence: string[];
  maxChunks: number;
  maxEvidenceTokens: number;
};
```

客户端不能提交 `userId`、任意文件路径或任意 chunk ID。服务端从登录会话、目标、课节和资料关联读取。

### 6.2 FTS5 首版流程

```text
能力名称 + 课节目标 + 关键概念
→ 生成 2–4 个确定性查询
→ userId / goalId / active sourceVersion 过滤
→ FTS5 召回
→ 相同片段与高重叠片段去重
→ 每份资料限制最大占比
→ 按 Token 预算组装 EvidenceBundle
```

首版不要求语义检索，但检索接口必须与底层实现解耦，V0.4.4.1 可以在不修改 Tutor 契约的情况下加入 Embedding 和重排。

### 6.3 检索输出

```ts
type RetrievedEvidence = {
  chunkId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceTitle: string;
  sourceType: "pasted_text" | "txt" | "pdf" | "docx";
  pageStart: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  text: string;
  contentHash: string;
  retrievalScore: number;
  trustLevel: "user_provided";
};

type EvidenceBundle = {
  retrievalRunId: string;
  querySummary: string;
  evidence: RetrievedEvidence[];
  totalEvidenceTokens: number;
  insufficient: boolean;
  insufficiencyReason: string;
};
```

`retrievalScore` 只用于系统排序，不能被 Tutor 当作事实正确率。

### 6.4 来源不足

以下情况进入 `source_insufficient`：

- 当前目标没有可用资料；
- 资料仍在解析或全部失败；
- 检索没有命中；
- 关键课程目标没有任何支持片段；
- 只有冲突片段且无法形成明确教学边界；
- 证据 Token 预算内无法覆盖最低教学要求。

页面应告诉用户缺的是“没有资料”“资料未就绪”还是“当前资料没有覆盖这个能力”，不能只显示统一的“生成失败”。

---

## 7. 教学块、题目与来源绑定

### 7.1 废弃课节级全量复制

`LessonContentOutput.sourceRefs` 可以暂时保留用于旧版本兼容，但不能再把所有来源复制给每个教学块。

新增服务端契约：

```ts
type BlockSourceBinding = {
  blockId: string;
  sourceChunkIds: string[];
  supportType: "supports" | "contradicts" | "example";
};

type GroundedLessonContentOutput = LessonContentOutput & {
  retrievalRunId: string;
  blockSourceBindings: BlockSourceBinding[];
};
```

每个 `sourceChunkId` 必须来自本次固定的 `retrievalRunId`，服务端在落库前重新校验，不能相信模型随意输出的 ID。

### 7.2 哪些块必须有来源

必须来源绑定：

- `explanation`；
- `concept_relation`；
- `comparison`；
- `worked_example`；
- `case_study`；
- `demonstration`；
- `common_mistake`；
- `boundary`；
- `summary` 中的事实性要点。

可以只绑定其依据块、不要求每句单独引用：

- `guided_practice`；
- `retrieval_practice`；
- `reflection`；
- `speaking_practice`；
- 用户要完成的独立交付物说明。

练习虽然不一定直接引用原文，但不得考查所有来源块都未教学的事实。

### 7.3 题目来源

服务端完整题目增加：

```ts
type AuthoredGroundedQuestion = AuthoredCourseQuestion & {
  sourceChunkIds: string[];
  retrievalRunId: string;
};
```

约束：

- 题目的 `sourceChunkIds` 必须属于其 `taughtBlockIds` 已绑定来源的并集；
- 参考答案和 rubric 只能使用生成题目时的固定片段；
- 客户端课程响应继续不返回参考答案、rubric 或内部检索分数；
- 评分时不重新搜索、不重新检索、不改用资料新版本；
- 评分尝试保存题目和来源绑定快照。

### 7.4 来源状态计算

`sourceStatus` 由确定性服务计算，模型不能直接决定：

```text
unverified
  没有有效来源绑定

partially_grounded
  至少一个必要教学块有来源，但没有覆盖所有必要块或正式题目

grounded
  所有必要教学块均有有效来源；
  所有正式题目、参考答案和 rubric 均绑定其已教学来源；
  所有 chunk 均来自当前固定 retrievalRun；
  没有未处理的硬冲突
```

`grounded` 仍必须同时通过 V0.4.3 教学质量门禁才能发布。

---

## 8. 数据库 Schema V8 底座与 Schema V9 结构切片扩展

### 8.1 新表

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

复用现有：

```text
lesson_content_versions
lesson_block_sources
lesson_assessment_attempts
agent_runs
workflow_runs
```

### 8.2 `knowledge_sources`

表示用户视角的一份逻辑资料：

```text
id
user_id
title
description
kind                  text / txt / pdf / docx
original_filename
mime_type
byte_size
content_hash
status
parser_version
current_version_id
chunk_count
char_count
warning_message
error_message
created_at
updated_at
deleted_at
```

资料删除默认写 `deleted_at` 并从未来检索排除。

### 8.3 `source_versions`

表示不可变资料版本：

```text
id
source_id
user_id
version
raw_blob
extracted_text
text_hash
parser_version
status
warnings_json
created_at
```

约束：`UNIQUE(source_id, version)`。当前 Demo 把原文件 BLOB 与抽取文本一起保存在 SQLite，便于单文件备份且不产生路径穿越面；成为课程证据的版本不允许原地修改。若后续迁移对象存储，只替换 `raw_blob` 存储实现，不改变 `source_version_id` 与内容哈希。

### 8.4 Schema V8 遗留 `source_chunks`

```text
id
source_version_id
source_id
user_id
position
heading
content
page_start
page_end
char_start
char_end
token_estimate
content_hash
created_at
```

以上字段是 V8 历史结构。Schema V9 已重建该表并加入 `chunk_set_id`、`parent_chunk_id`、`section_path_json`、`context_prefix`、节点位置和 `boundary_reason_json`；唯一约束改为 `(chunk_set_id, position)`。`source_chunks_fts` 仍由触发器同步，现索引 `资料标题 + heading + context_prefix + content`，并保存未索引的 `chunk_id / source_id / user_id`。未来检索必须继续回表校验资料状态、active ChunkSet 和所有权，不能只信 FTS 行里的未索引字段。

### 8.5 `goal_source_links`

```text
goal_id
source_id
user_id
status                active / disabled
created_at
```

主键：`(goal_id, source_id)`。读写时同时校验目标和资料都属于当前用户。

### 8.6 `retrieval_runs` 与 `retrieval_run_items`

`retrieval_runs` 保存：

```text
id
user_id
goal_id
lesson_id
skill_id
agent_run_id
tool_name
retrieval_mode          fts5
query
filters_json
top_k
max_evidence_tokens
result_count
total_evidence_tokens
status
insufficiency_reason
latency_ms
created_at
```

`retrieval_run_items` 保存本次固定结果：

```text
id
retrieval_run_id
source_id
source_version_id
chunk_id
rank
score
excerpt
snapshot_text
snapshot_hash
created_at
```

约束：`UNIQUE(retrieval_run_id, rank)`。同一 chunk 去重由检索服务在写入前执行；`snapshot_text` 和 `snapshot_hash` 用于确保原资料停止使用后历史课程仍能回放当时证据。当前只建表，尚未写入真实检索运行。

### 8.7 复用 `lesson_block_sources`

首版不重建该表。写入规则调整为：

- `source_ref` 保存真实 `source_chunks.id`；
- `source_snapshot_hash` 必须填入固定快照哈希，不能继续为空；
- `support_type` 继续使用 `supports / contradicts / example`；
- 写入前校验 chunk 属于同一 `retrieval_run` 和当前用户；
- 数据库校验脚本检查悬空 `source_ref` 和空 snapshot hash。

由于旧表没有外键指向 V8 新表，所有权与引用合法性由应用事务和数据库验证脚本双重检查。

### 8.8 `question_source_links`

```text
question_type          diagnostic / lesson
question_id
lesson_content_version_id
retrieval_run_id
source_id
source_version_id
chunk_id
source_snapshot_hash
support_type
created_at
```

主键：`(question_type, question_id, chunk_id)`。

当前课程题目仍保存在 JSON 契约中，本版本不为了来源表重构成独立 `course_questions` 表。

### 8.9 迁移要求

- V8 已完成资料、版本、FTS5、目标关系、检索运行和题目来源底座；
- V9 已增加 `knowledge_sources.active_chunk_set_id`、`document_parse_runs`、`document_nodes`、`source_chunk_sets` 和 `source_parent_chunks`，并重建 `source_chunks`；
- 新表写入完整 `DATABASE_SCHEMA`，后补列同时进入 `COLUMN_ADDITIONS`；
- FTS5 表、触发器与重建命令必须可重复执行；
- 新库、V8 老库、重复启动和中断后重启都要通过；
- V8/V9 都不创建 `lesson_annotations`，不增加 `open_book`；Schema V10/V11 已分别用于 Embedding 与目标资料范围，这两项若实施应使用后续迁移版本，不再占用已发布版本号。

### 8.10 Schema V9 的不可变切片关系

```text
knowledge_sources.active_chunk_set_id
              ↓
document_parse_runs → document_nodes
              ↓
source_chunk_sets → source_parent_chunks → source_chunks
```

每次重新切片都创建新的 ParseRun 与 ChunkSet；只有节点、Parent、Child、计数与索引全部写入成功后，事务才更新 `active_chunk_set_id`。旧 ChunkSet 不覆盖、不删除。V8 旧数据迁移时为每个旧 Child 创建一个 legacy Parent，保留原 Child ID，确保已经保存的题目或证据引用不失效。

---

## 9. Agentic RAG Tool 与确定性服务边界

### 9.1 不新增 RAG Agent

RAG 不是一个需要人格、目标和长期状态的独立 Agent。解析、索引和检索是确定性能力；Tutor 或 Planner 可以根据任务决定是否调用它们，这才是本项目所说的 **Agentic RAG**。

以下工作全部由普通服务完成：

- 文件类型和权限校验；
- 文本提取；
- 分块与哈希；
- FTS5 索引；
- 用户/目标过滤；
- 去重、排序和 Token 预算；
- chunk ID 与快照合法性校验；
- `sourceStatus` 计算；
- 数据库事务与状态推进。

对 Agent 只暴露窄而可审计的 Tool 契约，首批计划为：

```ts
search_knowledge_base(input: {
  goalId: string;
  query: string;
  topK?: number;
  maxEvidenceTokens?: number;
}): EvidenceBundle;

read_source_chunks(input: {
  retrievalRunId: string;
  chunkIds: string[];
}): RetrievedEvidence[];

check_source_coverage(input: {
  retrievalRunId: string;
  requiredConcepts: string[];
}): {
  sufficient: boolean;
  uncoveredConcepts: string[];
  conflicts: string[];
};
```

Tool 实现必须从登录会话、当前目标和工作流上下文解析 `userId`，不得让模型或客户端自行提交 `userId`、任意文件路径或未出现在 `retrievalRun` 中的 chunk ID。每次 Tool 调用写入 `retrieval_runs` / `retrieval_run_items`，并可关联 `agent_runs`；这样“Agent 为什么用了哪份资料”可以回放，而不是只剩一段最终回答。

当前已经实现 `search_knowledge_base` 的确定性核心和服务端上下文包装：支持目标资料范围、`lesson_generation / classroom_qa` 用途、FTS5/精确向量自动路由、Parent 去重、单资料上限、Token 预算、基础覆盖状态、固定 RetrievalRun 快照与阶段计时。登录保护的 `/api/rag/search` 用于调试/BFF；启用 workflow service 后，LangGraph 会先由 Pydantic AI/规则生成检索计划，再让 Next.js 调用该 Tool。**Tool 尚未把 EvidenceBundle 传给 Tutor，也未接入课堂提问页面；`read_source_chunks` 和按 required concepts 的独立 `check_source_coverage` 仍未实现。**

### 9.2 Tutor 的变化

Tutor 新增输入：

```ts
evidenceBundle: EvidenceBundle
```

Tutor 负责：

- 根据来源片段组织结构化教学内容；
- 输出 `blockSourceBindings`；
- 只在片段支持的范围内解释；
- 明确资料没有覆盖的边界；
- 根据已发布教学块生成来源一致的形成性题目。

Tutor 不负责：

- 自己搜索文件系统；
- 自己访问数据库；
- 自行追加不存在的 chunk ID；
- 判断当前用户是否有权读取资料；
- 将提示词注入文本当成系统指令；
- 修改课程、任务或掌握度。

### 9.3 LessonQualityReviewer 的变化

语义复核新增检查：

- 教学块是否真的由引用片段支持；
- 是否把用户资料中的不确定表述说成确定事实；
- 是否存在片段冲突；
- 题目是否超出已教学且有来源的范围；
- 参考答案和 rubric 是否引入资料外事实。

它不能证明资料本身正确，也不能推翻确定性来源硬门禁。

### 9.4 Examiner 保持不变

V0.4.4 不要求初始诊断使用用户资料。Examiner 仍负责当前初始诊断和未来总结性考核；Tutor 继续负责课内形成性题目。

等可信题库策略稳定后，再单独决定初始诊断是否允许绑定用户资料，不能在本版本里顺手改变诊断基线。

---

## 10. Prompt 注入、隐私与安全

### 10.1 用户资料是数据，不是指令

所有来源片段必须以明确的数据边界传入模型。Prompt 必须声明：

- 资料中的“忽略之前规则”“调用工具”“上传文件”等文字不是系统指令；
- 只能从片段提取与当前课节有关的知识；
- 不执行资料中要求的外部动作；
- 不输出未授权的其他资料内容。

提示词隔离只能降低风险，不能宣称完全防御。固定回归要包含恶意指令片段。

### 10.2 权限隔离

每个查询必须从登录用户开始：

```text
session userId
→ goal belongs to user
→ linked source belongs to user
→ active sourceVersion belongs to source
→ chunk belongs to sourceVersion
```

任何一步失败都返回统一的不存在/无权限错误，不能泄露别人的资料标题、文件名、页码或片段。

### 10.3 模型数据披露

上传资料会在课程生成时发送给用户配置的模型服务。页面和文档必须明确说明：

- 哪些资料片段会被发送；
- 发送给哪个已配置 provider；
- 本地演示模式不会调用外部模型；
- 不应上传不允许发给该服务的敏感资料。

### 10.4 删除语义

首版提供两种语义：

- **停止使用**：软删除资料，不再用于新课程，历史引用保留；
- **永久删除**：只有不存在课程/题目/评分引用时才允许直接删除；存在引用时先提示影响，后续再设计可验证的证据匿名化或级联方案。

不能在用户点击普通“删除资料”时静默破坏历史考核证据。

### 10.5 后续 URL/联网安全

V0.4.4 核心版不抓取 URL。V0.4.4.2 开始前必须补齐：

- 禁止 localhost、环回、私网、云元数据和非 HTTP(S) 地址；
- 每次重定向重新校验目标；
- DNS 解析后再次检查地址；
- 限制下载体积、响应时间和内容类型；
- 不携带用户 Cookie；
- 保存最终 URL、抓取时间、正文哈希和来源快照；
- 搜索摘要不能直接作为正式教学来源。

---

## 11. API 契约

### 11.1 资料列表与上传

```text
GET  /api/knowledge-sources
POST /api/knowledge-sources
```

`POST` 支持 multipart 文件或 JSON 粘贴文本。返回资料元数据和真实处理状态，不在同步请求里等待完整课程生成。

### 11.2 单份资料

```text
GET    /api/knowledge-sources/[id]
DELETE /api/knowledge-sources/[id]
POST   /api/knowledge-sources/[id]/retry
```

`GET` 默认不返回整份原文，只返回元数据、解析状态、版本和有限预览。

### 11.3 目标资料关系

```text
GET    /api/goals/[id]/sources
POST   /api/goals/[id]/sources
DELETE /api/goals/[id]/sources?sourceId=
```

关联与取消关联不删除资料本身。

### 11.4 课程生成

继续复用：

```text
POST /api/learning-program
action = prepare-stream / retry-lesson
```

客户端不能提交原文、检索结果或任意 chunk ID。服务端根据 `goalId` 读取启用资料、执行检索并固定 `retrievalRun`。

进度流增加真实阶段：

```text
source_loading
source_retrieval
source_validation
lesson_material
lesson_grounding
lesson_quality
lesson_check
persist
```

### 11.5 来源展示

课程公开响应只返回有限引用视图：

```ts
type PublicSourceCitation = {
  sourceTitle: string;
  sourceType: string;
  pageStart: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  excerpt: string;
  supportType: "supports" | "contradicts" | "example";
};
```

不返回文件存储路径、其他目标关系、完整资料正文或内部检索分数。

---

## 12. 性能与恢复

### 12.1 证据预算

实现时必须统一配置：

```text
RAG_MAX_CHUNKS_PER_LESSON
RAG_MAX_CHUNKS_PER_SOURCE
RAG_MAX_EVIDENCE_TOKENS
RAG_RETRIEVAL_TIMEOUT_MS
```

任何节点都不能绕过预算把整份 PDF 放入模型请求。

### 12.2 生成时间

当前 V0.4.3 整节生成在复杂修复分支可能接近 5 分钟。V0.4.4 至少要做到：

- 检索耗时与生成耗时分开记录；
- 资料解析不阻塞浏览器长连接；
- 页面离开后可以从数据库恢复资料状态；
- 相同 `sourceVersion + parserVersion` 不重复解析；
- 相同课节输入和来源版本不重复创建并发检索；
- 证据上下文超过预算时明确截断并记录原因。

若真实模型加入证据后仍持续超过单节点等待闸门，必须在 LangGraph 中按教学块组拆分为可 checkpoint、可幂等重放的短节点，不能只继续提高单次模型调用或 HTTP 请求的超时时间。

### 12.3 幂等键

建议：

```text
parseKey      = sourceVersionId + extractorVersion
chunkKey      = sourceVersionId + chunkStrategyVersion
retrievalKey  = lessonId + contentInputHash + activeSourceVersionHashes + retrievalConfigVersion
generationKey = lessonId + retrievalRunId + promptVersion
```

失败重试创建新的运行记录，但不可重复写入相同不可变版本。

---

## 13. 质量门禁

### 13.1 来源硬规则

发布 `grounded` 课程前必须全部满足：

- 引用的 chunk 存在且属于当前用户与目标；
- chunk 来自本次固定 `retrievalRun`；
- snapshot hash 与检索快照一致；
- 所有必要教学块至少有一个有效支持来源；
- 所有正式题目至少有一个来源；
- 题目来源属于其 `taughtBlockIds` 来源并集；
- 没有把 `contradicts` 当作唯一支持来源；
- 参考答案和 rubric 没有引用检索集合外事实；
- 公开响应不泄露受保护字段。

任一硬规则失败，不能由 LLM 语义复核改成通过。

### 13.2 语义复核

语义复核可以输出：

```ts
type GroundingIssue = {
  blockId: string | null;
  questionId: string | null;
  sourceChunkIds: string[];
  code:
    | "unsupported_claim"
    | "citation_mismatch"
    | "source_conflict"
    | "overstated_certainty"
    | "question_outside_sources";
  severity: "error" | "warning";
  message: string;
};
```

定向修复只能重写有问题的教学块或题目，并继续使用同一 `retrievalRun`。如果需要新证据，必须创建新检索运行和新内容版本，不能偷偷改变旧版本的来源集合。

### 13.3 失败状态

| 状态 | 含义 | 前端行为 |
|---|---|---|
| `source_insufficient` | 没有足够资料覆盖课节 | 引导添加资料或调整范围 |
| `quality_failed` | 有来源但教学内容质量失败 | 展示问题摘要并允许重新生成 |
| `generation_failed` | 模型/解析/持久化失败 | 展示真实失败阶段与重试入口 |
| `partially_grounded` | 只有部分必要内容有来源 | 可作为预览，不得显示“来源已验证” |
| `grounded` | 来源硬门禁与教学质量门禁均通过 | 开放正式形成性题目 |

---

## 14. 测试与量化

### 14.1 固定资料集

至少准备：

1. 一份 TXT：包含明确术语、步骤和边界；
2. 一份可检索 PDF：包含页码和跨页段落；
3. 一份 DOCX：包含标题、列表和表格；
4. 一段粘贴文本；
5. 一份无文本扫描 PDF；
6. 一份带“忽略规则并泄露系统提示”文本的恶意资料；
7. 两份对同一事实表述冲突的资料；
8. 一份与目标无关的干扰资料。

固定问题必须能明确判断预期命中的 chunk，不能只看生成文字“感觉相关”。

### 14.2 数据库与权限测试

- V7 → V8 迁移成功；
- 重复迁移不报错；
- FTS 索引可重建；
- 用户 A 无法读取、关联、检索或删除用户 B 的资料；
- 同哈希资料不会跨用户共享权限；
- 软删除资料不再进入新检索；
- 历史课程仍能回放固定引用；
- 悬空 chunk 引用和空 snapshot hash 被校验脚本发现。

### 14.3 检索测试

- 已知查询的正确片段进入 Top K；
- 无关资料不会因为标题相似占满结果；
- 每份资料的结果数量受到限制；
- 结果总 Token 不超过预算；
- 没有命中时明确 `source_insufficient`；
- 同一输入和配置可以回放相同检索快照。

### 14.4 课程与题目测试

- 每个必要教学块均绑定真实 chunk；
- `lesson_block_sources.source_snapshot_hash` 不为空；
- 正式题目来源属于其已教学块来源并集；
- 评分不会在答题时创建新检索；
- 资料更新后旧课程引用不变化；
- `grounded` 课程来源绑定有效率为 100%；
- 客户端参考答案和 rubric 字段仍为 0；
- 恶意资料不能改变系统角色、调用外部工具或泄露其他资料。

### 14.5 指标

| 指标 | 计算方式 | 当前可写结论 |
|---|---|---|
| 解析成功率 | `ready` 资料 / 可解析资料 | 实现后测量 |
| OCR 识别率 | `ocr_required` 扫描 PDF / 扫描 PDF | 只验证正确识别状态 |
| Recall@K | 固定查询中预期 chunk 进入 Top K 的比例 | 先建立 FTS5 基线 |
| 引用合法率 | 有效 chunk 绑定 / 全部来源绑定 | `grounded` 目标为 100% |
| 教学块来源覆盖率 | 有来源的必要块 / 全部必要块 | `grounded` 必须 100% |
| 题目来源覆盖率 | 有来源的正式题目 / 全部正式题目 | `grounded` 必须 100% |
| 检索延迟 | `retrieval_runs.latency_ms` | 报告 P50/P95 |
| 证据 Token | 每次生成的证据上下文 Token | 受统一预算约束 |
| 来源不足率 | `source_insufficient` 课节 / 来源课节 | 用于发现资料覆盖问题 |

这些工程指标不能替代真实学习效果评测。

---

## 15. 分阶段实施顺序

### 阶段 A：个人资料库契约与 Schema V8（已完成）

1. 定义资料、版本、片段、检索和公开引用类型；
2. 将生成方式与来源状态彻底分开；
3. 新建 V8 表、FTS5 索引和验证规则；
4. 定义软删除、版本更新和历史快照语义；
5. 准备固定 TXT/PDF/DOCX/恶意/冲突资料集。

完成条件：新库、V7 → V8 迁移和重复启动通过；类型契约能表达块级和题目级来源。

### 阶段 B：上传、结构解析与父子切片（已完成核心）

1. 实现资料 API 和所有权校验；
2. 实现粘贴文本、TXT、PDF、DOCX 提取与版本哈希；
3. 实现规范化 Markdown 与 DocumentNode；
4. 实现不可变 ParseRun/ChunkSet 和结构化 Parent/Child；
5. 实现重新切片与 active ChunkSet 原子切换；
6. 实现 FTS5 自动写入和父子切片查看器。

完成情况：核心链路已完成。PDF 复杂版面仍等待 MinerU，LLM 模糊边界辅助不属于当前确定性基线。

### 阶段 C：目标范围与真实检索（核心已完成）

1. 已完成目标资料范围 UI/API：`auto` 默认纳入全部可用资料并允许排除，`selected` 只允许严格白名单；
2. 已实现 FTS5 查询、精确向量路由以及用户/目标/active ChunkSet 过滤；
3. 已实现 Parent 去重、单资料上限和统一 Token 预算；当前不额外拼接相邻 Child；
4. 已写入不可变 RetrievalRun/Item、SourceVersion/ChunkSet 快照、Parent 文本哈希和 Pipeline 阶段计时；
5. 已增加隔离数据库契约回归；固定问题集的 Recall@K、legacy/structure A/B 和 reranker 仍是后续质量工作。

完成情况：核心工程条件已满足。下一步进入阶段 D；在 Tool 接入课程前仍需由编排层为课节生成查询和处理 `insufficient` 分支。

### 阶段 D：LangGraph / Pydantic AI 最小编排层

1. 建立只供 Next.js 调用的 Python FastAPI workflow service；
2. 将 `prepareGoalLoop`、`generateCourseForGoal` 和课程质量修复循环拆成 LangGraph 节点；
3. 使用 Pydantic AI 收紧 Planner、Tutor、Examiner 和质量复核的结构化输入输出；
4. 使用持久化 checkpointer、稳定 `thread_id`、节点幂等键和输入哈希；
5. 将等待诊断回答和资料不足等待实现为显式 `interrupt`；
6. 图状态只保存业务 ID、小型路由状态和错误摘要，业务正文与证据继续保存在权威数据库；
7. 前端进度从持久化节点事件读取，刷新和服务重启后仍可显示真实阶段。

完成条件：课程准备流程在浏览器刷新、请求断开或服务重启后可从最近完成节点继续，节点重放不会重复创建检索运行、课程版本或题目。

完成情况：最小主图已实现。LangGraph checkpoint、诊断/资料 interrupt、Next.js 外部动作执行、Schema V12 事件日志和幂等动作结果已经落地，并通过服务重启测试与真实 Next.js/FastAPI 隔离数据库回归。Pydantic AI 当前先用于检索计划；课程质量修复仍是 `generate_course` 动作内的 TypeScript 子流程，全部 Agent 的 Pydantic AI 迁移与更细节点拆分留到证据课程接线时完成。

### 阶段 E：检索接入 Tutor

1. 由课节目标构造检索输入；
2. 建立证据 Token 预算和来源去重；
3. Tutor 接收 `EvidenceBundle`；
4. 输出并校验 `blockSourceBindings`；
5. 来源不足时进入 `source_insufficient`；
6. 检索和生成阶段进入现有进度流。

完成条件：正式来源课程的每个必要教学块均能回到固定片段。

### 阶段 F：来源题目与固定评分

1. 题目生成保存 `sourceChunkIds`；
2. 题目来源必须来自 `taughtBlockIds`；
3. 参考答案和 rubric 固定到同一来源快照；
4. 评分只读取固定快照；
5. 质量门禁同时检查教学追溯和来源追溯。

完成条件：资料更新、停止使用或重新上传后，历史评分标准保持不变。

### 阶段 G：引用 UI 与回归

1. 资料区和真实解析进度；
2. 教学块来源抽屉；
3. 来源不足、部分来源和冲突状态；
4. 权限、恶意资料、历史快照和公开字段回归；
5. 记录 Recall@K、引用覆盖、延迟、Token 和失败原因；
6. 同步 README、课程说明、V1、Roles、数据库文档和项目亮点。

完成条件：从导入资料到来源课程、来源题目和固定评分的完整 E2E 通过。

### 阶段 H：联网资料补充

1. `search_web` 只返回来源候选，不直接进入课程 Prompt；
2. 用户选中后通过 `ingest_url` 进入统一 Source、Version、ParseRun、ChunkSet 和 Embedding 主链；
3. 绑定当前 Goal 并重新执行覆盖检查；
4. 网页更新创建新版本，不在检索或评分时自动刷新；
5. 完成 SSRF、重定向、协议、地址、体积和超时安全回归。

完成条件：本地资料不足的 interrupt 可以在用户补充可信网页后恢复，并生成与本地文件相同可追溯标准的课程。

---

## 16. Definition of Done

V0.4.4 核心版只有同时满足以下条件才算完成：

- [x] 支持粘贴文本、TXT、可检索 PDF 和 DOCX；
- [x] 扫描 PDF 明确返回 `ocr_required`；
- [ ] 所有资料、版本、片段和目标关系都执行用户所有权校验；
- [x] Schema V9 新库、V8 表重建迁移、旧 Chunk ID 保留、重复迁移和完整性校验通过；
- [ ] FTS5 检索只访问当前用户、当前目标和启用版本；
- [ ] 检索结果受 chunk 数、单资料占比和 Token 预算约束；
- [ ] 资料不足时进入 `source_insufficient`，不静默伪装为来源课程；
- [x] 目标准备主流程使用持久化 LangGraph checkpoint，并能在请求结束或服务重启后恢复；
- [x] 等待诊断回答和资料不足等待使用显式 `interrupt`，恢复时沿用同一个 `thread_id`；
- [x] 图状态不复制全文、完整 Chunk 或课程正文，外部动作重放通过幂等结果缓存避免重复业务记录；
- [x] 当前 Pydantic AI 检索计划输出经过 schema 校验，模型不能决定用户、权限或业务事务；
- [ ] 不再把课节全部来源复制给每个教学块；
- [ ] 所有 `grounded` 必要教学块绑定真实 chunk 和非空快照哈希；
- [ ] 所有 `grounded` 正式题目绑定其已教学块的来源片段；
- [ ] 评分不重新检索，使用生成题目时的固定来源快照；
- [ ] 资料更新和软删除不改变历史课程与评分依据；
- [ ] 课程页能够查看来源标题、页码/章节和引用片段；
- [ ] 普通用户看不到文件存储路径、内部检索分数、参考答案或 rubric；
- [ ] 恶意资料不能改变系统指令、调用工具或读取其他用户资料；
- [ ] 固定资料集建立可复现的 Recall@K 与引用覆盖基线；
- [ ] 解析、检索、生成、质量和失败均记录耗时、Token 或错误原因；
- [ ] `typecheck`、`lint`、数据库校验、生产构建和 V0.4.4 E2E 通过；
- [ ] README、课程说明、V1、Roles、数据库说明和项目亮点同步更新；
- [ ] 没有把确定性 RAG 包装成独立 Agent，也没有借框架迁移重写 Next.js、数据库或全部 CRUD；
- [ ] 联网资料仅在本地闭环之后接入，搜索候选不会未经抓取、解析和入库直接用于教学；
- [ ] 没有未经实验支撑的学习效果百分比。

---

## 17. 建议代码位置

```text
app/
  api/knowledge-sources/route.ts
  api/knowledge-sources/[id]/route.ts
  api/knowledge-sources/[id]/retry/route.ts
  api/goals/[id]/sources/route.ts
  source-library.tsx
  learning-studio.tsx

lib/
  knowledge/
    types.ts
    validation.ts
    extractors/
      text.ts
      pdf.ts
      docx.ts
    chunking.ts
    retrieval.ts
    grounding.ts
    security.ts
  db/
    schema.ts
    knowledge-sources.ts
    retrieval.ts
    programs.ts
  agents/
    types.ts
    tutor.ts
  learning-loop/
    service.ts

scripts/
  validate-database-schema.mjs
  v044-rag-smoke.mjs
  fixtures/v044/
```

具体文件名可以随实现调整，但解析、检索、来源校验和 Agent Prompt 不能混在一个大文件中。

---

## 18. 与后续版本的边界

| 版本 | 重点 | 与 V0.4.4 的关系 |
|---|---|---|
| V0.4.3 | 结构化课程与教学质量门禁 | 提供 `LearningBlock`、内容版本和题目追溯基础 |
| V0.4.4 基础/向量阶段 | 私有资料、MinerU、父子切片、FTS5、Embedding 与资料级向量检索 | 已完成主要底座，不改变 Tutor 证据契约 |
| V0.4.4 编排阶段 | Pydantic AI 与 LangGraph 最小课程主图 | 目标范围 Tool 核心已经完成；在修改 Tutor 为来源课程前建立可恢复边界 |
| V0.4.4 教学阶段 | 来源课程、来源题目、固定评分与引用 UI | 使用同一 EvidenceBundle 和不可变快照 |
| V0.4.4 联网阶段 | 用户 URL 与官方联网来源 | 进入统一来源版本和片段链，增加联网权限与安全门禁 |
| V0.4.5 | 工作流扩展与加固 | 扩展补课、间隔复习和更多人工确认点，不再承担首次框架迁移 |
| V0.5 | 补课、阶段考核、模拟面试与毕业门禁 | 使用固定来源和高质量教学证据推进正式考核 |
| 后续 Schema | 困惑、收藏和 `open_book` | 与本文独立；V10/V11 已被 Embedding 与目标资料范围使用，实施时再分配版本 |

---

## 19. 给后续开发者或 LLM 的修改约束

继续实现 V0.4.4 时必须遵守：

1. 先读取本文、V0.4.3、V1、Roles、README 和当前数据库 Schema；
2. 不把来源是否可信与 LLM 是否成功混成一个 `mode`；
3. 不把整份文件或全部 chunks 塞入 Prompt；
4. 不让客户端提交用户 ID、文件路径、课程正文或任意检索结果；
5. 不把所有课节来源自动复制给每个教学块；
6. 不在评分时重新检索并改变参考标准；
7. 不允许 `grounded` 在缺少块级或题目级来源时通过；
8. 不因用户删除资料而静默破坏历史证据；
9. 不把用户资料中的指令当作系统指令；
10. LangGraph/Pydantic AI 只迁移目标准备与课程生成主流程；不得让 Python 图直接绕过 Next.js 的所有权、幂等和事务门禁；
11. 每次修改同步 README 变更记录；
12. 所有量化结论必须来自固定资料集、数据库查询或自动回归。

如果实现方向与本文发生冲突，应先修改本文并说明原因，再修改代码，避免设计、数据库和 UI 再次出现版本漂移。
