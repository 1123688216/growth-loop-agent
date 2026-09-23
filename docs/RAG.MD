# Growth Loop RAG 总体架构

> 三层研究增量：Schema V14 保存研究记录与动作缓存，LangGraph 独立 web-research 图等待用户选择；Pydantic AI 拟定查询/评估候选，Next.js 执行有权限的搜索/收录工具。DeepSeek 原生联网可替代 Tavily Search，但正文提取暂仍使用 Tavily Extract，模型回答不作为原文。最多两轮外层请求，单次 DeepSeek 内部搜索次数由提供商控制。

> 2026-09-07 联网增量：Schema V13 新增 web_search_candidates 与 web_source_imports。Tavily 仅发现候选和提取选中网页正文；正文按 text/Markdown 进入同一 Source 主链，URL 映射与抓取时间另存。搜索结果由用户选择，不自动触发课程重生成；同一 URL 复用现有快照。向量化失败保留 FTS5 并提示重试。尚未提供 Agent 自主联网循环和手动 URL 导入。

> 2026-09-07 增量基线（优先于下方历史状态）：Schema V12，目标范围 Tool 与 LangGraph 编排已接入。Tutor 使用受权限校验的 RetrievalRun 快照生成/复核/修订，教学块保存实际引用及哈希，前端仅展示有限摘录。无资料 auto Demo 保留 unverified；已有候选资料不足不能静默退回无来源教学。课堂问答 Tool、题目来源链、联网及策略目录待实现，SubAgent 延期。

> 文档状态：目标架构、当前实现基线与后续约束  
> 更新日期：2026-09-01  
> 当前实现：Schema V10、个人资料库、规范化 Markdown、结构化原子单元、不可变 ParseRun/ChunkSet、FTS5、重新切片、父子查看器、本地双模型 Embedding、资料级精确向量检索、RetrievalRun 快照和 Embedding/检索阶段计时已经完成；MinerU protocol v2、LlamaIndex 适配代码和本机 MinerU GPU 服务均已跑通。图片视觉理解方案已经冻结但尚未接入 VLM；LLM 边界辅助、目标绑定、混合检索、Agent Tool、URL 导入和联网搜索尚未完成。  
> 相关文档：[V0.4.4 实施方案](IMPLEMENTATION_PLAN_V044.md)、[V1 实施方案](IMPLEMENTATION_PLAN_V1.md)、[Agent 角色与信息边界](AGENT_ROLES.md)

## 1. 文档目的

本文冻结 Growth Loop 的 RAG 总体关系，避免后续分别实现文件上传、网页链接、联网搜索、语义切片和课程引用时反复修改数据库与 Agent 契约。

本文关注的不是某一个解析库，而是所有来源必须遵守的共同数据链：

```text
发现资料
→ 收录资料
→ 保存不可变原始快照
→ 提取结构化原子单元
→ 生成不可变切片集合
→ 建立父子切片和检索索引
→ 绑定学习目标
→ Agent 通过受控 Tool 检索
→ 固定检索快照
→ 课程、题目和评分引用同一证据
```

后续更换解析器、Embedding 模型、LLM、检索算法或 Agent 框架时，只能替换链路中的具体实现，不能绕开这条证据关系。

---

## 2. 已冻结的架构决策

### 2.1 RAG 是服务和 Tool，不是独立 Agent

文件解析、网页抓取、结构识别、切片、索引、权限过滤、Token 预算、去重和证据快照由普通服务负责。

Planner、Tutor 等 Agent 只决定什么时候调用受控 Tool，不直接访问文件系统、数据库、任意 URL 或其他用户的资料。

### 2.2 所有入口汇入同一条资料流水线

以下入口不能各自建立一套 RAG：

- 用户粘贴文本；
- 用户上传 TXT、PDF、DOCX，未来可扩展 Markdown；
- 用户主动发送 URL；
- Agent 联网搜索后选择的 URL。

入口只影响来源元数据和前置处理。进入 `knowledge_source` 后，版本、结构、切片、索引、目标关系和引用方式必须一致。

### 2.3 来源方式与内容格式分离

当前 `knowledge_sources.kind` 同时承担来源和格式含义，只能表达 `text / txt / pdf / docx`。目标结构必须拆分：

```ts
type SourceOriginType =
  | "paste"
  | "upload"
  | "user_url"
  | "web_search";

type SourceContentFormat =
  | "text"
  | "txt"
  | "markdown"
  | "html"
  | "pdf"
  | "docx";
```

例如用户发送一个 PDF 链接时：

```json
{
  "originType": "user_url",
  "contentFormat": "pdf"
}
```

迁移期间保留 `kind` 兼容旧代码，但新逻辑不得继续用 `kind` 判断资料是上传还是联网获得。

### 2.4 原始证据与 LLM 衍生产物分离

系统必须保存：

1. 原始文件或原始网页快照；
2. 确定性提取的正文和结构；
3. LLM 生成的摘要、关键点、标签和边界判断。

LLM 摘要不能替代原文，LLM 也不能把改写后的内容当成引用证据。

### 2.5 切片集合不可变

同一份 `source_version` 可以拥有多套切片。当前实际存在的策略是：

- `character-boundary-v1`：Schema V8 遗留字符切片，迁移后记录为 `legacy-character`；
- `structure-parent-child-v2`：当前默认策略，增加 PDF 软换行修复、实验/案例标题识别、句末优先递归边界和父子切片；
- `llama-index-core-0.14.24-hierarchical-v1`：启用 Python ingestion 服务后的成熟组件策略，在 MinerU/Markdown 结构内部使用 `HierarchicalNodeParser` 生成两级 Parent/Child；
- `structure-llm-v1`：未来的结构加 LLM 模糊边界辅助；
- 未来的 Embedding 语义切片。

每次重新切片创建新的 `chunk_set`，不能覆盖、更新或删除已经被课程和检索快照引用的旧 chunks。

### 2.6 父子切片是正式结构

- Parent 保存完整章节或主题上下文；
- Child 保存更小、可精确匹配的知识单元；
- 默认只检索 Child；
- 命中 Child 后按 Token 预算展开 Parent、相邻 Child 或章节路径；
- Parent 与 Child 都必须来自同一个 `chunk_set`。

父子关系本身不会自动降低检索耗时。只有先匹配 Parent 摘要、再限定 Child 候选范围的两阶段检索，才可能减少匹配范围。

### 2.7 LLM 只能决定边界，不能重写证据

LLM 接收带稳定 ID 的原子单元，只返回：

- 哪些连续原子单元组成一个知识块；
- 建议标题；
- 边界理由；
- 无法判断的结构警告。

最终 chunk 内容由程序按原始单元重新拼装。程序必须验证覆盖率、顺序、连续性、最大长度和内容哈希。

### 2.8 URL 是一次性静态快照

用户 URL 或搜索结果被正式收录时只抓取一次：

- 不做定时刷新；
- 不自动检查 ETag、Last-Modified 或网页变化；
- 不因为 URL 长期存在而重新消耗解析与 LLM Token；
- 相同用户再次提交相同规范化 URL 时优先复用已有 Source；
- UI 显示收录时间，提醒它是历史快照。

`source_versions` 继续保留，但当前 URL 通常只有版本 1。未来若需要重新收录，必须由用户明确触发并另行设计，当前不实现。

### 2.9 搜索结果不是正式知识来源

搜索标题、URL 和摘要只属于候选结果。只有 Agent 或用户选择结果并成功抓取正文后，才创建 `knowledge_source`、结构和 chunks。

不得把全部搜索结果、搜索摘要或无法访问的网页直接写入检索索引。

### 2.10 评分不重新检索

课程和题目生成时固定 `retrieval_run` 及其证据快照。评分只读取题目生成时的快照，不搜索最新资料、不更换切片集合、不调用联网搜索。

---

## 3. 当前实现与目标架构

### 3.1 当前已经实现

```text
粘贴文本 / TXT / PDF / DOCX
→ ingestKnowledgeSource 统一入口
├─ 未配置 Python 服务：TypeScript 结构解析 + structure-parent-child-v2
└─ 配置 Python 服务
   ├─ 文本：Markdown → LlamaIndex
   └─ PDF/DOCX：MinerU protocol v2 → Markdown/content_list_v2 → LlamaIndex
→ ExtractedDocument + SourceChunkSetDraft 稳定契约
→ 不可变 ChunkSet
→ Parent / Child chunks
→ FTS5 自动写入
→ 资料库、重新切片与父子查看器
→ BGE-M3 / Qwen3-Embedding-0.6B 批量向量化
→ SQLite 精确余弦召回 Child
→ Parent 去重展开与 RetrievalRun 快照
```

当前优点：稳定、可回退、可复现，已经能保存原文件、抽取文本、规范化 Markdown、节点、哈希、页码、字符范围、边界原因和 Token 估算。成熟组件和业务数据库之间只有一个明确 DTO 契约；旧 V8 chunks 迁移时保留原 ID，重新切片会创建新集合，全部写入成功后才切换 active 集合。

当前成熟适配层的边界：

- Python 服务固定使用 Python 3.10–3.12；本机开发环境采用 Python 3.12；
- MinerU 使用官方 API protocol v2：`GET /health`、`POST /tasks`、轮询任务状态、下载结果 ZIP；
- 对 MinerU 3.4.5 提交任务时固定使用接口允许的 `effort=medium`（可配置为 `high`），服务端 4xx/5xx 的官方错误详情必须透传到 ingestion 响应；
- ZIP 在内存中检查路径穿越、条目数量、解压总量和异常压缩比，不把服务端文件名直接写入用户目录；
- 优先读取 `content_list_v2.json`，页眉、页脚、页码和旁注不进入正文节点；缺少 V2 结构时退回 MinerU Markdown；
- Schema V10 的切片正式模型仍只有 Parent/Child 两级，因此 LlamaIndex 当前从官方默认层级 `[2048, 512, 128]` 取前两级 `[2048, 512]`，并沿用官方默认 20 Token overlap；不把第三层偷偷塞进 Child。这些数值只是初始配置，必须通过固定查询集的 Recall@K、上下文完整率和 Token 成本调优；
- Python 返回值仍是现有 `ExtractedDocument + SourceChunkSetDraft`，数据库不保存任何 LlamaIndex 对象或 MinerU 私有对象；
- `RAG_INGESTION_REQUIRED=false` 时服务故障会记录 warning 并回退 TypeScript；设为 `true` 时直接失败，避免生产环境误以为使用了 MinerU；
- 本机已部署 MinerU 3.4.5，并用 1 页样本和 66 页真实 PDF 跑通 `MinerU → Markdown/content_list_v2 → LlamaIndex Parent/Child`；当前验证证明链路可运行，不代表 OCR、复杂表格、图片语义和检索精度已经通过专项评测。
- 本机已固定 BGE-M3 与 Qwen3-Embedding-0.6B revision；Embedding 服务只接受两个模型别名，不接受任意本机路径，同一时间只在 GPU 中保留一个模型；Document 输入固定为 `context_prefix + Child 原文`，Query 仅对 Qwen 使用固定检索指令；
- 每个模型 revision 与输入模板形成独立 `embedding_profile`，同一 Child 可保存多套向量；重跑按实际模型输入哈希复用，切换 active ChunkSet 后不会误用旧向量；
- 当前向量存储为 SQLite float32 BLOB，召回使用归一化向量点积执行精确余弦扫描。该实现适合个人 Demo、单资料和模型 A/B，不是大规模 ANN 方案。

当前缺陷：

- 默认回退路径中的 DOCX 已保留标题、段落、列表、代码和表格文字，但图片与复杂样式仍不能成为结构化证据；
- 配置 Python ingestion 服务时，PDF/DOCX 已进入 MinerU 成熟解析路径；未配置服务时 PDF 仍回退 `pdf-parse`。MinerU 提取出的图片目前只作为解析资产和结构节点存在，尚未经过视觉语义理解；
- 当前结构识别以确定性规则为主，模糊标题和跨段语义边界尚未经过 LLM 辅助；
- 当前已有资料级精确向量检索和真实 RetrievalRun，但尚未完成面向目标的权限范围、BM25/向量混合路由、reranker 和固定查询集 A/B 质量评测；
- chunks 已能固定到向量 RetrievalRun，尚未绑定课程和题目；
- Agent 尚不能调用资料库。

### 3.2 目标架构

```text
Source Discovery
├─ paste
├─ upload
├─ user_url
└─ web_search → selected result
        ↓
Knowledge Source
        ↓
Immutable Source Version
        ↓
Parse Run
        ↓
Document Nodes
        ↓
Immutable Chunk Set
        ↓
Parent Chunks
        ↓
Child Chunks → FTS5 / Embedding
        ↓
Goal Source Link
        ↓
Retrieval Run + Fixed Items
        ↓
Lesson Block / Question / Rubric / Assessment Snapshot
```

---

## 4. 统一领域模型

### 4.1 `KnowledgeSource`

用户视角的一份逻辑资料。它回答：

- 这是什么资料；
- 属于哪个用户；
- 从哪里获得；
- 是什么内容格式；
- 当前是否可用；
- 当前默认使用哪个内容版本和切片集合。

目标字段：

```text
id
user_id
title
description
origin_type                 paste / upload / user_url / web_search
content_format              text / txt / markdown / html / pdf / docx
original_filename
mime_type
origin_url
canonical_url
origin_domain
search_result_id
content_hash
status
current_version_id
active_chunk_set_id
captured_at
created_at
updated_at
deleted_at
```

`description` 是资料本身的通用说明。某份资料对具体目标的用途不能只写在这里，应写入 `goal_source_links.purpose`。

### 4.2 `SourceVersion`

保存不可变的原始快照和抽取正文：

```text
id
source_id
user_id
version
raw_blob
raw_content_type
extracted_text
text_hash
parser_version
status
warnings_json
created_at
```

上传文件和静态 URL 首次收录通常都只有版本 1。重新解析和重新切片不创建新的内容版本，应分别创建新的 `parse_run` 和 `chunk_set`。

### 4.3 `IngestionJob`

大文件、URL 抓取和 LLM 辅助切片不能长期占用一个同步 HTTP 请求。`ingestion_jobs` 负责进度和失败恢复：

```text
id
user_id
goal_id
source_id
input_type                  paste / upload / user_url / web_search_result
input_ref
stage                       queued / fetching / extracting / structuring /
                            chunking / indexing / ready / failed
progress_percent
message
error_code
error_message
workflow_run_id
created_at
updated_at
completed_at
```

`knowledge_sources.status` 保持粗粒度状态，详细阶段只放在 Job，避免来源表状态无限膨胀。

### 4.4 `ParseRun` 与 `DocumentNode`

实际表名为 `document_parse_runs`，表示一次结构解析产物：

```text
id
source_version_id
parser_name
parser_version
output_format
status
normalized_markdown
text_hash
node_count
warnings_json
error_message
created_at
completed_at
```

`document_nodes` 保存原子单元：

```text
id
parse_run_id
source_version_id
source_id
user_id
position
parent_node_id
node_type                   title / heading / paragraph / list /
                            code / table / equation / image / caption
heading_level
text
section_path_json
page_start
page_end
char_start
char_end
metadata_json
created_at
```

原子单元必须保持原文顺序，并尽可能映射回页码或字符范围。

### 4.5 `ChunkSet`

`source_chunk_sets` 表示针对同一内容版本生成的一套不可变切片：

```text
id
source_id
source_version_id
parse_run_id
strategy                    character / structure / structure_llm / semantic
strategy_version
status
parent_count
child_count
config_json
warnings_json
created_at
activated_at
```

同一 Source 由 `knowledge_sources.active_chunk_set_id` 指向未来检索使用的 ChunkSet。旧集合保持不可变，以支持历史回放；不在 ChunkSet 表使用易产生多行并发冲突的 `is_active` 标记。

### 4.6 Parent 与 Child

`source_parent_chunks`：

```text
id
chunk_set_id
source_id
source_version_id
position
heading
section_path_json
content
node_start_order
node_end_order
token_estimate
content_hash
created_at
```

现有 `source_chunks` 继续作为 Child，但需要迁移为：

```text
id
chunk_set_id
parent_chunk_id
source_id
source_version_id
user_id
position
heading
section_path_json
context_prefix
content
node_start_order
node_end_order
page_start
page_end
char_start
char_end
token_estimate
boundary_reason_json
content_hash
created_at
```

当前唯一约束 `UNIQUE(source_version_id, position)` 必须调整为：

```text
UNIQUE(chunk_set_id, position)
```

SQLite 无法直接删除旧唯一约束，因此 Schema V9 已执行明确的表重建迁移：先为旧 chunks 创建 `legacy-character / character-boundary-v1` ChunkSet 和对应 Parent，再把旧数据挂到该集合。迁移保留原 Child ID 和证据外键，不能直接清空用户已有切片。

### 4.7 `SourceArtifact`

`source_artifacts` 保存 LLM 衍生产物，不参与原文真实性判断：

```text
id
source_version_id
chunk_set_id
parent_chunk_id
artifact_type               summary / key_points / keywords / entities
content_json
evidence_node_ids_json
model
prompt_version
input_tokens
output_tokens
created_at
```

摘要和关键点必须保存引用的 node IDs 或 chunk IDs，不能成为无来源的独立知识。

### 4.8 `PipelineRun` 与阶段计时（Schema V10 已部分实现）

解析、切片、Embedding、索引和查询不能只输出一个总耗时，也不能只使用前端进度动画或临时日志。为保证 BGE-M3、Qwen3 Embedding、不同切片策略和不同检索路由可重复比较，Schema V10 已增加统一运行与阶段指标：

```text
pipeline_runs
id
trace_id
user_id
source_id
chunk_set_id
operation                   ingestion / index / embedding / retrieval
profile_id
status                      running / completed / failed
started_at
completed_at
total_duration_ms
config_json
error_code
error_message

pipeline_stage_metrics
id
pipeline_run_id
parent_stage_id
stage
attempt
status                      running / completed / failed / skipped
started_at
completed_at
wall_duration_ms
compute_duration_ms
queue_duration_ms
input_count
output_count
input_tokens
output_tokens
cache_state                 cold / warm / hit / miss / not_applicable
provider
model
model_revision
device
batch_size
metadata_json
error_code
error_message
```

`config_json` 必须保存会影响比较结果的参数快照，例如 ChunkSet、Embedding 维度、归一化方式、距离算法、Top K、查询指令版本、候选过滤范围和并发数。`metadata_json` 不得保存 API Key、Cookie、完整用户查询或整段私有资料。

阶段名称至少覆盖：

```text
ingestion.validate
ingestion.mineru_submit
ingestion.mineru_wait
ingestion.mineru_download
ingestion.structure
ingestion.chunk
ingestion.persist
index.fts
embedding.model_load
embedding.tokenize
embedding.encode
embedding.persist
retrieval.query_encode
retrieval.filter
retrieval.bm25
retrieval.vector
retrieval.fusion
retrieval.rerank
retrieval.parent_expand
retrieval.evidence_bundle
```

没有执行的阶段保存为 `skipped`，不能记成 0ms 并伪装为已执行。BM25 与向量检索未来若并行运行，各自保存真实时间，总耗时按运行起止时间计算，不能简单相加。

当前已埋点 `embedding.model_load / tokenize / encode / persist` 和 `retrieval.query_encode / filter / vector / parent_expand / evidence_bundle`。Python 使用 `perf_counter_ns()` 测量模型计算，Node.js 使用 `performance.now()` 测量服务往返、SQLite 持久化和召回；冷/热状态、revision、设备、dtype、batch size、输入数量和 Token 均随运行落库。MinerU、结构恢复、切片、FTS、BM25、融合与重排阶段仍需继续接入，性能查看页也尚未实现。

---

## 5. 各类入口如何进入统一链路

| 入口 | `origin_type` | 前置处理 | 是否立即成为 Source |
|---|---|---|---|
| 粘贴文本 | `paste` | 编码与空内容检查 | 是 |
| 上传文件 | `upload` | 文件签名、MIME 与安全解析 | 是 |
| 用户 URL | `user_url` | URL 安全检查、抓取和正文提取 | 成功抓取后是 |
| 联网搜索结果 | `web_search` | 先保存候选，选中后抓取 | 只有选中且抓取成功后是 |

所有入口进入 Source 后都执行：

```text
SourceVersion
→ ParseRun
→ DocumentNodes
→ ChunkSet
→ Parent/Child Chunks
→ Index
```

不得为 URL、搜索结果或某种文件格式另外建立一套课程引用表。

---

## 6. 用户发送 URL 的处理方式

### 6.1 用户意图

链接入口支持三种意图，但最终是否持久化必须明确：

```ts
type UrlIngestionIntent =
  | "preview_only"
  | "save_to_library"
  | "bind_to_current_goal";
```

- `preview_only`：只用于当前回答，不进入长期检索；
- `save_to_library`：保存到个人资料库；
- `bind_to_current_goal`：保存并创建 `goal_source_link`。

在目标或课程上下文中用户明确说“学习、收录、作为资料”时，可以直接绑定当前目标；仅发送裸链接且意图不明确时，先展示抓取预览，再由用户确认长期保存，避免个人资料库积累噪声。

### 6.2 URL 收录流程

```text
接收 URL
→ 规范化 URL 并移除常见跟踪参数
→ 安全检查
→ 查询当前用户是否已有相同 canonical_url
   ├─ 有：复用 Source，按需要绑定目标
   └─ 无：创建 IngestionJob
          → 抓取一次
          → 根据真实 Content-Type 选择 HTML/PDF 等解析器
          → 保存原始静态快照
          → 结构解析与父子切片
          → 建立索引
          → 可选生成摘要和关键点
```

### 6.3 不做网页更新

当前明确不实现：

- 自动刷新；
- 定时爬取；
- ETag/Last-Modified 检查；
- 打开资料时重新请求原网页；
- 自动创建 URL 新版本。

后续课程和问答始终使用数据库中的首次收录快照。`captured_at` 必须在 UI 和引用中可见。

---

## 7. 联网搜索如何入库

### 7.1 搜索运行

`web_search_runs` 保存一次搜索行为：

```text
id
user_id
goal_id
agent_run_id
query
provider
status
result_count
latency_ms
created_at
```

### 7.2 候选结果

`web_search_results` 保存候选元数据：

```text
id
search_run_id
rank
title
url
canonical_url
domain
snippet
published_at
selection_status            candidate / selected / ignored / fetch_failed
source_id
created_at
```

这些候选不写入 `source_chunks_fts`，也不能直接生成 grounded 课程。

### 7.3 从候选变成正式资料

```text
Agent 调用 search_web
→ 得到候选结果
→ 根据目标、域名、摘要和重复情况选择少量结果
→ 调用 ingest_search_result
→ fetch_url 受控抓取
→ 创建或复用 KnowledgeSource
→ 写回 web_search_results.source_id
→ 进入统一结构和切片流水线
```

默认不批量抓取全部结果。搜索负责发现 URL，收录服务负责创建知识来源，两者不能合并成一个不可审计的大调用。

---

## 8. 原子单元提取

### 8.1 DOCX

当前 `mammoth.extractRawText()` 会丢失结构。目标实现应优先使用结构化 HTML 或直接读取 OOXML：

- `h1-h6` / `w:pStyle` → heading；
- `p` → paragraph；
- `ul/ol/li` / `w:numPr` → list 与 list_item；
- `table` / `w:tbl` → table；
- `pre/code`、代码样式、等宽字体 → code；
- 段首加粗并以冒号结尾 → 小标题候选；
- `w:keepNext` → 与下一段保持关系。

段首加粗是否是真正小标题可以由规则先判定，低置信度情况再交给 LLM。

### 8.2 HTML

URL 网页先移除导航、广告、页脚和重复区域，再按 DOM 元素转换：

- `h1-h6` → heading；
- `p` → paragraph；
- `ul/ol/li` → list 与 list_item；
- `pre/code` → code；
- `table` → table；
- `blockquote` → quote；
- `figcaption` → caption。

正文清洗必须保留原始 HTML 快照和节点到原文的定位信息。

### 8.3 TXT 与 Markdown

- Markdown 使用正式语法树解析标题、列表、代码、表格和引用；
- TXT 根据空行、编号、缩进、项目符号和代码围栏推断；
- 无法可靠恢复的格式标记为普通段落，不能伪造结构。

### 8.4 PDF

配置 Python ingestion 服务时，PDF 由 MinerU 恢复 Markdown 与 `content_list_v2.json`，再按页码、坐标、块类型和文档顺序映射为原子节点；未配置服务时才回退 `pdf-parse` 逐页文本。复杂表格、双栏版面和扫描件仍可能无法准确恢复：

- 可提取文本但结构不确定：保留 warning，并允许 LLM 只辅助边界；
- 文本不足：进入 `ocr_required`；
- MinerU 可以执行 OCR 和版面分析，但当前尚未完成扫描件专项样本验收，不能把“服务可运行”等同于“OCR 质量已达标”；
- 不把错误恢复的表格宣称为可靠结构。

### 8.5 图片提取与按需视觉理解（已冻结设计，暂未实现）

MinerU 负责检测图片区域、裁剪并保存图片资产，同时在 Markdown 中保留相对引用、在结构结果中保留页码、坐标、图注和相邻节点。MinerU 完成的是图片提取和版面结构恢复，不等于已经理解流程图、架构图、统计图或代码截图的语义。

视觉模型不能对所有图片无条件调用。目标流程固定为：

```text
MinerU 提取 Image Node 与图片资产
→ 判断是否存在值得理解的图片
├─ Logo、图标、装饰图、重复页眉：忽略
├─ 图注和正文已完整表达：优先使用原文，不调用 VLM
└─ 流程图、架构图、示意图、统计图、代码截图：调用 VLM
→ 默认 detail=low
→ 检查文字覆盖、结构完整性和模型置信度
→ 仅在低置信度、文字缺失或明确需要高分辨率时升级 detail=original
→ 保存结构化视觉衍生产物，并保留到原图和上下文节点的引用
```

`low` 会缩小图片，因此升级条件不能只看图形是否复杂，还要看节点文字是否足够清晰。建议的确定性升级信号包括：

- 视觉结果 `confidence < 0.75`；
- VLM 明确返回 `text_incomplete=true` 或 `needs_higher_resolution=true`；
- MinerU/OCR 发现文本区域，但 VLM 没有覆盖关键标签；
- 代码截图、密集表格或小字号流程图在 `low` 下无法恢复关键内容。

视觉结果属于 `SourceArtifact`，建议至少保存：

```text
artifact_type               image_understanding
image_node_id
asset_ref
image_type                  diagram / chart / table / code / screenshot / other
summary
elements_json
relations_json
ocr_text
confidence
detail_level                low / original
context_node_ids_json
model
prompt_version
input_tokens
output_tokens
```

图片摘要不得替代原图或原文证据。后续检索优先索引图片摘要、OCR 文字、元素和关系；命中后回读原图、图注与所在 Parent。第一阶段不做原始图片向量，先把结构化视觉结果作为文本 Child 的补充证据。当前主文本模型 `deepseek-v4-flash` 不接收图片，未来单独配置 `deepseek-v4-flash-vision-exp` 或其他可替换 VLM，不能让全部文本任务改走视觉模型。

### 8.6 原子单元约束

- 节点顺序必须严格递增；
- 节点文本必须能回到原文范围；
- 标题级别允许为空，但不能伪造；
- 表格、代码块和列表必须保留整体语义；
- 单个节点过长时才允许使用句子或行级子节点；
- 所有节点内容哈希可复算。

---

## 9. 父子切片与 LLM 辅助

### 9.1 确定性结构分组

先按标题层级建立章节树：

```text
Document
└─ Heading 1
   ├─ Paragraph
   ├─ Heading 2
   │  ├─ Paragraph
   │  └─ Code
   └─ Heading 2
      └─ Table
```

Parent 优先对应一个完整章节或子章节。Child 在 Parent 内组合连续原子单元，不能跨越无关章节。

### 9.2 Child 组合规则

- 标题至少和一个正文节点一起出现；
- 列表默认整体保留；
- 代码与紧邻的解释、输入输出说明优先保留；
- 表格过长时按行拆分并重复表头；
- 定义、解释、示例和边界条件优先组成完整知识单元；
- Child 目标大小由 Token 预算控制，不能只用字符数；
- 只有单个原子单元本身过长时才降级到句子切分；
- 重叠必须以节点或句子边界为单位，不能固定回退若干字符。

初始建议范围不是永久常量，必须通过检索评测调整：

```text
Child：约 300–700 tokens
Parent：约 1,500–3,000 tokens
```

### 9.3 Embedding 与 LLM 的位置

目标混合流程：

```text
结构规则生成原子单元
→ Embedding 计算相邻单元语义变化，提出候选断点
→ LLM 只审核模糊断点与合并关系
→ 程序按节点 ID 组装原文
→ 硬校验
```

Embedding 与 LLM 都不是格式解析器。明确的标题、列表和代码边界不需要再次消耗 LLM Token。

### 9.4 LLM 输入输出

输入示例：

```json
{
  "section_path": ["常见分块策略"],
  "units": [
    {"id": "u1", "type": "heading", "text": "固定大小切分"},
    {"id": "u2", "type": "paragraph", "text": "最简单的方法……"},
    {"id": "u3", "type": "heading", "text": "递归切分"},
    {"id": "u4", "type": "paragraph", "text": "按照文档自然边界……"}
  ]
}
```

输出示例：

```json
{
  "groups": [
    {
      "start_unit_id": "u1",
      "end_unit_id": "u2",
      "title": "固定大小切分",
      "reason": "标题、定义和优缺点构成完整知识单元"
    },
    {
      "start_unit_id": "u3",
      "end_unit_id": "u4",
      "title": "递归与结构感知切分",
      "reason": "标题和解释不可分开"
    }
  ]
}
```

禁止 LLM 返回整段改写正文作为 chunk。

### 9.5 硬校验与回退

LLM 结果必须通过：

- unit IDs 全部存在；
- 每组单元连续且顺序正确；
- 原子单元覆盖率 100%；
- 不重复、不遗漏；
- 不跨 Parent；
- 代码、列表、表格完整性合格；
- Child 与 Parent Token 在允许范围；
- 程序组装后的文本哈希可复算。

失败时按顺序回退：

```text
structure_llm
→ structure
→ sentence_boundary
→ character_boundary（最终兜底）
```

回退必须记录原因，不能把兜底结果标记成 LLM 增强成功。

---

## 10. 目标关系

同一份 Source 可以绑定多个目标，不能为每个目标复制一份资料和 chunks。

`goal_source_links` 目标字段：

```text
goal_id
source_id
user_id
status                      active / disabled
purpose
scope_note
priority
added_via                   user / planner / tutor / search
created_at
```

- `description` 描述资料是什么；
- `purpose` 描述它对当前目标有什么用；
- `scope_note` 描述只使用哪些章节或排除哪些内容；
- 取消关联不删除 Source；
- Source 软删除后从未来检索排除，但历史快照继续可回放。

---

## 11. 检索流程

当前已实现的最小检索链为：登录用户与单一 Source 过滤 → active ChunkSet → Query Embedding → 所有已向量化 Child 的精确余弦排序 → 同 Parent 去重 → Parent 原文展开 → RetrievalRun 与快照落库。它用于先验证 Embedding、数据隔离、父子回读和计时，不等同于下面的完整默认混合检索。

### 11.1 默认检索

```text
用户/目标/课节上下文
→ 生成受限查询
→ 只读取当前用户、当前目标、active Source 和 active ChunkSet
→ FTS5 / Embedding 召回 Child
→ 相同 Child 和高重叠 Child 去重
→ 每个 Source 与 Parent 限制最大占比
→ 按 Token 预算展开 Parent 或相邻 Child
→ 形成 EvidenceBundle
→ 固定 RetrievalRun
```

Agent 不接收整份文件，也不能自行要求任意 Source ID。

### 11.2 两阶段父子检索

资料较大时可以启用：

```text
查询 Parent 标题与摘要
→ 选出少量 Parent
→ 只在这些 Parent 下检索 Child
→ 展开必要上下文
```

是否启用必须由固定检索集验证。不能因为理论上更快就默认宣称性能提升。

### 11.3 EvidenceBundle

```ts
type RetrievedEvidence = {
  childChunkId: string;
  parentChunkId: string;
  chunkSetId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceTitle: string;
  originType: SourceOriginType;
  contentFormat: SourceContentFormat;
  sectionPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  childText: string;
  expandedContext: string;
  childHash: string;
  parentHash: string;
  retrievalScore: number;
};
```

`retrievalScore` 只是排序分数，不是真实性分数。

### 11.4 固定快照

`retrieval_run_items` 后续需要同时记录：

```text
chunk_set_id
parent_chunk_id
child_chunk_id
child_snapshot_text
child_snapshot_hash
expanded_context_snapshot
parent_snapshot_hash
```

这样即使以后启用新的切片集合，旧课程仍然能回放生成时真正看到的上下文。

---

## 12. 课程、题目和评分如何连接

```text
RetrievalRunItem
├─ LessonBlockSource
│  └─ LearningBlock
├─ QuestionSourceLink
│  ├─ Question
│  ├─ ReferenceAnswer
│  └─ Rubric
└─ AssessmentSnapshot
   └─ Grading
```

约束：

- 每个事实型 `LearningBlock` 绑定实际使用的 Child；
- 页面引用可以展示 Parent 标题、章节路径和 Child 摘录；
- 题目来源必须属于其已教学块来源的并集；
- 参考答案与 rubric 只能使用题目生成时的固定快照；
- 评分时不重新检索资料库或网络；
- `grounded` 由服务端按绑定覆盖率计算，模型不能自行声明；
- 来源充分性门禁和教学质量门禁必须同时通过。

---

## 13. Agent 与 Tool 边界

### 13.1 资料发现与收录 Tool

```ts
search_web(input: {
  goalId: string;
  query: string;
  maxResults?: number;
}): WebSearchCandidate[];

preview_url(input: {
  url: string;
}): UrlPreview;

ingest_url(input: {
  goalId?: string;
  url: string;
  intent: "save_to_library" | "bind_to_current_goal";
  description?: string;
}): IngestionJobView;
```

### 13.2 资料检索 Tool

```ts
search_knowledge_base(input: {
  goalId: string;
  query: string;
  topK?: number;
  maxEvidenceTokens?: number;
}): EvidenceBundle;

read_source_chunks(input: {
  retrievalRunId: string;
  childChunkIds: string[];
}): RetrievedEvidence[];

check_source_coverage(input: {
  retrievalRunId: string;
  requiredConcepts: string[];
}): CoverageResult;
```

### 13.3 权限来源

Tool 的 `userId` 必须来自服务端登录会话；`goalId` 必须同时属于当前用户。Agent 和客户端不能提交：

- 任意 `userId`；
- 本地文件路径；
- 任意数据库 chunk ID；
- 未出现在当前 RetrievalRun 的 chunk ID；
- 内网 URL 或本机 URL；
- 课程参考答案和 rubric。

Planner 只获得资料覆盖分析；Tutor 获得当前 Tool 返回的固定证据；Examiner 只在未来来源型大考中读取蓝图允许的快照；Reviewer 不调用检索 Tool。

---

## 14. URL 与网页安全

`preview_url` 和 `ingest_url` 必须由服务端受控抓取器实现：

- 只允许 HTTP/HTTPS；
- 禁止 `file://`、本机、内网、云元数据地址和非公开 IP；
- DNS 解析和每次重定向后都重新校验目标；
- 限制重定向次数、连接时间、总处理时间和响应展开量；
- 根据真实 Content-Type 选择解析器，不只信文件扩展名；
- HTML 中的指令一律视为资料正文，不能覆盖系统提示或触发 Tool；
- 不自动登录、不绕过付费墙、不提交网页表单；
- 动态页面无法可靠提取时返回明确状态，不能保存空壳页面；
- 原始 URL、最终 URL、抓取时间和内容哈希进入审计记录。

用户取消资料大小产品限制，不等于抓取器可以没有技术资源保护。安全超时、内存和展开量保护属于服务稳定性约束，不应被 UI 宣传成简单的固定文件大小上限。

---

## 15. Token、缓存和成本

### 15.1 不重复处理相同资料

处理缓存键：

```text
parse_key = source_version.text_hash + parser_version
chunk_key = parse_run.id + strategy_version + config_hash + prompt_version + model
artifact_key = chunk_set.id + artifact_type + prompt_version + model
```

命中缓存时直接复用，不再次调用 LLM。

### 15.2 LLM 只处理模糊部分

- 明确标题、列表、代码和表格使用规则；
- 只把边界不确定的相邻单元窗口交给 LLM；
- 不把整个大型文档一次塞入 Prompt；
- 使用稳定的结构化输出；
- 记录模型、Prompt 版本和输入输出 Token；
- LLM 失败时走确定性回退。

### 15.3 URL 不自动更新

抓取一次后长期使用数据库快照，不在检索、打开资料、生成课程或定时任务中重新抓取。这样避免重复网络开销、重新切片和 LLM Token。

---

## 16. API 与 UI 关系

### 16.1 已有 API

```text
GET    /api/knowledge-sources
POST   /api/knowledge-sources
DELETE /api/knowledge-sources/[id]
GET    /api/knowledge-sources/[id]/chunks
POST   /api/knowledge-sources/[id]/rechunk
GET    /api/knowledge-sources/[id]/embeddings
POST   /api/knowledge-sources/[id]/embeddings
POST   /api/knowledge-sources/[id]/search
```

### 16.2 后续 API

```text
POST /api/knowledge-sources/url
GET  /api/knowledge-sources/[id]/ingestion-status
GET  /api/knowledge-sources/[id]/chunk-sets
GET  /api/knowledge-sources/[id]/chunk-sets/[chunkSetId]

GET    /api/goals/[id]/sources
POST   /api/goals/[id]/sources
DELETE /api/goals/[id]/sources?sourceId=

POST /api/web-search
POST /api/web-search/[runId]/results/[resultId]/ingest
```

### 16.3 资料库 UI

资料库最终需要展示：

- 来源方式和内容格式；
- 文件名或原始 URL；
- 收录时间；
- 当前解析和切片状态；
- 当前激活的 ChunkSet 策略；
- Parent → Child 树；
- 页码、章节路径、字符范围和 Token；
- LLM 边界理由与回退状态；
- 已绑定的学习目标及目标用途；
- 重新切片入口，但不重新下载 URL；
- 搜索候选与正式入库资料的明显区分。

切片查看器不能只展示正文，还要帮助用户判断“为什么这样切”和“它属于哪个 Parent”。

---

## 17. 状态、幂等与失败恢复

### 17.1 幂等键

- 上传和粘贴文本：`user_id + content_hash`；
- URL：`user_id + canonical_url`；
- ParseRun：`source_version_id + parser_version`；
- ChunkSet：`parse_run_id + strategy_version + config_hash + model + prompt_version`；
- 搜索运行可使用 `agent_run_id + normalized_query` 防止工作流重试重复创建。

### 17.2 失败边界

以下阶段分别保存错误，不能全部显示为“资料处理失败”：

```text
URL 校验失败
网页抓取失败
格式识别失败
正文提取失败
结构解析失败
LLM 边界失败并回退
切片硬校验失败
索引写入失败
目标绑定失败
```

失败不能留下半套 active ChunkSet。只有结构、切片、校验和索引全部成功后，才能原子切换 `active_chunk_set_id`。

### 17.3 计时口径与失败记录

- Node.js 使用单调时钟 `performance.now()`，Python 使用 `time.perf_counter_ns()` 计算持续时间；数据库 UTC 时间只用于跨进程关联，不用于高精度耗时差；
- 模型首次加载与实际编码必须拆开，分别记录 `embedding.model_load` 和 `embedding.encode`，并标明 cold/warm；
- 队列等待、网络等待和本机计算分别记录，不能把 MinerU 轮询等待或下载时间当作 GPU 推理时间；
- 阶段失败也必须写入已消耗时间、attempt 和错误码；重试创建新的 attempt，不覆盖第一次失败；
- 同一批输入的 BGE/Qwen 对比必须使用相同 Child、顺序、batch size、设备、精度、归一化、Top K 和固定查询集；
- 计时器自身不能修改检索排序或用户证据，埋点写入失败也不能让已成功的证据结果变成另一份内容。

---

## 18. 评测指标

### 18.1 结构和切片质量

| 指标 | 含义 |
|---|---|
| 原子单元覆盖率 | 原文是否全部被节点覆盖，目标 100% |
| 顺序正确率 | 节点和 chunks 是否保持原文顺序 |
| 边界完整率 | Child 是否从完整节点/句子开始并结束 |
| 标题正文绑定率 | 标题是否与对应解释保持在同一 Parent/Child |
| 代码/表格完整率 | 代码与表格是否被非法截断 |
| Parent 展开有效率 | Child 命中后展开的 Parent 是否真正补足上下文 |
| 回退率 | LLM 增强失败后使用结构/句子/字符兜底的比例 |

### 18.2 检索与引用质量

| 指标 | 含义 |
|---|---|
| Recall@K | 固定问题的预期 Child 是否进入 Top K |
| Parent Recall@K | 预期章节是否进入 Parent 候选 |
| Context Precision | 返回上下文中真正相关内容的比例 |
| Context Sufficiency | 证据是否足以回答或教学 |
| 引用合法率 | 引用是否属于当前用户、目标和 RetrievalRun |
| 教学块来源覆盖率 | 必要教学块是否都有有效来源 |
| 题目来源覆盖率 | 正式题目和 rubric 是否固定到已教学来源 |

### 18.3 成本与性能

- 每份资料端到端耗时，以及 MinerU 等待、结构恢复、切片和持久化分阶段耗时；
- Embedding 冷启动加载、分词、编码、持久化的 P50/P95，并同时报告 chunks/s 与 tokens/s；
- 结构/切片 LLM 输入输出 Token；
- 每个 ChunkSet 成本；
- Query Embedding、BM25、向量召回、融合、重排和 Parent 展开的 P50/P95；
- 每次 EvidenceBundle Token；
- 相同资料的缓存命中率；
- URL 重复提交复用率。

性能数字必须同时标注模型 revision、设备、精度、batch size、样本数、冷/热状态和缓存状态。不能只凭切片查看器“看起来更完整”或一次最快值宣称检索精度/性能提高；至少需要固定资料、固定问题和预期命中 chunks 进行多轮 A/B 对比，并报告中位数与 P95。

---

## 19. 测试要求

### 19.1 数据关系

- 一个 Source 可绑定多个 Goal，不复制版本和 chunks；
- 一个 SourceVersion 可拥有多个不可变 ChunkSet；
- 每个 Child 只属于一个 Parent 和 ChunkSet；
- 切换 active ChunkSet 不改变历史 RetrievalRun；
- 软删除 Source 后未来检索排除，历史快照仍可读取；
- 其他用户无法读取 Source、Parent、Child、Job、SearchRun 或 RetrievalRun。

### 19.2 解析和切片

- DOCX 标题、段首加粗、列表、代码与表格固定样例；
- HTML 标题、正文、列表、代码、表格、导航和广告清理样例；
- TXT/Markdown 的标题、列表和代码围栏样例；
- PDF 单栏、多栏、扫描件和表格警告样例；
- LLM 返回遗漏、重复、乱序、跨 Parent、未知 unit ID 时必须拒绝；
- 回退结果必须可用且标记真实策略；
- 旧 character chunks 迁移后仍能查看。

### 19.3 URL 与搜索

- 相同 canonical URL 复用 Source；
- URL 不在读取和检索时自动刷新；
- 内网、localhost、重定向到内网和非 HTTP 协议被拒绝；
- 搜索候选不进入知识索引；
- 只有选中且抓取成功的结果创建 Source；
- 搜索结果与 Source 的 lineage 可回放。

### 19.4 教学闭环

- Tutor 只能引用当前 RetrievalRun 返回的 Child；
- Parent 展开内容和 Child 快照同时保存；
- 题目来源属于其已教学块来源；
- 评分期间不会产生新的检索或搜索运行；
- 缺少资料时进入 `source_insufficient`，不静默使用模型知识伪装 grounded。

---

## 20. 实施顺序

### 阶段 1：修复切片数据骨架（已完成）

1. 新建 `source_chunk_sets`；
2. 为现有 chunks 生成 legacy ChunkSet；
3. 重建 `source_chunks` 唯一约束；
4. 新建 `source_parent_chunks`；
5. 切片查看器支持 ChunkSet 和父子树；
6. 保证已有用户资料不丢失。

这是后续所有工作的前置条件，应在课程正式引用 chunks 之前完成。

### 阶段 2：结构化解析（核心已完成）

1. 新建 `document_parse_runs` 和 `document_nodes`；
2. DOCX 从纯文本提取升级为结构提取；
3. TXT/Markdown 结构解析；HTML 已用于 DOCX 中间格式，独立网页 HTML 入口待 URL 阶段完成；
4. PDF 保留页码能力并增加 warning；MinerU 复杂结构适配和本机真实 PDF 链路已完成，扫描 OCR、复杂表格和图片语义仍待专项验证；
5. 实现 `structure-parent-child-v2` Parent/Child 切片。

已落地的确定性默认值：Child 最小/目标/最大约 220/450/700 Token，Parent 最大约 2400 Token；结构正常时不做固定重叠，只有单个原子节点超长时才按自然边界递归回退。

### 阶段 2.5：文本 Embedding 与资料级向量检索（已完成 MVP）

1. 固定 BGE-M3 与 Qwen3-Embedding-0.6B 模型 revision；
2. 独立 Python 服务执行 CUDA 推理并返回 1024 维归一化向量；
3. Schema V10 保存 Profile、EmbeddingRun、Child Vector、PipelineRun 和 StageMetric；
4. 支持按资料和模型幂等批量向量化；
5. 支持单资料精确余弦召回、Parent 去重展开和 RetrievalRun 快照；
6. 使用现有 1,019 个 Child 对两模型完成真实联调。

该阶段尚未证明哪个模型质量更高；需要固定查询、期望 Child/Parent 和负样本后，才能报告 Recall@K、MRR、上下文完整率、P50/P95 和吞吐。

### 阶段 3：LLM 边界辅助

1. 定义结构化边界输出；
2. 只提交模糊窗口；
3. 建立覆盖、顺序和完整性硬校验；
4. 实现确定性回退；
5. 保存 Token、模型、Prompt 版本和边界理由；
6. 用固定问题对比 legacy、structure 和 structure_llm。

### 阶段 4：目标绑定与 Agentic RAG

1. 完成目标资料关系 UI/API；
2. 在现有资料级向量检索上实现 FTS5/BM25、路由、融合、Token 预算和去重；
3. 扩展现有 RetrievalRun 快照为完整 EvidenceBundle；
4. 注册 `search_knowledge_base`、`read_source_chunks` 和 `check_source_coverage`；
5. Tutor 输出块级来源绑定。

### 阶段 5：用户 URL

1. 实现受控 URL 抓取器；
2. 实现静态 HTML/PDF 收录；
3. 复用统一 ParseRun、DocumentNode 和 ChunkSet；
4. 增加链接预览、保存与目标绑定；
5. 明确不实现自动更新。

### 阶段 6：联网搜索

1. 新建 SearchRun 和 SearchResult；
2. 实现 `search_web` 候选发现；
3. 只抓取用户或 Agent 选中的少量结果；
4. 建立 SearchResult → Source lineage；
5. 评估来源质量、重复率、Token 和延迟。

### 阶段 7：题目与固定评分

1. LearningBlock 绑定实际 Child；
2. 题目、参考答案和 rubric 绑定同一证据；
3. 评分读取固定快照；
4. 引用 UI 显示 Source、Parent、Child 和收录时间；
5. 完成来源充分性与教学质量双门禁。

---

## 21. 当前明确不做

- URL 自动更新和定时爬取；
- 打开资料时重新加载网页；
- 自动抓取全部搜索结果；
- 让搜索摘要直接进入知识库；
- 让 LLM 改写原文作为引用；
- 把整个大型文档交给一次 LLM 调用；
- 在没有固定评测集前宣称某种切片精度最高；
- 额外建设独立 OCR 管线；当前先使用 MinerU OCR，但尚未宣称扫描件质量达标；
- 对全部图片无条件调用 VLM，或在当前 Embedding/检索主链完成前实现图片语义索引；
- 绕过登录、付费墙或网页安全限制；
- 新增 RAG Agent；
- 因为后续计划使用 Pydantic AI/LangGraph 而提前改变稳定的数据契约。

---

## 22. 后续修改约束

后续开发者或 LLM 修改 RAG 前必须遵守：

1. 先阅读本文、V0.4.4、V1、Roles、README 和当前 Schema；
2. 新入口必须进入统一 Source → Version → ParseRun → ChunkSet 链；
3. 不允许覆盖已被引用的 SourceVersion、ChunkSet、Parent 或 Child；
4. 不允许把来源方式和内容格式重新混成一个字段；
5. 不允许让 LLM 输出的改写正文替代原始证据；
6. 不允许让客户端或 Agent 自行提交 userId 和任意 chunk ID；
7. 不允许搜索候选未经抓取就进入检索索引；
8. 不允许 URL 在后台自动更新；
9. 不允许评分时重新检索或联网；
10. 数据库变化必须同步迁移、Schema 校验、README 和相关实施文档；
11. 新切片策略必须创建新 ChunkSet，并与旧策略做固定集对比；
12. 若实现方向与本文冲突，必须先修改本文并记录决策原因，再修改代码。

---

## 23. 核心关系速查

```text
WebSearchRun
└─ WebSearchResult
   └─ selected/fetched → KnowledgeSource

IngestionJob
└─ KnowledgeSource
   ├─ GoalSourceLink → Goal
   └─ SourceVersion
      ├─ ParseRun
      │  └─ DocumentNode
      └─ ChunkSet
         ├─ ParentChunk
         │  └─ ChildChunk
         └─ SourceArtifact

ChildChunk
└─ RetrievalRunItem
   ├─ LessonBlockSource
   ├─ QuestionSourceLink
   └─ AssessmentSnapshot
```

只要这条关系不被破坏，未来增加新的文件类型、URL、联网搜索、Embedding、重排模型、Pydantic AI 或 LangGraph，都不需要重新设计资料和教学证据的主链。
