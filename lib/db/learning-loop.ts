import { randomUUID } from "node:crypto";

import type { AgentResult } from "@/lib/agents/shared";
import type { DiagnosticQuestionDraft, PersistedSkill, SkillDraft } from "@/lib/agents/types";
import { getDatabase, withTransaction } from "@/lib/db";
import type { SelfLevel } from "@/lib/db/goals";
import type { AdaptiveDiagnosticState } from "@/lib/learning-loop/adaptive";
import type { CapabilityType, DiagnosticAssessment, DiagnosticGrade, DiagnosticQuestion } from "@/lib/learning-program/types";

type SkillRow = { id: string; name: string; description: string; target_level: number; weight: number; capability_type: CapabilityType };
type DiagnosticRow = {
  id: string;
  goal_id: string;
  status: "generated" | "in_progress" | "completed";
  source: "llm" | "rules" | "manual";
  provider: string;
  min_questions: number;
  max_questions: number;
  answered_count: number;
  adaptive_state_json: string;
};
type DiagnosticQuestionRow = {
  id: string;
  skill_id: string;
  kind: DiagnosticQuestion["kind"];
  difficulty: number;
  prompt: string;
  hint: string;
  reference_answer: string;
  rubric_json: string;
  max_score: number;
};
type DiagnosticResponseRow = {
  question_id: string;
  skill_id: string | null;
  answer: string;
  score: number;
  max_score: number;
  feedback: string;
  grader_mode: "llm" | "rules" | "manual";
  provider: string;
  model: string;
};

function toSkill(row: SkillRow): PersistedSkill {
  return { id: row.id, name: row.name, description: row.description, targetLevel: row.target_level, weight: row.weight, capabilityType: row.capability_type };
}

export function readGoalSkills(userId: string, goalId: string): PersistedSkill[] {
  const rows = getDatabase().prepare(`
    SELECT id, name, description, target_level, weight, capability_type
    FROM goal_skills WHERE goal_id = ? AND user_id = ? AND status = 'active'
    ORDER BY created_at, id
  `).all(goalId, userId) as SkillRow[];
  return rows.map(toSkill);
}

/** 首次拆能力时写入；重复 prepare 直接复用，避免刷新页面生成另一套 skill id。 */
export function ensureGoalSkills(userId: string, goalId: string, drafts: SkillDraft[]): PersistedSkill[] {
  const existing = readGoalSkills(userId, goalId);
  if (existing.length) return existing;
  const now = new Date().toISOString();
  withTransaction((database) => {
    const owned = database.prepare("SELECT id FROM goals WHERE id = ? AND user_id = ?").get(goalId, userId);
    if (!owned) throw new Error("找不到这个目标。");
    for (const draft of drafts) {
      const skillId = randomUUID();
      database.prepare(`
        INSERT INTO goal_skills (id, goal_id, user_id, name, description, target_level, weight, capability_type, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)
      `).run(skillId, goalId, userId, draft.name, draft.description, draft.targetLevel, draft.weight, draft.capabilityType, now, now);
      // 0 分 + 0 置信度表示未知，而不是断言完全不会。
      database.prepare(`
        INSERT INTO skill_mastery (user_id, skill_id, mastery_score, confidence, evidence_count, updated_at)
        VALUES (?, ?, 0, 0, 0, ?)
      `).run(userId, skillId, now);
    }
  });
  return readGoalSkills(userId, goalId);
}

function readQuestionRows(assessmentId: string): DiagnosticQuestionRow[] {
  return getDatabase().prepare(`
    SELECT id, skill_id, kind, difficulty, prompt, hint, reference_answer, rubric_json, max_score
    FROM diagnostic_questions WHERE assessment_id = ? ORDER BY position
  `).all(assessmentId) as DiagnosticQuestionRow[];
}

function toPublicDiagnostic(row: DiagnosticRow): DiagnosticAssessment {
  return {
    id: row.id,
    goalId: row.goal_id,
    status: row.status,
    source: row.source,
    provider: row.provider,
    adaptive: (() => {
      try { return (JSON.parse(row.adaptive_state_json) as { version?: unknown }).version === 1; } catch { return false; }
    })(),
    answeredCount: row.answered_count,
    minQuestions: row.min_questions,
    maxQuestions: row.max_questions,
    questions: readQuestionRows(row.id).map((question) => ({
      id: question.id,
      skillId: question.skill_id,
      kind: question.kind,
      difficulty: question.difficulty,
      prompt: question.prompt,
      hint: question.hint,
      maxScore: question.max_score,
    })),
  };
}

export function readActiveDiagnostic(userId: string, goalId: string): DiagnosticAssessment | null {
  const row = getDatabase().prepare(`
    SELECT id, goal_id, status, source, provider, min_questions, max_questions,
           answered_count, adaptive_state_json
    FROM diagnostic_assessments
    WHERE user_id = ? AND goal_id = ? AND status IN ('generated', 'in_progress', 'completed')
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, goalId) as DiagnosticRow | undefined;
  return row ? toPublicDiagnostic(row) : null;
}

export function saveDiagnostic(input: {
  userId: string;
  goalId: string;
  selfLevel: Exclude<SelfLevel, "beginner">;
  questions: DiagnosticQuestionDraft[];
  result: AgentResult<unknown>;
  minQuestions?: number;
  maxQuestions?: number;
  adaptiveState?: AdaptiveDiagnosticState;
}): DiagnosticAssessment {
  const existing = readActiveDiagnostic(input.userId, input.goalId);
  if (existing?.adaptive) return existing;
  if (existing && existing.status !== "completed") expireLegacyDiagnostic(input.userId, existing.id);
  const id = randomUUID();
  const now = new Date().toISOString();
  withTransaction((database) => {
    database.prepare(`
      INSERT INTO diagnostic_assessments (
        id, user_id, goal_id, self_level, status, question_count, min_questions,
        max_questions, answered_count, adaptive_state_json, source, provider, model, created_at
      ) VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      id, input.userId, input.goalId, input.selfLevel, input.questions.length,
      input.minQuestions || input.questions.length, input.maxQuestions || input.questions.length,
      JSON.stringify(input.adaptiveState || {}), input.result.mode, input.result.provider, input.result.model, now,
    );
    const insert = database.prepare(`
      INSERT INTO diagnostic_questions (
        id, assessment_id, skill_id, position, kind, difficulty, prompt, hint,
        reference_answer, rubric_json, max_score, generated_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.questions.forEach((question, position) => insert.run(
      randomUUID(), id, question.skillId, position, question.kind, question.difficulty,
      question.prompt, question.hint, question.referenceAnswer,
      JSON.stringify({ text: question.rubric }), question.maxScore, input.result.mode, now,
    ));
    database.prepare(`
      UPDATE goal_learning_profiles SET diagnostic_status = 'in_progress', updated_at = ?
      WHERE goal_id = ? AND user_id = ?
    `).run(now, input.goalId, input.userId);
  });
  return readActiveDiagnostic(input.userId, input.goalId)!;
}

export function readAuthoredDiagnostic(userId: string, assessmentId: string) {
  const row = getDatabase().prepare(`
    SELECT id, goal_id, status, source, provider, min_questions, max_questions,
           answered_count, adaptive_state_json
    FROM diagnostic_assessments WHERE id = ? AND user_id = ?
  `).get(assessmentId, userId) as DiagnosticRow | undefined;
  if (!row) return null;
  return {
    assessment: toPublicDiagnostic(row),
    adaptiveStateJson: row.adaptive_state_json,
    questions: readQuestionRows(row.id).map((question) => ({
      id: question.id,
      skillId: question.skill_id,
      kind: question.kind,
      difficulty: question.difficulty,
      prompt: question.prompt,
      hint: question.hint,
      referenceAnswer: question.reference_answer,
      rubric: (() => {
        try { return String((JSON.parse(question.rubric_json) as { text?: unknown }).text || ""); } catch { return ""; }
      })(),
      maxScore: question.max_score,
    })),
  };
}

export function readDiagnosticResponses(userId: string, assessmentId: string) {
  return getDatabase().prepare(`
    SELECT response.question_id, response.skill_id, response.answer, response.score,
           response.max_score, response.feedback, response.grader_mode, response.provider, response.model
    FROM diagnostic_responses AS response
    JOIN diagnostic_assessments AS assessment ON assessment.id = response.assessment_id
    WHERE response.assessment_id = ? AND response.user_id = ? AND assessment.user_id = ?
    ORDER BY response.answered_at, response.id
  `).all(assessmentId, userId, userId) as DiagnosticResponseRow[];
}

export function expireLegacyDiagnostic(userId: string, assessmentId: string) {
  getDatabase().prepare(`
    UPDATE diagnostic_assessments SET status = 'expired'
    WHERE id = ? AND user_id = ? AND adaptive_state_json = '{}'
      AND status IN ('generated', 'in_progress')
  `).run(assessmentId, userId);
}

export function appendDiagnosticQuestion(input: {
  userId: string;
  assessmentId: string;
  question: DiagnosticQuestionDraft;
  result: AgentResult<unknown>;
}) {
  const now = new Date().toISOString();
  withTransaction((database) => {
    const assessment = database.prepare(`
      SELECT id, status FROM diagnostic_assessments WHERE id = ? AND user_id = ?
    `).get(input.assessmentId, input.userId) as { id: string; status: string } | undefined;
    if (!assessment) throw new Error("找不到这次诊断。");
    if (!['generated', 'in_progress'].includes(assessment.status)) throw new Error("这次诊断不能继续出题。");
    const positionRow = database.prepare(`
      SELECT COALESCE(MAX(position), -1) + 1 AS position FROM diagnostic_questions WHERE assessment_id = ?
    `).get(input.assessmentId) as { position: number };
    database.prepare(`
      INSERT INTO diagnostic_questions (
        id, assessment_id, skill_id, position, kind, difficulty, prompt, hint,
        reference_answer, rubric_json, max_score, generated_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.assessmentId, input.question.skillId, positionRow.position,
      input.question.kind, input.question.difficulty, input.question.prompt, input.question.hint,
      input.question.referenceAnswer, JSON.stringify({ text: input.question.rubric }),
      input.question.maxScore, input.result.mode, now,
    );
    database.prepare(`
      UPDATE diagnostic_assessments SET question_count = question_count + 1,
        status = 'in_progress', started_at = COALESCE(started_at, ?)
      WHERE id = ? AND user_id = ?
    `).run(now, input.assessmentId, input.userId);
  });
}

export function recordAdaptiveResponse(input: {
  userId: string;
  assessmentId: string;
  question: DiagnosticQuestionDraft & { id: string };
  answer: string;
  score: number;
  feedback: string;
  graderMode: "llm" | "rules";
  provider: string;
  model: string;
  state: AdaptiveDiagnosticState;
}) {
  const now = new Date().toISOString();
  return withTransaction((database) => {
    const existing = database.prepare(`
      SELECT question_id, skill_id, answer, score, max_score, feedback, grader_mode, provider, model
      FROM diagnostic_responses WHERE assessment_id = ? AND question_id = ? AND user_id = ?
    `).get(input.assessmentId, input.question.id, input.userId) as DiagnosticResponseRow | undefined;
    if (existing) return existing;
    const owned = database.prepare(`
      SELECT id FROM diagnostic_assessments WHERE id = ? AND user_id = ? AND status IN ('generated', 'in_progress')
    `).get(input.assessmentId, input.userId);
    if (!owned) throw new Error("这次诊断不能继续作答。");
    database.prepare(`
      INSERT INTO diagnostic_responses (
        id, assessment_id, question_id, user_id, skill_id, answer, score, max_score,
        feedback, grader_mode, provider, model, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.assessmentId, input.question.id, input.userId, input.question.skillId,
      input.answer, input.score, input.question.maxScore, input.feedback, input.graderMode,
      input.provider, input.model, now,
    );
    database.prepare(`
      UPDATE diagnostic_assessments SET answered_count = answered_count + 1,
        adaptive_state_json = ?, status = 'in_progress', started_at = COALESCE(started_at, ?)
      WHERE id = ? AND user_id = ?
    `).run(JSON.stringify(input.state), now, input.assessmentId, input.userId);
    return {
      question_id: input.question.id,
      skill_id: input.question.skillId,
      answer: input.answer,
      score: input.score,
      max_score: input.question.maxScore,
      feedback: input.feedback,
      grader_mode: input.graderMode,
      provider: input.provider,
      model: input.model,
    } satisfies DiagnosticResponseRow;
  });
}

function diagnosticLevel(score: number): DiagnosticGrade["level"] {
  if (score >= 90) return "优";
  if (score >= 75) return "良";
  return score >= 60 ? "合格" : "不合格";
}

export function recordDiagnosticAttempt(input: {
  userId: string;
  assessmentId: string;
  answers: Record<string, string>;
  grade: { score: number; summary: string; skillScores: Record<string, number>; feedback: unknown; gradedBy: "llm" | "rules" };
  skillEvidenceCounts?: Record<string, number>;
}): DiagnosticGrade {
  const now = new Date().toISOString();
  return withTransaction((database) => {
    const row = database.prepare(`
      SELECT goal_id, status FROM diagnostic_assessments WHERE id = ? AND user_id = ?
    `).get(input.assessmentId, input.userId) as { goal_id: string; status: string } | undefined;
    if (!row) throw new Error("找不到这次诊断。");
    if (row.status === "completed") throw new Error("这次诊断已经提交，不能重复修改基线。");
    const score = Math.max(0, Math.min(100, Math.round(input.grade.score)));
    const level = diagnosticLevel(score);
    database.prepare(`
      INSERT INTO diagnostic_attempts (
        id, assessment_id, user_id, attempt_number, answers_json, score, level,
        feedback_json, skill_scores_json, passed, grader_mode, started_at, submitted_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.assessmentId, input.userId, JSON.stringify(input.answers), score,
      level === "优" ? "excellent" : level === "良" ? "good" : level === "合格" ? "qualified" : "unqualified",
      JSON.stringify(input.grade.feedback), JSON.stringify(input.grade.skillScores), score >= 60 ? 1 : 0,
      input.grade.gradedBy, now, now,
    );
    for (const [skillId, rawScore] of Object.entries(input.grade.skillScores)) {
      const skillScore = Math.max(0, Math.min(100, Math.round(rawScore)));
      const evidenceCount = Math.max(1, Math.round(input.skillEvidenceCounts?.[skillId] || 1));
      const confidence = Math.min(.9, .45 + evidenceCount * .15);
      database.prepare(`
        UPDATE skill_mastery SET mastery_score = ?, confidence = ?, evidence_count = ?,
          last_assessed_at = ?, updated_at = ? WHERE user_id = ? AND skill_id = ?
      `).run(skillScore, confidence, evidenceCount, now, now, input.userId, skillId);
    }
    database.prepare("UPDATE diagnostic_assessments SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(now, input.assessmentId);
    database.prepare(`
      UPDATE goal_learning_profiles SET diagnostic_status = 'completed', diagnostic_score = ?,
        baseline_summary = ?, updated_at = ? WHERE goal_id = ? AND user_id = ?
    `).run(score, input.grade.summary, now, row.goal_id, input.userId);
    return { score, level, summary: input.grade.summary, skillScores: input.grade.skillScores, feedback: input.grade.feedback as DiagnosticGrade["feedback"] };
  });
}

export function readDiagnosticResult(userId: string, assessmentId: string): DiagnosticGrade | null {
  const row = getDatabase().prepare(`
    SELECT attempt.score, attempt.level, attempt.feedback_json, attempt.skill_scores_json,
           profile.baseline_summary
    FROM diagnostic_attempts AS attempt
    JOIN diagnostic_assessments AS assessment ON assessment.id = attempt.assessment_id
    JOIN goal_learning_profiles AS profile ON profile.goal_id = assessment.goal_id
    WHERE attempt.assessment_id = ? AND attempt.user_id = ? AND assessment.user_id = ?
    ORDER BY attempt.attempt_number DESC LIMIT 1
  `).get(assessmentId, userId, userId) as {
    score: number; level: "unqualified" | "qualified" | "good" | "excellent";
    feedback_json: string; skill_scores_json: string; baseline_summary: string;
  } | undefined;
  if (!row) return null;
  const levels: Record<typeof row.level, DiagnosticGrade["level"]> = {
    unqualified: "不合格", qualified: "合格", good: "良", excellent: "优",
  };
  try {
    return {
      score: row.score,
      level: levels[row.level],
      summary: row.baseline_summary,
      skillScores: JSON.parse(row.skill_scores_json) as Record<string, number>,
      feedback: JSON.parse(row.feedback_json) as DiagnosticGrade["feedback"],
    };
  } catch { return null; }
}

export function readSkillMastery(userId: string, skillId: string) {
  const row = getDatabase().prepare(`
    SELECT mastery_score, confidence, evidence_count FROM skill_mastery WHERE user_id = ? AND skill_id = ?
  `).get(userId, skillId) as { mastery_score: number; confidence: number; evidence_count: number } | undefined;
  return { score: row?.mastery_score || 0, confidence: row?.confidence || 0, evidenceCount: row?.evidence_count || 0 };
}

export function recordAgentRun(input: {
  userId: string;
  goalId?: string;
  agentType: "planner" | "tutor" | "examiner" | "guard";
  nodeName: string;
  request: unknown;
  result: AgentResult<unknown>;
}) {
  const now = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO agent_runs (
      id, user_id, goal_id, agent_type, node_name, input_json, output_json, provider, model,
      prompt_tokens, completion_tokens, total_tokens, latency_ms, status, error_message, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), input.userId, input.goalId || null, input.agentType, input.nodeName,
    JSON.stringify(input.request), JSON.stringify(input.result.data), input.result.provider, input.result.model,
    input.result.usage.promptTokens, input.result.usage.completionTokens, input.result.usage.totalTokens,
    input.result.latencyMs, input.result.mode === "llm" ? "completed" : "fallback",
    input.result.fallbackReason, now, now,
  );
}
