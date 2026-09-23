import { NextResponse } from "next/server";

import { gradeLessonCheck } from "@/lib/agents/tutor";
import { resolveTutorKnowledge, KnowledgeUnresolved } from "@/lib/knowledge/resolve-knowledge";
import { getCurrentUser } from "@/lib/auth/session";
import { isExplicitDemoMode } from "@/lib/agents/shared";
import { readGoalWithProfile } from "@/lib/db/goals";
import { readGoalSkills, recordAgentRun } from "@/lib/db/learning-loop";
import { readAuthoredLesson, readLearningProgram, recordLessonAttempt } from "@/lib/db/programs";
import { generateCourseForGoal, materializeNextLesson, regenerateCourseForGoal } from "@/lib/learning-loop/service";
import { askCourseInstructor, getLearningProgramStatus } from "@/lib/learning-program/service";
import { runGoalOnboardingWorkflow } from "@/lib/workflow/goal-onboarding";
import { SourceSelectionRequired } from "@/lib/learning-loop/lesson-evidence";

export const runtime = "nodejs";

type Body = Record<string, unknown>;

function asBody(value: unknown): Body {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式不正确。");
  return value as Body;
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`请填写${label}。`);
  return value.trim().slice(0, max);
}

function optionalText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function answerMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, answer]) => key.length < 120 && typeof answer === "string")
    .map(([key, answer]) => [key, (answer as string).slice(0, 3000)]));
}

function streamGoalPreparation(userId: string, goalId: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const preparation = await runGoalOnboardingWorkflow({ userId, goalId, reporter: (progress) => {
          send({ type: "progress", progress });
        } });
        send({ type: "result", preparation });
      } catch (error) {
        send({
          type: "error",
          error: error instanceof Error ? error.message : "学习路径准备失败，请稍后重试。",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("program")?.trim() || "";
  if (!requested) return NextResponse.json(getLearningProgramStatus(), { headers: { "Cache-Control": "no-store" } });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录。" }, { status: 401 });
  const program = readLearningProgram(user.id, requested === "current" ? undefined : requested.slice(0, 180));
  return NextResponse.json({ program }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录。" }, { status: 401 });
  try {
    const body = asBody(await request.json());
    const action = optionalText(body.action, 24);

    if (action === "prepare-stream") {
      return streamGoalPreparation(user.id, requiredText(body.goalId, "学习目标", 180));
    }

    if (action === "prepare") {
      const preparation = await runGoalOnboardingWorkflow({ userId: user.id, goalId: requiredText(body.goalId, "学习目标", 180) });
      return NextResponse.json({ preparation });
    }

    if (action === "resume-sources") {
      const preparation = await runGoalOnboardingWorkflow({
        userId: user.id,
        goalId: requiredText(body.goalId, "学习目标", 180),
        resumeEvent: "sources_updated",
      });
      return NextResponse.json({ preparation });
    }

    if (action === "generate") {
      const goalId = requiredText(body.goalId, "学习目标", 180);
      const requestedCount = Number(body.lessonCount);
      const lessonCount = Number.isFinite(requestedCount) ? Math.max(3, Math.min(12, Math.round(requestedCount))) : undefined;
      return NextResponse.json({ program: await generateCourseForGoal(user.id, goalId, lessonCount) });
    }

    if (action === "retry-lesson" || action === "retry-lesson-stream" || action === "regenerate-course-stream") {
      const programId = requiredText(body.programId, "课程", 180);
      const regenerateCourse = action === "regenerate-course-stream";
      const ownedProgram = regenerateCourse ? readLearningProgram(user.id, programId) : null;
      const lessonId = regenerateCourse ? ownedProgram?.lessons[0]?.id || "" : requiredText(body.lessonId, "课程章节", 180);
      const found = readAuthoredLesson(user.id, programId, lessonId);
      if (!found) return NextResponse.json({ error: "找不到要重新生成的课程章节。" }, { status: 404 });
      if (action === "retry-lesson-stream" || regenerateCourse) {
        const encoder = new TextEncoder();
        let disconnected = false;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: unknown) => {
              if (disconnected) return;
              try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
              catch { disconnected = true; }
            };
            try {
              const reporter = (progress: import("@/lib/learning-loop/service").LearningPreparationProgress) => send({ type: "progress", progress });
              const program = regenerateCourse
                ? await regenerateCourseForGoal(user.id, programId, reporter)
                : found.lesson.generationStatus === "ready" ? found.program
                  : await materializeNextLesson(user.id, programId, lessonId, undefined, reporter);
              send({ type: "result", program });
            } catch (error) {
              send({ type: error instanceof SourceSelectionRequired ? "needs_sources" : "error", error: error instanceof Error ? error.message : "课程重新生成失败。" });
            } finally {
              if (!disconnected) controller.close();
            }
          },
          cancel() { disconnected = true; },
        });
        return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
      }
      if (found.lesson.generationStatus === "ready") return NextResponse.json({ program: found.program });
      return NextResponse.json({ program: await materializeNextLesson(user.id, programId, lessonId) });
    }

    if (action === "tutor") {
      const found = readAuthoredLesson(user.id, requiredText(body.programId, "课程", 180), requiredText(body.lessonId, "课程章节", 180));
      if (!found) return NextResponse.json({ error: "找不到要学习的课程章节。" }, { status: 404 });
      if (found.lesson.generationStatus !== "ready") return NextResponse.json({ error: "请先通过前一节，本节内容才会生成。" }, { status: 409 });
      const message = requiredText(body.message, "想问老师的内容", 1200);
      let evidence;
      try {
        evidence = await resolveTutorKnowledge({userId:user.id,goalId:found.program.goalId,
          actionKey:`qa:${found.lesson.id}:${message}`,action:{message,verifiedContext:found.lesson.qualityStatus === 'passed'}});
      } catch(error) {
        if(error instanceof SourceSelectionRequired || error instanceof KnowledgeUnresolved)
          return NextResponse.json({error:error.message,code:error.code},{status:409});
        throw error;
      }
      const reply = await askCourseInstructor({ title: found.program.title, instructor: found.program.instructor }, found.lesson, message,
        evidence ? JSON.stringify(evidence.items.map(item=>({chunkId:item.chunkId,text:item.snapshotText}))) : '本次没有已验证的外部资料，可以根据课程上下文和模型知识解释，但开头须说明“模型知识回答，未经资料验证”；不要编造来源、声称已经查证或确定不明版本的事实。');
      return NextResponse.json({ reply });
    }

    if (action === "grade") {
      const found = readAuthoredLesson(user.id, requiredText(body.programId, "课程", 180), requiredText(body.lessonId, "课程章节", 180));
      if (!found) return NextResponse.json({ error: "找不到要评分的课程章节。" }, { status: 404 });
      if (found.lesson.generationStatus !== "ready") return NextResponse.json({ error: "这节课还没有生成，不能评分。" }, { status: 409 });
      if (!found.lesson.legacyContent && found.lesson.qualityStatus !== "passed") {
        return NextResponse.json({ error: "这节课还没有通过教学质量门禁，不能评分。" }, { status: 409 });
      }
      const goal = readGoalWithProfile(user.id, found.program.goalId);
      if (!goal) return NextResponse.json({ error: "找不到课程对应的目标。" }, { status: 404 });
      const skill = readGoalSkills(user.id, goal.id).find((item) => item.id === found.lesson.primarySkillId);
      if (!skill) return NextResponse.json({ error: "这节课没有关联能力点。" }, { status: 409 });
      const answers = answerMap(body.answers);
      if (!found.lesson.questions.length || !found.lesson.questions.some(question => answers[question.id]?.trim())) {
        return NextResponse.json({ error: "请先填写至少一道题的答案。", code: "answers_required" }, { status: 400 });
      }
      const material = found.lesson.contentVersion?.content || {
        opening: found.lesson.opening, explanation: found.lesson.explanation, example: found.lesson.example,
        practice: found.lesson.practice, deliverable: found.lesson.deliverable, concepts: found.lesson.concepts,
      };
      const lesson = {
        title: found.lesson.title, phase: found.lesson.phase, objective: found.lesson.objective,
        concepts: found.lesson.concepts, durationMinutes: found.lesson.durationMinutes,
        skillId: skill.id, difficulty: found.lesson.difficulty,
        capabilityType: found.lesson.capabilityType || skill.capabilityType,
        prerequisites: found.lesson.prerequisites || [],
        completionEvidence: found.lesson.completionEvidence || [],
      };
      const gradingResult = await gradeLessonCheck({
        goal: { id: goal.id, title: goal.title, description: goal.description, background: goal.background, selfLevel: goal.selfLevel, weeklyHours: goal.weeklyHours, targetDate: goal.targetDate },
        skill, lesson, mastery: { score: 0, confidence: 0 }, material, questions: found.lesson.questions, answers,
      });
      recordAgentRun({ userId: user.id, goalId: goal.id, agentType: "tutor", nodeName: "grade_lesson_check", request: { lessonId: found.lesson.id, answers }, result: gradingResult });
      const demoGrade = isExplicitDemoMode() && found.lesson.generationMode === 'demo'
        && gradingResult.mode === 'rules' && gradingResult.fallbackReason === 'llm_disabled';
      if (gradingResult.mode !== 'llm' && !demoGrade) {
        return NextResponse.json({
          code: 'grading_unavailable', gradingStatus: 'pending', retryable: true,
          error: '评分服务未完成有效评分，本次没有写入成绩、修改掌握度或解锁下一课。答案保留在当前页面，请重试评分。',
          reason: gradingResult.fallbackReason,
          issues: gradingResult.validationErrors || [],
        }, { status: 503 });
      }
      const grade = recordLessonAttempt({ userId: user.id, lesson: found.lesson, answers, grade: { ...gradingResult.data, lessonId: found.lesson.id } });
      let nextLessonWarning: string | undefined;
      // The web client displays the committed grade first, then starts a separate
      // streamed lesson request. Keep the synchronous path for existing clients.
      if (grade.passed && grade.nextLessonId && body.deferNextLesson !== true) {
        try {
          const nextProgram=await materializeNextLesson(user.id, found.program.programId, grade.nextLessonId, grade.score);
          if(nextProgram.lessons.find(lesson=>lesson.id===grade.nextLessonId)?.generationStatus!=='ready')
            nextLessonWarning='本节评分和任务完成状态已保存；下一节暂未通过内容检查，请进入下一节重新生成。';
        } catch {
          nextLessonWarning='本节评分和任务完成状态已保存；下一节生成暂时失败，请进入下一节重试，无需重新提交本节答案。';
        }
      }
      const program = readLearningProgram(user.id, found.program.programId);
      return NextResponse.json({ grade, program, nextLessonWarning });
    }

    return NextResponse.json({ error: "未知的学习动作。" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "学习服务暂时不可用。";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
