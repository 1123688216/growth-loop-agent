import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/db/dashboard";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  return Response.json({ data: getDashboardData(user) });
}
