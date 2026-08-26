import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getDatabase } from "@/lib/db";

export const SESSION_COOKIE_NAME = "growth_loop_session";
const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;

type SessionUserRow = {
  id: string;
  username: string;
  display_name: string;
  action_streak_days: number;
  level: number;
  role: string;
  focus_score: number;
};

export type CurrentUser = {
  id: string;
  username: string;
  displayName: string;
  actionStreakDays: number;
  level: number;
  role: string;
  focusScore: number;
};

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_SECONDS * 1_000);
  const database = getDatabase();

  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
  database
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, userId, expiresAt.toISOString(), now.toISOString());

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.ALLOW_INSECURE_LOCAL_COOKIE !== "true",
    path: "/",
    expires: expiresAt,
  });
}

export async function deleteSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    getDatabase().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const now = new Date().toISOString();
  const row = getDatabase()
    .prepare(`
      SELECT users.id, users.username, users.display_name, users.action_streak_days,
             users.level, users.role, users.focus_score
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `)
    .get(hashSessionToken(token), now) as SessionUserRow | undefined;

  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    actionStreakDays: row.action_streak_days,
    level: row.level,
    role: row.role,
    focusScore: row.focus_score,
  };
}
