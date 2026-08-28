import { randomUUID } from "node:crypto";

import { getDatabase, withTransaction } from "@/lib/db";
import type { Goal } from "@/lib/demo-data";

export type SelfLevel = "beginner" | "familiar" | "intermediate";

export const SELF_LEVELS: SelfLevel[] = ["beginner", "familiar", "intermediate"];

export type CreateGoalInput = {
  userId: string;
  title: string;
  description: string;
  horizon: string;
  /** ISO 日期（YYYY-MM-DD）；null 表示不设期限。 */
  targetDate: string | null;
  selfLevel: SelfLevel;
  weeklyHours: number;
  background: string;
};

export type GoalLearningProfile = {
  selfLevel: SelfLevel;
  weeklyHours: number;
  background: string;
  diagnosticRequired?: boolean;
  diagnosticStatus?: "skipped" | "pending" | "in_progress" | "completed" | "failed";
  diagnosticScore?: number | null;
};

/**
 * 目标和自评档案必须一起落库：课程生成要靠 goal_learning_profiles 里的
 * weeklyHours 和 background，缺一份就会生成出与用户情况无关的课程。
 * 返回值中的 profile 是写入后回读的结果，可用来确认两张表都已落库。
 */
export function createGoalWithProfile(input: CreateGoalInput): { goal: Goal; profile: GoalLearningProfile } {
  const id = randomUUID();
  const now = new Date().toISOString();
  // 自评只决定是否需要诊断，不直接作为能力分数；诊断分支属于 V0.4.2。
  const diagnosticRequired = input.selfLevel === "beginner" ? 0 : 1;

  const profile = withTransaction((database) => {
    database.prepare(`
      INSERT INTO goals (
        id, user_id, title, description, progress_percent, horizon, target_date, status,
        progress_source, progress_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, 'active', 'user', ?, ?, ?)
    `).run(id, input.userId, input.title, input.description, input.horizon, input.targetDate, now, now, now);

    database.prepare(`
      INSERT INTO goal_learning_profiles (
        goal_id, user_id, self_level, weekly_hours, background,
        diagnostic_required, diagnostic_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      input.selfLevel,
      input.weeklyHours,
      input.background,
      diagnosticRequired,
      diagnosticRequired ? "pending" : "skipped",
      now,
      now,
    );

    const row = database
      .prepare("SELECT self_level, weekly_hours, background FROM goal_learning_profiles WHERE goal_id = ?")
      .get(id) as { self_level: SelfLevel; weekly_hours: number; background: string };
    return { selfLevel: row.self_level, weeklyHours: row.weekly_hours, background: row.background };
  });

  return {
    goal: {
      id,
      title: input.title,
      description: input.description,
      progress: 0,
      horizon: input.horizon,
      targetDate: input.targetDate ?? undefined,
      status: "进行中",
    },
    profile,
  };
}

type GoalWithProfileRow = {
  id: string;
  title: string;
  description: string;
  target_date: string | null;
  self_level: SelfLevel;
  weekly_hours: number;
  background: string;
  diagnostic_required: number;
  diagnostic_status: "skipped" | "pending" | "in_progress" | "completed" | "failed";
  diagnostic_score: number | null;
};

export function readGoalWithProfile(userId: string, goalId: string) {
  const row = getDatabase()
    .prepare(`
      SELECT goals.id, goals.title, goals.description, goals.target_date,
             COALESCE(profile.self_level, 'beginner') AS self_level,
             COALESCE(profile.weekly_hours, 4) AS weekly_hours,
             COALESCE(profile.background, '') AS background,
             COALESCE(profile.diagnostic_required, 0) AS diagnostic_required,
             COALESCE(profile.diagnostic_status, 'skipped') AS diagnostic_status,
             profile.diagnostic_score
      FROM goals
      LEFT JOIN goal_learning_profiles AS profile ON profile.goal_id = goals.id
      WHERE goals.id = ? AND goals.user_id = ?
    `)
    .get(goalId, userId) as GoalWithProfileRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    targetDate: row.target_date,
    selfLevel: row.self_level,
    weeklyHours: row.weekly_hours,
    background: row.background,
    diagnosticRequired: row.diagnostic_required === 1,
    diagnosticStatus: row.diagnostic_status,
    diagnosticScore: row.diagnostic_score,
  };
}

export function deleteGoal(userId: string, goalId: string) {
  return withTransaction((database) => {
    const goal = database
      .prepare("SELECT id, title FROM goals WHERE id = ? AND user_id = ?")
      .get(goalId, userId) as { id: string; title: string } | undefined;
    if (!goal) return null;

    // 课程任务本身不直接持有 goal_id，需要在课程和课节级联删除前先找到并清理。
    const linkedTasks = database.prepare(`
      SELECT tasks.id
      FROM tasks
      WHERE tasks.user_id = ? AND (
        tasks.goal_id = ? OR tasks.id IN (
          SELECT link.task_id
          FROM task_lesson_links AS link
          JOIN course_lessons AS lesson ON lesson.id = link.lesson_id
          JOIN learning_programs AS program ON program.id = lesson.program_id
          WHERE program.goal_id = ? AND program.user_id = ?
        )
      )
    `).all(userId, goalId, goalId, userId) as Array<{ id: string }>;
    const deletedTasks = Number(database.prepare(`
      DELETE FROM tasks
      WHERE user_id = ? AND (
        goal_id = ? OR id IN (
          SELECT link.task_id
          FROM task_lesson_links AS link
          JOIN course_lessons AS lesson ON lesson.id = link.lesson_id
          JOIN learning_programs AS program ON program.id = lesson.program_id
          WHERE program.goal_id = ? AND program.user_id = ?
        )
      )
    `).run(userId, goalId, goalId, userId).changes);

    // Agent 调用属于目标生成过程；目标删除后不保留失去上下文的孤立运行记录。
    const deletedAgentRuns = Number(database
      .prepare("DELETE FROM agent_runs WHERE user_id = ? AND goal_id = ?")
      .run(userId, goalId).changes);

    database.prepare("DELETE FROM goals WHERE id = ? AND user_id = ?").run(goalId, userId);
    return { ...goal, deletedTasks, deletedTaskIds: linkedTasks.map((task) => task.id), deletedAgentRuns };
  });
}
