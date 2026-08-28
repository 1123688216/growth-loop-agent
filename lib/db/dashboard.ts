import { getDatabase } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth/session";
import type { DemoSeed, Goal, LearningLog, LedgerEntry, Task, TaskKind } from "@/lib/demo-data";

type GoalRow = {
  id: string;
  title: string;
  description: string;
  progress_percent: number;
  horizon: string;
  target_date: string | null;
  status: "active" | "review" | "completed" | "archived";
  self_level: Goal["selfLevel"] | null;
  diagnostic_status: Goal["diagnosticStatus"] | null;
  program_id: string | null;
};

type TaskRow = {
  id: string;
  title: string;
  subtitle: string;
  time_label: string;
  duration_minutes: number;
  xp_reward: number;
  coin_reward: number;
  status: Task["status"];
  kind: TaskKind;
  lesson_id: string | null;
  program_id: string | null;
};

type ActivityRow = {
  id: string;
  raw_content: string;
  topic: string;
  output: string | null;
  minutes: number | null;
  xp_reward: number;
  coin_reward: number;
  occurred_at: string;
};

type LedgerRow = {
  id: string;
  currency: "XP" | "COIN";
  amount: number;
  reason: string;
  created_at: string;
};

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function statusLabel(status: GoalRow["status"]): Goal["status"] {
  return status === "review" ? "待复盘" : "进行中";
}

function getBalance(userId: string, currency: "XP" | "COIN") {
  const row = getDatabase()
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE user_id = ? AND currency = ?")
    .get(userId, currency) as { balance: number };
  return Number(row.balance || 0);
}

function buildWeeklyBars(rows: ActivityRow[]) {
  const formatter = new Intl.DateTimeFormat("zh-CN", { weekday: "short" });
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    const key = date.toISOString().slice(0, 10);
    const minutes = rows
      .filter((row) => row.occurred_at.slice(0, 10) === key)
      .reduce((total, row) => total + (row.minutes || 0), 0);
    return {
      day: formatter.format(date).replace("周", ""),
      value: Math.min(100, Math.max(minutes > 0 ? 8 : 0, Math.round((minutes / 120) * 100))),
      label: `${minutes}m`,
    };
  });
}

export function getDashboardData(user: CurrentUser): DemoSeed {
  const database = getDatabase();
  const goalRows = database
    .prepare(`
      SELECT goals.id, goals.title, goals.description, goals.progress_percent, goals.horizon,
             goals.target_date, goals.status, profile.self_level, profile.diagnostic_status,
             (SELECT program.id FROM learning_programs AS program
              WHERE program.goal_id = goals.id AND program.status = 'active'
              ORDER BY program.version DESC LIMIT 1) AS program_id
      FROM goals
      LEFT JOIN goal_learning_profiles AS profile ON profile.goal_id = goals.id
      WHERE goals.user_id = ? AND goals.status != 'archived'
      ORDER BY goals.created_at
    `)
    .all(user.id) as GoalRow[];
  const taskRows = database
    .prepare(`
      SELECT tasks.id, tasks.title, tasks.subtitle, tasks.time_label, tasks.duration_minutes,
             tasks.xp_reward, tasks.coin_reward, tasks.status, tasks.kind,
             link.lesson_id AS lesson_id, lesson.program_id AS program_id
      FROM tasks
      LEFT JOIN task_lesson_links AS link ON link.task_id = tasks.id
      LEFT JOIN course_lessons AS lesson ON lesson.id = link.lesson_id
      WHERE tasks.user_id = ? AND tasks.status != 'skipped'
      ORDER BY tasks.position, tasks.created_at
    `)
    .all(user.id) as TaskRow[];
  const activityRows = database
    .prepare("SELECT id, raw_content, topic, output, minutes, xp_reward, coin_reward, occurred_at FROM activity_logs WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 100")
    .all(user.id) as ActivityRow[];
  const ledgerRows = database
    .prepare("SELECT id, currency, amount, reason, created_at FROM ledger_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(user.id) as LedgerRow[];

  const goals: Goal[] = goalRows.map((goal) => ({
    id: goal.id,
    title: goal.title,
    description: goal.description,
    progress: goal.progress_percent,
    horizon: goal.horizon,
    ...(goal.target_date ? { targetDate: goal.target_date } : {}),
    ...(goal.self_level ? { selfLevel: goal.self_level } : {}),
    ...(goal.diagnostic_status ? { diagnosticStatus: goal.diagnostic_status } : {}),
    ...(goal.program_id ? { learningProgramId: goal.program_id } : {}),
    status: statusLabel(goal.status),
  }));
  const tasks: Task[] = taskRows.map((task) => ({
    id: task.id,
    title: task.title,
    subtitle: task.subtitle,
    time: task.time_label,
    duration: `${task.duration_minutes} min`,
    xp: task.xp_reward,
    coin: task.coin_reward,
    status: task.status,
    kind: task.kind,
    ...(task.lesson_id ? { lessonId: task.lesson_id } : {}),
    ...(task.program_id ? { programId: task.program_id } : {}),
  }));
  const learningLogs: LearningLog[] = activityRows.map((log) => ({
    id: log.id,
    topic: log.topic || "学习记录",
    summary: log.output || log.raw_content,
    duration: log.minutes ? `${log.minutes} min` : "随手记录",
    xp: log.xp_reward,
    coin: log.coin_reward,
    evidence: log.output ? "输入 + 输出" : "输入",
    occurredAt: formatDateTime(log.occurred_at),
  }));
  const ledger: LedgerEntry[] = ledgerRows.map((entry) => ({
    id: entry.id,
    account: entry.currency,
    amount: entry.amount,
    reason: entry.reason,
    occurredAt: formatDateTime(entry.created_at),
  }));

  const now = new Date();
  return {
    seedVersion: "database.v1",
    user: {
      displayName: user.displayName,
      level: user.level,
      role: user.role,
      streak: user.actionStreakDays,
      focusScore: user.focusScore,
      xpBalance: getBalance(user.id, "XP"),
      coinBalance: getBalance(user.id, "COIN"),
      dateLabel: now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }),
      weekdayLabel: now.toLocaleDateString("zh-CN", { weekday: "long" }),
    },
    goals,
    tasks,
    learningLogs,
    ledger,
    weeklyBars: buildWeeklyBars(activityRows),
    insight: learningLogs.length
      ? "继续留下可验证的结果，后续考核系统会用这些记录判断你真正缺少什么。"
      : "先完成第一条学习记录。只有留下事实和结果，系统才能开始判断你的能力缺口。",
    quote: "学习不是完成内容，而是让下一次行动比这一次更准确。",
  };
}
