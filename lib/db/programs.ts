import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getDatabase, withTransaction } from "@/lib/db";
import { providerLabel } from "@/lib/learning-program/service";
import type {
  AuthoredCourseLesson,
  AuthoredCourseQuestion,
  AuthoredLearningProgram,
  CourseInstructor,
  CourseLesson,
  CourseLessonGrade,
  CourseLessonGradeDraft,
  LearningProgram,
  LessonGenerationMode,
  LessonGenerationStatus,
  LessonContentOutput,
  LessonContentVersionDraft,
  LessonQualityReport,
  LessonQualityStatus,
  LessonStatus,
  SourceStatus,
} from "@/lib/learning-program/types";
import { projectLessonContent, validateQuestionGrounding } from "@/lib/learning-program/quality";

type ProgramRow = {
  id: string; goal_id: string; version: number; title: string; summary: string; cadence: string;
  outcomes_json: string; instructor_json: string; generation_mode: string; provider: string; model: string; created_at: string;
};

type LessonRow = {
  id: string; primary_skill_id: string | null; title: string; phase: string; objective: string;
  opening: string; explanation: string; example: string; practice: string; deliverable: string;
  concepts_json: string; questions_json: string; duration_minutes: number; required_score: number;
  position: number; status: LessonStatus; generation_mode: LessonGenerationMode;
  generation_status: LessonGenerationStatus; difficulty: number;
  current_content_version_id: string | null; source_status: SourceStatus; quality_status: LessonQualityStatus;
  capability_type: NonNullable<CourseLesson["capabilityType"]>;
  prerequisites_json: string;
  completion_evidence_json: string;
};

type ContentVersionRow = {
  id: string; lesson_id: string; schema_version: string; content_json: string;
  status: LessonContentVersionDraft["status"]; source_status: SourceStatus; generation_mode: string;
  provider: string; model: string; prompt_version: string; input_hash: string;
  prompt_tokens: number; completion_tokens: number; total_tokens: number; latency_ms: number;
  fallback_reason: string;
};

type QualityReportRow = {
  deterministic_passed: number; semantic_passed: number; score: number; issues_json: string;
  checker_version: string; checker_mode: "llm" | "rules"; provider: string; model: string; created_at: string;
};

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function parseInstructor(value: string): CourseInstructor {
  try {
    const parsed = JSON.parse(value) as Partial<CourseInstructor> | null;
    return { name: parsed?.name || "AI 导师", role: parsed?.role || "", style: parsed?.style || "", openingMessage: parsed?.openingMessage || "" };
  } catch { return { name: "AI 导师", role: "", style: "", openingMessage: "" }; }
}

function parseQuestions(value: string): AuthoredCourseQuestion[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as AuthoredCourseQuestion[] : [];
  } catch { return []; }
}

function parseContent(value: string): LessonContentOutput | null {
  try {
    const parsed = JSON.parse(value) as LessonContentOutput;
    return parsed?.schemaVersion === "1" && Array.isArray(parsed.blocks) ? parsed : null;
  } catch { return null; }
}

function parseQualityReport(row: QualityReportRow | undefined): LessonQualityReport | null {
  if (!row) return null;
  let issues: LessonQualityReport["issues"] = [];
  try { issues = JSON.parse(row.issues_json) as LessonQualityReport["issues"]; } catch { issues = []; }
  return {
    deterministicPassed: row.deterministic_passed === 1,
    semanticPassed: row.semantic_passed === 1,
    score: row.score,
    issues,
    checkerVersion: row.checker_version,
    checkedAt: row.created_at,
    mode: row.checker_mode,
    provider: row.provider,
    model: row.model,
  };
}

function readContentVersion(contentVersionId: string | null): LessonContentVersionDraft | null {
  if (!contentVersionId) return null;
  const database = getDatabase();
  const row = database.prepare(`
    SELECT id, lesson_id, schema_version, content_json, status, source_status, generation_mode,
           provider, model, prompt_version, input_hash, prompt_tokens, completion_tokens,
           total_tokens, latency_ms, fallback_reason
    FROM lesson_content_versions WHERE id = ?
  `).get(contentVersionId) as ContentVersionRow | undefined;
  if (!row) return null;
  const content = parseContent(row.content_json);
  if (!content) return null;
  const qualityRow = database.prepare(`
    SELECT deterministic_passed, semantic_passed, score, issues_json, checker_version,
           checker_mode, provider, model, created_at
    FROM lesson_quality_reports WHERE lesson_content_version_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(contentVersionId) as QualityReportRow | undefined;
  const qualityReport = parseQualityReport(qualityRow);
  if (!qualityReport) return null;
  return {
    content,
    status: row.status,
    qualityReport,
    generation: {
      mode: row.generation_mode === "llm" || row.generation_mode === "repaired" ? "llm" : "rules",
      provider: row.provider,
      model: row.model,
      promptVersion: row.prompt_version,
      inputHash: row.input_hash,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      latencyMs: row.latency_ms,
      fallbackReason: row.fallback_reason,
    },
  };
}

function toAuthoredLesson(row: LessonRow): AuthoredCourseLesson {
  const contentVersion = readContentVersion(row.current_content_version_id);
  return {
    id: row.id, order: row.position + 1, phase: row.phase, title: row.title,
    durationMinutes: row.duration_minutes, objective: row.objective, concepts: parseList(row.concepts_json),
    opening: row.opening, explanation: row.explanation, example: row.example, practice: row.practice,
    deliverable: row.deliverable, requiredScore: row.required_score, status: row.status,
    primarySkillId: row.primary_skill_id || "", difficulty: row.difficulty,
    generationStatus: row.generation_status, generationMode: row.generation_mode,
    capabilityType: contentVersion?.content.capabilityType || row.capability_type,
    prerequisites: parseList(row.prerequisites_json),
    completionEvidence: contentVersion?.content.evidenceRequirements.map((item) => item.description) || parseList(row.completion_evidence_json),
    blocks: contentVersion?.content.blocks || [],
    contentVersionId: contentVersion?.content.contentVersionId,
    sourceStatus: contentVersion?.content.sourceStatus || row.source_status,
    qualityStatus: row.quality_status,
    legacyContent: !contentVersion && row.generation_status === "ready",
    questions: parseQuestions(row.questions_json),
    contentVersion,
  };
}

function toPublicLesson(lesson: AuthoredCourseLesson): CourseLesson {
  const { contentVersion: _contentVersion, contentVersions: _contentVersions, ...publicLesson } = lesson;
  void _contentVersion;
  void _contentVersions;
  return {
    ...publicLesson,
    questions: lesson.questions.map(({ id, skillId, kind, contentVersionId, taughtBlockIds, evidenceType, expectedConcepts, prompt, hint, maxScore }) => ({
      id, skillId, kind, contentVersionId, taughtBlockIds, evidenceType, expectedConcepts, prompt, hint, maxScore,
    })),
  };
}

function toPublicProgram(row: ProgramRow, lessons: AuthoredCourseLesson[]): LearningProgram {
  return {
    programId: row.id, goalId: row.goal_id, version: row.version, title: row.title, summary: row.summary,
    outcomes: parseList(row.outcomes_json), cadence: row.cadence, instructor: parseInstructor(row.instructor_json),
    lessons: lessons.map(toPublicLesson), mode: row.generation_mode === "llm" ? "llm" : "rules",
    provider: providerLabel(row.provider, row.model), createdAt: row.created_at,
  };
}

const PROGRAM_COLUMNS = `id, goal_id, version, title, summary, cadence, outcomes_json, instructor_json, generation_mode, provider, model, created_at`;
const LESSON_COLUMNS = `
  id, primary_skill_id, title, phase, objective, opening, explanation, example, practice, deliverable,
  concepts_json, questions_json, duration_minutes, required_score, position, status,
  generation_mode, generation_status, difficulty
  , current_content_version_id, source_status, quality_status, capability_type, prerequisites_json, completion_evidence_json
`;

function persistContentVersions(database: DatabaseSync, lessonId: string, versions: LessonContentVersionDraft[]) {
  if (!versions.length) return null;
  const existing = database.prepare("SELECT COALESCE(MAX(version), 0) AS max_version FROM lesson_content_versions WHERE lesson_id = ?").get(lessonId) as { max_version: number };
  const now = new Date().toISOString();
  versions.forEach((draft, index) => {
    const content = { ...draft.content, lessonId };
    const version = Number(existing.max_version) + index + 1;
    database.prepare(`
      INSERT INTO lesson_content_versions (
        id, lesson_id, version, schema_version, content_json, status, source_status,
        generation_mode, provider, model, prompt_version, input_hash, prompt_tokens,
        completion_tokens, total_tokens, latency_ms, fallback_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      content.contentVersionId, lessonId, version, content.schemaVersion, JSON.stringify(content), draft.status,
      content.sourceStatus, index === 0 ? draft.generation.mode : "repaired", draft.generation.provider,
      draft.generation.model, draft.generation.promptVersion, draft.generation.inputHash,
      draft.generation.promptTokens, draft.generation.completionTokens, draft.generation.totalTokens,
      draft.generation.latencyMs, draft.generation.fallbackReason, now,
    );
    database.prepare(`
      INSERT INTO lesson_quality_reports (
        id, lesson_content_version_id, deterministic_passed, semantic_passed, score, issues_json,
        checker_version, checker_mode, provider, model, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), content.contentVersionId, draft.qualityReport.deterministicPassed ? 1 : 0,
      draft.qualityReport.semanticPassed ? 1 : 0, draft.qualityReport.score,
      JSON.stringify(draft.qualityReport.issues), draft.qualityReport.checkerVersion,
      draft.qualityReport.mode, draft.qualityReport.provider, draft.qualityReport.model,
      draft.qualityReport.checkedAt || now,
    );
    for (const block of content.blocks) {
      for (const sourceRef of content.sourceRefs) {
        database.prepare(`
          INSERT OR IGNORE INTO lesson_block_sources (
            lesson_content_version_id, block_id, source_ref, source_snapshot_hash, support_type, created_at
          ) VALUES (?, ?, ?, '', 'supports', ?)
        `).run(content.contentVersionId, block.id, sourceRef, now);
      }
    }
  });
  return versions.at(-1)!;
}

function readLessonRows(programId: string): AuthoredCourseLesson[] {
  const rows = getDatabase().prepare(`SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE program_id = ? ORDER BY position`).all(programId) as LessonRow[];
  return rows.map(toAuthoredLesson);
}

/** 保存课程骨架。首节可以 ready，其余章节只保存结构和 planned 状态。 */
export function saveLearningProgram(input: { userId: string; goalId: string; program: AuthoredLearningProgram }): LearningProgram {
  const { userId, goalId, program } = input;
  const now = new Date().toISOString();
  return withTransaction((database) => {
    const owned = database.prepare("SELECT id FROM goals WHERE id = ? AND user_id = ?").get(goalId, userId);
    if (!owned) throw new Error("找不到这个目标，无法保存课程。");
    const existing = database.prepare(`
      SELECT ${PROGRAM_COLUMNS} FROM learning_programs WHERE goal_id = ? AND user_id = ? AND status = 'active'
      ORDER BY version DESC LIMIT 1
    `).get(goalId, userId) as ProgramRow | undefined;
    if (existing) {
      const lessonRows = database.prepare(`SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE program_id = ? ORDER BY position`).all(existing.id) as LessonRow[];
      return toPublicProgram(existing, lessonRows.map(toAuthoredLesson));
    }

    const versionRow = database.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM learning_programs WHERE goal_id = ?").get(goalId) as { next_version: number };
    const version = Number(versionRow.next_version) || 1;
    const persistedMode = program.mode === "llm" ? "llm" : "demo";
    database.prepare(`
      INSERT INTO learning_programs (
        id, user_id, goal_id, version, title, summary, cadence, outcomes_json,
        instructor_json, status, generation_mode, provider, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(program.programId, userId, goalId, version, program.title, program.summary, program.cadence,
      JSON.stringify(program.outcomes), JSON.stringify(program.instructor), persistedMode, program.provider, program.model, now, now);

    const phases = [...new Set(program.lessons.map((lesson) => lesson.phase || "课程"))];
    const moduleIds = new Map<string, string>();
    const insertModule = database.prepare(`
      INSERT INTO course_modules (id, program_id, title, objective, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    phases.forEach((phase, index) => {
      const moduleId = randomUUID();
      insertModule.run(moduleId, program.programId, phase, program.lessons.find((lesson) => (lesson.phase || "课程") === phase)?.objective || "", index, now, now);
      moduleIds.set(phase, moduleId);
    });

    const insertLesson = database.prepare(`
      INSERT INTO course_lessons (
        id, program_id, module_id, primary_skill_id, title, phase, objective, opening, explanation, example,
        practice, deliverable, concepts_json, questions_json, duration_minutes, required_score, position,
        status, generation_mode, generation_status, difficulty, current_content_version_id,
        source_status, quality_status, capability_type, prerequisites_json, completion_evidence_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `);
    program.lessons.forEach((lesson, index) => {
      insertLesson.run(
        lesson.id, program.programId, moduleIds.get(lesson.phase || "课程") ?? null, lesson.primarySkillId || null,
        lesson.title, lesson.phase, lesson.objective, lesson.opening, lesson.explanation, lesson.example,
        lesson.practice, lesson.deliverable, JSON.stringify(lesson.concepts), JSON.stringify(lesson.questions),
        lesson.durationMinutes, lesson.requiredScore, index, lesson.status, lesson.generationMode,
        lesson.generationStatus, lesson.difficulty, lesson.sourceStatus || "unverified",
        lesson.qualityStatus || (lesson.generationStatus === "ready" ? "legacy" : "pending"),
        lesson.capabilityType || "conceptual_understanding", JSON.stringify(lesson.prerequisites || []),
        JSON.stringify(lesson.completionEvidence || []), now, now,
      );
      const versions = lesson.contentVersions?.length
        ? lesson.contentVersions
        : lesson.contentVersion
          ? [lesson.contentVersion]
          : [];
      const current = persistContentVersions(database, lesson.id, versions);
      if (current) {
        database.prepare(`
          UPDATE course_lessons SET current_content_version_id = ?, source_status = ?, quality_status = ?, updated_at = ?
          WHERE id = ?
        `).run(
          current.content.contentVersionId,
          current.content.sourceStatus,
          current.status === "ready" ? "passed" : "failed",
          now,
          lesson.id,
        );
      }
    });
    const row = database.prepare(`SELECT ${PROGRAM_COLUMNS} FROM learning_programs WHERE id = ?`).get(program.programId) as ProgramRow;
    const lessons = (database.prepare(`SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE program_id = ? ORDER BY position`).all(program.programId) as LessonRow[]).map(toAuthoredLesson);
    return toPublicProgram(row, lessons);
  });
}

export function readLearningProgram(userId: string, programId?: string): LearningProgram | null {
  const database = getDatabase();
  const row = programId
    ? database.prepare(`SELECT ${PROGRAM_COLUMNS} FROM learning_programs WHERE id = ? AND user_id = ?`).get(programId, userId) as ProgramRow | undefined
    : database.prepare(`SELECT ${PROGRAM_COLUMNS} FROM learning_programs WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(userId) as ProgramRow | undefined;
  return row ? toPublicProgram(row, readLessonRows(row.id)) : null;
}

export function readLearningProgramForGoal(userId: string, goalId: string): LearningProgram | null {
  const row = getDatabase().prepare(`
    SELECT ${PROGRAM_COLUMNS} FROM learning_programs
    WHERE user_id = ? AND goal_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1
  `).get(userId, goalId) as ProgramRow | undefined;
  return row ? toPublicProgram(row, readLessonRows(row.id)) : null;
}

export function readAuthoredLesson(userId: string, programId: string, lessonId: string): { program: LearningProgram; lesson: AuthoredCourseLesson } | null {
  const row = getDatabase().prepare(`SELECT ${PROGRAM_COLUMNS} FROM learning_programs WHERE id = ? AND user_id = ?`).get(programId, userId) as ProgramRow | undefined;
  if (!row) return null;
  const lessons = readLessonRows(row.id);
  const lesson = lessons.find((item) => item.id === lessonId);
  return lesson ? { program: toPublicProgram(row, lessons), lesson } : null;
}

export function readOwnedLesson(userId: string, lessonId: string): { programId: string; lesson: AuthoredCourseLesson } | null {
  const database = getDatabase();
  const link = database.prepare(`
    SELECT lesson.program_id FROM course_lessons AS lesson
    JOIN learning_programs AS program ON program.id = lesson.program_id
    WHERE lesson.id = ? AND program.user_id = ?
  `).get(lessonId, userId) as { program_id: string } | undefined;
  if (!link) return null;
  const row = database.prepare(`SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE id = ?`).get(lessonId) as LessonRow;
  return { programId: link.program_id, lesson: toAuthoredLesson(row) };
}

export function materializeLesson(input: {
  userId: string; programId: string; lessonId: string;
  contentVersions: LessonContentVersionDraft[];
  questions: AuthoredCourseQuestion[];
  mode: "llm" | "rules";
  difficulty?: number;
}): LearningProgram {
  const now = new Date().toISOString();
  withTransaction((database) => {
    const owned = database.prepare(`
      SELECT lesson.id, lesson.generation_status FROM course_lessons AS lesson
      JOIN learning_programs AS program ON program.id = lesson.program_id
      WHERE lesson.id = ? AND lesson.program_id = ? AND program.user_id = ?
    `).get(input.lessonId, input.programId, input.userId) as { id: string; generation_status: string } | undefined;
    if (!owned) throw new Error("找不到要生成的课程章节。");
    if (owned.generation_status === "ready") return;
    const current = input.contentVersions.at(-1);
    if (!current) throw new Error("课程生成没有产生可保存的内容版本。");
    const material = projectLessonContent(current.content);
    persistContentVersions(database, input.lessonId, input.contentVersions);
    const ready = current.status === "ready";
    database.prepare(`
      UPDATE course_lessons SET opening = ?, explanation = ?, example = ?, practice = ?, deliverable = ?,
        concepts_json = ?, questions_json = ?, generation_mode = ?, generation_status = ?, difficulty = ?,
        current_content_version_id = ?, source_status = ?, quality_status = ?, updated_at = ?
      WHERE id = ?
    `).run(material.opening, material.explanation, material.example, material.practice,
      material.deliverable, JSON.stringify(material.concepts), JSON.stringify(ready ? input.questions : []),
      input.mode === "llm" ? "llm" : "demo", ready ? "ready" : "failed",
      Math.max(1, Math.min(5, Math.round(input.difficulty || 3))), current.content.contentVersionId,
      current.content.sourceStatus, ready ? "passed" : "failed", now, input.lessonId);
  });
  return readLearningProgram(input.userId, input.programId)!;
}

function gradeLevel(score: number, requiredScore: number): CourseLessonGrade["level"] {
  if (score >= 90) return "优";
  if (score >= 75) return "良";
  return score >= requiredScore ? "合格" : "不合格";
}
const DB_LEVEL: Record<CourseLessonGrade["level"], string> = { 不合格: "unqualified", 合格: "qualified", 良: "good", 优: "excellent" };

/** 权威闭环事务：评分证据、掌握度、章节、关联任务、目标进度和下一课一起更新。 */
export function recordLessonAttempt(input: { userId: string; lesson: AuthoredCourseLesson; answers: Record<string, string>; grade: CourseLessonGradeDraft }): CourseLessonGrade {
  const { userId, lesson, answers, grade } = input;
  if (lesson.generationStatus !== "ready") throw new Error("这节课还没有生成，不能提交评测。");
  if (!lesson.legacyContent) {
    if (lesson.qualityStatus !== "passed" || !lesson.contentVersion) throw new Error("这节课还没有通过教学质量门禁，不能提交评测。");
    const groundingIssues = validateQuestionGrounding(lesson.contentVersion.content, lesson.questions);
    if (groundingIssues.length) throw new Error(`课后题与教学内容不一致：${groundingIssues.join("、")}`);
  }
  const score = Math.max(0, Math.min(100, Math.round(grade.score)));
  const level = gradeLevel(score, lesson.requiredScore);
  const passed = score >= lesson.requiredScore;
  const now = new Date().toISOString();
  return withTransaction((database) => {
    const owned = database.prepare(`
      SELECT lesson.program_id, lesson.position FROM course_lessons AS lesson
      JOIN learning_programs AS program ON program.id = lesson.program_id
      WHERE lesson.id = ? AND program.user_id = ?
    `).get(lesson.id, userId) as { program_id: string; position: number } | undefined;
    if (!owned) throw new Error("找不到要评分的课程章节。");
    const attemptRow = database.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt FROM lesson_assessment_attempts WHERE lesson_id = ? AND user_id = ?").get(lesson.id, userId) as { next_attempt: number };
    const attemptNumber = Number(attemptRow.next_attempt) || 1;
    const skillScores = lesson.primarySkillId ? { [lesson.primarySkillId]: score } : {};
    database.prepare(`
      INSERT INTO lesson_assessment_attempts (
        id, lesson_id, user_id, attempt_number, answers_json, score, level, feedback_json,
        skill_scores_json, passed, grader_mode, provider, model, content_version_id, questions_json,
        created_at, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), lesson.id, userId, attemptNumber, JSON.stringify(answers), score, DB_LEVEL[level],
      JSON.stringify({ summary: grade.summary, nextStep: grade.nextStep, feedback: grade.feedback }), JSON.stringify(skillScores),
      passed ? 1 : 0, grade.gradedBy, grade.provider, grade.model, lesson.contentVersionId || null,
      JSON.stringify(lesson.questions), now, now);

    let mastery: CourseLessonGrade["mastery"];
    if (lesson.primarySkillId) {
      const current = database.prepare(`SELECT mastery_score, confidence, evidence_count FROM skill_mastery WHERE user_id = ? AND skill_id = ?`)
        .get(userId, lesson.primarySkillId) as { mastery_score: number; confidence: number; evidence_count: number } | undefined;
      if (current) {
        const evidenceCount = current.evidence_count + 1;
        const nextScore = current.confidence === 0 ? score : Math.round(current.mastery_score * 0.6 + score * 0.4);
        const confidence = Math.min(0.95, Math.max(current.confidence, 0.45) + 0.12);
        database.prepare(`
          UPDATE skill_mastery SET mastery_score = ?, confidence = ?, evidence_count = ?, last_assessed_at = ?, updated_at = ?
          WHERE user_id = ? AND skill_id = ?
        `).run(nextScore, confidence, evidenceCount, now, now, userId, lesson.primarySkillId);
        mastery = { skillId: lesson.primarySkillId, score: nextScore, confidence, evidenceCount };
      }
    }

    let nextLessonId: string | undefined;
    if (passed) {
      database.prepare("UPDATE course_lessons SET status = 'passed', updated_at = ? WHERE id = ?").run(now, lesson.id);
      database.prepare(`
        UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?
        WHERE id IN (SELECT task_id FROM task_lesson_links WHERE lesson_id = ?) AND user_id = ?
      `).run(now, now, lesson.id, userId);
      const next = database.prepare(`
        SELECT id FROM course_lessons WHERE program_id = ? AND position > ? AND status != 'archived'
        ORDER BY position LIMIT 1
      `).get(owned.program_id, owned.position) as { id: string } | undefined;
      if (next) {
        nextLessonId = next.id;
        database.prepare("UPDATE course_lessons SET status = 'available', updated_at = ? WHERE id = ? AND status = 'locked'").run(now, next.id);
      }
      const progress = database.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed
        FROM course_lessons WHERE program_id = ? AND status != 'archived'
      `).get(owned.program_id) as { total: number; passed: number };
      database.prepare(`
        UPDATE goals SET progress_percent = ?, progress_source = 'system', progress_updated_at = ?, updated_at = ?
        WHERE id = (SELECT goal_id FROM learning_programs WHERE id = ?) AND user_id = ?
      `).run(Math.round((progress.passed || 0) / Math.max(1, progress.total) * 100), now, now, owned.program_id, userId);
    }
    return { ...grade, score, level, passed, attemptNumber, provider: providerLabel(grade.provider, grade.model), mastery, nextLessonId };
  });
}
