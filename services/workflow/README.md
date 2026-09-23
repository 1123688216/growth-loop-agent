# Workflow service

该服务是 V0.4.4 的窄编排层：LangGraph 保存目标准备流程的 checkpoint，Pydantic AI 只负责结构化检索计划。浏览器不直接访问它；Next.js BFF 负责登录、权限、业务数据库事务和所有副作用。

```powershell
Set-Location services\workflow
uv sync --extra dev --python D:\Python3.12\python.exe
$env:WORKFLOW_SERVICE_TOKEN = "replace-with-a-local-secret"
.\.venv\Scripts\python.exe -m uvicorn growth_loop_workflow.main:app --host 127.0.0.1 --port 8030
```

Next.js 的 `.env.local` 配置：

```dotenv
WORKFLOW_SERVICE_URL=http://127.0.0.1:8030
WORKFLOW_SERVICE_TOKEN=replace-with-a-local-secret
WORKFLOW_REQUIRE_SOURCES=false
```

`WORKFLOW_REQUIRE_SOURCES=false` 时，资料不足会保留 RetrievalRun，但阶段 D 完成前仍允许旧的非 grounded 课程生成；设为 `true` 时会在资料不足处中断。工作流服务自身的 Pydantic AI 调用默认关闭，可按需配置 `WORKFLOW_LLM_*`，未配置时使用同一 Pydantic 输出模型验证的确定性检索计划。
# Web research increment

`POST /v1/web-research/advance` runs the bounded research graph. It accepts a trusted server-issued `web-research:` thread ID, user/goal IDs, query and optional resume payload. Query planning and recommendation use the existing `WORKFLOW_LLM_*` settings. Search and ingestion are external actions executed by Next.js; no business database writes occur in Python. Two outer search requests maximum, one selected source per run, persistent selection interrupt. DeepSeek's internal native-tool rounds are not controlled by this outer budget. Restart both services after updating.

