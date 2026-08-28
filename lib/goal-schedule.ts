const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** 统一按 UTC 零点比较，避免客户端与服务端时区不同导致差一天。 */
function toUtcDay(value: string) {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

function todayUtcDay() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function isValidTargetDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const time = toUtcDay(value);
  // Date.parse 会把 2026-02-31 归一化成 3 月，回写比对可以挡掉这类不存在的日期。
  if (time === null || new Date(time).toISOString().slice(0, 10) !== value) return false;
  return time > todayUtcDay();
}

/** 距离目标日期还剩几周，向上取整；已过期或不设期限返回 0。 */
export function weeksUntil(targetDate: string | null) {
  if (!targetDate) return 0;
  const time = toUtcDay(targetDate);
  if (time === null) return 0;
  return Math.max(0, Math.ceil((time - todayUtcDay()) / MS_PER_WEEK));
}

/**
 * 到目标日期为止大致可投入的总工时。
 * 这是确定性计算，由代码承担；将来规划师只负责估算「这个目标需要多少工时」。
 */
export function availableHours(targetDate: string | null, weeklyHours: number) {
  return weeksUntil(targetDate) * Math.max(0, weeklyHours);
}

/** 日期选择器的最小可选值：明天。与服务端的「必须是将来日期」校验保持一致。 */
export function minTargetDate() {
  return new Date(todayUtcDay() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 目标卡片上展示的周期文案，由目标日期派生，避免用户重复填写。 */
export function horizonLabel(targetDate: string | null) {
  if (!targetDate) return "长期";
  const time = toUtcDay(targetDate);
  if (time === null) return "长期";
  const date = new Date(time);
  return `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日前`;
}
