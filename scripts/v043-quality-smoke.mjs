const baseArgument = process.argv.find((value) => value.startsWith("--base="))?.slice("--base=".length);
const baseUrl = (baseArgument || process.env.GROWTH_LOOP_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const requireLlm = process.argv.includes("--require-llm");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let cookie = "";

async function call(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
  });
  const session = response.headers.getSetCookie?.().find((value) => value.startsWith("growth_loop_session="));
  if (session) cookie = session.split(";")[0];
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`${path} returned non-JSON: ${body.slice(0, 200)}`); }
  if (!response.ok) throw new Error(data.error || `${path} failed with ${response.status}`);
  return data;
}

function post(path, payload) {
  return call(path, { method: "POST", body: JSON.stringify(payload) });
}

async function prepare(goalId) {
  const response = await fetch(`${baseUrl}/api/learning-program`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ action: "prepare-stream", goalId }),
  });
  const events = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const failure = events.find((event) => event.type === "error");
  if (failure) throw new Error(failure.error || "course preparation failed");
  return {
    preparation: events.find((event) => event.type === "result")?.preparation,
    progress: events.filter((event) => event.type === "progress").map((event) => event.progress),
  };
}

const username = `v043_${Date.now().toString(36)}`;
await post("/api/auth/register", { username, password: "v043-quality-password", displayName: "V0.4.3 质量回归" });
const targetDate = new Date(Date.now() + 56 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const { goal } = await post("/api/goals", {
  title: "Java 并发中的竞态条件排查",
  description: "能够从一段共享计数器代码中定位竞态条件，解释发生顺序，完成修复并用并发测试验证。",
  targetDate,
  background: "会 Java 基础语法和 JUnit，但没有系统学习线程安全。",
  weeklyHours: 5,
  selfLevel: "beginner",
});

const prepared = await prepare(goal.id);
assert(prepared.preparation?.nextAction === "course", "beginner goal did not create a course");
const course = prepared.preparation.program;
assert(course?.programId, "course has no programId");
if (requireLlm) assert(course.mode === "llm", `expected all course nodes to use LLM, got ${course.mode}`);
assert(course.lessons.length >= 5 && course.lessons.length <= 12, `unexpected dynamic lesson count: ${course.lessons.length}`);
const lesson = course.lessons[0];
assert(lesson.generationStatus === "ready", `first lesson is not ready: ${lesson.generationStatus}`);
assert(lesson.qualityStatus === "passed", `quality gate did not pass: ${lesson.qualityStatus}`);
assert(lesson.legacyContent === false, "new lesson was marked as legacy");
assert(lesson.blocks?.length >= 5, "structured learning blocks are missing");
assert(lesson.blocks.some((block) => ["worked_example", "demonstration", "code_lab"].includes(block.type)), "lesson has no concrete worked example");
const exampleBlock = lesson.blocks.find((block) => ["worked_example", "demonstration", "code_lab"].includes(block.type));
assert(JSON.stringify(exampleBlock).length > 400, "worked example is too thin to be independently verifiable");
assert(lesson.blocks.some((block) => ["common_mistake", "boundary"].includes(block.type)), "lesson has no mistake or boundary block");
assert(lesson.blocks.some((block) => ["guided_practice", "retrieval_practice", "speaking_practice"].includes(block.type)), "lesson has no practice block");
const serialized = JSON.stringify(lesson.blocks);
assert(!/请给出一个具体场景|结合实际进行|根据实际情况/.test(serialized), "lesson contains a generic placeholder");
const blockIds = new Set(lesson.blocks.map((block) => block.id));
assert(lesson.questions.length === 3, "lesson check does not contain 3 questions");
assert(lesson.questions.every((question) => question.contentVersionId === lesson.contentVersionId), "question content version mismatch");
assert(lesson.questions.every((question) => question.taughtBlockIds?.length && question.taughtBlockIds.every((id) => blockIds.has(id))), "question is not grounded in taught blocks");
assert(lesson.questions.every((question) => !question.referenceAnswer && !question.rubric), "protected answer or rubric leaked to client");
assert(prepared.progress.some((item) => item.stage === "lesson_quality"), "progress stream has no lesson quality stage");
assert(prepared.progress.at(-1)?.percent === 100, "progress stream did not finish at 100%");

const nonCodeCapabilities = [];
if (!requireLlm) {
  const nonCodeCases = [
    {
      title: "技术分享演讲表达训练",
      description: "能够面向初学者完成一次十分钟技术分享，并根据结构、清晰度和听众反馈改进表达。",
      background: "有技术经验，但没有系统练习过公开表达。",
      expectedCapability: "expression_communication",
      expectedBlock: "speaking_practice",
    },
    {
      title: "中国近代史事件辨析",
      description: "能够按时间、背景、参与者和影响区分易混历史事件，并解释判断依据。",
      background: "记得零散事件名称，但时间线和因果关系容易混淆。",
      expectedCapability: "retrieval_discrimination",
      expectedBlock: "retrieval_practice",
    },
  ];
  for (const item of nonCodeCases) {
    const { goal: nonCodeGoal } = await post("/api/goals", {
      title: item.title,
      description: item.description,
      targetDate,
      background: item.background,
      weeklyHours: 3,
      selfLevel: "beginner",
    });
    const nonCodePrepared = await prepare(nonCodeGoal.id);
    const nonCodeLesson = nonCodePrepared.preparation.program.lessons[0];
    assert(nonCodeLesson.capabilityType === item.expectedCapability, `${item.title} capability strategy mismatch`);
    assert(nonCodeLesson.blocks.some((block) => block.type === item.expectedBlock), `${item.title} missing ${item.expectedBlock}`);
    assert(nonCodeLesson.qualityStatus === "passed", `${item.title} did not pass quality gate`);
    nonCodeCapabilities.push({ title: item.title, capabilityType: nonCodeLesson.capabilityType, practice: item.expectedBlock });
  }
}

console.log(JSON.stringify({
  ok: true,
  courseMode: course.mode,
  provider: course.provider,
  lessonCount: course.lessons.length,
  firstLesson: lesson.title,
  capabilityType: lesson.capabilityType,
  sourceStatus: lesson.sourceStatus,
  qualityStatus: lesson.qualityStatus,
  blockTypes: lesson.blocks.map((block) => block.type),
  blockTitles: lesson.blocks.map((block) => block.title),
  questionPrompts: lesson.questions.map((question) => question.prompt),
  progressStages: prepared.progress.map((item) => item.stage),
  nonCodeCapabilities,
}));
