import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/auth/session";
import { runAgent } from "@/lib/agent/provider";
import { getDatabase } from "@/lib/db";

export const runtime = "nodejs";

function updateActionStreak(userId: string) {
  const database = getDatabase();
  const rows = database
    .prepare("SELECT DISTINCT substr(occurred_at, 1, 10) AS action_date FROM activity_logs WHERE user_id = ? ORDER BY action_date DESC")
    .all(userId) as Array<{ action_date: string }>;
  const dates = new Set(rows.map((row) => row.action_date));
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  let streak = 0;
  while (dates.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  database.prepare("UPDATE users SET action_streak_days = ?, updated_at = ? WHERE id = ?").run(streak, new Date().toISOString(), userId);
  return streak;
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
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const context = typeof value.context === "string" ? value.context.slice(0, 4_000) : undefined;
  if (!message || message.length > 480) {
    return Response.json({ error: "记录内容需要在 1-480 个字符之间。" }, { status: 400 });
  }

    const result = await runAgent(message, { conversationId: user.id, context });
    const extracted = result.extracted || {};
  const id = randomUUID();
  const now = new Date().toISOString();
  const xp = 3;
  const coin = 1;
  const database = getDatabase();

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO activity_logs (
        id, user_id, raw_content, topic, kind, minutes, output, intent,
        xp_reward, coin_reward, agent_mode, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.id,
      message,
      extracted.topic || message,
      extracted.kind || null,
      extracted.minutes || null,
      extracted.output || null,
      result.intent,
      xp,
      coin,
      result.mode,
      now,
      now,
    );
    const insertLedger = database.prepare(`
      INSERT INTO ledger_entries (
        id, user_id, currency, amount, reason, source_type, source_id, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, 'activity_log', ?, ?, ?)
    `);
    insertLedger.run(randomUUID(), user.id, "XP", xp, "完成一条有效行动记录", id, `activity:${id}:xp`, now);
    insertLedger.run(randomUUID(), user.id, "COIN", coin, "完成一条有效行动记录", id, `activity:${id}:coin`, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const streak = updateActionStreak(user.id);
  return Response.json({
    ...result,
    streak,
    log: {
      id,
      text: message,
      topic: extracted.topic || message,
      kind: extracted.kind,
      minutes: extracted.minutes,
      output: extracted.output,
      intent: result.intent,
      xp,
      coin,
      createdAt: "刚刚",
      mode: result.mode,
    },
  });
}
