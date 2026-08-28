import { asRecord, cleanList, cleanText, requestStructured } from "@/lib/agents/shared";
import type { CourseOutlineDraft, GoalContext, PersistedSkill, SkillDraft } from "@/lib/agents/types";

function fallbackSkills(goal: GoalContext): SkillDraft[] {
  return [
    ["foundation", `${goal.title}的核心概念与边界`, "能解释关键概念、适用范围和常见误区"],
    ["method", `${goal.title}的核心方法`, "能按步骤完成一个典型任务并解释选择"],
    ["application", `${goal.title}的实际应用`, "能把方法迁移到一个自己的真实场景"],
    ["debugging", `${goal.title}的纠错与复盘`, "能发现失败原因并提出可验证的改进"],
    ["delivery", `${goal.title}的综合交付`, "能独立完成并说明一项可展示成果"],
  ].map(([key, name, description], index) => ({ key, name, description, targetLevel: index === 4 ? 4 : 3, weight: index === 4 ? 1.3 : 1 }));
}

export async function buildSkillMap(goal: GoalContext) {
  const fallback = fallbackSkills(goal);
  return requestStructured({
    fallback,
    system: "你是学习规划员。只负责把目标拆成可评测能力，不写课程正文。输出严格 JSON，不使用 Markdown。",
    user: `目标：${goal.title}\n完成标准：${goal.description || "能独立完成一项可验证成果"}\n当前背景：${goal.background || "未说明"}\n请输出 {"skills":[...]}，包含 4-6 项。每项字段：key（英文短标识）、name、description（可观察能力）、targetLevel（1-5）、weight（0.5-2）。`,
    normalize(raw) {
      const values = Array.isArray(raw.skills) ? raw.skills.slice(0, 6) : [];
      const skills = values.map((value, index) => {
        const item = asRecord(value);
        const source = fallback[index] || fallback[fallback.length - 1];
        return {
          key: cleanText(item?.key, source.key, 40).replace(/[^a-zA-Z0-9_-]/g, "-") || `skill-${index + 1}`,
          name: cleanText(item?.name, source.name, 120),
          description: cleanText(item?.description, source.description, 400),
          targetLevel: Math.max(1, Math.min(5, Math.round(Number(item?.targetLevel) || source.targetLevel))),
          weight: Math.max(0.5, Math.min(2, Number(item?.weight) || source.weight)),
        };
      });
      return skills.length >= 4 ? skills : fallback;
    },
  });
}

function fallbackOutline(goal: GoalContext, skills: PersistedSkill[], lessonCount: number): CourseOutlineDraft {
  const lessons = Array.from({ length: lessonCount }, (_, index) => {
    const skill = skills[Math.min(index, skills.length - 1)];
    return {
      title: skill.name,
      phase: index === 0 ? "建立基础" : index === lessonCount - 1 ? "综合交付" : "理解与应用",
      objective: skill.description,
      concepts: [skill.name, "判断依据", "验证结果"],
      durationMinutes: index === lessonCount - 1 ? 60 : 45,
      skillId: skill.id,
      difficulty: goal.selfLevel === "beginner" ? 2 : 3,
    };
  });
  return {
    title: `${goal.title} · 学习路线`,
    summary: `围绕“${goal.description || goal.title}”，按能力逐步学习、练习并留下可验证成果。`,
    outcomes: skills.slice(0, 4).map((skill) => skill.description),
    cadence: `建议每周投入 ${goal.weeklyHours} 小时；每节通过导师巩固题后再生成下一节。`,
    instructor: { name: "岚 · AI 学习导师", role: `陪你把 ${goal.title} 学到能独立应用`, style: "结合你的基础讲解，用小测确认理解，再决定下一步。", openingMessage: "先说说你对这一节已经知道什么，我们从现有理解继续。" },
    lessons,
  };
}

export async function buildCourseOutline(goal: GoalContext, skills: PersistedSkill[], lessonCount = 5) {
  const count = Math.max(3, Math.min(5, lessonCount));
  const fallback = fallbackOutline(goal, skills, count);
  return requestStructured({
    fallback,
    system: "你是学习规划员。根据已经持久化的能力清单生成课程骨架，不写讲解正文、不出题。只输出严格 JSON。",
    user: `目标：${goal.title}\n完成标准：${goal.description}\n每周投入：${goal.weeklyHours} 小时\n能力：${JSON.stringify(skills)}\n输出 title、summary、outcomes、cadence、instructor，以及恰好 ${count} 节 lessons。每节只含 title、phase、objective、concepts、durationMinutes、skillId、difficulty。skillId 必须来自能力清单。`,
    normalize(raw) {
      const allowed = new Set(skills.map((skill) => skill.id));
      const rawLessons = Array.isArray(raw.lessons) ? raw.lessons.slice(0, count) : [];
      if (rawLessons.length !== count) return fallback;
      const lessons = rawLessons.map((value, index) => {
        const item = asRecord(value);
        const source = fallback.lessons[index];
        const requestedSkillId = cleanText(item?.skillId, source.skillId, 180);
        return {
          title: cleanText(item?.title, source.title, 160),
          phase: cleanText(item?.phase, source.phase, 80),
          objective: cleanText(item?.objective, source.objective, 400),
          concepts: cleanList(item?.concepts, source.concepts, 6),
          durationMinutes: Math.max(20, Math.min(120, Math.round(Number(item?.durationMinutes) || source.durationMinutes))),
          skillId: allowed.has(requestedSkillId) ? requestedSkillId : source.skillId,
          difficulty: Math.max(1, Math.min(5, Math.round(Number(item?.difficulty) || source.difficulty))),
        };
      });
      const instructor = asRecord(raw.instructor);
      return {
        title: cleanText(raw.title, fallback.title, 180), summary: cleanText(raw.summary, fallback.summary, 1000),
        outcomes: cleanList(raw.outcomes, fallback.outcomes, 6), cadence: cleanText(raw.cadence, fallback.cadence, 400),
        instructor: {
          name: cleanText(instructor?.name, fallback.instructor.name, 100), role: cleanText(instructor?.role, fallback.instructor.role, 240),
          style: cleanText(instructor?.style, fallback.instructor.style, 400), openingMessage: cleanText(instructor?.openingMessage, fallback.instructor.openingMessage, 700),
        }, lessons,
      };
    },
  });
}
