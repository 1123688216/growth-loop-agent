import { NextResponse } from "next/server";

import {
  askCourseInstructor,
  generateLearningProgram,
  getLearningProgramStatus,
  gradeCourseLesson,
} from "@/lib/learning-program/service";
import type { LearningProgram } from "@/lib/learning-program/types";

export const runtime = "nodejs";

type Body = Record<string, unknown>;

function asBody(value: unknown): Body {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请求格式不正确。");
  }
  return value as Body;
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`请填写${label}。`);
  return value.trim().slice(0, max);
}

function optionalText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function courseFrom(value: unknown): LearningProgram {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("课程数据不完整，请重新生成课程。 ");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 180_000) throw new Error("课程数据过大，请重新生成课程。 ");
  const course = value as LearningProgram;
  if (!Array.isArray(course.lessons) || course.lessons.length < 1) {
    throw new Error("课程章节不完整，请重新生成课程。 ");
  }
  return course;
}

function answerMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, answer]) => key.length < 120 && typeof answer === "string")
      .map(([key, answer]) => [key, (answer as string).slice(0, 3000)]),
  );
}

export async function GET() {
  return NextResponse.json(getLearningProgramStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const body = asBody(await request.json());
    const action = optionalText(body.action, 24);

    if (action === "generate") {
      const weeklyHours = Math.max(1, Math.min(20, Number(body.weeklyHours) || 4));
      const lessonCount = Math.max(3, Math.min(5, Number(body.lessonCount) || 5));
      const program = await generateLearningProgram({
        subject: requiredText(body.subject, "学习主题", 180),
        goal: requiredText(body.goal, "学习目标", 500),
        background: optionalText(body.background, 500),
        weeklyHours,
        lessonCount,
      });
      return NextResponse.json({ program });
    }

    if (action === "tutor") {
      const course = courseFrom(body.course);
      const reply = await askCourseInstructor(
        course,
        requiredText(body.lessonId, "课程章节", 100),
        requiredText(body.message, "想问老师的内容", 1200),
      );
      return NextResponse.json({ reply });
    }

    if (action === "grade") {
      const course = courseFrom(body.course);
      const grade = await gradeCourseLesson(
        course,
        requiredText(body.lessonId, "课程章节", 100),
        answerMap(body.answers),
      );
      return NextResponse.json({ grade });
    }

    return NextResponse.json({ error: "未知的学习动作。" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "学习服务暂时不可用。";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
