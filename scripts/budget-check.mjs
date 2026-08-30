// 预算检查的最小回归：跨目标总量是这次改动的核心，不能只靠 typecheck。
import assert from "node:assert/strict";

import { formatHours, reviewBudget, spreadWeeklyMinutes, weeklyMinutes } from "../lib/learning-budget.ts";

function profileWith(weeklyHours, sustainableHours = 40) {
  return {
    weekdayMinutes: spreadWeeklyMinutes(weeklyHours * 60, [true, true, true, true, true, true, true]),
    sustainableWeeklyMinutes: sustainableHours * 60,
    preferredPeriod: "evening",
    preferredSession: "standard",
    habitNote: "",
  };
}

const profile = profileWith(10);
assert.equal(weeklyMinutes(profile.weekdayMinutes), 600, "摊分后的每周总量应当守恒");

// 用户提的场景：两个目标各要 40 小时，单看都在 CHECK 允许的 1..40 内。
const over = reviewBudget({
  profile,
  allocations: [{ goalId: "a", title: "Agent 系统设计", weeklyMinutes: 40 * 60 }],
  incoming: { title: "英语面试表达", weeklyMinutes: 40 * 60 },
});
assert.equal(over.status, "over_budget");
assert(over.suggestions.length >= 3, "超支必须给出可选方案");
assert(over.reason.includes("2 个目标"), "原因要点明是跨目标合计");
assert(
  !over.suggestions.some((item) => item.includes("降到")),
  "已有目标就占满额度时，不能建议把新目标降到某个负数或兜底值",
);

// 额度还有富余时，"降到 X 以内"是可执行的，应当给出。
const partial = reviewBudget({
  profile,
  allocations: [{ goalId: "a", title: "A", weeklyMinutes: 6 * 60 }],
  incoming: { title: "B", weeklyMinutes: 8 * 60 },
});
assert.equal(partial.status, "over_budget");
assert(partial.suggestions.some((item) => item.includes("降到 4 小时")), "应当算出剩余额度 4 小时");

// 时间表排得下，但超过可持续上限。
const tiring = reviewBudget({
  profile: profileWith(60, 15),
  allocations: [{ goalId: "a", title: "A", weeklyMinutes: 50 * 60 }],
});
assert.equal(tiring.status, "over_sustainable");

// 正常范围。
const ok = reviewBudget({
  profile,
  allocations: [{ goalId: "a", title: "A", weeklyMinutes: 4 * 60 }],
  incoming: { title: "B", weeklyMinutes: 3 * 60 },
});
assert.equal(ok.status, "ok");
assert.equal(ok.remainingMinutes, 180);

// 还没设预算时不能装作一切正常。
const none = reviewBudget({ profile: profileWith(0), allocations: [] });
assert.equal(none.status, "no_budget");

assert.equal(formatHours(90), "1 小时 30 分钟");
assert.equal(formatHours(120), "2 小时");
assert.equal(formatHours(45), "45 分钟");

console.log(JSON.stringify({
  ok: true,
  overBudget: { status: over.status, reason: over.reason, suggestions: over.suggestions },
  overSustainable: tiring.status,
  normal: { status: ok.status, remaining: formatHours(ok.remainingMinutes) },
}, null, 2));
