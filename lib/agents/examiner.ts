import { asRecord, cleanText, requestStructured } from "@/lib/agents/shared";
import type {
  AdaptiveAnswerGradeDraft,
  AssessmentGradeDraft,
  DiagnosticQuestionDraft,
  PersistedSkill,
} from "@/lib/agents/types";
import type { CourseQuestionFeedback, DiagnosticQuestionKind } from "@/lib/learning-program/types";

const KINDS: DiagnosticQuestionKind[] = ["concept", "explanation", "application", "debugging", "design"];

type ExaminerGoal = { title: string; description: string };
type DiagnosticBlueprint = { questionCount: number; baseDifficulty: number };

function clampDifficulty(value: number) {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function kindForDifficulty(difficulty: number): DiagnosticQuestionKind {
  return (["concept", "explanation", "application", "debugging", "design"] as const)[clampDifficulty(difficulty) - 1];
}

function concretePrompt(goal: ExaminerGoal, skill: PersistedSkill, difficulty: number) {
  const level = clampDifficulty(difficulty);
  if (/并发|线程|锁|竞态|同步/.test(skill.name)) {
    const prompts = [
      "一个共享计数器初始为 0，两个线程各执行 1000 次 `count++`，最终结果偶尔小于 2000。请指出 `count++` 包含的三个步骤，并解释结果为什么会丢失。",
      "账户余额为 100 元，两个线程同时读取余额并各扣款 80 元。请写出一种可能的执行顺序、最终余额，并给出一种保证扣款正确的同步方案。",
      "下面的缓存采用 `if (!map.containsKey(k)) map.put(k, load(k))`。在 20 个线程请求同一 key 时，`load` 被调用多次。请定位竞态窗口，给出修复代码思路和并发测试断言。",
      "你要设计每秒 1 万次请求的库存扣减服务，要求不超卖、单商品高并发、失败可重试。请在数据库锁、CAS 与消息队列中选择方案，并说明幂等键和故障恢复。",
      "某团队用一把全局锁解决全部线程安全问题，正确但 P99 延迟升到 2 秒。请给出拆锁或无锁改造方案，分析死锁、活锁、ABA 和可观测性风险，并设计压测验证。",
    ];
    return prompts[level - 1];
  }
  if (/SQL|数据库|事务|索引/.test(skill.name)) {
    const prompts = [
      "表 `orders(id, user_id, amount, status, created_at)` 中要查询某用户最近 20 条已支付订单。请写出 SQL，并说明返回顺序。",
      "同一笔转账需要同时扣减 A 账户 100 元并增加 B 账户 100 元。请写出事务边界，并说明任一步失败时数据库应该处于什么状态。",
      "查询 `WHERE user_id=? AND status='paid' ORDER BY created_at DESC LIMIT 20` 在百万行后变慢。请设计联合索引，解释字段顺序，并给出 `EXPLAIN` 中希望看到的信号。",
      "订单写入主库后立刻查询只读副本，偶尔查不到。请在一致性、延迟和吞吐之间设计方案，并说明什么时候必须回主库。",
      "一个热点账户导致行锁竞争和大量死锁。请给出可落地的分片或队列化方案，说明事务隔离级别、重试幂等性与压测指标。",
    ];
    return prompts[level - 1];
  }
  if (/Agent|智能体|工具调用|工作流/.test(`${goal.title}${skill.name}`)) {
    const prompts = [
      "用户说“帮我规划学习 Agent”。请列出这个 Agent 最少需要保存的 3 个状态，以及每个状态怎样判断已经写入成功。",
      "学习助手收到“我今天学了线程池但没太懂”。请给出一次完整处理：需要提取什么结构化字段、调用什么工具、向用户返回什么可验证结果。",
      "一个 Agent 在工具超时后重复创建了两份任务。请定位缺失的控制机制，设计幂等键、重试条件和最小回归测试。",
      "请为“记录学习 → 出题校验 → 更新掌握度 → 安排下一课”设计状态图，明确每个节点的输入输出、失败分支和人工中断点。",
      "该学习 Agent 上线后任务完成率提高，但用户实际答题正确率下降。请设计证据链和对照实验，判断是奖励机制、题目泄露还是规划偏差造成的。",
    ];
    return prompts[level - 1];
  }

  const description = skill.description || goal.description || `完成${goal.title}`;
  const prompts = [
    `目标是「${goal.title}」。请用自己的话解释「${skill.name}」具体解决什么问题，并给出一个明确的输入和预期输出。背景要求：${description}`,
    `你正在交付「${goal.title}」，当前必须完成「${skill.name}」。已知验收要求是“结果可复现且能解释”。请列出 3 个执行步骤和每一步的检查结果。`,
    `某人按「${skill.name}」完成了「${goal.title}」，但只展示最终结果，没有输入、过程证据和失败用例。请指出至少 3 个缺陷，并补出一组可执行的验证。`,
    `请为「${goal.title}」中的「${skill.name}」设计一个可交付方案。约束：2 小时内完成、允许一次失败重试、结果必须能由第三方复核。请说明取舍和异常处理。`,
    `现有「${skill.name}」方案在小规模有效，但数据量扩大 100 倍后成本和错误率同时上升。请提出改造方案，给出容量边界、降级策略和至少 3 项验收指标。`,
  ];
  return prompts[level - 1];
}

function fallbackAdaptiveQuestion(input: { goal: ExaminerGoal; skill: PersistedSkill; difficulty: number }): DiagnosticQuestionDraft {
  const difficulty = clampDifficulty(input.difficulty);
  return {
    skillId: input.skill.id,
    kind: kindForDifficulty(difficulty),
    difficulty,
    prompt: concretePrompt(input.goal, input.skill, difficulty),
    hint: difficulty >= 4
      ? "请明确约束、取舍、失败路径和可观测指标。"
      : "请写出具体数据、步骤或代码，并说明怎样判断结果正确。",
    referenceAnswer: `回答应准确运用「${input.skill.name}」，覆盖：${input.skill.description}；同时给出可执行步骤、关键风险和可验证结果。`,
    rubric: "概念与判断 3 分；具体执行或代码 3 分；边界与风险 2 分；验证方法 2 分。",
    maxScore: 10,
  };
}

export async function buildAdaptiveQuestion(input: {
  goal: ExaminerGoal;
  skill: PersistedSkill;
  difficulty: number;
  previousEvidence?: { answer: string; score: number; feedback: string };
  previousPrompts?: string[];
}) {
  const fallback = fallbackAdaptiveQuestion(input);
  const difficulty = fallback.difficulty;
  return requestStructured({
    fallback,
    system: "你是自适应诊断考官。一次只出一道自包含、可评分的具体题，不教学、不泄露答案。题干必须自带具体数据、代码、约束、故障现象或明确交付物；禁止让用户自己虚构场景。只输出严格 JSON。",
    user: `学习目标：${JSON.stringify(input.goal)}\n当前能力：${JSON.stringify(input.skill)}\n目标难度：${difficulty}/5\n上一题证据：${JSON.stringify(input.previousEvidence || null)}\n已出题干（不得重复）：${JSON.stringify(input.previousPrompts?.slice(-5) || [])}\n请输出 skillId、kind、difficulty、prompt、hint、referenceAnswer、rubric、maxScore。难度 1 检查基本理解，2 检查固定情境应用，3 检查调试和边界，4 检查方案设计与取舍，5 检查复杂故障、规模化和反例。maxScore 固定为 10。`,
    normalize(raw) {
      const item = asRecord(raw);
      const prompt = cleanText(item?.prompt, fallback.prompt, 1200);
      const kind = cleanText(item?.kind, fallback.kind, 30) as DiagnosticQuestionKind;
      const vague = /给出一个具体场景|围绕[「\s]|说明你的判断、做法以及如何验证/.test(prompt);
      return {
        skillId: input.skill.id,
        kind: KINDS.includes(kind) ? kind : fallback.kind,
        difficulty,
        prompt: vague ? fallback.prompt : prompt,
        hint: cleanText(item?.hint, fallback.hint, 500),
        referenceAnswer: cleanText(item?.referenceAnswer, fallback.referenceAnswer, 1800),
        rubric: cleanText(item?.rubric, fallback.rubric, 1000),
        maxScore: 10,
      };
    },
  });
}

function ruleScore(answer: string, maxScore: number) {
  const text = answer.trim();
  if (!text) return 0;
  let score = Math.min(maxScore * 0.45, text.length / 45 * maxScore * 0.45);
  if (/因为|依据|原因|判断|原子|事务|锁|索引|状态|约束/.test(text)) score += maxScore * 0.18;
  if (/步骤|首先|然后|最后|1[.、]|2[.、]|代码|SQL|测试/.test(text)) score += maxScore * 0.17;
  if (/验证|断言|检查|结果|指标|边界|失败|异常/.test(text)) score += maxScore * 0.2;
  return Math.round(Math.min(maxScore, score));
}

export async function gradeAdaptiveAnswer(input: { question: DiagnosticQuestionDraft & { id: string }; answer: string }) {
  const fallbackScore = ruleScore(input.answer, input.question.maxScore);
  const fallback: AdaptiveAnswerGradeDraft = {
    score: fallbackScore,
    feedback: fallbackScore >= 8
      ? "答案包含了明确做法和验证证据，可以继续上探难度。"
      : fallbackScore <= 4
        ? "当前答案缺少关键依据或可验证步骤，下一题会降低难度确认基础边界。"
        : "答案体现了部分理解，但边界和验证还不完整，将继续在相近难度确认。",
    evidenceSummary: cleanText(input.answer, "暂无有效证据", 240),
    gradedBy: "rules",
    provider: "本地规则",
    model: "",
  };
  const result = await requestStructured({
    fallback,
    system: "你是自适应诊断考官。仅依据当前题目、固定参考答案、rubric 和用户本题作答评分。不要教学式放宽标准，不因表达长度加分。只输出严格 JSON。",
    user: `题目：${JSON.stringify(input.question)}\n用户作答：${JSON.stringify(input.answer)}\n输出 score（0-10 整数）、feedback（指出已证明和未证明的能力）、evidenceSummary（不超过120字）。`,
    normalize(raw) {
      const numericScore = Number(raw.score);
      return {
        score: Number.isFinite(numericScore) ? Math.max(0, Math.min(10, Math.round(numericScore))) : fallback.score,
        feedback: cleanText(raw.feedback, fallback.feedback, 700),
        evidenceSummary: cleanText(raw.evidenceSummary, fallback.evidenceSummary, 300),
        gradedBy: "rules" as const,
        provider: "",
        model: "",
      };
    },
  });
  return { ...result, data: { ...result.data, gradedBy: result.mode, provider: result.provider, model: result.model } };
}

export async function summarizeAdaptiveDiagnostic(input: {
  skills: PersistedSkill[];
  skillScores: Record<string, number>;
  responses: Array<{ questionId: string; skillId: string; score: number; maxScore: number; feedback: string }>;
}) {
  const scoreValues = Object.values(input.skillScores);
  const score = scoreValues.length ? Math.round(scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length) : 0;
  const fallbackFeedback: CourseQuestionFeedback[] = input.responses.map((response) => ({
    questionId: response.questionId,
    score: response.score,
    maxScore: response.maxScore,
    feedback: response.feedback,
    reference: "",
  }));
  const fallback: AssessmentGradeDraft = {
    score,
    summary: score >= 75 ? "已探测到较高的能力上界，课程将减少基础重复并增加复杂实践。" : score >= 40 ? "已经找到部分稳定能力和明显薄弱点，课程将从边界附近开始。" : "基础证据仍较弱，课程将先补齐核心概念和固定情境应用。",
    nextStep: "根据逐题证据和能力上下界生成首节课程。",
    feedback: fallbackFeedback,
    skillScores: input.skillScores,
    gradedBy: "rules",
    provider: "本地规则",
    model: "",
  };
  const result = await requestStructured({
    fallback,
    system: "你是诊断考官，只汇总已评分的逐题证据，不重新改分。总结要指出已确认的能力上界、薄弱边界和课程起点。只输出严格 JSON。",
    user: `能力：${JSON.stringify(input.skills)}\n逐题证据：${JSON.stringify(input.responses)}\n固定能力得分：${JSON.stringify(input.skillScores)}\n输出 summary 和 nextStep。`,
    normalize(raw) {
      return {
        ...fallback,
        summary: cleanText(raw.summary, fallback.summary, 1000),
        nextStep: cleanText(raw.nextStep, fallback.nextStep, 500),
      };
    },
  });
  return { ...result, data: { ...result.data, gradedBy: result.mode, provider: result.provider, model: result.model } };
}

// 兼容旧的整套诊断：新目标改走 buildAdaptiveQuestion，旧调用仍得到具体题而非模板题。
function fallbackQuestions(goal: ExaminerGoal, skills: PersistedSkill[], blueprint: DiagnosticBlueprint): DiagnosticQuestionDraft[] {
  return Array.from({ length: blueprint.questionCount }, (_, index) => fallbackAdaptiveQuestion({
    goal,
    skill: skills[index % skills.length],
    difficulty: Math.min(5, blueprint.baseDifficulty + (index % 3)),
  }));
}

export async function buildDiagnostic(goal: ExaminerGoal, skills: PersistedSkill[], blueprint: DiagnosticBlueprint) {
  const count = Math.max(5, Math.min(8, Math.round(blueprint.questionCount)));
  const safeBlueprint = { questionCount: count, baseDifficulty: clampDifficulty(blueprint.baseDifficulty) };
  const fallback = fallbackQuestions(goal, skills, safeBlueprint);
  const allowed = new Set(skills.map((skill) => skill.id));
  return requestStructured({
    fallback,
    system: "你是独立考官。每道题必须提供具体数据、约束、代码或故障现象，禁止使用‘请给出一个具体场景’之类模板题。只输出严格 JSON。",
    user: `学习目标：${JSON.stringify(goal)}\n能力清单：${JSON.stringify(skills)}\n诊断蓝图：${JSON.stringify(safeBlueprint)}\n生成恰好 ${count} 道具体开放题，输出 {"questions":[...]}。`,
    normalize(raw) {
      const values = Array.isArray(raw.questions) ? raw.questions.slice(0, count) : [];
      if (values.length !== count) return fallback;
      return values.map((value, index) => {
        const item = asRecord(value);
        const source = fallback[index];
        const skillId = cleanText(item?.skillId, source.skillId, 180);
        const prompt = cleanText(item?.prompt, source.prompt, 1200);
        return {
          ...source,
          skillId: allowed.has(skillId) ? skillId : source.skillId,
          prompt: /给出一个具体场景|说明你的判断、做法以及如何验证/.test(prompt) ? source.prompt : prompt,
          hint: cleanText(item?.hint, source.hint, 500),
          referenceAnswer: cleanText(item?.referenceAnswer, source.referenceAnswer, 1800),
          rubric: cleanText(item?.rubric, source.rubric, 1000),
        };
      });
    },
  });
}

export async function gradeDiagnostic(input: { questions: Array<DiagnosticQuestionDraft & { id: string }>; answers: Record<string, string> }) {
  const feedback: CourseQuestionFeedback[] = [];
  for (const question of input.questions) {
    const graded = await gradeAdaptiveAnswer({ question, answer: input.answers[question.id] || "" });
    feedback.push({ questionId: question.id, score: graded.data.score, maxScore: question.maxScore, feedback: graded.data.feedback, reference: question.referenceAnswer });
  }
  const grouped = new Map<string, { score: number; max: number }>();
  input.questions.forEach((question, index) => {
    const current = grouped.get(question.skillId) || { score: 0, max: 0 };
    current.score += feedback[index].score;
    current.max += feedback[index].maxScore;
    grouped.set(question.skillId, current);
  });
  const skillScores = Object.fromEntries([...grouped].map(([skillId, value]) => [skillId, Math.round(value.score / Math.max(1, value.max) * 100)]));
  return summarizeAdaptiveDiagnostic({
    skills: [...new Set(input.questions.map((question) => question.skillId))].map((id) => ({ id, name: id, description: "", targetLevel: 3, weight: 1 })),
    skillScores,
    responses: input.questions.map((question, index) => ({ questionId: question.id, skillId: question.skillId, score: feedback[index].score, maxScore: feedback[index].maxScore, feedback: feedback[index].feedback })),
  });
}
