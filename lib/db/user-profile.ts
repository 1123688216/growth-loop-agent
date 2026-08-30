import { getDatabase, withTransaction } from "@/lib/db";
import {
  DEFAULT_SUSTAINABLE_WEEKLY_MINUTES,
  emptyWeekdayMinutes,
  parseWeekdayMinutes,
  spreadWeeklyMinutes,
  weeklyMinutes,
  type PreferredPeriod,
  type PreferredSession,
  type UserLearningProfile,
  type WeekdayMinutes,
} from "@/lib/learning-budget";

type ProfileRow = {
  weekday_minutes_json: string;
  sustainable_weekly_minutes: number;
  preferred_period: PreferredPeriod;
  preferred_session: PreferredSession;
  habit_note: string;
};

const PERIODS: PreferredPeriod[] = ["morning", "daytime", "evening", "late_night", "flexible"];
const SESSIONS: PreferredSession[] = ["fragment", "standard", "long"];

export function readUserLearningProfile(userId: string): UserLearningProfile | null {
  const row = getDatabase().prepare(`
    SELECT weekday_minutes_json, sustainable_weekly_minutes, preferred_period, preferred_session, habit_note
    FROM user_learning_profiles WHERE user_id = ?
  `).get(userId) as ProfileRow | undefined;
  if (!row) return null;
  return {
    weekdayMinutes: parseWeekdayMinutes(row.weekday_minutes_json),
    sustainableWeeklyMinutes: row.sustainable_weekly_minutes,
    preferredPeriod: row.preferred_period,
    preferredSession: row.preferred_session,
    habitNote: row.habit_note,
  };
}

/**
 * 引导表单的默认值：老用户已经有目标和 weekly_hours，但没有预算。
 * 用现有活跃目标之和回填，避免升级当天所有人都被判超支。
 */
export function suggestedProfile(userId: string): UserLearningProfile {
  const row = getDatabase().prepare(`
    SELECT COALESCE(SUM(profile.weekly_hours), 0) AS hours
    FROM goal_learning_profiles AS profile
    JOIN goals ON goals.id = profile.goal_id
    WHERE profile.user_id = ? AND goals.status = 'active'
  `).get(userId) as { hours: number };
  const allocated = Math.round(Number(row.hours || 0) * 60);
  // 没有目标时给一个温和的起点：工作日各 45 分钟、周末各 90 分钟。
  const weekdayMinutes = allocated > 0
    ? spreadWeeklyMinutes(allocated, [true, true, true, true, true, true, true])
    : ([45, 45, 45, 45, 45, 90, 90] as WeekdayMinutes);
  return {
    weekdayMinutes,
    sustainableWeeklyMinutes: DEFAULT_SUSTAINABLE_WEEKLY_MINUTES,
    preferredPeriod: "evening",
    preferredSession: "standard",
    habitNote: "",
  };
}

export function saveUserLearningProfile(userId: string, input: {
  weekdayMinutes: unknown;
  sustainableWeeklyMinutes: unknown;
  preferredPeriod: unknown;
  preferredSession: unknown;
  habitNote: unknown;
}): UserLearningProfile {
  const weekdayMinutes = parseWeekdayMinutes(input.weekdayMinutes);
  // CHECK 只在新库生效（ALTER 加的列拿不到约束），取值一律在应用层再夹一次。
  const sustainable = Math.max(60, Math.min(10080, Math.round(Number(input.sustainableWeeklyMinutes) || DEFAULT_SUSTAINABLE_WEEKLY_MINUTES)));
  const period = PERIODS.includes(input.preferredPeriod as PreferredPeriod) ? input.preferredPeriod as PreferredPeriod : "evening";
  const session = SESSIONS.includes(input.preferredSession as PreferredSession) ? input.preferredSession as PreferredSession : "standard";
  const habitNote = typeof input.habitNote === "string" ? input.habitNote.trim().slice(0, 500) : "";
  const now = new Date().toISOString();

  withTransaction((database) => {
    database.prepare(`
      INSERT INTO user_learning_profiles (
        user_id, weekday_minutes_json, sustainable_weekly_minutes,
        preferred_period, preferred_session, habit_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        weekday_minutes_json = excluded.weekday_minutes_json,
        sustainable_weekly_minutes = excluded.sustainable_weekly_minutes,
        preferred_period = excluded.preferred_period,
        preferred_session = excluded.preferred_session,
        habit_note = excluded.habit_note,
        updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(weekdayMinutes), sustainable, period, session, habitNote, now, now);
  });

  return { weekdayMinutes, sustainableWeeklyMinutes: sustainable, preferredPeriod: period, preferredSession: session, habitNote };
}

/** 各活跃目标当前占用的每周分钟数，用于跨目标总量检查。 */
export function readActiveAllocations(userId: string) {
  const rows = getDatabase().prepare(`
    SELECT goals.id, goals.title, profile.weekly_hours
    FROM goals
    JOIN goal_learning_profiles AS profile ON profile.goal_id = goals.id
    WHERE goals.user_id = ? AND goals.status = 'active'
    ORDER BY goals.created_at
  `).all(userId) as Array<{ id: string; title: string; weekly_hours: number }>;
  return rows.map((row) => ({ goalId: row.id, title: row.title, weeklyMinutes: Math.round(row.weekly_hours * 60) }));
}

export function readBudgetSnapshot(userId: string) {
  const profile = readUserLearningProfile(userId);
  const allocations = readActiveAllocations(userId);
  return {
    profile,
    allocations,
    weeklyBudgetMinutes: profile ? weeklyMinutes(profile.weekdayMinutes) : 0,
    allocatedMinutes: allocations.reduce((total, item) => total + item.weeklyMinutes, 0),
    hasProfile: Boolean(profile),
    fallbackWeekdayMinutes: profile ? profile.weekdayMinutes : emptyWeekdayMinutes(),
  };
}
