import { NextResponse } from "next/server";

import { gradeLessonCheck } from "@/lib/agents/tutor";
import { getCurrentUser } from "@/lib/auth/session";
import { readGoalWithProfile } from "@/lib/db/goals";
import { readGoalSkills, recordAgentRun } from "@/lib/db/learning-loop";
import { readAuthoredLesson, readLearningProgram, recordLessonAttempt } from "@/lib/db/programs";
import { generateCourseForGoal, materializeNextLesson, prepareGoalLoop } from "@/lib/learning-loop/service";
import { askCourseInstructor, getLearningProgramStatus } from "@/lib/learning-program/service";

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
        const preparation = await prepareGoalLoop(userId, goalId, (progress) => {
          send({ type: "progress", progress });
        });
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
      const preparation = await prepareGoalLoop(user.id, requiredText(body.goalId, "学习目标", 180));
      return NextResponse.json({ preparation });
    }

    if (action === "generate") {
      const goalId = requiredText(body.goalId, "学习目标", 180);
      const lessonCount = Math.max(3, Math.min(5, Number(body.lessonCount) || 5));
      return NextResponse.json({ program: await generateCourseForGoal(user.id, goalId, lessonCount) });
    }

    if (action === "tutor") {
      const found = readAuthoredLesson(user.id, requiredText(body.programId, "课程", 180), requiredText(body.lessonId, "课程章节", 180));
      if (!found) return NextResponse.json({ error: "找不到要学习的课程章节。" }, { status: 404 });
      if (found.lesson.generationStatus !== "ready") return NextResponse.json({ error: "请先通过前一节，本节内容才会生成。" }, { status: 409 });
      const reply = await askCourseInstructor({ title: found.program.title, instructor: found.program.instructor }, found.lesson, requiredText(body.message, "想问老师的内容", 1200));
      return NextResponse.json({ reply });
    }

    if (action === "grade") {
      const found = readAuthoredLesson(user.id, requiredText(body.programId, "课程", 180), requiredText(body.lessonId, "课程章节", 180));
      if (!found) return NextResponse.json({ error: "找不到要评分的课程章节。" }, { status: 404 });
      if (found.lesson.generationStatus !== "ready") return NextResponse.json({ error: "这节课还没有生成，不能评分。" }, { status: 409 });
      const goal = readGoalWithProfile(user.id, found.program.goalId);
      if (!goal) return NextResponse.json({ error: "找不到课程对应的目标。" }, { status: 404 });
      const skill = readGoalSkills(user.id, goal.id).find((item) => item.id === found.lesson.primarySkillId);
      if (!skill) return NextResponse.json({ error: "这节课没有关联能力点。" }, { status: 409 });
      const answers = answerMap(body.answers);
      const material = {
        opening: found.lesson.opening, explanation: found.lesson.explanation, example: found.lesson.example,
        practice: found.lesson.practice, deliverable: found.lesson.deliverable, concepts: found.lesson.concepts,
      };
      const lesson = {
        title: found.lesson.title, phase: found.lesson.phase, objective: found.lesson.objective,
        concepts: found.lesson.concepts, durationMinutes: found.lesson.durationMinutes,
        skillId: skill.id, difficulty: found.lesson.difficulty,
      };
      const gradingResult = await gradeLessonCheck({
        goal: { id: goal.id, title: goal.title, description: goal.description, background: goal.background, selfLevel: goal.selfLevel, weeklyHours: goal.weeklyHours },
        skill, lesson, mastery: { score: 0, confidence: 0 }, material, questions: found.lesson.questions, answers,
      });
      recordAgentRun({ userId: user.id, goalId: goal.id, agentType: "tutor", nodeName: "grade_lesson_check", request: { lessonId: found.lesson.id, answers }, result: gradingResult });
      const grade = recordLessonAttempt({ userId: user.id, lesson: found.lesson, answers, grade: { ...gradingResult.data, lessonId: found.lesson.id } });
      if (grade.passed && grade.nextLessonId) await materializeNextLesson(user.id, found.program.programId, grade.nextLessonId, grade.score);
      const program = readLearningProgram(user.id, found.program.programId);
      return NextResponse.json({ grade, program });
    }

    return NextResponse.json({ error: "未知的学习动作。" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "学习服务暂时不可用。";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
