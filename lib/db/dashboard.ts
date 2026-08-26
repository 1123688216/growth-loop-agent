import { getDatabase } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth/session";
import type { DemoSeed, Goal, LearningLog, LedgerEntry, Task, TaskKind } from "@/lib/demo-data";

type GoalRow = {
  id: string;
  title: string;
  description: string;
  progress_percent: number;
  horizon: string;
  status: "active" | "review" | "completed" | "archived";
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
    .prepare("SELECT id, title, description, progress_percent, horizon, status FROM goals WHERE user_id = ? AND status != 'archived' ORDER BY created_at")
    .all(user.id) as GoalRow[];
  const taskRows = database
    .prepare("SELECT id, title, subtitle, time_label, duration_minutes, xp_reward, coin_reward, status, kind FROM tasks WHERE user_id = ? AND status != 'skipped' ORDER BY position, created_at")
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
