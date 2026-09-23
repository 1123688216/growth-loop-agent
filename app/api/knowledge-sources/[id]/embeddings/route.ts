import { getCurrentUser } from "@/lib/auth/session";
import {
  EmbeddingIndexError,
  listKnowledgeSourceEmbeddingStatus,
  vectorizeKnowledgeSource,
} from "@/lib/db/embeddings";
import { EmbeddingServiceError } from "@/lib/knowledge/embedding-client";
import { isEmbeddingModelAlias } from "@/lib/knowledge/embedding-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  const status = listKnowledgeSourceEmbeddingStatus(user.id, id);
  if (!status) return Response.json({ error: "资料不存在、尚未就绪或已经删除。" }, { status: 404 });
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { model?: unknown } | null;
  if (!body || (body.model !== undefined && !isEmbeddingModelAlias(body.model))) {
    return Response.json({ error: "model 仅支持 bge-m3 或 qwen3-embedding-0.6b。" }, { status: 400 });
  }
  try {
    return Response.json({ run: await vectorizeKnowledgeSource({ userId: user.id, sourceId: id, model: isEmbeddingModelAlias(body.model) ? body.model : undefined }) });
  } catch (error) {
    if (error instanceof EmbeddingIndexError || error instanceof EmbeddingServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("knowledge source embedding failed", error);
    return Response.json({ error: "资料向量化失败，请查看服务日志。" }, { status: 500 });
  }
}
