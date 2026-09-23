import { getCurrentUser } from "@/lib/auth/session";
import { softDeleteKnowledgeSource } from "@/lib/db/knowledge-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  if (!id) return Response.json({ error: "资料 ID 无效。" }, { status: 400 });
  const deleted = softDeleteKnowledgeSource(user.id, id);
  if (!deleted) return Response.json({ error: "资料不存在或已经删除。" }, { status: 404 });
  return Response.json({ ok: true });
}

