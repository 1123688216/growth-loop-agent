import { getCurrentUser } from "@/lib/auth/session";
import { createGoalWithProfile, deleteGoal, SELF_LEVELS, type SelfLevel } from "@/lib/db/goals";
import { horizonLabel, isValidTargetDate } from "@/lib/goal-schedule";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式不正确。" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "请求格式不正确。" }, { status: 400 });
  }

  const value = body as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const background = typeof value.background === "string" ? value.background.trim() : "";
  const requestedDate = typeof value.targetDate === "string" ? value.targetDate.trim() : "";
  const selfLevel = value.selfLevel as SelfLevel;
  const weeklyHours = Math.max(1, Math.min(40, Math.round(Number(value.weeklyHours) || 4)));

  if (!title || title.length > 100) {
    return Response.json({ error: "目标名称需要在 1-100 个字符之间。" }, { status: 400 });
  }
  if (description.length > 500) {
    return Response.json({ error: "目标说明过长。" }, { status: 400 });
  }
  if (background.length > 500) {
    return Response.json({ error: "当前基础说明过长。" }, { status: 400 });
  }
  if (!SELF_LEVELS.includes(selfLevel)) {
    return Response.json({ error: "请选择当前掌握程度。" }, { status: 400 });
  }
  // 留空表示不设期限；填了就必须是一个将来的合法日期，不静默丢弃用户填错的截止日。
  if (requestedDate && !isValidTargetDate(requestedDate)) {
    return Response.json({ error: "目标日期需要是一个将来的日期。" }, { status: 400 });
  }

  const targetDate = requestedDate || null;
  const { goal, profile } = createGoalWithProfile({
    userId: user.id,
    title,
    description,
    // 周期文案由目标日期派生，避免用户同时填日期和周期造成两个真相。
    horizon: horizonLabel(targetDate),
    targetDate,
    selfLevel,
    weeklyHours,
    background,
  });

  return Response.json({ goal, profile }, { status: 201 });
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式不正确。" }, { status: 400 });
  }
  const goalId = body && typeof body === "object" && typeof (body as Record<string, unknown>).goalId === "string"
    ? ((body as Record<string, unknown>).goalId as string).trim().slice(0, 180)
    : "";
  if (!goalId) return Response.json({ error: "缺少要删除的目标。" }, { status: 400 });

  const deleted = deleteGoal(user.id, goalId);
  if (!deleted) return Response.json({ error: "找不到这个目标。" }, { status: 404 });
  return Response.json({ deleted });
}
