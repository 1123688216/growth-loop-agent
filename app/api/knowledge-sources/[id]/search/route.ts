import { getCurrentUser } from "@/lib/auth/session";
import { EmbeddingIndexError, searchKnowledgeSourceVectors } from "@/lib/db/embeddings";
import { EmbeddingServiceError } from "@/lib/knowledge/embedding-client";
import { isEmbeddingModelAlias } from "@/lib/knowledge/embedding-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as {
    model?: unknown;
    query?: unknown;
    limit?: unknown;
  } | null;
  if (body?.model !== undefined && !isEmbeddingModelAlias(body.model)) {
    return Response.json({ error: "model 仅支持 bge-m3 或 qwen3-embedding-0.6b。" }, { status: 400 });
  }
  if (typeof body?.query !== "string" || !body.query.trim()) {
    return Response.json({ error: "请输入检索问题。" }, { status: 400 });
  }
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : 5;
  try {
    return Response.json(await searchKnowledgeSourceVectors({
      userId: user.id,
      sourceId: id,
      model: isEmbeddingModelAlias(body.model) ? body.model : undefined,
      query: body.query,
      limit,
    }));
  } catch (error) {
    if (error instanceof EmbeddingIndexError || error instanceof EmbeddingServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("knowledge source vector search failed", error);
    return Response.json({ error: "向量检索失败，请查看服务日志。" }, { status: 500 });
  }
}
