import { asRecord, cleanList, cleanText, requestStructured } from "@/lib/agents/shared";
import type { CourseOutlineDraft, GoalContext, PersistedSkill, SkillDraft } from "@/lib/agents/types";
import type { CapabilityType } from "@/lib/learning-program/types";

const CAPABILITY_TYPES: CapabilityType[] = [
  "conceptual_understanding",
  "procedural_skill",
  "problem_solving",
  "expression_communication",
  "retrieval_discrimination",
  "integrated_creation",
];

function inferCapabilityType(text: string, index = 0): CapabilityType {
  if (/表达|沟通|面试|演讲|写作|介绍|语言/i.test(text)) return "expression_communication";
  if (/记忆|辨析|识别|区分|背诵|历史|词汇/i.test(text)) return "retrieval_discrimination";
  if (/项目|作品|交付|设计|实现|搭建|创作/i.test(text)) return "integrated_creation";
  if (/排错|调试|解决|分析|推理|决策|优化/i.test(text)) return "problem_solving";
  if (/操作|配置|步骤|使用|部署|安装|流程/i.test(text)) return "procedural_skill";
  return index === 1 ? "procedural_skill" : index >= 2 ? "problem_solving" : "conceptual_understanding";
}

function fallbackSkills(goal: GoalContext): SkillDraft[] {
  return [
    ["foundation", `${goal.title}的核心概念与边界`, "能解释关键概念、适用范围和常见误区"],
    ["method", `${goal.title}的核心方法`, "能按步骤完成一个典型任务并解释选择"],
    ["application", `${goal.title}的实际应用`, "能把方法迁移到一个自己的真实场景"],
    ["debugging", `${goal.title}的纠错与复盘`, "能发现失败原因并提出可验证的改进"],
    ["delivery", `${goal.title}的综合交付`, "能独立完成并说明一项可展示成果"],
  ].map(([key, name, description], index) => ({
    key,
    name,
    description,
    targetLevel: index === 4 ? 4 : 3,
    weight: index === 4 ? 1.3 : 1,
    capabilityType: inferCapabilityType(`${name} ${description}`, index),
  }));
}

export async function buildSkillMap(goal: GoalContext) {
  const fallback = fallbackSkills(goal);
  return requestStructured({
    fallback,
    timeoutMs: 75_000,
    system: "你是学习规划员。只负责把目标拆成可评测能力，不写课程正文。输出严格 JSON，不使用 Markdown。",
    user: `目标：${goal.title}\n完成标准：${goal.description || "能独立完成一项可验证成果"}\n当前背景：${goal.background || "未说明"}\n请输出 {"skills":[...]}，包含 4-6 项。每项字段：key（英文短标识）、name、description（可观察能力）、targetLevel（1-5）、weight（0.5-2）、capabilityType。capabilityType 只能是 ${CAPABILITY_TYPES.join("、")}；按用户最终需要证明的行为选择，不要把所有知识都标成概念理解。`,
    normalize(raw) {
      const values = Array.isArray(raw.skills) ? raw.skills.slice(0, 6) : [];
      const skills = values.map((value, index) => {
        const item = asRecord(value);
        const source = fallback[index] || fallback[fallback.length - 1];
        const requestedCapability = cleanText(item?.capabilityType, source.capabilityType, 60) as CapabilityType;
        return {
          key: cleanText(item?.key, source.key, 40).replace(/[^a-zA-Z0-9_-]/g, "-") || `skill-${index + 1}`,
          name: cleanText(item?.name, source.name, 120),
          description: cleanText(item?.description, source.description, 400),
          targetLevel: Math.max(1, Math.min(5, Math.round(Number(item?.targetLevel) || source.targetLevel))),
          weight: Math.max(0.5, Math.min(2, Number(item?.weight) || source.weight)),
          capabilityType: CAPABILITY_TYPES.includes(requestedCapability)
            ? requestedCapability
            : inferCapabilityType(`${cleanText(item?.name)} ${cleanText(item?.description)}`, index),
        };
      });
      return skills.length >= 4 ? skills : fallback;
    },
  });
}

export function estimateLessonCount(goal: GoalContext, skillCount: number) {
  const now = new Date();
  const target = goal.targetDate ? new Date(`${goal.targetDate}T23:59:59`) : null;
  const weeks = target && Number.isFinite(target.getTime())
    ? Math.max(1, Math.ceil((target.getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000)))
    : 4;
  const availableHours = Math.max(3, weeks * goal.weeklyHours);
  const capacityCount = Math.round(availableHours / 7.5);
  return Math.max(3, Math.min(12, Math.max(skillCount, capacityCount)));
}

function fallbackOutline(goal: GoalContext, skills: PersistedSkill[], lessonCount: number): CourseOutlineDraft {
  const lessons = Array.from({ length: lessonCount }, (_, index) => {
    const skill = skills[index % skills.length];
    const cycle = Math.floor(index / skills.length);
    const isFinal = index === lessonCount - 1;
    return {
      title: cycle === 0 ? skill.name : `${skill.name} · ${isFinal ? "综合交付" : "迁移练习"}`,
      phase: index === 0 ? "建立基础" : isFinal ? "综合交付" : cycle === 0 ? "理解与应用" : "迁移与强化",
      objective: isFinal ? `综合运用已有能力，${goal.description || "完成一项可验证成果"}` : skill.description,
      concepts: [skill.name, "判断依据", "验证结果"],
      durationMinutes: isFinal ? 75 : skill.capabilityType === "integrated_creation" ? 60 : 45,
      skillId: skill.id,
      difficulty: goal.selfLevel === "beginner" ? 2 : 3,
      capabilityType: isFinal ? "integrated_creation" : skill.capabilityType,
      prerequisites: index === 0 ? [] : [skills[(index - 1) % skills.length].id],
      completionEvidence: [isFinal ? "提交满足目标完成标准的综合成果，并说明验证结果。" : `独立展示：${skill.description}`],
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

export async function buildCourseOutline(goal: GoalContext, skills: PersistedSkill[], lessonCount?: number) {
  const count = Math.max(3, Math.min(12, lessonCount || estimateLessonCount(goal, skills.length)));
  const fallback = fallbackOutline(goal, skills, count);
  return requestStructured({
    fallback,
    timeoutMs: 90_000,
    system: "你是学习规划员。根据已经持久化的能力清单生成课程骨架，不写讲解正文、不出题。只输出严格 JSON。",
    user: `目标：${goal.title}\n完成标准：${goal.description}\n目标日期：${goal.targetDate || "不设期限"}\n每周投入：${goal.weeklyHours} 小时\n能力：${JSON.stringify(skills)}\n系统根据时间容量决定生成 ${count} 节。输出 title、summary、outcomes、cadence、instructor，以及恰好 ${count} 节 lessons。每节只含 title、phase、objective、concepts、durationMinutes、skillId、difficulty、capabilityType、prerequisites、completionEvidence。skillId 必须来自能力清单；capabilityType 必须来自允许集合；completionEvidence 必须描述可观察产物或表现，禁止只写“理解/掌握”。`,
    normalize(raw) {
      const allowed = new Set(skills.map((skill) => skill.id));
      const rawLessons = Array.isArray(raw.lessons) ? raw.lessons.slice(0, count) : [];
      if (rawLessons.length !== count) return fallback;
      const lessons = rawLessons.map((value, index) => {
        const item = asRecord(value);
        const source = fallback.lessons[index];
        const requestedSkillId = cleanText(item?.skillId, source.skillId, 180);
        const requestedCapability = cleanText(item?.capabilityType, source.capabilityType, 60) as CapabilityType;
        return {
          title: cleanText(item?.title, source.title, 160),
          phase: cleanText(item?.phase, source.phase, 80),
          objective: cleanText(item?.objective, source.objective, 400),
          concepts: cleanList(item?.concepts, source.concepts, 6),
          durationMinutes: Math.max(20, Math.min(120, Math.round(Number(item?.durationMinutes) || source.durationMinutes))),
          skillId: allowed.has(requestedSkillId) ? requestedSkillId : source.skillId,
          difficulty: Math.max(1, Math.min(5, Math.round(Number(item?.difficulty) || source.difficulty))),
          capabilityType: CAPABILITY_TYPES.includes(requestedCapability) ? requestedCapability : source.capabilityType,
          prerequisites: cleanList(item?.prerequisites, source.prerequisites, 5).filter((id) => allowed.has(id)),
          completionEvidence: cleanList(item?.completionEvidence, source.completionEvidence, 4),
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
