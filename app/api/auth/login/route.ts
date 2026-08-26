import { createSession } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { parseAuthInput } from "@/lib/auth/validation";
import { findUserByUsername } from "@/lib/db/users";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式不正确。" }, { status: 400 });
  }

  const parsed = parseAuthInput(body, "login");
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  const user = findUserByUsername(parsed.data.username);
  const valid = user ? await verifyPassword(parsed.data.password, user.password_hash) : false;
  if (!user || !valid) {
    return Response.json({ error: "账号或密码不正确。" }, { status: 401 });
  }

  await createSession(user.id);
  return Response.json({
    user: { id: user.id, username: user.username, displayName: user.display_name },
  });
}
