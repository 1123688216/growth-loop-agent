import { deleteSession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST() {
  await deleteSession();
  return Response.json({ ok: true });
}
