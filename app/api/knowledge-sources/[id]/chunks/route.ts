import { getCurrentUser } from "@/lib/auth/session";
import { listKnowledgeSourceChunks } from "@/lib/db/knowledge-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numberParameter(value: string | null, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });

  const { id } = await context.params;
  if (!id) return Response.json({ error: "资料 ID 无效。" }, { status: 400 });
  const url = new URL(request.url);
  const result = listKnowledgeSourceChunks({
    userId: user.id,
    sourceId: id,
    query: url.searchParams.get("query") || "",
    offset: numberParameter(url.searchParams.get("offset"), 0),
    limit: numberParameter(url.searchParams.get("limit"), 50),
  });
  if (!result) return Response.json({ error: "资料不存在或已经删除。" }, { status: 404 });

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
