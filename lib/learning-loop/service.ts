import { randomUUID } from "node:crypto";

import { buildAdaptiveQuestion } from "@/lib/agents/examiner";
import { buildCourseOutline, buildSkillMap } from "@/lib/agents/planner";
import { buildLessonCheck, buildLessonMaterial } from "@/lib/agents/tutor";
import type { GoalContext } from "@/lib/agents/types";
import { readGoalWithProfile } from "@/lib/db/goals";
import {
  ensureGoalSkills,
  expireLegacyDiagnostic,
  readActiveDiagnostic,
  readGoalSkills,
  readSkillMastery,
  recordAgentRun,
  saveDiagnostic,
} from "@/lib/db/learning-loop";
import { createAdaptiveState, selectAdaptiveTarget } from "@/lib/learning-loop/adaptive";
import {
  materializeLesson,
  readAuthoredLesson,
  readLearningProgramForGoal,
  saveLearningProgram,
} from "@/lib/db/programs";
import type { AuthoredLearningProgram, GoalPreparation, LearningProgram } from "@/lib/learning-program/types";

export type LearningPreparationStage =
  | "load_goal"
  | "skill_map"
  | "diagnostic"
  | "course_outline"
  | "lesson_material"
  | "lesson_check"
  | "persist";

export type LearningPreparationProgress = {
  stage: LearningPreparationStage;
  percent: number;
  message: string;
};

export type LearningPreparationReporter = (progress: LearningPreparationProgress) => void | Promise<void>;

async function reportProgress(reporter: LearningPreparationReporter | undefined, progress: LearningPreparationProgress) {
  await reporter?.(progress);
}

function asGoalContext(goal: NonNullable<ReturnType<typeof readGoalWithProfile>>): GoalContext {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description || `完成「${goal.title}」并留下可验证成果。`,
    background: goal.background,
    selfLevel: goal.selfLevel,
    weeklyHours: goal.weeklyHours,
  };
}

async function ensureSkills(userId: string, goal: GoalContext, reporter?: LearningPreparationReporter) {
  const existing = readGoalSkills(userId, goal.id);
  if (existing.length) {
    await reportProgress(reporter, {
      stage: "skill_map",
      percent: 24,
      message: `已读取现有能力地图，共 ${existing.length} 项能力`,
    });
    return existing;
  }
  await reportProgress(reporter, {
    stage: "skill_map",
    percent: 12,
    message: "Planner 正在把目标拆成可评测能力",
  });
  const result = await buildSkillMap(goal);
  recordAgentRun({ userId, goalId: goal.id, agentType: "planner", nodeName: "build_skill_map", request: goal, result });
  const skills = ensureGoalSkills(userId, goal.id, result.data);
  await reportProgress(reporter, {
    stage: "skill_map",
    percent: 28,
    message: `能力地图已保存，共 ${skills.length} 项能力`,
  });
  return skills;
}

export async function generateCourseForGoal(
  userId: string,
  goalId: string,
  lessonCount = 5,
  reporter?: LearningPreparationReporter,
): Promise<LearningProgram> {
  const existing = readLearningProgramForGoal(userId, goalId);
  if (existing) {
    await reportProgress(reporter, { stage: "persist", percent: 100, message: "已有课程已恢复，可以继续学习" });
    return existing;
  }
  const storedGoal = readGoalWithProfile(userId, goalId);
  if (!storedGoal) throw new Error("找不到这个目标。");
  if (storedGoal.diagnosticRequired && storedGoal.diagnosticStatus !== "completed") {
    throw new Error("请先完成初始诊断，再生成课程。");
  }
  const goal = asGoalContext(storedGoal);
  const storedSkills = readGoalSkills(userId, goal.id);
  const skills = storedSkills.length ? storedSkills : await ensureSkills(userId, goal, reporter);
  await reportProgress(reporter, {
    stage: "course_outline",
    percent: 38,
    message: "Planner 正在编排完整课程路线",
  });
  const outlineResult = await buildCourseOutline(goal, skills, lessonCount);
  recordAgentRun({ userId, goalId, agentType: "planner", nodeName: "build_course_outline", request: { goal, skills }, result: outlineResult });
  await reportProgress(reporter, {
    stage: "course_outline",
    percent: 54,
    message: `课程骨架已生成，共 ${outlineResult.data.lessons.length} 节`,
  });

  const firstOutline = outlineResult.data.lessons[0];
  const firstSkill = skills.find((skill) => skill.id === firstOutline.skillId) || skills[0];
  const firstInput = { goal, skill: firstSkill, lesson: firstOutline, mastery: readSkillMastery(userId, firstSkill.id) };
  await reportProgress(reporter, {
    stage: "lesson_material",
    percent: 62,
    message: "Tutor 正在生成第一节课程正文",
  });
  const materialResult = await buildLessonMaterial(firstInput);
  recordAgentRun({ userId, goalId, agentType: "tutor", nodeName: "materialize_first_lesson", request: firstInput, result: materialResult });
  await reportProgress(reporter, {
    stage: "lesson_material",
    percent: 74,
    message: "第一节课程正文已生成",
  });
  await reportProgress(reporter, {
    stage: "lesson_check",
    percent: 80,
    message: "Tutor 正在生成首课巩固题和评分标准",
  });
  const checkResult = await buildLessonCheck({ ...firstInput, material: materialResult.data });
  recordAgentRun({ userId, goalId, agentType: "tutor", nodeName: "build_first_lesson_check", request: { ...firstInput, material: materialResult.data }, result: checkResult });
  await reportProgress(reporter, {
    stage: "lesson_check",
    percent: 90,
    message: `首课考核已生成，共 ${checkResult.data.length} 道题`,
  });

  const sourceModes = [outlineResult.mode, materialResult.mode, checkResult.mode];
  const program: AuthoredLearningProgram = {
    programId: randomUUID(),
    title: outlineResult.data.title,
    summary: outlineResult.data.summary,
    outcomes: outlineResult.data.outcomes,
    cadence: outlineResult.data.cadence,
    instructor: outlineResult.data.instructor,
    mode: sourceModes.every((mode) => mode === "llm") ? "llm" : sourceModes.every((mode) => mode === "rules") ? "rules" : "mixed",
    provider: sourceModes.every((mode) => mode === "llm") ? outlineResult.provider : "混合编排",
    model: sourceModes.every((mode) => mode === "llm") ? outlineResult.model : "",
    lessons: outlineResult.data.lessons.map((lesson, index) => ({
      id: randomUUID(),
      order: index + 1,
      phase: lesson.phase,
      title: lesson.title,
      durationMinutes: lesson.durationMinutes,
      objective: lesson.objective,
      concepts: index === 0 ? materialResult.data.concepts : lesson.concepts,
      opening: index === 0 ? materialResult.data.opening : "",
      explanation: index === 0 ? materialResult.data.explanation : "",
      example: index === 0 ? materialResult.data.example : "",
      practice: index === 0 ? materialResult.data.practice : "",
      deliverable: index === 0 ? materialResult.data.deliverable : "通过前一节评测后生成本节交付物。",
      requiredScore: 60,
      status: index === 0 ? "available" : "locked",
      primarySkillId: lesson.skillId,
      difficulty: lesson.difficulty,
      generationStatus: index === 0 ? "ready" : "planned",
      generationMode: index === 0 ? (materialResult.mode === "llm" && checkResult.mode === "llm" ? "llm" : "demo") : "demo",
      questions: index === 0 ? checkResult.data : [],
    })),
  };
  await reportProgress(reporter, { stage: "persist", percent: 95, message: "正在保存课程、课节和任务关联" });
  const saved = saveLearningProgram({ userId, goalId, program });
  await reportProgress(reporter, { stage: "persist", percent: 100, message: "学习路径已准备完成" });
  return saved;
}

export async function prepareGoalLoop(
  userId: string,
  goalId: string,
  reporter?: LearningPreparationReporter,
): Promise<GoalPreparation> {
  await reportProgress(reporter, { stage: "load_goal", percent: 4, message: "正在读取目标和学习偏好" });
  const storedGoal = readGoalWithProfile(userId, goalId);
  if (!storedGoal) throw new Error("找不到这个目标。");
  const goal = asGoalContext(storedGoal);
  const skills = await ensureSkills(userId, goal, reporter);
  if (storedGoal.diagnosticRequired && storedGoal.diagnosticStatus !== "completed") {
    const existing = readActiveDiagnostic(userId, goalId);
    if (existing?.adaptive) {
      await reportProgress(reporter, { stage: "diagnostic", percent: 100, message: "已有初始诊断已恢复，等待作答" });
      return { nextAction: "diagnostic", diagnostic: existing };
    }
    if (existing && existing.status !== "completed") expireLegacyDiagnostic(userId, existing.id);
    if (goal.selfLevel === "beginner") throw new Error("初学者目标不应进入诊断分支。");
    const examinerGoal = { title: goal.title, description: goal.description };
  const blueprint = goal.selfLevel === "intermediate"
    ? { minQuestions: 6, maxQuestions: 12, baseDifficulty: 3 }
    : { minQuestions: 5, maxQuestions: 10, baseDifficulty: 2 };
    const adaptiveState = createAdaptiveState(skills, blueprint.baseDifficulty);
    const firstTarget = selectAdaptiveTarget({
      skills,
      state: adaptiveState,
      answeredCount: 0,
      minQuestions: blueprint.minQuestions,
      maxQuestions: blueprint.maxQuestions,
    });
    if (!firstTarget) throw new Error("目标没有可用于诊断的能力点。");
    await reportProgress(reporter, {
      stage: "diagnostic",
      percent: 42,
      message: `Examiner 正在为「${firstTarget.skill.name}」生成首道具体诊断题`,
    });
    const result = await buildAdaptiveQuestion({
      goal: examinerGoal,
      skill: firstTarget.skill,
      difficulty: firstTarget.difficulty,
    });
    recordAgentRun({ userId, goalId, agentType: "examiner", nodeName: "build_adaptive_initial_question", request: { goal: examinerGoal, skills, blueprint, firstTarget }, result });
    await reportProgress(reporter, {
      stage: "diagnostic",
      percent: 84,
      message: "首道具体题已生成，正在固定答案和评分标准",
    });
    await reportProgress(reporter, { stage: "persist", percent: 94, message: "正在保存诊断快照" });
    const diagnostic = saveDiagnostic({
      userId,
      goalId,
      selfLevel: goal.selfLevel,
      questions: [result.data],
      result,
      minQuestions: blueprint.minQuestions,
      maxQuestions: blueprint.maxQuestions,
      adaptiveState,
    });
    await reportProgress(reporter, { stage: "persist", percent: 100, message: "初始诊断已准备完成" });
    return { nextAction: "diagnostic", diagnostic };
  }
  await reportProgress(reporter, { stage: "course_outline", percent: 32, message: "学习基线已确认，开始编排课程" });
  return { nextAction: "course", program: await generateCourseForGoal(userId, goalId, 5, reporter) };
}

export async function materializeNextLesson(userId: string, programId: string, lessonId: string, previousLessonScore?: number) {
  const found = readAuthoredLesson(userId, programId, lessonId);
  if (!found) throw new Error("找不到下一节课程。");
  if (found.lesson.generationStatus === "ready") return found.program;
  const storedGoal = readGoalWithProfile(userId, found.program.goalId);
  if (!storedGoal) throw new Error("找不到课程对应的目标。");
  const goal = asGoalContext(storedGoal);
  const skills = readGoalSkills(userId, goal.id);
  const skill = skills.find((item) => item.id === found.lesson.primarySkillId);
  if (!skill) throw new Error("下一节课程缺少能力点。");
  const mastery = readSkillMastery(userId, skill.id);
  const policyScore = Number.isFinite(previousLessonScore) ? Number(previousLessonScore) : mastery.score;
  const adjustedDifficulty = mastery.confidence === 0 && !Number.isFinite(previousLessonScore)
    ? found.lesson.difficulty
    : policyScore < 40
      ? Math.max(1, found.lesson.difficulty - 1)
      : policyScore >= 75
        ? Math.min(5, found.lesson.difficulty + 1)
        : found.lesson.difficulty;
  const outlineLesson = {
    title: found.lesson.title,
    phase: found.lesson.phase,
    objective: found.lesson.objective,
    concepts: found.lesson.concepts,
    durationMinutes: found.lesson.durationMinutes,
    skillId: skill.id,
    difficulty: adjustedDifficulty,
  };
  const base = { goal, skill, lesson: outlineLesson, mastery };
  const materialResult = await buildLessonMaterial(base);
  recordAgentRun({ userId, goalId: goal.id, agentType: "tutor", nodeName: "materialize_next_lesson", request: base, result: materialResult });
  const checkResult = await buildLessonCheck({ ...base, material: materialResult.data });
  recordAgentRun({ userId, goalId: goal.id, agentType: "tutor", nodeName: "build_next_lesson_check", request: { ...base, material: materialResult.data }, result: checkResult });
  return materializeLesson({
    userId, programId, lessonId, material: materialResult.data, questions: checkResult.data,
    mode: materialResult.mode === "llm" && checkResult.mode === "llm" ? "llm" : "rules",
    difficulty: adjustedDifficulty,
  });
}
