import { buildAdaptiveQuestion, gradeAdaptiveAnswer, summarizeAdaptiveDiagnostic } from "@/lib/agents/examiner";
import { readGoalWithProfile } from "@/lib/db/goals";
import {
  appendDiagnosticQuestion,
  readAuthoredDiagnostic,
  readDiagnosticResponses,
  readDiagnosticResult,
  readGoalSkills,
  recordAdaptiveResponse,
  recordAgentRun,
  recordDiagnosticAttempt,
} from "@/lib/db/learning-loop";
import {
  adaptiveEvidenceCounts,
  adaptiveSkillScores,
  parseAdaptiveState,
  selectAdaptiveTarget,
  updateAdaptiveBoundary,
} from "@/lib/learning-loop/adaptive";
import { generateCourseForGoal } from "@/lib/learning-loop/service";
import type { DiagnosticQuestionResult } from "@/lib/learning-program/types";

export type DiagnosticProgress = {
  stage: "load_evidence" | "grade_answer" | "update_bounds" | "generate_question" | "summarize" | "persist" | "course";
  percent: number;
  message: string;
};

export type DiagnosticProgressReporter = (progress: DiagnosticProgress) => void | Promise<void>;

async function report(reporter: DiagnosticProgressReporter | undefined, progress: DiagnosticProgress) {
  await reporter?.(progress);
}

export async function answerAdaptiveDiagnostic(input: {
  userId: string;
  assessmentId: string;
  questionId: string;
  answer: string;
  reporter?: DiagnosticProgressReporter;
}) {
  await report(input.reporter, { stage: "load_evidence", percent: 5, message: "正在读取本题、历史证据和能力边界" });
  const found = readAuthoredDiagnostic(input.userId, input.assessmentId);
  if (!found) throw new Error("找不到这次诊断。");
  if (!found.assessment.adaptive) throw new Error("这是一份旧版诊断，请从目标卡片重新开始诊断。");
  if (found.assessment.status === "completed") {
    const grade = readDiagnosticResult(input.userId, input.assessmentId);
    const program = await generateCourseForGoal(input.userId, found.assessment.goalId);
    if (!grade) throw new Error("诊断已完成，但结果暂时无法读取。");
    await report(input.reporter, { stage: "course", percent: 100, message: "诊断结果和课程已恢复" });
    return { complete: true as const, grade, program, replayed: true };
  }

  const question = found.questions.at(-1);
  if (!question || question.id !== input.questionId) throw new Error("当前题目已经变化，请刷新后继续。");
  const answer = input.answer.trim().slice(0, 3000);
  if (!answer) throw new Error("请先回答当前题目。不会也可以写出目前的判断。");
  const goal = readGoalWithProfile(input.userId, found.assessment.goalId);
  if (!goal) throw new Error("找不到诊断对应的目标。");
  const skills = readGoalSkills(input.userId, found.assessment.goalId);
  const skill = skills.find((item) => item.id === question.skillId);
  if (!skill) throw new Error("当前题目缺少对应能力。");

  await report(input.reporter, { stage: "grade_answer", percent: 14, message: `Examiner 正在评分难度 ${question.difficulty} 的本题证据` });
  const grading = await gradeAdaptiveAnswer({ question, answer });
  recordAgentRun({
    userId: input.userId,
    goalId: found.assessment.goalId,
    agentType: "examiner",
    nodeName: "grade_adaptive_diagnostic_answer",
    request: { assessmentId: input.assessmentId, questionId: question.id, answer },
    result: grading,
  });
  await report(input.reporter, { stage: "update_bounds", percent: 38, message: `本题 ${grading.data.score}/10，正在更新「${skill.name}」的能力上下界` });
  const previousState = parseAdaptiveState(found.adaptiveStateJson, skills, goal.selfLevel === "intermediate" ? 3 : 2);
  const updated = updateAdaptiveBoundary(previousState, skill.id, question.difficulty, grading.data.score);
  recordAdaptiveResponse({
    userId: input.userId,
    assessmentId: input.assessmentId,
    question,
    answer,
    score: grading.data.score,
    feedback: grading.data.feedback,
    graderMode: grading.data.gradedBy,
    provider: grading.data.provider,
    model: grading.data.model,
    state: updated.state,
  });

  const answeredCount = found.assessment.answeredCount + 1;
  const target = selectAdaptiveTarget({
    skills,
    state: updated.state,
    answeredCount,
    minQuestions: found.assessment.minQuestions,
    maxQuestions: found.assessment.maxQuestions,
    preferredSkillId: skill.id,
  });
  if (target) {
    const direction: DiagnosticQuestionResult["direction"] = target.difficulty > question.difficulty
      ? "harder"
      : target.difficulty < question.difficulty
        ? "easier"
        : "same";
    const directionText = direction === "harder" ? "上调难度继续探测上限" : direction === "easier" ? "下调难度确认基础边界" : "切换能力或在相近难度继续确认";
    await report(input.reporter, { stage: "generate_question", percent: 56, message: `${directionText}，正在生成下一道具体题` });
    const nextQuestion = await buildAdaptiveQuestion({
      goal: { title: goal.title, description: goal.description },
      skill: target.skill,
      difficulty: target.difficulty,
      previousEvidence: { answer, score: grading.data.score, feedback: grading.data.feedback },
      previousPrompts: found.questions.map((item) => item.prompt),
    });
    recordAgentRun({
      userId: input.userId,
      goalId: found.assessment.goalId,
      agentType: "examiner",
      nodeName: "build_adaptive_diagnostic_question",
      request: { assessmentId: input.assessmentId, target, previousScore: grading.data.score },
      result: nextQuestion,
    });
    await report(input.reporter, { stage: "persist", percent: 88, message: "正在保存本题证据和下一题快照" });
    appendDiagnosticQuestion({
      userId: input.userId,
      assessmentId: input.assessmentId,
      question: nextQuestion.data,
      result: nextQuestion,
    });
    const refreshed = readAuthoredDiagnostic(input.userId, input.assessmentId);
    if (!refreshed) throw new Error("下一题已生成，但诊断状态无法读取。");
    await report(input.reporter, { stage: "persist", percent: 100, message: `下一题难度 ${target.difficulty}，可以继续作答` });
    return {
      complete: false as const,
      assessment: refreshed.assessment,
      questionResult: {
        questionId: question.id,
        score: grading.data.score,
        maxScore: question.maxScore,
        feedback: grading.data.feedback,
        direction,
        nextDifficulty: target.difficulty,
      } satisfies DiagnosticQuestionResult,
    };
  }

  await report(input.reporter, { stage: "summarize", percent: 48, message: "上下界探测已收敛，正在汇总各能力证据" });
  const responses = readDiagnosticResponses(input.userId, input.assessmentId);
  const skillScores = adaptiveSkillScores(skills, updated.state);
  const summary = await summarizeAdaptiveDiagnostic({
    skills,
    skillScores,
    responses: responses.map((response) => ({
      questionId: response.question_id,
      skillId: response.skill_id || "",
      score: response.score,
      maxScore: response.max_score,
      feedback: response.feedback,
    })),
  });
  recordAgentRun({
    userId: input.userId,
    goalId: found.assessment.goalId,
    agentType: "examiner",
    nodeName: "summarize_adaptive_diagnostic",
    request: { assessmentId: input.assessmentId, skillScores, responseCount: responses.length },
    result: summary,
  });
  await report(input.reporter, { stage: "persist", percent: 62, message: "正在写入能力基线和证据置信度" });
  const grade = recordDiagnosticAttempt({
    userId: input.userId,
    assessmentId: input.assessmentId,
    answers: Object.fromEntries(responses.map((response) => [response.question_id, response.answer])),
    grade: summary.data,
    skillEvidenceCounts: adaptiveEvidenceCounts(skills, updated.state),
  });

  await report(input.reporter, { stage: "course", percent: 68, message: "能力基线已确定，正在生成课程骨架和首课" });
  const program = await generateCourseForGoal(input.userId, found.assessment.goalId, 5, async (progress) => {
    await report(input.reporter, {
      stage: "course",
      percent: Math.min(98, 68 + Math.round(progress.percent * .3)),
      message: progress.message,
    });
  });
  await report(input.reporter, { stage: "course", percent: 100, message: "诊断评分和首节课程已完成" });
  return {
    complete: true as const,
    grade,
    program,
    questionResult: {
      questionId: question.id,
      score: grading.data.score,
      maxScore: question.maxScore,
      feedback: grading.data.feedback,
      direction: "complete" as const,
    },
  };
}
