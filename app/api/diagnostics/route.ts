import { gradeDiagnostic } from "@/lib/agents/examiner";
import { getCurrentUser } from "@/lib/auth/session";
import { readAuthoredDiagnostic, readDiagnosticResult, recordAgentRun, recordDiagnosticAttempt } from "@/lib/db/learning-loop";
import { answerAdaptiveDiagnostic } from "@/lib/learning-loop/adaptive-diagnostic";
import { generateCourseForGoal } from "@/lib/learning-loop/service";

export const runtime = "nodejs";

function answerMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, answer]) => key.length < 120 && typeof answer === "string")
    .map(([key, answer]) => [key, (answer as string).trim().slice(0, 3000)]));
}

function streamAdaptiveAnswer(input: {
  userId: string;
  assessmentId: string;
  questionId: string;
  answer: string;
}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = await answerAdaptiveDiagnostic({
          ...input,
          reporter: (progress) => send({ type: "progress", progress }),
        });
        send({ type: "result", result });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "诊断评分失败。" });
      } finally {
        controller.close();
      }
    },
  }), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "未登录。" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const assessmentId = typeof body.assessmentId === "string" ? body.assessmentId.trim().slice(0, 180) : "";
    if (!assessmentId) return Response.json({ error: "缺少诊断记录。" }, { status: 400 });
    if (body.action === "answer-stream") {
      const questionId = typeof body.questionId === "string" ? body.questionId.trim().slice(0, 180) : "";
      const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 3000) : "";
      if (!questionId) return Response.json({ error: "缺少当前题目。" }, { status: 400 });
      if (!answer) return Response.json({ error: "请先回答当前题目。" }, { status: 400 });
      return streamAdaptiveAnswer({ userId: user.id, assessmentId, questionId, answer });
    }
    const found = readAuthoredDiagnostic(user.id, assessmentId);
    if (!found) return Response.json({ error: "找不到这次诊断。" }, { status: 404 });
    if (found.assessment.adaptive) return Response.json({ error: "自适应诊断需要逐题提交。" }, { status: 409 });
    if (found.assessment.status === "completed") {
      const grade = readDiagnosticResult(user.id, assessmentId);
      const program = await generateCourseForGoal(user.id, found.assessment.goalId);
      if (!grade) return Response.json({ error: "诊断已完成，但结果暂时无法读取。" }, { status: 409 });
      return Response.json({ grade, program, replayed: true });
    }
    const answers = answerMap(body.answers);
    const unanswered = found.questions.filter((question) => !answers[question.id]);
    if (unanswered.length) return Response.json({ error: `还有 ${unanswered.length} 道题未作答。不会也可以写出当前判断。` }, { status: 400 });
    const result = await gradeDiagnostic({ questions: found.questions, answers });
    recordAgentRun({ userId: user.id, goalId: found.assessment.goalId, agentType: "examiner", nodeName: "grade_initial_diagnostic", request: { assessmentId, answers }, result });
    const grade = recordDiagnosticAttempt({ userId: user.id, assessmentId, answers, grade: result.data });
    const program = await generateCourseForGoal(user.id, found.assessment.goalId);
    return Response.json({ grade, program });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "诊断提交失败。" }, { status: 400 });
  }
}
