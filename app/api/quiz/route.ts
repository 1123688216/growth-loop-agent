import { NextResponse } from "next/server";
import { generateLearningQuiz, gradeLearningQuiz, type GeneratedQuiz, type QuizQuestion } from "@/lib/agent/quiz";

export const runtime = "nodejs";

function errorResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function stringField(input: Record<string, unknown>, key: string, required = false) {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${key} is required`);
  return trimmed;
}

function parseQuestions(value: unknown): QuizQuestion[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error("questions must contain at least 2 items");
  return value.slice(0, 3).map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid question");
    const question = item as Record<string, unknown>;
    if (typeof question.id !== "string" || typeof question.prompt !== "string") throw new Error("invalid question");
    return {
      id: question.id.trim(),
      prompt: question.prompt.trim(),
      hint: typeof question.hint === "string" ? question.hint.trim() : "直接回答，并尽量给一个例子。",
      rubric: typeof question.rubric === "string" ? question.rubric.trim() : "准确理解；能够迁移应用",
    } satisfies QuizQuestion;
  });
}

function reconstructQuiz(input: Record<string, unknown>, questions: QuizQuestion[]): GeneratedQuiz {
  const topic = typeof input.topic === "string" && input.topic.trim() ? input.topic.trim() : "这次学习内容";
  const sourceSummary = typeof input.source === "string" ? input.source.trim() : "";
  const quizId = typeof input.quizId === "string" && input.quizId.trim() ? input.quizId.trim() : `quiz-${Date.now()}`;
  return {
    quizId,
    topic,
    sourceSummary,
    questions,
    internalQuestions: questions.map((question) => ({
      ...question,
      keywords: [topic, ...sourceSummary.split(/\s+/).filter((word) => word.length >= 2).slice(0, 5)],
    })),
    mode: "demo",
    provider: "rules",
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid JSON body");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse("request body must be an object");
  const input = body as Record<string, unknown>;
  const action = input.action;
  if (action !== "generate" && action !== "grade") return errorResponse("action must be generate or grade");

  try {
    if (action === "generate") {
      const content = stringField(input, "content", true)!;
      const topic = stringField(input, "topic");
      const output = stringField(input, "output");
      const quiz = await generateLearningQuiz(content, topic, output);
      return NextResponse.json({
        quizId: quiz.quizId,
        topic: quiz.topic,
        sourceSummary: quiz.sourceSummary,
        questions: quiz.questions,
        mode: quiz.mode,
        provider: quiz.provider,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const topic = stringField(input, "topic", true)!;
    const source = stringField(input, "source", true)!;
    const questions = parseQuestions(input.questions);
    if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) throw new Error("answers must be an object");
    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.answers as Record<string, unknown>)) {
      if (typeof value !== "string") throw new Error("answers must contain strings");
      answers[key] = value.trim().slice(0, 1_000);
    }
    const quiz = reconstructQuiz({ quizId: input.quizId, topic, source }, questions);
    const result = await gradeLearningQuiz(quiz, answers);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "invalid quiz request");
  }
}
