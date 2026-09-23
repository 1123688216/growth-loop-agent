import { getCurrentUser } from "@/lib/auth/session";
import { KnowledgeRetrievalError } from "@/lib/db/retrieval";
import { EmbeddingServiceError } from "@/lib/knowledge/embedding-client";
import { isEmbeddingModelAlias } from "@/lib/knowledge/embedding-profiles";
import { searchKnowledgeBaseTool } from "@/lib/knowledge/search-tool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const body = await request.json().catch(() => null) as {
    goalId?: unknown;
    lessonId?: unknown;
    skillId?: unknown;
    query?: unknown;
    purpose?: unknown;
    mode?: unknown;
    model?: unknown;
    topK?: unknown;
    maxEvidenceTokens?: unknown;
  } | null;
  const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const goalId = text(body?.goalId, 180);
  const query = text(body?.query, 2_000);
  const purpose = body?.purpose === "lesson_generation" || body?.purpose === "classroom_qa"
    ? body.purpose
    : null;
  const mode = body?.mode === "auto" || body?.mode === "vector" || body?.mode === "fts5"
    ? body.mode
    : "auto";
  if (!goalId || !query || !purpose) {
    return Response.json({ error: "缺少目标、检索问题或检索用途。" }, { status: 400 });
  }
  if (body?.model !== undefined && !isEmbeddingModelAlias(body.model)) {
    return Response.json({ error: "不支持这个 Embedding 模型。" }, { status: 400 });
  }
  try {
    const evidence = await searchKnowledgeBaseTool({
      userId: user.id,
      goalId,
      lessonId: text(body?.lessonId, 180) || null,
      skillId: text(body?.skillId, 180) || null,
      purpose,
    }, {
      query,
      mode,
      ...(body?.model ? { model: body.model } : {}),
      topK: typeof body?.topK === "number" ? body.topK : undefined,
      maxEvidenceTokens: typeof body?.maxEvidenceTokens === "number" ? body.maxEvidenceTokens : undefined,
    });
    return Response.json({ evidence });
  } catch (error) {
    if (error instanceof KnowledgeRetrievalError || error instanceof EmbeddingServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("goal knowledge retrieval failed", error);
    return Response.json({ error: "知识库检索失败，请查看服务日志。" }, { status: 500 });
  }
}
