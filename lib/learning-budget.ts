export type PreferredPeriod = "morning" | "daytime" | "evening" | "late_night" | "flexible";
export type PreferredSession = "fragment" | "standard" | "long";

/** 周一到周日各自可投入的分钟数。 */
export type WeekdayMinutes = [number, number, number, number, number, number, number];

export type UserLearningProfile = {
  weekdayMinutes: WeekdayMinutes;
  sustainableWeeklyMinutes: number;
  preferredPeriod: PreferredPeriod;
  preferredSession: PreferredSession;
  habitNote: string;
};

export const DEFAULT_SUSTAINABLE_WEEKLY_MINUTES = 40 * 60;

/** 单次时长偏好对应的课节长度区间，规划师据此排每日任务。 */
export const SESSION_MINUTES: Record<PreferredSession, { min: number; max: number }> = {
  fragment: { min: 15, max: 30 },
  standard: { min: 45, max: 60 },
  long: { min: 60, max: 120 },
};

export const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

export function emptyWeekdayMinutes(): WeekdayMinutes {
  return [0, 0, 0, 0, 0, 0, 0];
}

export function parseWeekdayMinutes(value: unknown): WeekdayMinutes {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(raw) || raw.length !== 7) return emptyWeekdayMinutes();
  return raw.map((item) => clampDayMinutes(Number(item))) as WeekdayMinutes;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 单日上限 16 小时：再多就不是"可投入时间"而是笔误。 */
function clampDayMinutes(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(960, Math.round(value))) : 0;
}

export function weeklyMinutes(weekday: WeekdayMinutes) {
  return weekday.reduce((total, minutes) => total + minutes, 0);
}

export function studyDaysPerWeek(weekday: WeekdayMinutes) {
  return weekday.filter((minutes) => minutes > 0).length;
}

/** JS 的 getDay() 是周日为 0；这里统一成周一为 0。 */
export function weekdayIndex(date: Date) {
  return (date.getDay() + 6) % 7;
}

export function minutesOn(weekday: WeekdayMinutes, date: Date) {
  return weekday[weekdayIndex(date)];
}

/** 把"每周 N 小时，学这几天"展开成逐日分钟数，余数摊给靠前的学习日。 */
export function spreadWeeklyMinutes(totalMinutes: number, activeDays: boolean[]): WeekdayMinutes {
  const days = activeDays.filter(Boolean).length;
  const result = emptyWeekdayMinutes();
  if (days === 0 || totalMinutes <= 0) return result;
  const base = Math.floor(totalMinutes / days);
  let remainder = totalMinutes - base * days;
  for (let index = 0; index < 7; index += 1) {
    if (!activeDays[index]) continue;
    result[index] = clampDayMinutes(base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }
  return result;
}

export type BudgetAllocation = { goalId: string; title: string; weeklyMinutes: number };

export type BudgetReview = {
  status: "ok" | "over_budget" | "over_sustainable" | "no_budget";
  weeklyBudgetMinutes: number;
  allocatedMinutes: number;
  remainingMinutes: number;
  sustainableWeeklyMinutes: number;
  dailyAverageMinutes: number;
  reason: string;
  suggestions: string[];
};

/**
 * 跨目标总量检查：单个目标各自看都合理，加起来未必。
 * 只产出警告和建议，从不阻止创建——用户可以自行调整每周预算。
 */
export function reviewBudget(input: {
  profile: UserLearningProfile;
  allocations: BudgetAllocation[];
  incoming?: { title: string; weeklyMinutes: number };
}): BudgetReview {
  const { profile, allocations, incoming } = input;
  const weeklyBudgetMinutes = weeklyMinutes(profile.weekdayMinutes);
  const allocatedMinutes = allocations.reduce((total, item) => total + item.weeklyMinutes, 0)
    + (incoming?.weeklyMinutes || 0);
  const remainingMinutes = weeklyBudgetMinutes - allocatedMinutes;
  const days = studyDaysPerWeek(profile.weekdayMinutes) || 7;
  const dailyAverageMinutes = Math.round(allocatedMinutes / days);

  const base = {
    weeklyBudgetMinutes,
    allocatedMinutes,
    remainingMinutes,
    sustainableWeeklyMinutes: profile.sustainableWeeklyMinutes,
    dailyAverageMinutes,
  };

  if (weeklyBudgetMinutes === 0) {
    return {
      ...base,
      status: "no_budget",
      reason: "还没有设置每周可投入的时间，系统无法判断这些目标排得开不开。",
      suggestions: ["先填写一周里哪几天能学、每天大约多少分钟。"],
    };
  }

  const names = [...allocations.map((item) => item.title), ...(incoming ? [incoming.title] : [])];
  const goalCount = names.length;

  if (allocatedMinutes > weeklyBudgetMinutes) {
    const over = allocatedMinutes - weeklyBudgetMinutes;
    // 已有目标就已经占满甚至超出时，"把这个目标降到 X" 算出来是负数或兜底值，
    // 给了也没法执行——这种情况只给真正可行的三条。
    const headroom = weeklyBudgetMinutes - (allocatedMinutes - (incoming?.weeklyMinutes || 0));
    return {
      ...base,
      status: "over_budget",
      reason: goalCount > 1
        ? `${goalCount} 个目标每周合计 ${formatHours(allocatedMinutes)}，超出你设定的 ${formatHours(weeklyBudgetMinutes)}，多出 ${formatHours(over)}；按学习日摊开是每天约 ${dailyAverageMinutes} 分钟。`
        : `这个目标每周需要 ${formatHours(allocatedMinutes)}，超出你设定的 ${formatHours(weeklyBudgetMinutes)}。`,
      suggestions: [
        ...(incoming && headroom >= 15 ? [`把这个目标的每周投入降到 ${formatHours(headroom)} 以内`] : []),
        "推迟目标日期，用更长的周期摊薄每周投入",
        ...(goalCount > 1 ? ["暂停其中一个进行中的目标，先专注一个"] : []),
        "调高每周可投入时间",
      ],
    };
  }

  if (allocatedMinutes > profile.sustainableWeeklyMinutes) {
    return {
      ...base,
      status: "over_sustainable",
      reason: `每周合计 ${formatHours(allocatedMinutes)}，超过你设定的可持续上限 ${formatHours(profile.sustainableWeeklyMinutes)}。时间表上排得下，但长期未必撑得住。`,
      suggestions: ["降低其中一个目标的每周投入", "推迟目标日期", "如果确实能坚持，到个人设置里调高可持续上限"],
    };
  }

  return {
    ...base,
    status: "ok",
    reason: `每周合计 ${formatHours(allocatedMinutes)}，在 ${formatHours(weeklyBudgetMinutes)} 预算内，还剩 ${formatHours(remainingMinutes)}。`,
    suggestions: [],
  };
}

export function formatHours(minutes: number) {
  if (minutes <= 0) return "0 小时";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
