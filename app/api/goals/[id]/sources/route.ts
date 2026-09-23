import { getCurrentUser } from "@/lib/auth/session";
import {
  GoalSourceScopeError,
  readGoalSourceScope,
  updateGoalSourceScope,
} from "@/lib/db/goal-sources";
import type { GoalSourceScopeMode } from "@/lib/knowledge/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  const scope = readGoalSourceScope(user.id, id);
  if (!scope) return Response.json({ error: "找不到这个学习目标。" }, { status: 404 });
  return Response.json({ scope });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as {
    mode?: unknown;
    includedSourceIds?: unknown;
    excludedSourceIds?: unknown;
  } | null;
  if (!body || (body.mode !== "auto" && body.mode !== "selected")) {
    return Response.json({ error: "资料范围模式不正确。" }, { status: 400 });
  }
  const stringIds = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 180))
    : [];
  try {
    const scope = updateGoalSourceScope({
      userId: user.id,
      goalId: id,
      mode: body.mode as GoalSourceScopeMode,
      includedSourceIds: stringIds(body.includedSourceIds),
      excludedSourceIds: stringIds(body.excludedSourceIds),
    });
    return Response.json({ scope });
  } catch (error) {
    if (error instanceof GoalSourceScopeError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("update goal source scope failed", error);
    return Response.json({ error: "保存资料范围失败。" }, { status: 500 });
  }
}
