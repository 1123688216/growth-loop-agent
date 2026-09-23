import { getCurrentUser } from "@/lib/auth/session";
import {
  KnowledgeSourceChunkingError,
  rechunkKnowledgeSource,
} from "@/lib/db/knowledge-sources";
import { KnowledgeIngestionError } from "@/lib/knowledge/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  if (!id) return Response.json({ error: "资料 ID 无效。" }, { status: 400 });

  try {
    const source = await rechunkKnowledgeSource(user.id, id);
    if (!source) return Response.json({ error: "资料不存在或已经删除。" }, { status: 404 });
    return Response.json({ source }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof KnowledgeIngestionError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof KnowledgeSourceChunkingError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error("knowledge source rechunk failed", error);
    return Response.json({ error: "重新切片失败，请稍后重试。" }, { status: 500 });
  }
}
