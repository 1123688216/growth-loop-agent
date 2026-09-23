# 项目架构约束（后续开发必读）

涉及 Agent、模型调用、RAG、工作流或恢复机制的修改前，必须阅读并遵守 [框架职责与编排边界](docs/ARCHITECTURE_BOUNDARIES.md) 和相关角色契约 [AGENT_ROLES](docs/AGENT_ROLES.md)。

核心原则：**跨步骤的状态、分支和恢复统一交给 LangGraph；节点内部的模型调用、工具执行和结构化输出交给 Pydantic AI。** 不引入重复管理同一流程的状态机。

保留 RAG Tool 接口；2026-09-16 用户确认目标底层改为 RAGFlow，见 [部署与迁移边界](docs/RAGFLOW_DEPLOYMENT.md)。旧 LlamaIndex 路径在新后端验收前保留，不叠加 LlamaIndex→RAGFlow。权限、业务事务、幂等和来源追溯保留在业务服务。现有 TypeScript 模型调用及自写检索属于待迁移实现，不得将目标架构描述成迁移已经完成。新增例外须明确记录原因和范围，不默认扩大遗留实现。

修改后更新 README 顶部变更记录；架构或迁移状态发生变化时同步上述文档。以下 Next.js 自动维护区块保持原样。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
