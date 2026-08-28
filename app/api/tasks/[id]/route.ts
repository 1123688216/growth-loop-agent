import { getCurrentUser } from "@/lib/auth/session";
import { getDatabase } from "@/lib/db";

export const runtime = "nodejs";

type TaskRow = { id: string; status: "current" | "upcoming" | "done" };

export async function PATCH(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  const database = getDatabase();
  const task = database
    .prepare("SELECT id, status FROM tasks WHERE id = ? AND user_id = ?")
    .get(id, user.id) as TaskRow | undefined;
  if (!task) return Response.json({ error: "任务不存在。" }, { status: 404 });

  const courseLink = database
    .prepare("SELECT lesson_id FROM task_lesson_links WHERE task_id = ?")
    .get(id) as { lesson_id: string } | undefined;
  if (courseLink) {
    return Response.json({ error: "课程任务必须通过课后考核，不能手动标记完成。" }, { status: 409 });
  }

  const nextStatus = task.status === "done" ? "upcoming" : "done";
  const now = new Date().toISOString();
  database
    .prepare("UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(nextStatus, nextStatus === "done" ? now : null, now, id, user.id);
  return Response.json({ task: { id, status: nextStatus } });
}
