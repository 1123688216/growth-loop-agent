import type { AgentIntent } from "./provider";

export type QuizQuestion = {
  id: string;
  prompt: string;
  hint: string;
  rubric: string;
};

type InternalQuizQuestion = QuizQuestion & {
  keywords: string[];
};

export type GeneratedQuiz = {
  quizId: string;
  topic: string;
  sourceSummary: string;
  questions: QuizQuestion[];
  internalQuestions: InternalQuizQuestion[];
  mode: "demo" | "llm";
  provider: string;
};

export type QuizFeedback = {
  questionId: string;
  score: number;
  comment: string;
  modelAnswer: string;
};

export type QuizGrade = {
  quizId: string;
  score: number;
  level: "需要回看" | "基本掌握" | "迁移得不错";
  summary: string;
  nextHabit: string;
  feedback: QuizFeedback[];
  mode: "demo" | "llm";
  provider: string;
  gradedBy: "llm" | "rules";
};

type LlmCallResult = {
  configured: boolean;
  provider: string;
  content?: string;
};

type LlmConfig = {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function firstEnv(...keys: string[]) {
  return keys.map((key) => process.env[key]?.trim()).find(Boolean);
}

function readConfig(): LlmConfig {
  const provider = firstEnv("LLM_PROVIDER", "LLM_PROFILE") ?? "demo";
  const normalizedProvider = provider.toLowerCase();

  return {
    provider,
    baseUrl: firstEnv(
      "LLM_BASE_URL",
      normalizedProvider === "openai" ? "OPENAI_BASE_URL" : "",
      normalizedProvider === "deepseek" ? "DEEPSEEK_BASE_URL" : "",
      normalizedProvider === "glm" ? "GLM_BASE_URL" : "",
    ),
    apiKey: firstEnv(
      "LLM_API_KEY",
      normalizedProvider === "openai" ? "OPENAI_API_KEY" : "",
      normalizedProvider === "deepseek" ? "DEEPSEEK_API_KEY" : "",
      normalizedProvider === "glm" ? "GLM_API_KEY" : "",
    ),
    model: firstEnv(
      "LLM_MODEL",
      normalizedProvider === "openai" ? "OPENAI_MODEL" : "",
      normalizedProvider === "deepseek" ? "DEEPSEEK_MODEL" : "",
      normalizedProvider === "glm" ? "GLM_MODEL" : "",
    ),
  };
}

async function callLlm(messages: Array<{ role: "system" | "user"; content: string }>, timeoutMs = 25_000): Promise<LlmCallResult> {
  const config = readConfig();
  const configured = Boolean(config.baseUrl && config.apiKey && config.model);
  if (!configured) return { configured: false, provider: config.provider };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { configured: true, provider: config.provider };
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { configured: true, provider: config.provider, content: data.choices?.[0]?.message?.content?.trim() };
  } catch {
    return { configured: true, provider: config.provider };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return undefined;
    }
  }
}

function pickKeywords(source: string, topic: string) {
  const candidates = normalizeText(`${topic} ${source}`)
    .replace(/[，。；：、,.!?！？()（）“”‘’\[\]{}<>《》]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !/^(分钟|今天|学习|完成|记录|输出|内容|自己|一个|这个|然后|以及|还有)$/.test(word));
  return Array.from(new Set(candidates)).slice(0, 5);
}

function publicQuestion(question: InternalQuizQuestion): QuizQuestion {
  return {
    id: question.id,
    prompt: question.prompt,
    hint: question.hint,
    rubric: question.rubric,
  };
}

function buildRuleQuiz(content: string, topicInput?: string, output?: string): GeneratedQuiz {
  const topic = normalizeText(topicInput || "") || "这次学习内容";
  const sourceSummary = normalizeText([content, output ? `我的补充：${output}` : ""].filter(Boolean).join("；")).slice(0, 180);
  const keywords = pickKeywords(sourceSummary, topic);
  const quizId = `quiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const internalQuestions: InternalQuizQuestion[] = [
    {
      id: "concept",
      prompt: `解释「${topic}」里最重要的一个概念，并说明它解决了什么问题。`,
      hint: "不要抄定义，至少写出“概念 + 作用”。",
      rubric: "概念准确；能说出作用或因果关系",
      keywords,
    },
    {
      id: "application",
      prompt: `假设明天要把「${topic}」用到一个真实任务中，你会怎么做？请写出一个具体场景和步骤。`,
      hint: "用“场景 → 行动 → 结果”三段式回答。",
      rubric: "场景具体；步骤可执行；结果可验证",
      keywords,
    },
    {
      id: "teachback",
      prompt: `如果要把今天的内容教给朋友，你会留下哪三条要点？请尽量使用自己的表达。`,
      hint: "三条要点比一段泛泛的感想更有用。",
      rubric: "有结构；覆盖关键概念；能迁移到他人理解",
      keywords,
    },
  ];

  return {
    quizId,
    topic,
    sourceSummary,
    questions: internalQuestions.map(publicQuestion),
    internalQuestions,
    mode: "demo",
    provider: "rules",
  };
}

function modelQuestions(value: unknown, fallback: GeneratedQuiz) {
  if (!value || typeof value !== "object") return fallback;
  const data = value as { topic?: unknown; questions?: unknown };
  if (typeof data.topic !== "string" || !Array.isArray(data.questions) || data.questions.length < 2) return fallback;
  const questions = data.questions
    .slice(0, 3)
    .map((question, index) => {
      if (!question || typeof question !== "object") return undefined;
      const item = question as Record<string, unknown>;
      if (typeof item.prompt !== "string" || !item.prompt.trim()) return undefined;
      return {
        id: typeof item.id === "string" ? item.id : `q${index + 1}`,
        prompt: item.prompt.trim(),
        hint: typeof item.hint === "string" ? item.hint.trim() : "直接回答，并尽量给一个例子。",
        rubric: typeof item.rubric === "string" ? item.rubric.trim() : "准确理解；能够迁移应用",
        keywords: pickKeywords(fallback.sourceSummary, data.topic as string),
      } satisfies InternalQuizQuestion;
    })
    .filter((question): question is InternalQuizQuestion => Boolean(question));
  if (questions.length < 2) return fallback;
  return {
    ...fallback,
    topic: normalizeText(data.topic),
    questions: questions.map(publicQuestion),
    internalQuestions: questions,
    mode: "llm" as const,
    provider: fallback.provider,
  };
}

export async function generateLearningQuiz(content: string, topic?: string, output?: string): Promise<GeneratedQuiz> {
  const fallback = buildRuleQuiz(content, topic, output);
  const llm = await callLlm([
    {
      role: "system",
      content: "你是学习教练。根据用户的学习内容生成 2 到 3 道开放题，检查概念理解、迁移应用和教回能力。题目必须紧扣内容，不能考记忆细节。只返回 JSON：{\"topic\":\"...\",\"questions\":[{\"id\":\"q1\",\"prompt\":\"...\",\"hint\":\"...\",\"rubric\":\"...\"}]}。",
    },
    {
      role: "user",
      content: JSON.stringify({ topic, content, output }, null, 2),
    },
  ]);
  const generated = modelQuestions(parseJson<{ topic?: unknown; questions?: unknown }>(llm.content), fallback);
  if (generated.mode === "llm") return { ...generated, provider: llm.provider };
  return generated;
}

function scoreRuleAnswer(answer: string, question: InternalQuizQuestion) {
  const normalized = normalizeText(answer);
  if (!normalized) return 0;
  const lengthScore = normalized.length >= 45 ? 45 : normalized.length >= 20 ? 30 : 15;
  const keywordHits = question.keywords.filter((keyword) => normalized.includes(keyword)).length;
  const keywordScore = Math.min(35, keywordHits * 12);
  const structureScore = /因为|所以|例如|步骤|先|再|最后|结果|场景|问题|作用/.test(normalized) ? 20 : 5;
  return Math.min(100, lengthScore + keywordScore + structureScore);
}

function ruleGrade(quiz: GeneratedQuiz, answers: Record<string, string>): QuizGrade {
  const feedback = quiz.internalQuestions.map((question) => {
    const score = scoreRuleAnswer(answers[question.id] || "", question);
    const comment = score >= 80
      ? "解释和迁移都比较具体，可以继续用一个真实案例验证。"
      : score >= 55
        ? "已经抓到部分重点，再补一个因果关系或具体例子会更扎实。"
        : "先回看学习材料，再补上概念、作用和一个例子。";
    return {
      questionId: question.id,
      score,
      comment,
      modelAnswer: `参考方向：围绕「${quiz.topic}」说明概念、作用，并结合${question.id === "application" ? "一个可执行场景" : "一个具体例子"}。`,
    } satisfies QuizFeedback;
  });
  const score = Math.round(feedback.reduce((total, item) => total + item.score, 0) / feedback.length);
  const level = score >= 85 ? "迁移得不错" : score >= 60 ? "基本掌握" : "需要回看";
  return {
    quizId: quiz.quizId,
    score,
    level,
    summary: score >= 80 ? "你已经形成了清晰理解，下一步可以在真实任务里验证。" : "理解正在形成，补一次回看和教回，记忆会更稳。",
    nextHabit: score >= 70 ? "明天继续保留“学完立刻教回”的 3 分钟习惯。" : "明天先用 3 分钟回忆，再打开材料核对遗漏。",
    feedback,
    mode: "demo",
    provider: quiz.provider,
    gradedBy: "rules",
  };
}

function normalizeFeedback(value: unknown, quiz: GeneratedQuiz, answers: Record<string, string>): QuizFeedback[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byId = new Map(quiz.questions.map((question) => [question.id, question]));
  const feedback = value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const entry = item as Record<string, unknown>;
      if (typeof entry.questionId !== "string" || !byId.has(entry.questionId)) return undefined;
      const score = typeof entry.score === "number" ? Math.max(0, Math.min(100, Math.round(entry.score))) : undefined;
      if (score === undefined || typeof entry.comment !== "string") return undefined;
      return {
        questionId: entry.questionId,
        score,
        comment: entry.comment.trim(),
        modelAnswer: typeof entry.modelAnswer === "string" ? entry.modelAnswer.trim() : "结合原学习材料补一个更具体的例子。",
      } satisfies QuizFeedback;
    })
    .filter((item): item is QuizFeedback => Boolean(item));
  if (feedback.length < 2) return undefined;
  return quiz.questions.map((question) => feedback.find((item) => item.questionId === question.id) ?? {
    questionId: question.id,
    score: answers[question.id]?.trim() ? 50 : 0,
    comment: "请补充这道题的回答。",
    modelAnswer: "结合学习材料说明概念、作用和一个例子。",
  });
}

export async function gradeLearningQuiz(quiz: GeneratedQuiz, answers: Record<string, string>): Promise<QuizGrade> {
  const fallback = ruleGrade(quiz, answers);
  const llm = await callLlm([
    {
      role: "system",
      content: "你是严格但鼓励性的学习教练。根据学习材料、题目和用户回答评估理解，不按关键词机械匹配。概念准确性、因果解释、迁移应用和表达结构都要考虑。只返回 JSON：{\"score\":0,\"summary\":\"...\",\"nextHabit\":\"...\",\"feedback\":[{\"questionId\":\"q1\",\"score\":0,\"comment\":\"...\",\"modelAnswer\":\"...\"}]}。score 和每题 score 都是 0 到 100 的整数；不要羞辱用户，不做心理或医疗诊断。",
    },
    {
      role: "user",
      content: JSON.stringify({
        topic: quiz.topic,
        source: quiz.sourceSummary,
        questions: quiz.questions,
        answers,
      }, null, 2),
    },
  ]);
  const data = parseJson<{ score?: unknown; summary?: unknown; nextHabit?: unknown; feedback?: unknown }>(llm.content);
  const feedback = normalizeFeedback(data?.feedback, quiz, answers);
  if (!feedback || typeof data?.score !== "number") return fallback;
  const score = Math.max(0, Math.min(100, Math.round(data.score)));
  return {
    quizId: quiz.quizId,
    score,
    level: score >= 85 ? "迁移得不错" : score >= 60 ? "基本掌握" : "需要回看",
    summary: typeof data.summary === "string" && data.summary.trim() ? data.summary.trim() : fallback.summary,
    nextHabit: typeof data.nextHabit === "string" && data.nextHabit.trim() ? data.nextHabit.trim() : fallback.nextHabit,
    feedback,
    mode: "llm",
    provider: llm.provider,
    gradedBy: "llm",
  };
}

export function quizIntentLabel(intent: AgentIntent) {
  return intent === "plan_today" ? "计划" : intent === "review" ? "复盘" : "学习记录";
}
