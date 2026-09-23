import { createHash, randomUUID } from "node:crypto";

import { buildAdaptiveQuestion } from "@/lib/agents/examiner";
import { buildCourseOutline, buildSkillMap } from "@/lib/agents/planner";
import { buildLessonCheck, buildLessonMaterial, repairLessonMaterial, reviewLessonSemantics } from "@/lib/agents/tutor";
import type { GoalContext } from "@/lib/agents/types";
import { readGoalWithProfile } from "@/lib/db/goals";
import { readTutorEvidence } from "@/lib/db/retrieval";
import { resolveTutorKnowledge } from "@/lib/knowledge/resolve-knowledge";
import { attachLessonSources, checkLessonSources } from "@/lib/learning-program/grounding";
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
  readLearningProgram,
  readLearningProgramForGoal,
  saveLearningProgram,
} from "@/lib/db/programs";
import {
  buildLessonQualityReport,
  LESSON_PROMPT_VERSION,
  MAX_LESSON_REPAIR_ATTEMPTS,
  projectLessonContent,
  qualityPassed,
} from "@/lib/learning-program/quality";
import type {
  AgentResult,
} from "@/lib/agents/shared";
import type {
  AuthoredCourseQuestion,
  AuthoredLearningProgram,
  GoalPreparation,
  LearningProgram,
  LessonContentOutput,
  LessonContentVersionDraft,
} from "@/lib/learning-program/types";

export type LearningPreparationStage =
  | "load_goal"
  | "sources"
  | "skill_map"
  | "diagnostic"
  | "course_outline"
  | "lesson_material"
  | "lesson_quality"
  | "lesson_repair"
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
    targetDate: goal.targetDate,
  };
}

function contentInputHash(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function asContentVersion(
  contentResult: AgentResult<LessonContentOutput>,
  content: LessonContentOutput,
  qualityReport: LessonContentVersionDraft["qualityReport"],
): LessonContentVersionDraft {
  return {
    content,
    status: qualityPassed(qualityReport) ? "ready" : "quality_failed",
    qualityReport,
    generation: {
      mode: contentResult.mode,
      provider: contentResult.provider,
      model: contentResult.model,
      promptVersion: LESSON_PROMPT_VERSION,
      inputHash: "",
      promptTokens: contentResult.usage.promptTokens,
      completionTokens: contentResult.usage.completionTokens,
      totalTokens: contentResult.usage.totalTokens,
      latencyMs: contentResult.latencyMs,
      fallbackReason: contentResult.fallbackReason,
    },
  };
}

async function buildQualityCheckedLesson(input: {
  userId: string;
  goalId: string;
  lessonId: string;
  tutorInput: Parameters<typeof buildLessonMaterial>[0];
  reporter?: LearningPreparationReporter;
  progressBase?: number;
  resumeVersion?: LessonContentVersionDraft;
}): Promise<{ versions: LessonContentVersionDraft[]; questions: AuthoredCourseQuestion[]; mode: "llm" | "rules" }> {
  if (input.resumeVersion) {
    const retrievalId = input.resumeVersion.content.retrievalRunId;
    const evidence = retrievalId ? readTutorEvidence(input.userId, input.goalId, retrievalId) : undefined;
    if (retrievalId && !evidence) throw new Error('原课程引用资料已不可用，请重新生成课程后复核。');
    input.tutorInput = { ...input.tutorInput, groundedContext: evidence };
  } else {
    const query = `${input.tutorInput.lesson.title} ${input.tutorInput.lesson.objective} ${input.tutorInput.lesson.concepts.join(" ")}`;
    const report = (message: string) => {
      const round=Number(message.match(/知识补充 (\d)\/3/)?.[1] || 0);
      const phase=/验证仍不足|证据已充分/.test(message)?4:/重新 RAG/.test(message)?3:/向量|切片/.test(message)?2:/正文/.test(message)?1:0;
      return reportProgress(input.reporter, { stage: "sources", percent: round ? 63+(round-1)*5+phase : 63, message });
    };
    const evidence = await resolveTutorKnowledge({
      userId: input.userId, goalId: input.goalId, actionKey: `lesson:${input.lessonId}`,
      action: { message: query, generatingLesson: true, lessonScope: {title:input.tutorInput.lesson.title,objective:input.tutorInput.lesson.objective} }, report,
    });
    if (evidence?.status === "sufficient") {
      input.tutorInput = { ...input.tutorInput, groundedContext: readTutorEvidence(input.userId, input.goalId, evidence.retrievalRunId) };
    } else input.tutorInput = {...input.tutorInput,groundedContext:undefined};
  }
  const context = input.tutorInput.groundedContext;
  await reportProgress(input.reporter, { stage: "lesson_material", percent: 35, message: input.resumeVersion ? '保留已有正文，仅重试语义复核；通过后再出题。' : "资料决策已完成，导师正在生成本节正文" });
  const versions: LessonContentVersionDraft[] = [];
  const inputHash = contentInputHash(input.tutorInput);
  const onValidationRepair = async (issues:string[]) => reportProgress(input.reporter,{
    stage:'lesson_material',percent:79,message:`课程格式有 ${issues.length} 项需要修复，正在自动修复一次：${issues.join('；')}`,
  });
  let result: AgentResult<LessonContentOutput> = input.resumeVersion ? {
    data: { ...input.resumeVersion.content, contentVersionId: randomUUID() }, mode: input.resumeVersion.generation.mode,
    provider: input.resumeVersion.generation.provider, model: input.resumeVersion.generation.model,
    latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, fallbackReason: '',
  } : await buildLessonMaterial(input.tutorInput,onValidationRepair);
  if (!input.resumeVersion) recordAgentRun({ userId: input.userId, goalId: input.goalId, agentType: "tutor", nodeName: "generate_structured_lesson", request: input.tutorInput, result });
  let finalMode: "llm" | "rules" = result.mode;

  for (let attempt = 0; attempt <= MAX_LESSON_REPAIR_ATTEMPTS; attempt += 1) {
    if (result.mode === "rules" && result.fallbackReason !== "llm_disabled" && !(attempt === 0 && input.resumeVersion)) {
      const message = `模型${attempt ? "修订" : "生成"}失败：${result.fallbackReason}。${result.validationErrors?.length ? `具体结构问题：${result.validationErrors.join('；')}。已尝试格式修复。` : ''}已停止本轮，不会继续修订回退模板。`;
      const content = { ...result.data, lessonId: input.lessonId };
      const report: LessonContentVersionDraft["qualityReport"] = {
        deterministicPassed: false, semanticPassed: false, score: 0,
        issues: [{ code: "generation_service_failed", severity: "error", blockIds: [], message,
          repairInstruction: "检查模型连接和超时配置后重试；这是生成服务错误，不是缺少资料引用。" }],
        checkerVersion: "generation-service-1", checkedAt: new Date().toISOString(),
        mode: "rules", provider: result.provider, model: result.model,
      };
      const version = asContentVersion(result, content, report);
      version.status = "generation_failed";
      version.generation.inputHash = inputHash;
      versions.push(version);
      await reportProgress(input.reporter, { stage: "lesson_material", percent: 90, message });
      return { versions, questions: [], mode: "rules" };
    }
    let content: LessonContentOutput = { ...result.data, lessonId: input.lessonId };
    if(!context) content={...content,sourceStatus:'unverified',sourceRefs:[],sources:[],retrievalRunId:undefined,
      blocks:content.blocks.map(block=>({...block,sourceChunkIds:[]}))};
    if (context) content = attachLessonSources(content, context);
    await reportProgress(input.reporter, {
      stage: "lesson_quality",
      percent: Math.min(86, (input.progressBase || 62) + attempt * 6),
      message: attempt === 0 ? "正在检查课程目标、示例、边界与练习是否完整" : `正在复核第 ${attempt} 次修订结果`,
    });
    const sourceIssues = context ? checkLessonSources(content, context) : [];
    const deterministic = buildLessonQualityReport({ content, semanticIssues: sourceIssues });
    let qualityReport = deterministic;
    if (deterministic.deterministicPassed && !sourceIssues.length) {
      const semanticResult = await reviewLessonSemantics(content, context);
      recordAgentRun({
        userId: input.userId,
        goalId: input.goalId,
        agentType: "guard",
        nodeName: "review_lesson_quality",
        request: { contentVersionId: content.contentVersionId, content },
        result: semanticResult,
      });
      const semanticIssues = semanticResult.data.passed || semanticResult.data.issues.length
        ? semanticResult.data.issues
        : [{
            code: "semantic_review_failed",
            severity: "error" as const,
            blockIds: [],
            message: "语义复核没有给出可发布结论。",
            repairInstruction: "重新检查课程是否具体、自洽并与目标一致。",
          }];
      qualityReport = buildLessonQualityReport({
        content,
        semanticPassed: semanticResult.data.passed,
        semanticIssues,
        mode: semanticResult.mode,
        provider: semanticResult.provider,
        model: semanticResult.model,
      });
      if (semanticResult.mode !== 'llm' && semanticResult.data.issues.some(issue => issue.code === 'semantic_review_unavailable')) {
        const details = semanticResult.validationErrors?.join('；') || semanticResult.fallbackReason;
        qualityReport = { ...qualityReport, semanticPassed: false, issues: qualityReport.issues.map(issue =>
          issue.code === 'semantic_review_unavailable' ? { ...issue, message: `${issue.message} 原因：${details}` } : issue) };
        const pending = asContentVersion(result, content, qualityReport);
        pending.status = 'generation_failed';
        pending.generation.inputHash = inputHash;
        versions.push(pending);
        await reportProgress(input.reporter, { stage: 'lesson_quality', percent: 90,
          message: '审核服务未完成有效复核，正文已保留；不会判为通过或自动重写正文，请重试复核。' });
        return { versions, questions: [], mode: result.mode };
      }
    }
    if (context && qualityPassed(qualityReport) && result.mode === "llm") content.sourceStatus = "grounded";
    const version = asContentVersion(result, content, qualityReport);
    version.generation.inputHash = inputHash;
    versions.push(version);
    if (version.status === "ready") {
      await reportProgress(input.reporter, {
        stage: "lesson_quality",
        percent: Math.min(90, (input.progressBase || 62) + 18),
        message: qualityReport.issues.some(issue => issue.code === 'demo_semantic_review')
          ? '演示课程结构检查已完成，未执行模型语义复核；正在准备演示题。'
          : `课程质量门禁已通过（${qualityReport.score} 分）`,
      });
      // Repairs may narrow the lesson. Question generation must use the published content, not the old outline.
      const checkInput = { ...input.tutorInput, lesson: { ...input.tutorInput.lesson,
        title: content.title, objective: content.objective, durationMinutes: content.estimatedMinutes,
        completionEvidence: content.evidenceRequirements.map(item => item.description),
      }, material: content };
      const checkResult = await buildLessonCheck(checkInput);
      recordAgentRun({
        userId: input.userId,
        goalId: input.goalId,
        agentType: "tutor",
        nodeName: "build_grounded_lesson_check",
        request: checkInput,
        result: checkResult,
      });
      if (checkResult.mode === 'rules' && checkResult.fallbackReason !== 'llm_disabled') {
        const message = `正文检查已通过，但巩固题生成失败：${checkResult.fallbackReason}。${checkResult.validationErrors?.length ? `具体字段：${checkResult.validationErrors.join('；')}。` : ''}未发布模板题，请重试。`;
        version.status = 'generation_failed';
        version.qualityReport = { ...qualityReport, issues: [...qualityReport.issues, {
          code: 'assessment_generation_failed', severity: 'error', blockIds: [], message,
          repairInstruction: '重新生成符合已发布教学内容的巩固题，检查模型连接与输出格式。',
        }] };
        await reportProgress(input.reporter, { stage: 'lesson_check', percent: 92, message });
        return { versions, questions: [], mode: 'rules' };
      }
      finalMode = result.mode === "llm" && checkResult.mode === "llm" ? "llm" : "rules";
      return { versions, questions: checkResult.data, mode: finalMode };
    }
    if (attempt === MAX_LESSON_REPAIR_ATTEMPTS) break;
    await reportProgress(input.reporter, {
      stage: "lesson_repair",
      percent: Math.min(88, (input.progressBase || 62) + attempt * 6 + 4),
      message: `AI 课程内容检查发现 ${qualityReport.issues.filter((item) => item.severity === "error").length} 个问题（不是你的答题成绩），正在第 ${attempt + 1}/${MAX_LESSON_REPAIR_ATTEMPTS} 轮修订：${qualityReport.issues.filter((item) => item.severity === "error").slice(0, 3).map((item) => item.message).join("；")}${qualityReport.issues.filter((item) => item.severity === "error").length > 3 ? "；其余问题见课程质量报告" : ""}`,
    });
    const repairResult = await repairLessonMaterial(input.tutorInput, content, qualityReport.issues,onValidationRepair);
    recordAgentRun({
      userId: input.userId,
      goalId: input.goalId,
      agentType: "tutor",
      nodeName: "repair_lesson_content",
      request: { contentVersionId: content.contentVersionId, issues: qualityReport.issues },
      result: repairResult,
    });
    result = repairResult;
    finalMode = result.mode;
  }
  return { versions, questions: [], mode: finalMode };
}

export async function ensureSkillsForGoal(userId: string, goal: GoalContext, reporter?: LearningPreparationReporter) {
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
  lessonCount?: number,
  reporter?: LearningPreparationReporter,
  retrievalRunId?: string,
  options?: { replaceProgramId: string },
): Promise<LearningProgram> {
  const existing = readLearningProgramForGoal(userId, goalId);
  if (options && existing?.programId !== options.replaceProgramId) throw new Error("课程版本已改变，请刷新后再重新生成。");
  if (existing && !options) {
    await reportProgress(reporter, { stage: "persist", percent: 100, message: "已有课程已恢复，可以继续学习" });
    return existing;
  }
  const storedGoal = readGoalWithProfile(userId, goalId);
  if (!storedGoal) throw new Error("找不到这个目标。");
  if (storedGoal.diagnosticRequired && storedGoal.diagnosticStatus !== "completed") {
    throw new Error("请先完成初始诊断，再生成课程。");
  }
  const goal = asGoalContext(storedGoal);
  await reportProgress(reporter, {
    stage: "load_goal", percent: 6,
    message: options
      ? `已读取原目标「${goal.title}」、自评基础、学习背景、每周时间与诊断记录，无需重新填写；旧课程将在新版本成功后保留为历史版本`
      : "已读取目标、学习背景和时间安排",
  });
  const storedSkills = readGoalSkills(userId, goal.id);
  const skills = storedSkills.length ? storedSkills : await ensureSkillsForGoal(userId, goal, reporter);
  await reportProgress(reporter, {
    stage: "course_outline",
    percent: 38,
    message: "Planner 正在编排完整课程路线",
  });
  const outlineResult = await buildCourseOutline(goal, skills, lessonCount, async issues => {
    await reportProgress(reporter, { stage: "course_outline", percent: 48, message: `课程规划格式不符合要求，正在修复一次：${issues.join("；")}` });
  });
  recordAgentRun({ userId, goalId, agentType: "planner", nodeName: "build_course_outline", request: { goal, skills }, result: outlineResult });
  if (outlineResult.mode !== "llm" && (options || outlineResult.fallbackReason !== "llm_disabled")) {
    throw new Error(`课程规划未成功：${outlineResult.fallbackReason || "未获得有效模型规划"}。${options ? "旧课程未替换" : "目标资料已保留"}，请重试；不会将兜底标题作为正式路线保存。`);
  }
  await reportProgress(reporter, {
    stage: "course_outline",
    percent: 54,
    message: `课程骨架已生成，共 ${outlineResult.data.lessons.length} 节`,
  });

  const firstOutline = outlineResult.data.lessons[0];
  const firstSkill = skills.find((skill) => skill.id === firstOutline.skillId) || skills[0];
  const firstLessonId = options ? randomUUID() : `first:${goalId}`;
  const firstMastery = readSkillMastery(userId, firstSkill.id);
  const firstInput = {
    groundedContext: retrievalRunId ? readTutorEvidence(userId, goalId, retrievalRunId) : undefined,
    goal,
    skill: firstSkill,
    lesson: firstOutline,
    mastery: firstMastery,
    diagnosticEvidence: [{
      skillId: firstSkill.id,
      score: firstMastery.score,
      confidence: firstMastery.confidence,
      summary: firstMastery.confidence > 0 ? "来自初始诊断的能力基线。" : "尚无可靠诊断证据。",
    }],
  };
  await reportProgress(reporter, {
    stage: "lesson_material",
    percent: 62,
    message: "Tutor 正在生成第一节课程正文",
  });
  const firstBundle = await buildQualityCheckedLesson({
    userId,
    goalId,
    lessonId: firstLessonId,
    tutorInput: firstInput,
    reporter,
    progressBase: 62,
  });
  const firstVersion = firstBundle.versions.at(-1)!;
  const firstReady = firstVersion.status === "ready";
  if (options && !firstReady) {
    const details = firstVersion.qualityReport.issues.filter(issue => issue.severity === "error").map(issue => issue.message).slice(0, 3).join("；");
    throw new Error(`新路线已规划，但首课未通过内容检查：${details || "请查看生成执行记录"}。旧课程未替换，可以重试。`);
  }
  const firstMaterial = projectLessonContent(firstVersion.content);
  await reportProgress(reporter, {
    stage: "lesson_check",
    percent: 91,
    message: firstReady ? `首课考核已生成，共 ${firstBundle.questions.length} 道题` : "课程质量未通过，已保存报告并等待重新生成",
  });

  const sourceModes = [outlineResult.mode, firstBundle.mode];
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
      id: index === 0 ? firstLessonId : randomUUID(),
      order: index + 1,
      phase: lesson.phase,
      title: index === 0 ? firstVersion.content.title : lesson.title,
      durationMinutes: index === 0 ? firstVersion.content.estimatedMinutes : lesson.durationMinutes,
      objective: index === 0 ? firstVersion.content.objective : lesson.objective,
      concepts: index === 0 && firstMaterial.concepts.length ? firstMaterial.concepts : lesson.concepts,
      opening: index === 0 ? firstMaterial.opening : "",
      explanation: index === 0 ? firstMaterial.explanation : "",
      example: index === 0 ? firstMaterial.example : "",
      practice: index === 0 ? firstMaterial.practice : "",
      deliverable: index === 0 ? firstMaterial.deliverable : "通过前一节评测后生成本节交付物。",
      requiredScore: 60,
      status: index === 0 ? "available" : "locked",
      primarySkillId: lesson.skillId,
      difficulty: lesson.difficulty,
      generationStatus: index === 0 ? (firstReady ? "ready" : "failed") : "planned",
      generationMode: index === 0 ? (firstBundle.mode === "llm" ? "llm" : "demo") : "demo",
      capabilityType: lesson.capabilityType,
      prerequisites: lesson.prerequisites,
      completionEvidence: lesson.completionEvidence,
      blocks: index === 0 ? firstVersion.content.blocks : [],
      contentVersionId: index === 0 ? firstVersion.content.contentVersionId : undefined,
      sourceStatus: index === 0 ? firstVersion.content.sourceStatus : "unverified",
      qualityStatus: index === 0 ? (firstReady ? "passed" : "failed") : "pending",
      legacyContent: false,
      questions: index === 0 && firstReady ? firstBundle.questions : [],
      contentVersion: index === 0 ? firstVersion : null,
      contentVersions: index === 0 ? firstBundle.versions : [],
    })),
  };
  await reportProgress(reporter, { stage: "persist", percent: 95, message: "正在保存课程、课节和任务关联" });
  const saved = saveLearningProgram({ userId, goalId, program, replaceProgramId: options?.replaceProgramId });
  await reportProgress(reporter, {
    stage: "persist",
    percent: 100,
    message: firstReady ? "学习路径已准备完成" : "课程路线已保存，但首课需要重新生成",
  });
  return saved;
}

/** Reuse initial course generation, including the persisted goal/profile, diagnostics and source scope. */
export async function regenerateCourseForGoal(userId: string, programId: string, reporter?: LearningPreparationReporter) {
  const existing = readLearningProgram(userId, programId);
  if (!existing) throw new Error("找不到要重新生成的课程。");
  return generateCourseForGoal(userId, existing.goalId, existing.lessons.length, reporter, undefined, { replaceProgramId: programId });
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
  const skills = await ensureSkillsForGoal(userId, goal, reporter);
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
  return { nextAction: "course", program: await generateCourseForGoal(userId, goalId, undefined, reporter) };
}

export async function materializeNextLesson(userId: string, programId: string, lessonId: string, previousLessonScore?: number, reporter?: LearningPreparationReporter) {
  await reportProgress(reporter, { stage: "load_goal", percent: 5, message: "正在读取本节目标、能力画像和已有课程" });
  const found = readAuthoredLesson(userId, programId, lessonId);
  if (!found) throw new Error("找不到下一节课程。");
  if (found.lesson.status === "locked" || found.lesson.status === "archived") {
    throw new Error("本节尚未解锁或已归档，不能生成。请先完成前一节考核。");
  }
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
    capabilityType: found.lesson.capabilityType || skill.capabilityType,
    prerequisites: found.lesson.prerequisites || [],
    completionEvidence: found.lesson.completionEvidence?.length
      ? found.lesson.completionEvidence
      : [`独立展示：${skill.description}`],
  };
  const base = {
    goal,
    skill,
    lesson: outlineLesson,
    mastery,
    previousLessonEvidence: Number.isFinite(previousLessonScore)
      ? [{ lessonId, score: Number(previousLessonScore), summary: "上一节形成性考核结果。" }]
      : [],
  };
  const prior = found.lesson.contentVersion;
  const onlyCheckFailed = prior?.qualityReport.deterministicPassed && prior.qualityReport.semanticPassed
    && prior.qualityReport.issues.some(issue => issue.code === 'assessment_generation_failed')
    && prior.qualityReport.issues.filter(issue => issue.severity === 'error').every(issue => issue.code === 'assessment_generation_failed');
  if (prior && onlyCheckFailed) {
    await reportProgress(reporter, { stage: 'lesson_check', percent: 60, message: '正文已通过检查，保留原文与资料，仅重新生成巩固题。' });
    const content = { ...prior.content, contentVersionId: randomUUID() };
    const checkInput = { ...base, lesson: { ...base.lesson, title: content.title, objective: content.objective,
      durationMinutes: content.estimatedMinutes, completionEvidence: content.evidenceRequirements.map(item => item.description) }, material: content };
    const check = await buildLessonCheck(checkInput);
    recordAgentRun({ userId, goalId: goal.id, agentType: 'tutor', nodeName: 'build_grounded_lesson_check', request: checkInput, result: check });
    if (check.mode === 'rules' && check.fallbackReason !== 'llm_disabled') {
      throw new Error(`巩固题生成仍未完成：${check.fallbackReason}；${check.validationErrors?.join('；') || '请检查模型连接'}。已保留通过检查的正文，可再次重试出题。`);
    }
    const version: LessonContentVersionDraft = { ...prior, content, status: 'ready',
      qualityReport: { ...prior.qualityReport, issues: prior.qualityReport.issues.filter(issue => issue.code !== 'assessment_generation_failed') } };
    const saved = materializeLesson({ userId, programId, lessonId, contentVersions: [version], questions: check.data,
      mode: prior.generation.mode === 'llm' && check.mode === 'llm' ? 'llm' : 'rules', difficulty: found.lesson.difficulty });
    await reportProgress(reporter, { stage: 'persist', percent: 100, message: '巩固题已保存，课程可以继续学习和考核。' });
    return saved;
  }
  const onlyReviewFailed = prior?.qualityReport.deterministicPassed
    && prior.qualityReport.issues.some(issue => issue.code === 'semantic_review_unavailable')
    && prior.qualityReport.issues.filter(issue => issue.severity === 'error').every(issue => issue.code === 'semantic_review_unavailable');
  await reportProgress(reporter, { stage: "lesson_material", percent: 25, message: onlyReviewFailed
    ? "正在读取已保存正文，仅重试语义复核；无需重复生成或检索。"
    : "导师正在重新生成本节正文，随后进行内容检查和必要修订" });
  const bundle = await buildQualityCheckedLesson({
    userId,
    goalId: goal.id,
    lessonId,
    tutorInput: base,
    reporter,
    resumeVersion: onlyReviewFailed ? prior : undefined,
  });
  await reportProgress(reporter, { stage: "persist", percent: 95, message: "正在保存本节内容、质量报告和练习" });
  const saved = materializeLesson({
    userId,
    programId,
    lessonId,
    contentVersions: bundle.versions,
    questions: bundle.questions,
    mode: bundle.mode,
    difficulty: adjustedDifficulty,
  });
  await reportProgress(reporter, { stage: "persist", percent: 100, message: "本次生成及质量检查已结束，正在展示结果" });
  return saved;
}
