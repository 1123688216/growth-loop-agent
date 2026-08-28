import type { PersistedSkill } from "@/lib/agents/types";

export type AdaptiveSkillBoundary = {
  passMax: number;
  failMin: number;
  attempts: number;
  lastDifficulty: number;
  lastScore: number;
  resolved: boolean;
};

export type AdaptiveDiagnosticState = {
  version: 1;
  baseDifficulty: number;
  skills: Record<string, AdaptiveSkillBoundary>;
};

export type AdaptiveTarget = {
  skill: PersistedSkill;
  difficulty: number;
  reason: "untested" | "probe_higher" | "probe_lower" | "confirm_boundary";
};

function clampDifficulty(value: number) {
  return Math.max(1, Math.min(5, Math.round(value)));
}

export function createAdaptiveState(skills: PersistedSkill[], baseDifficulty: number): AdaptiveDiagnosticState {
  return {
    version: 1,
    baseDifficulty: clampDifficulty(baseDifficulty),
    skills: Object.fromEntries(skills.map((skill) => [skill.id, {
      passMax: 0,
      failMin: 6,
      attempts: 0,
      lastDifficulty: 0,
      lastScore: 0,
      resolved: false,
    }])),
  };
}

export function parseAdaptiveState(value: string | null | undefined, skills: PersistedSkill[], baseDifficulty: number) {
  try {
    const parsed = JSON.parse(value || "{}") as AdaptiveDiagnosticState;
    if (parsed.version === 1 && parsed.skills && typeof parsed.skills === "object") {
      const fallback = createAdaptiveState(skills, parsed.baseDifficulty || baseDifficulty);
      for (const skill of skills) {
        const item = parsed.skills[skill.id];
        if (!item) continue;
        fallback.skills[skill.id] = {
          passMax: Math.max(0, Math.min(5, Math.round(item.passMax || 0))),
          failMin: Math.max(1, Math.min(6, Math.round(item.failMin || 6))),
          attempts: Math.max(0, Math.round(item.attempts || 0)),
          lastDifficulty: Math.max(0, Math.min(5, Math.round(item.lastDifficulty || 0))),
          lastScore: Math.max(0, Math.min(10, Math.round(item.lastScore || 0))),
          resolved: Boolean(item.resolved),
        };
      }
      return fallback;
    }
  } catch {
    // 旧诊断没有自适应状态，调用方会使用新状态重新开始。
  }
  return createAdaptiveState(skills, baseDifficulty);
}

export function updateAdaptiveBoundary(
  state: AdaptiveDiagnosticState,
  skillId: string,
  difficulty: number,
  score: number,
) {
  const next = structuredClone(state);
  const current = next.skills[skillId];
  if (!current) throw new Error("诊断题缺少对应能力状态。");
  const level = clampDifficulty(difficulty);
  const normalizedScore = Math.max(0, Math.min(10, Math.round(score)));
  current.attempts += 1;
  current.lastDifficulty = level;
  current.lastScore = normalizedScore;

  let direction: "harder" | "easier" | "same";
  if (normalizedScore >= 8) {
    current.passMax = Math.max(current.passMax, level);
    direction = level < 5 ? "harder" : "same";
  } else if (normalizedScore <= 4) {
    current.failMin = Math.min(current.failMin, level);
    direction = level > 1 ? "easier" : "same";
  } else {
    current.passMax = Math.max(current.passMax, Math.max(0, level - 1));
    current.failMin = Math.min(current.failMin, Math.min(6, level + 1));
    direction = "same";
  }
  current.resolved = current.passMax >= 5
    || current.failMin <= 1
    || current.failMin - current.passMax <= 1
    || (current.attempts >= 2 && normalizedScore >= 5 && normalizedScore <= 7);
  return { state: next, direction };
}

function nextDifficulty(boundary: AdaptiveSkillBoundary, baseDifficulty: number) {
  if (!boundary.attempts) return clampDifficulty(baseDifficulty);
  if (boundary.lastScore >= 8) return clampDifficulty(boundary.lastDifficulty + 1);
  if (boundary.lastScore <= 4) return clampDifficulty(boundary.lastDifficulty - 1);
  return clampDifficulty(boundary.lastDifficulty);
}

export function selectAdaptiveTarget(input: {
  skills: PersistedSkill[];
  state: AdaptiveDiagnosticState;
  answeredCount: number;
  minQuestions: number;
  maxQuestions: number;
  preferredSkillId?: string;
}): AdaptiveTarget | null {
  if (input.answeredCount >= input.maxQuestions) return null;
  const ranked = [...input.skills].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const preferred = input.preferredSkillId ? ranked.find((skill) => skill.id === input.preferredSkillId) : undefined;
  const preferredBoundary = preferred ? input.state.skills[preferred.id] : undefined;
  if (preferred && preferredBoundary && !preferredBoundary.resolved && preferredBoundary.attempts < 3) {
    return {
      skill: preferred,
      difficulty: nextDifficulty(preferredBoundary, input.state.baseDifficulty),
      reason: preferredBoundary.lastScore >= 8
        ? "probe_higher"
        : preferredBoundary.lastScore <= 4
          ? "probe_lower"
          : "confirm_boundary",
    };
  }
  const untested = ranked.find((skill) => (input.state.skills[skill.id]?.attempts || 0) === 0);
  if (untested) {
    return { skill: untested, difficulty: input.state.baseDifficulty, reason: "untested" };
  }

  const unresolved = ranked
    .filter((skill) => !input.state.skills[skill.id]?.resolved && (input.state.skills[skill.id]?.attempts || 0) < 3)
    .sort((a, b) => input.state.skills[a.id].attempts - input.state.skills[b.id].attempts || b.weight - a.weight);
  if (unresolved.length) {
    const skill = unresolved[0];
    const boundary = input.state.skills[skill.id];
    return {
      skill,
      difficulty: nextDifficulty(boundary, input.state.baseDifficulty),
      reason: boundary.lastScore >= 8 ? "probe_higher" : boundary.lastScore <= 4 ? "probe_lower" : "confirm_boundary",
    };
  }

  if (input.answeredCount < input.minQuestions) {
    const skill = ranked.sort((a, b) => input.state.skills[a.id].attempts - input.state.skills[b.id].attempts || b.weight - a.weight)[0];
    return {
      skill,
      difficulty: nextDifficulty(input.state.skills[skill.id], input.state.baseDifficulty),
      reason: "confirm_boundary",
    };
  }
  return null;
}

export function adaptiveSkillScores(skills: PersistedSkill[], state: AdaptiveDiagnosticState) {
  return Object.fromEntries(skills.map((skill) => {
    const boundary = state.skills[skill.id];
    if (!boundary?.attempts) return [skill.id, 0];
    let estimatedLevel: number;
    if (boundary.passMax >= 5) estimatedLevel = 5;
    else if (boundary.failMin <= 1) estimatedLevel = 0;
    else if (boundary.passMax > 0 && boundary.failMin <= 5) estimatedLevel = (boundary.passMax + boundary.failMin - 1) / 2;
    else if (boundary.passMax > 0) estimatedLevel = Math.min(5, boundary.passMax + boundary.lastScore / 10 * .6);
    else if (boundary.failMin <= 5) estimatedLevel = Math.max(0, boundary.failMin - 1 + boundary.lastScore / 10 * .5);
    else estimatedLevel = boundary.lastDifficulty * boundary.lastScore / 10;
    return [skill.id, Math.max(0, Math.min(100, Math.round(estimatedLevel / 5 * 100)))];
  }));
}

export function adaptiveEvidenceCounts(skills: PersistedSkill[], state: AdaptiveDiagnosticState) {
  return Object.fromEntries(skills.map((skill) => [skill.id, state.skills[skill.id]?.attempts || 0]));
}
