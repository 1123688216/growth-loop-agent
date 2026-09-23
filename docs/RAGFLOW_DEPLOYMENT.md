# RAGFlow 本机部署与后续接入

最新状态（2026-09-22）：用户已在 RAGFlow 配置 MinerU、BGE-M3 和 DeepSeek；本项目新增已建文档的检索适配及片段快照绑定，见第 7 节。以下 2026-09-16 记录是部署阶段历史，不代表当前模型尚未配置。

日期：2026-09-16。用户确认用 RAGFlow 替换自研/LlamaIndex RAG 底层；现有 RAG Tool、业务权限和教学编排保留。本文优先于旧 LlamaIndex 迁移方案的目标选型，但不是业务迁移完成声明。

## 1. 本轮范围

- 固定 `infiniflow/ragflow:v0.27.2`，并固定已下载镜像的 SHA256 digest，避免 `latest` 漂移；该版本不预装 Embedding 权重，本地镜像实际约 8.49GB，不应宣传为 2GB。
- 使用镜像自带的同版本 entrypoint/nginx，不混用 main 分支脚本。
- 本机 `http://127.0.0.1:8088` 同时提供页面与 API；数据库、ES、对象存储和队列没有宿主机端口。
- 独立 Compose project `growth-loop-ragflow` 与独立命名数据卷。仅复用已有 ES 8.17.3 **镜像**，不挂载原项目的 ES 数据。官方默认 ES 版本为 8.11.3，本部署使用本机 8.17.3，需要将服务启动检查与后续真实检索验收区分。
- RAGFlow 使用 Python backend、一个 task executor，任务/分块/编码并发均为 1（已核对镜像中的 `task_executor_limiter.py`），对象存储并发 2；关闭 datasync、Go backend、Admin/MCP 服务，不部署代码执行沙箱、NATS、Kibana 或第二套模型服务。
- 未接入 MinerU/Qwen、未迁移用户资料、未切换 Next.js 的 RAG Tool；原有 6000/8010/8020 启停脚本保持不变。

## 2. 启停

先启动 Docker Desktop（Linux containers）。项目根目录双击：

- `start-ragflow.cmd`：初始化私有配置（仅第一次），启动服务，检查数据库/ES/存储/队列健康。
- `stop-ragflow.cmd`：只停止本 Compose 项目，保留容器、数据卷、镜像。会中断正在运行的解析任务，应等任务结束再停。
- `start-ragflow.cmd -Action Status`：查看状态。
- `start-ragflow.cmd -Action Logs`：查看 RAGFlow 最近日志；日志可能包含业务内容，仅本地排查，勿直接公开。
- `start-ragflow.cmd -Action Check`：验证配置，不启动服务。

自动化或已有终端不需要暂停时：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/ragflow-stack.ps1 -Action Start
```

首次镜像下载可能较慢；启动失败不会清理卷或替换其他服务。镜像下载失败后可以重新执行启动，已完成的镜像层会复用。

默认不随 Docker Desktop 自动启动（`restart: "no"`），避免笔记本开机后被后台服务占用内存。需要时运行启动脚本。

## 3. 配置、安全与资源

配置在 `deploy/ragflow/`：

- `compose.yaml`：隔离服务及资源上限。
- `service_conf.yaml.template`：RAGFlow 内部服务地址，不写入教学模型密钥。
- `.env`：首次启动生成的随机凭据，已被 Git 忽略；请备份。**已有数据后不可随意重新生成数据库密码**。若卷存在但 `.env` 丢失，脚本会拒绝生成新密码，要求恢复备份。
- `.env.example`：字段说明，不可将占位密码直接用于运行。

默认页面端口 8088，可修改部署 `.env` 的 `RAGFLOW_WEB_PORT`；脚本不会自动杀死占用端口的服务。

容器内存上限：RAGFlow 4GB、ES 3GB（JVM heap 1GB）、MySQL 1GB、对象存储 1GB、Valkey 256MB。这是各容器上限，**不是预留量、实测占用或吞吐保证**。针对 32GB 主机先用小文件/单文件解析；遇到 OOM 应查看容器状态、调整资源或降低负载，不通过无限重试掩盖问题。

Docker/WSL 的 `vm.max_map_count` 应至少为 262144；本机配置时已满足，未修改系统参数。仅在后续 ES 明确报此错误时再按官方说明处理。

页面第一次进入后，由用户创建独立的 RAGFlow 账号。`REGISTER_ENABLED=1` 只用于当前回环地址本机部署；若未来开放远程访问，需重新设计注册、认证、TLS 和网络边界，不能直接改成公网监听。

不要执行 `docker compose down -v` 或全局 prune 来解决启动问题，它们可能删除数据。本脚本不提供删卷/重置操作。

## 4. MinerU 与 Qwen 的后续接入

RAGFlow 容器中的 `127.0.0.1` 是容器自身，不是 Windows 宿主机。已保留 `host.docker.internal` 访问路径，但**主机服务是否能从容器访问要单独验证**，不能只替换 URL 就宣称接通。

- MinerU：后续配置其 API，候选宿主地址为 `http://host.docker.internal:6000`。需要核对当前 MinerU 协议与 RAGFlow v0.27.2 的客户端，验证网络和返回产物，不重装模型。
- Qwen：现有 `Qwen3-Embedding-0.6B` 服务使用自定义 `texts/input_type` 契约，不是现成 OpenAI Embeddings 协议。应补兼容适配层或使用 RAGFlow 支持的模型服务协议；必须保留 query instruction、文档/查询区分、归一化、维度与模型版本的一致性。
- 当前没有设置一个无法工作的默认模型，也没有复制业务 `.env.local` 中的 LLM/API 密钥到 Docker。
- 入库和查询必须选择相同 Embedding 模型；接入后再验证上传→解析→片段查看→向量化→检索，不以页面可访问代替真实 RAG 验收。

## 5. 业务迁移边界

后续链路为：`现有 RAG Tool → 服务端权限/目标范围 → RAGFlow retrieval API → 固定来源证据 → Tutor`。

RAGFlow 负责解析、索引和检索，不负责创建学习目标、考试评分或教学状态机。LangGraph 继续负责跨步骤状态/分支/恢复；Pydantic AI 负责节点内部模型调用/工具调用/结构化输出。SQLite 继续保存用户、目标、课程、业务来源映射与检索快照，不再以新目标架构继续扩建自写向量检索。

验证后再替换 Tool 后端；保留片段查看、每文档进度、来源归属、失败重试及课程引用。旧资料和代码不得在部署阶段清理。

## 6. 当前验收

- Compose 静态配置、随机配置初始化、Git 忽略检查已通过。
- 服务启动与健康验证结果见 README 最新变更记录。
- 尚未验证真实 PDF、Embedding、召回效果或教学闭环；这些属于后续模型/业务接入验收。

参考：[官方 v0.27.2 Compose](https://github.com/infiniflow/ragflow/blob/v0.27.2/docker/docker-compose.yml)、[配套依赖](https://github.com/infiniflow/ragflow/blob/v0.27.2/docker/docker-compose-base.yml)。

## 7. 已建知识库接入（2026-09-22）

后续实测更新：已验证真实首课生成（grounded）、带依据答疑、0 分不解锁、95 分解锁第二课并更新任务/进度。第二课生成仍遇指定范围证据不足，完整多课链路未通过。检索适配保留单教材完整候选配额，课程默认最多 20 个短片段、原证据预算不变；包含多个问句时最多 3 个授权范围内的 RAGFlow 子查询并融合去重排名。这是同次检索内部处理，不是新增 LangGraph 联网补充轮次，不增加任何教学 Agent。

RAGFlow 由用户通过 Docker 手动启动。`.env.local` 配置 `RAGFLOW_BASE_URL=http://127.0.0.1:8088`、`RAGFLOW_API_KEY`，可选 `RAGFLOW_TIMEOUT_MS=60000`。API Key 仅后端读取，不下发浏览器；请求禁止重定向，不向日志转发上游错误正文。

首先明确文档属于哪个**学习助手账号**，不能按数据库第一个用户或 RAGFlow 用户名自动推断。项目根目录执行：

```powershell
node --env-file=.env.local --experimental-strip-types scripts/ragflow-import.mjs 学习助手用户名 知识库ID 文档ID
```

该本地管理员命令只读取远端文档，不修改 RAGFlow。分页下载已启用片段，不调用解析或 Embedding；保存为当前账号可查看的来源快照。底层为兼容引用外键保留一对一父/子存储记录，二者正文相同，不代表 RAGFlow 使用父子切片；UI 不展示父子切换，不宣称可以看到远端完整 embedding 输入。

来源绑定放在当前 `source_chunk_sets.config_json.ragflow`，包含 endpoint、datasetId、documentId；片段的 `boundary_reason_json.ragflowChunkId` 保存远端 ID。这些字段只能由服务端/本地管理脚本写入，不接受模型提交。

绑定后资料出现在个人资料库。目标为自动范围时默认参与检索；指定资料模式需勾选新来源，排除资料则不请求它。课程生成和课堂答疑共用现有 `searchGoalKnowledgeBase`，只有授权范围包含已绑定文档才切换 RAGFlow。不会全局开放 API Key 下的所有知识库给每个用户。

检索过程：业务层校验账号/目标/课节 → 取已授权文档 ID → RAGFlow 编码查询与检索 → 复核 dataset/document/chunk/正文 → 转换为原有 EvidenceBundle → 原有 Evidence Review 与快照落库。返回正文若与绑定快照不同，拒绝挂到旧引用上。空 document_ids 不发请求，避免远端解释成全库搜索。

重复导入同一文档不会自动刷新。若在 RAGFlow 重解析/编辑了原文档，需在学习助手中移除旧来源后重新绑定，再重新勾选目标资料；移除是本地软删除，不删除 RAGFlow 文件或旧课程引用快照。后续可增量实现版本同步，当前不做静默更新。

新旧混合范围：RAGFlow 片段优先，旧上传/联网资料用 FTS5 作为补充，不将两种分数混排序；审计记录 `legacy_sources_fts5_after_ragflow`。未绑定资料仍走原路径。上传、网页收录、单资料旧向量调试接口本轮不迁移；已绑定资料禁止通过旧接口重新切片/向量化。

当前未新增 RAGFlow 教学 Agent，DeepSeek 教学调用仍走原项目。真实验收已覆盖远端 2644 片段导入及课堂检索（独立临时数据库）；课程充分性与引用回读由隔离 mock 测试覆盖，不等于真实生成课程/考试已端到端验收。测试入口 `node --experimental-strip-types scripts/ragflow-smoke.mjs` 已加入 `npm run verify:learning`。
