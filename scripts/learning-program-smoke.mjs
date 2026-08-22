const baseUrl = (process.env.GROWTH_LOOP_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const requireLlm = process.argv.includes("--require-llm");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

const generated = await request("/api/learning-program", {
  action: "generate",
  subject: "Agent 系统设计与自己的 Agent 原型",
  goal: "理解 Agent 的任务闭环、工具调用和状态管理，并做出一个能处理学习记录的最小 Agent。",
  background: "会基础 TypeScript 和 Next.js，希望先建立正确架构，再开始开发。",
  weeklyHours: 4,
  lessonCount: 5,
});

const course = generated.program;
assert(course && Array.isArray(course.lessons), "没有返回课程章节");
assert(course.lessons.length >= 5, "课程章节不足 5 节");
assert(course.lessons.every((lesson) => lesson.questions?.length >= 3), "至少有一节缺少 3 道课后题");
assert(course.instructor?.name && course.instructor?.openingMessage, "缺少 AI 讲师设定");
if (requireLlm) assert(course.mode === "llm", `课程未由 LLM 生成：${course.mode}`);

const lesson = course.lessons[0];
const tutor = await request("/api/learning-program", {
  action: "tutor",
  course,
  lessonId: lesson.id,
  message: "我担心把 Agent 做成堆功能的聊天框。应该怎样先定义它的最小闭环？",
});
assert(tutor.reply?.reply?.length >= 20, "AI 讲师没有返回有效讲解");
if (requireLlm) assert(tutor.reply.mode === "llm", `AI 讲师未由 LLM 回答：${tutor.reply.mode}`);

const answers = Object.fromEntries(
  lesson.questions.map((question) => [
    question.id,
    `我会先从“${lesson.concepts[0]}”定义用户要完成的事情，再用“${lesson.concepts[1]}”约束 Agent 的动作。例如处理学习记录时，先提取待办，再让用户确认结果；这样可以观察任务是否闭环，并避免系统擅自写入。`,
  ]),
);
const graded = await request("/api/learning-program", {
  action: "grade",
  course,
  lessonId: lesson.id,
  answers,
});
assert(Number.isFinite(graded.grade?.score), "课后题没有返回分数");
assert(graded.grade.feedback?.length === lesson.questions.length, "课后题反馈数量不匹配");
if (requireLlm) assert(graded.grade.gradedBy === "llm", `课后评分未由 LLM 完成：${graded.grade.gradedBy}`);

console.log(
  JSON.stringify({
    ok: true,
    title: course.title,
    lessons: course.lessons.length,
    questionsPerLesson: course.lessons.map((item) => item.questions.length),
    courseMode: course.mode,
    tutorMode: tutor.reply.mode,
    gradingMode: graded.grade.gradedBy,
    score: graded.grade.score,
  }),
);
