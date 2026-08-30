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
  const setCookie = response.headers.getSetCookie?.() || [];
  const session = setCookie.find((value) => value.startsWith("growth_loop_session="));
  if (session) cookie = session.split(";")[0];

  const body = await response.text();
  if (!body) throw new Error(`${path} 返回空响应（HTTP ${response.status}），请查看服务端日志。`);

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${path} 返回了非 JSON 响应（HTTP ${response.status}）：${body.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status} ${path}`);
  return data;
}

function post(path, payload) {
  return call(path, { method: "POST", body: JSON.stringify(payload) });
}

async function postProgress(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`进度接口请求失败（HTTP ${response.status}）：${body.slice(0, 200)}`);
  const events = body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const failure = events.find((event) => event.type === "error");
  if (failure) throw new Error(failure.error || "进度接口返回失败事件");
  const preparation = events.find((event) => event.type === "result")?.preparation;
  if (!preparation) throw new Error("进度接口没有返回最终结果");
  return { preparation, progress: events.filter((event) => event.type === "progress").map((event) => event.progress) };
}

async function postDiagnosticProgress(payload) {
  const response = await fetch(`${baseUrl}/api/diagnostics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ action: "answer-stream", ...payload }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`diagnostic progress request failed (${response.status}): ${body.slice(0, 200)}`);
  const events = body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const failure = events.find((event) => event.type === "error");
  if (failure) throw new Error(failure.error || "diagnostic progress stream returned an error");
  const result = events.find((event) => event.type === "result")?.result;
  if (!result) throw new Error("diagnostic progress stream did not return a result");
  return { result, progress: events.filter((event) => event.type === "progress").map((event) => event.progress) };
}

// 课程正文现在保存在服务端，冒烟流程必须先登录并创建目标。
const username = `smoke_${Date.now().toString(36)}`;
await post("/api/auth/register", { username, password: "smoke-password-1", displayName: "冒烟账号" });

const targetDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const { goal, profile } = await post("/api/goals", {
  title: "Agent 系统设计与自己的 Agent 原型",
  description: "理解 Agent 的任务闭环、工具调用和状态管理，并做出一个能处理学习记录的最小 Agent。",
  targetDate,
  background: "会基础 TypeScript 和 Next.js，希望先建立正确架构，再开始开发。",
  weeklyHours: 6,
  selfLevel: "familiar",
});
assert(goal?.id, "目标没有创建成功");
assert(goal.targetDate === targetDate, `目标日期没有落库：${goal.targetDate}`);
// horizon 由 targetDate 在服务端派生，不再由客户端提交。
assert(/年.*月.*日前$/.test(goal.horizon), `周期文案没有从目标日期派生：${goal.horizon}`);
// profile 由服务端写入后回读，用来确认 goal_learning_profiles 与 goals 同事务落库。
assert(profile?.selfLevel === "familiar", `自评档案没有落库：${JSON.stringify(profile)}`);
assert(profile.weeklyHours === 6, `每周投入没有落库：${profile.weeklyHours}`);
assert(profile.background.startsWith("会基础 TypeScript"), "当前基础没有落库");

// 过去的日期应当被拒绝，而不是静默存成「不设期限」。
const rejected = await fetch(`${baseUrl}/api/goals`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ title: "过期目标", targetDate: "2020-01-01" }),
});
assert(rejected.status === 400, `过去的目标日期应当被拒绝，实际状态码 ${rejected.status}`);

// 一知半解不能绕过初始诊断直接生成课程。
const premature = await fetch(`${baseUrl}/api/learning-program`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ action: "generate", goalId: goal.id, lessonCount: 5 }),
});
assert(premature.status === 400, `未诊断时生成课程应被拒绝，实际状态码 ${premature.status}`);

const prepared = await postProgress("/api/learning-program", { action: "prepare-stream", goalId: goal.id });
assert(prepared.preparation?.nextAction === "diagnostic", "一知半解没有进入初始诊断分支");
assert(prepared.progress.length >= 5, `创建目标进度节点不足：${prepared.progress.length}`);
assert(prepared.progress.some((item) => item.stage === "skill_map"), "进度流缺少能力地图节点");
assert(prepared.progress.some((item) => item.stage === "diagnostic"), "进度流缺少诊断生成节点");
assert(prepared.progress.at(-1)?.percent === 100, "进度流没有以 100% 结束");
assert(prepared.progress.every((item, index) => index === 0 || item.percent >= prepared.progress[index - 1].percent), "进度百分比发生倒退");
let diagnostic = prepared.preparation.diagnostic;
assert(diagnostic?.adaptive === true, "new diagnostic should use the adaptive flow");
assert(diagnostic?.questions?.length === 1, `adaptive diagnostic should initially generate one question, got ${diagnostic?.questions?.length}`);
assert(diagnostic.minQuestions >= 5 && diagnostic.maxQuestions > diagnostic.minQuestions, "adaptive diagnostic question bounds are invalid");
assert(diagnostic.questions.every((question) => !question.referenceAnswer && !question.rubric), "diagnostic response leaked a reference answer or rubric");
assert(diagnostic.questions.every((question) => !/给出一个具体场景|说明你的判断、做法以及如何验证/.test(question.prompt)), "diagnostic still contains a generic template question");

let diagnosed;
let replayedDiagnostic;
let course;
let lastDiagnosticSubmission;
const adaptiveDirections = [];
for (let attempt = 0; attempt < diagnostic.maxQuestions; attempt += 1) {
  const question = diagnostic.questions.at(-1);
  assert(question, "adaptive diagnostic has no current question");
  const adaptiveAnswer = attempt % 2 === 0
    ? "我的判断依据是先检查输入与约束，因为需要保证状态一致。步骤：首先记录当前状态，然后执行最小操作，最后使用 SQL 事务、锁和测试断言验证结果；还要覆盖边界、失败、异常和性能指标。"
    : "不知道。";
  lastDiagnosticSubmission = { assessmentId: diagnostic.id, questionId: question.id, answer: adaptiveAnswer };
  const streamed = await postDiagnosticProgress(lastDiagnosticSubmission);
  assert(streamed.progress.some((item) => item.stage === "grade_answer"), "diagnostic progress stream is missing the examiner grading stage");
  assert(streamed.progress.some((item) => item.stage === "update_bounds"), "diagnostic progress stream is missing the boundary update stage");
  assert(streamed.progress.at(-1)?.percent === 100, "diagnostic progress stream did not finish at 100%");
  if (streamed.result.questionResult?.direction) adaptiveDirections.push(streamed.result.questionResult.direction);
  if (streamed.result.complete) {
    diagnosed = streamed.result;
    break;
  }
  const nextDiagnostic = streamed.result.assessment;
  assert(nextDiagnostic.questions.length === diagnostic.questions.length + 1, "adaptive diagnostic did not persist exactly one next question");
  assert(nextDiagnostic.questions.every((item) => !/给出一个具体场景|说明你的判断、做法以及如何验证/.test(item.prompt)), "adaptive follow-up question fell back to a generic template");
  diagnostic = nextDiagnostic;
}
assert(diagnosed, "adaptive diagnostic did not converge within maxQuestions");
assert(adaptiveDirections.includes("harder"), "high-score answers did not trigger a higher-difficulty probe");
assert(adaptiveDirections.includes("easier"), "low-score answers did not trigger a lower-difficulty probe");
assert(Number.isFinite(diagnosed.grade?.score), "initial diagnostic did not return a score");
replayedDiagnostic = (await postDiagnosticProgress(lastDiagnosticSubmission)).result;
assert(replayedDiagnostic.replayed === true, "completed adaptive diagnostic was not replay-safe");
assert(replayedDiagnostic.grade.score === diagnosed.grade.score, "replaying adaptive diagnostic changed its score");
course = diagnosed.program;

if (process.env.GROWTH_LOOP_LEGACY_DIAGNOSTIC_SMOKE === "1") {
const diagnostic = prepared.preparation.diagnostic;
assert(diagnostic?.questions?.length === 5, `一知半解应生成 5 道诊断题，实际 ${diagnostic?.questions?.length}`);
assert(diagnostic.questions.every((question) => !question.referenceAnswer && !question.rubric), "诊断接口泄露了参考答案或 rubric");

const diagnosticAnswers = Object.fromEntries(diagnostic.questions.map((question) => [
  question.id,
  "我的判断是先明确目标和约束，因为需要知道成功依据。步骤是：首先列出输入，然后执行最小动作，最后用测试结果和验收标准验证是否有效。",
]));
const diagnosed = await post("/api/diagnostics", { assessmentId: diagnostic.id, answers: diagnosticAnswers });
assert(Number.isFinite(diagnosed.grade?.score), "初始诊断没有返回分数");
const replayedDiagnostic = await post("/api/diagnostics", { assessmentId: diagnostic.id, answers: diagnosticAnswers });
assert(replayedDiagnostic.replayed === true, "重复提交已完成诊断没有返回同一份持久化结果");
assert(replayedDiagnostic.grade.score === diagnosed.grade.score, "重复提交诊断改变了基线分数");
void diagnosed.program;
}
assert(course?.programId, "课程没有返回 programId");
assert(Array.isArray(course.lessons) && course.lessons.length > 5, `长周期高投入目标应生成超过 5 节课程，实际 ${course.lessons?.length}`);
assert(course.lessons[0].generationStatus === "ready" && course.lessons[0].questions?.length === 3, "首节课程没有完整生成");
assert(course.lessons[0].qualityStatus === "passed", "首节课程没有通过 V0.4.3 教学质量门禁");
assert(course.lessons[0].sourceStatus === "unverified", "未接入 RAG 的 Demo 课程没有明确标记为 unverified");
assert(course.lessons[0].legacyContent === false, "V0.4.3 新课程被错误标记成旧版正文");
assert(course.lessons[0].blocks?.length >= 5, "首节课程没有返回结构化 LearningBlock");
const publishedBlockIds = new Set(course.lessons[0].blocks.map((block) => block.id));
assert(course.lessons[0].questions.every((question) => question.contentVersionId === course.lessons[0].contentVersionId), "课后题没有绑定当前课程内容版本");
assert(course.lessons[0].questions.every((question) => question.taughtBlockIds?.length > 0), "课后题缺少 taughtBlockIds");
assert(course.lessons[0].questions.every((question) => question.taughtBlockIds.every((id) => publishedBlockIds.has(id))), "课后题引用了不存在的教学块");
assert(course.lessons[0].questions.every((question) => question.expectedConcepts?.length > 0), "课后题缺少预期概念证据");
assert(course.lessons.slice(1).every((lesson) => lesson.generationStatus === "planned" && lesson.questions.length === 0), "后续章节不应提前生成正文和题目");
assert(course.instructor?.name && course.instructor?.openingMessage, "缺少 AI 讲师设定");
assert(
  course.lessons.every((lesson) => lesson.questions.every((question) => !question.rubric && !question.referenceAnswer)),
  "课程下发了参考答案或 rubric，评分标准必须留在服务端",
);
if (requireLlm) assert(course.mode === "llm", `课程未由 LLM 生成：${course.mode}`);

const lesson = course.lessons[0];

// 课程任务必须通过 lessonId 关联，而不是靠标题匹配。
const { task } = await post("/api/tasks", { lessonId: lesson.id });
assert(task?.id && task.lessonId === lesson.id, "课程任务没有与章节建立关联");
const { data: dashboard } = await call("/api/dashboard");
assert(dashboard.tasks.some((item) => item.id === task.id && item.lessonId === lesson.id), "仪表盘没有回读到任务与章节的关联");

// 关联课程的任务不能通过普通 PATCH 手工完成。
const manualComplete = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}`, {
  method: "PATCH",
  headers: { Cookie: cookie },
});
assert(manualComplete.status === 409, `课程任务手工完成应被拒绝，实际状态码 ${manualComplete.status}`);

const tutor = await post("/api/learning-program", {
  action: "tutor",
  programId: course.programId,
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

async function grade() {
  const result = await post("/api/learning-program", {
    action: "grade",
    programId: course.programId,
    lessonId: lesson.id,
    answers,
  });
  assert(Number.isFinite(result.grade?.score), "课后题没有返回分数");
  assert(result.grade.feedback?.length === lesson.questions.length, "课后题反馈数量不匹配");
  return result;
}

const firstResult = await grade();
const first = firstResult.grade;
if (requireLlm) assert(first.gradedBy === "llm", `课后评分未由 LLM 完成：${first.gradedBy}`);
assert(first.attemptNumber === 1, `首次评测的 attemptNumber 应为 1，实际为 ${first.attemptNumber}`);
assert(first.passed, `高质量答案应通过首节评测，实际 ${first.score} 分`);
assert(first.mastery?.evidenceCount >= 2, "课后评测没有在诊断证据上继续更新能力掌握度");
const nextLesson = firstResult.program?.lessons?.[1];
assert(nextLesson?.generationStatus === "ready", "首节通过后没有按需生成下一节正文");
assert(nextLesson?.qualityStatus === "passed" && nextLesson.blocks?.length >= 5, "下一节没有经过结构化课程质量门禁");
assert(nextLesson.questions.every((question) => question.taughtBlockIds?.length > 0), "下一节题目没有绑定教学块");
assert(nextLesson.difficulty === Math.min(5, course.lessons[1].difficulty + 1), "高分后下一节难度没有按规则上调");

const { data: dashboardAfterPass } = await call("/api/dashboard");
assert(dashboardAfterPass.tasks.some((item) => item.id === task.id && item.status === "done"), "评测通过后关联任务没有在同一闭环中完成");

// 重测不覆盖历史尝试，attempt_number 必须递增。
const second = (await grade()).grade;
assert(second.attemptNumber === 2, `重测的 attemptNumber 应为 2，实际为 ${second.attemptNumber}`);

// 不带任何本地缓存重新拉取课程，进度应当仍然可以恢复。
const reloaded = await call(`/api/learning-program?program=${encodeURIComponent(course.programId)}`);
assert(reloaded.program?.programId === course.programId, "按 programId 读不回课程");
const reloadedLesson = reloaded.program.lessons.find((item) => item.id === lesson.id);
assert(reloadedLesson, "重新读取的课程缺少目标章节");
if (second.passed) assert(reloadedLesson.status === "passed", "合格后章节状态没有落库");

const current = await call("/api/learning-program?program=current");
assert(current.program?.programId === course.programId, "读不到当前进行中的课程");

// 初学者跳过诊断，但必须明确选择；首节从未知基线开始生成。
const { goal: beginnerGoal } = await post("/api/goals", {
  title: "学习 SQL 基础",
  description: "能独立写出并解释基础查询。",
  targetDate,
  background: "尚未系统学习",
  weeklyHours: 3,
  selfLevel: "beginner",
});
const beginnerPrepared = await post("/api/learning-program", { action: "prepare", goalId: beginnerGoal.id });
assert(beginnerPrepared.preparation?.nextAction === "course", "初学者不应被强制送入初始诊断");
assert(beginnerPrepared.preparation.program?.lessons?.[0]?.generationStatus === "ready", "初学者首节没有生成");
assert(
  beginnerPrepared.preparation.program.lessons.length < course.lessons.length,
  "课程规模没有随目标周期和每周投入动态变化",
);
const { data: multiGoalDashboard } = await call("/api/dashboard");
const familiarGoalState = multiGoalDashboard.goals.find((item) => item.id === goal.id);
const beginnerGoalState = multiGoalDashboard.goals.find((item) => item.id === beginnerGoal.id);
assert(familiarGoalState?.diagnosticStatus === "completed" && familiarGoalState.learningProgramId === course.programId, "仪表盘没有返回已诊断目标的课程切换信息");
assert(beginnerGoalState?.diagnosticStatus === "skipped" && beginnerGoalState.learningProgramId === beginnerPrepared.preparation.program.programId, "仪表盘没有返回初学者目标的课程切换信息");

// 删除长期目标必须同时清理课程生成的今日任务，并且不能影响其他目标。
const beginnerProgramId = beginnerPrepared.preparation.program.programId;
const beginnerLessonId = beginnerPrepared.preparation.program.lessons[0].id;
const { task: beginnerTask } = await post("/api/tasks", { lessonId: beginnerLessonId });
const deletedGoal = await call("/api/goals", { method: "DELETE", body: JSON.stringify({ goalId: beginnerGoal.id }) });
assert(deletedGoal.deleted?.id === beginnerGoal.id, "删除接口没有返回正确的目标");
assert(deletedGoal.deleted.deletedTaskIds?.includes(beginnerTask.id), "删除目标时没有清理课程关联任务");
const { data: dashboardAfterDelete } = await call("/api/dashboard");
assert(!dashboardAfterDelete.goals.some((item) => item.id === beginnerGoal.id), "已删除目标仍出现在仪表盘");
assert(!dashboardAfterDelete.tasks.some((item) => item.id === beginnerTask.id), "已删除目标的课程任务仍出现在仪表盘");
assert(dashboardAfterDelete.goals.some((item) => item.id === goal.id), "删除一个目标错误影响了其他目标");
const deletedProgram = await call(`/api/learning-program?program=${encodeURIComponent(beginnerProgramId)}`);
assert(deletedProgram.program === null, "删除目标后仍能读取其课程");

console.log(
  JSON.stringify({
    ok: true,
    account: username,
    goalId: goal.id,
    targetDate: goal.targetDate,
    horizon: goal.horizon,
    programId: course.programId,
    title: course.title,
    lessons: course.lessons.length,
    questionsPerLesson: course.lessons.map((item) => item.questions.length),
    diagnosticScore: diagnosed.grade.score,
    courseMode: course.mode,
    tutorMode: tutor.reply.mode,
    gradingMode: second.gradedBy,
    score: second.score,
    attempts: [first.attemptNumber, second.attemptNumber],
    lessonStatus: reloadedLesson.status,
    linkedTaskId: task.id,
    nextLessonStatus: nextLesson.generationStatus,
    diagnosticReplay: replayedDiagnostic.replayed,
    beginnerBranch: beginnerPrepared.preparation.nextAction,
    switchableGoals: multiGoalDashboard.goals.filter((item) => item.learningProgramId).length,
    progressStages: prepared.progress.map((item) => item.stage),
    deletedGoalId: deletedGoal.deleted.id,
    deletedTaskCount: deletedGoal.deleted.deletedTasks,
  }),
);
