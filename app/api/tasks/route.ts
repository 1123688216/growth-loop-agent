import { randomUUID } from "node:crypto";

import { getCurrentUser } from "@/lib/auth/session";
import { getDatabase, withTransaction } from "@/lib/db";
import { readOwnedLesson } from "@/lib/db/programs";

export const runtime = "nodejs";

const taskKinds = new Set(["focus", "learn", "exercise", "life", "rest"]);

function nextPosition(userId: string) {
  const row = getDatabase()
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE user_id = ?")
    .get(userId) as { next_position: number };
  return row.next_position;
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
  const lessonId = typeof value.lessonId === "string" ? value.lessonId.trim() : "";
  const database = getDatabase();

  // 课程任务由 task_lesson_links 关联，标题、时长和合格线全部来自章节本身。
  if (lessonId) {
    const found = readOwnedLesson(user.id, lessonId);
    if (!found) return Response.json({ error: "找不到这节课程。" }, { status: 404 });
    if (found.lesson.generationStatus !== "ready" || found.lesson.status === "locked") {
      return Response.json({ error: "这节课尚未解锁，不能加入今日计划。" }, { status: 409 });
    }

    const linked = database
      .prepare(`
        SELECT tasks.id FROM task_lesson_links
        JOIN tasks ON tasks.id = task_lesson_links.task_id
        WHERE task_lesson_links.lesson_id = ? AND tasks.user_id = ?
      `)
      .get(lessonId, user.id) as { id: string } | undefined;
    if (linked) return Response.json({ task: { id: linked.id, lessonId } });

    const { lesson } = found;
    const id = randomUUID();
    const position = nextPosition(user.id);
    const now = new Date().toISOString();
    withTransaction((transaction) => {
      transaction.prepare(`
        INSERT INTO tasks (
          id, user_id, title, subtitle, time_label, duration_minutes, xp_reward,
          coin_reward, status, kind, position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '今天', ?, 18, 6, 'upcoming', 'learn', ?, ?, ?)
      `).run(id, user.id, `课程 · ${lesson.title}`, lesson.deliverable, lesson.durationMinutes, position, now, now);

      transaction.prepare(`
        INSERT INTO task_lesson_links (task_id, lesson_id, required_score, completion_rule, created_at)
        VALUES (?, ?, ?, 'passing_score', ?)
      `).run(id, lessonId, lesson.requiredScore, now);
    });

    return Response.json({ task: { id, lessonId } }, { status: 201 });
  }

  const requestedId = typeof value.id === "string" ? value.id.trim() : "";
  const requestedTaskId = requestedId && requestedId.length <= 180 ? requestedId : randomUUID();
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const subtitle = typeof value.subtitle === "string" ? value.subtitle.trim() : "";
  const time = typeof value.time === "string" ? value.time.trim() : "今天";
  const duration = Number.isFinite(value.durationMinutes) ? Math.max(0, Math.round(Number(value.durationMinutes))) : 0;
  const kind = typeof value.kind === "string" && taskKinds.has(value.kind) ? value.kind : "focus";

  if (!title || title.length > 160 || subtitle.length > 500) {
    return Response.json({ error: "任务标题或说明不符合长度要求。" }, { status: 400 });
  }

  const exists = database.prepare("SELECT id FROM tasks WHERE id = ? AND user_id = ?").get(requestedTaskId, user.id) as { id: string } | undefined;
  if (exists) return Response.json({ task: { id: exists.id } });

  const idTaken = database.prepare("SELECT id FROM tasks WHERE id = ?").get(requestedTaskId) as { id: string } | undefined;
  const id = idTaken ? randomUUID() : requestedTaskId;
  const position = nextPosition(user.id);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO tasks (
      id, user_id, title, subtitle, time_label, duration_minutes, xp_reward,
      coin_reward, status, kind, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 18, 6, 'upcoming', ?, ?, ?, ?)
  `).run(id, user.id, title, subtitle, time, duration, kind, position, now, now);

  return Response.json({ task: { id } }, { status: 201 });
}
