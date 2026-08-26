import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { parseAuthInput } from "@/lib/auth/validation";
import { createUserWithStarterData, findUserByUsername } from "@/lib/db/users";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式不正确。" }, { status: 400 });
  }

  const parsed = parseAuthInput(body, "register");
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  if (findUserByUsername(parsed.data.username)) {
    return Response.json({ error: "这个账号已经存在。" }, { status: 409 });
  }

  try {
    const passwordHash = await hashPassword(parsed.data.password);
    const user = createUserWithStarterData({
      username: parsed.data.username,
      displayName: parsed.data.displayName || parsed.data.username,
      passwordHash,
    });
    await createSession(user.id);
    return Response.json({ user }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint failed")) {
      return Response.json({ error: "这个账号已经存在。" }, { status: 409 });
    }
    return Response.json({ error: "创建账号失败，请稍后重试。" }, { status: 500 });
  }
}
