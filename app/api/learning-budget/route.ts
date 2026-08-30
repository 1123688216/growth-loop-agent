import { getCurrentUser } from "@/lib/auth/session";
import {
  readActiveAllocations,
  readUserLearningProfile,
  saveUserLearningProfile,
  suggestedProfile,
} from "@/lib/db/user-profile";
import { reviewBudget } from "@/lib/learning-budget";

export const runtime = "nodejs";

/**
 * 返回当前预算、各目标占用和跨目标总量结论。
 * 没有 profile 时返回 suggested 供引导表单预填，并标记 hasProfile=false。
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });

  const profile = readUserLearningProfile(user.id);
  const allocations = readActiveAllocations(user.id);
  return Response.json({
    hasProfile: Boolean(profile),
    profile: profile || suggestedProfile(user.id),
    allocations,
    review: profile ? reviewBudget({ profile, allocations }) : null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式不正确。" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return Response.json({ error: "请求格式不正确。" }, { status: 400 });

  const value = body as Record<string, unknown>;
  const profile = saveUserLearningProfile(user.id, {
    weekdayMinutes: value.weekdayMinutes,
    sustainableWeeklyMinutes: value.sustainableWeeklyMinutes,
    preferredPeriod: value.preferredPeriod,
    preferredSession: value.preferredSession,
    habitNote: value.habitNote,
  });
  const allocations = readActiveAllocations(user.id);
  return Response.json({ hasProfile: true, profile, allocations, review: reviewBudget({ profile, allocations }) });
}
