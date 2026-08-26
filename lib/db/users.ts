import { randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/db";

export type UserRecord = {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
};

export function findUserByUsername(username: string) {
  return getDatabase()
    .prepare("SELECT id, username, password_hash, display_name FROM users WHERE username = ? COLLATE NOCASE")
    .get(username) as UserRecord | undefined;
}

export function createUserWithStarterData(input: { username: string; passwordHash: string; displayName: string }) {
  const database = getDatabase();
  const userId = randomUUID();
  const now = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`
        INSERT INTO users (
          id, username, password_hash, display_name, action_streak_days,
          level, role, focus_score, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 1, '探索者', 0, ?, ?)
      `)
      .run(userId, input.username, input.passwordHash, input.displayName, now, now);

    const goalId = randomUUID();
    database
      .prepare(`
        INSERT INTO goals (
          id, user_id, title, description, progress_percent, horizon, status,
          progress_source, progress_updated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, 'active', 'system', ?, ?, ?)
      `)
      .run(
        goalId,
        userId,
        "建立第一个可验证的学习目标",
        "先告诉 AI 你想达到什么结果，再把它拆成今天能完成的一步。",
        "首次成长回路",
        now,
        now,
        now,
      );

    const starterTasks = [
      ["告诉 AI 你的学习目标", "写下目标岗位、技能或最近最想解决的问题", "09:30", 10, 5, 2, "current", "learn"],
      ["完成一次最小学习行动", "只需要投入 20 分钟，并留下一个可检查的结果", "14:00", 20, 10, 4, "upcoming", "focus"],
      ["晚上完成第一次回顾", "确认今天保留了什么，以及明天的下一步", "21:30", 10, 5, 2, "upcoming", "rest"],
    ] as const;

    const insertTask = database.prepare(`
      INSERT INTO tasks (
        id, user_id, goal_id, title, subtitle, time_label, duration_minutes,
        xp_reward, coin_reward, status, kind, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    starterTasks.forEach((task, index) => {
      insertTask.run(randomUUID(), userId, goalId, ...task, index, now, now);
    });

    database.exec("COMMIT");
    return { id: userId, username: input.username, displayName: input.displayName };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
