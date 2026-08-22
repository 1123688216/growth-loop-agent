import type {
  CourseGenerationInput,
  CourseLesson,
  CourseLessonGrade,
  CourseQuestion,
  CourseQuestionFeedback,
  CourseQuestionKind,
  LearningProgram,
  LessonTutorReply,
} from "@/lib/learning-program/types";

type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
};

type UnknownRecord = Record<string, unknown>;

const MAX_LESSONS = 5;
const DEFAULT_LESSON_COUNT = 5;

function text(value: unknown, fallback = "", max = 1200) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : fallback;
}

function stringList(value: unknown, fallback: string[], maxItems = 6) {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => text(item, "", 160))
    .filter(Boolean)
    .slice(0, maxItems);
  return items.length ? items : fallback;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAgentSubject(subject: string) {
  return /(\bagent\b|智能体|代理系统|工具调用|tool\s*calling)/i.test(subject);
}

function questionSet(
  lessonId: string,
  concepts: string[],
  objective: string,
): CourseQuestion[] {
  const [first = "核心概念", second = "方法", third = "边界"] = concepts;
  return [
    {
      id: `${lessonId}-understand`,
      kind: "理解",
      prompt: `用自己的话说明「${first}」在本节中的作用，并说出它和「${second}」的关系。`,
      hint: "先给定义，再说它在流程中解决了什么问题。",
      rubric: `能准确解释 ${first}，并把它和 ${second} 放进同一个因果或工作流程中。`,
    },
    {
      id: `${lessonId}-apply`,
      kind: "迁移",
      prompt: `选一个你正在面对的真实场景，说明你会怎样用本节的「${second}」达成「${objective}」。`,
      hint: "写出场景、行动和你会观察的结果。",
      rubric: `答案应包含具体场景、可执行行动，以及至少一个可观察的结果或验证点。`,
    },
    {
      id: `${lessonId}-teach`,
      kind: "教回",
      prompt: `假设要向刚入门的同学解释本节，请用一个例子讲清「${third}」为什么不能忽略。`,
      hint: "避免背定义，用一个反例或取舍来讲。",
      rubric: `能用通俗例子说明 ${third} 的风险、取舍或限制，而不只是重复术语。`,
    },
  ];
}

function genericLessons(subject: string, goal: string, lessonCount: number): CourseLesson[] {
  const templates = [
    {
      phase: "定向",
      title: "把学习目标变成可验证的结果",
      objective: "明确范围、起点和一件能交付的小成果",
      concepts: ["学习边界", "成功标准", "最小成果"],
      explanation: `学习 ${subject} 时，先不要用“全部学会”做目标。把 ${goal} 拆成能看见、能检查的最小成果，才知道接下来该学什么、暂时不学什么。`,
      example: `例如，把“了解 ${subject}”改写为“能用自己的话解释一个核心概念，并完成一份小型输出”。这样每一次练习都有明确的完成判据。`,
      practice: "写下你的起点、一个暂不处理的范围，以及本课程结束时要拿得出的作品或表现。",
      deliverable: "一页学习契约：目标、边界、验收方式和每周投入。",
    },
    {
      phase: "建模",
      title: "建立核心概念之间的地图",
      objective: "用关系而非零散名词理解主题",
      concepts: ["核心概念", "因果关系", "系统地图"],
      explanation: `${subject} 的入门难点通常不是术语多，而是不知道术语彼此怎样作用。把概念放进“输入—过程—输出—反馈”的地图，能让后面的资料有位置可放。`,
      example: "遇到一个新概念时，不只记定义，而是补上：它解决什么问题、依赖什么、会影响什么、失效时有什么征兆。",
      practice: `从 ${subject} 中挑出 5 个关键词，画出它们之间的箭头，并在每条箭头旁写明关系。`,
      deliverable: "一张可继续补充的概念关系图。",
    },
    {
      phase: "方法",
      title: "在一个典型案例中走完整流程",
      objective: "把抽象方法放进真实决策过程",
      concepts: ["典型流程", "案例拆解", "判断依据"],
      explanation: `真正掌握 ${subject}，要能在案例中说出“下一步为什么这样做”。本节用一个从问题到结果的典型流程，把前一节的概念地图变成可执行步骤。`,
      example: "分析案例时先列出约束和目标，再标记关键选择，最后回看结果是否由这些选择带来；不要只复述过程。",
      practice: "找一个公开案例或自己的经历，按“目标—约束—选择—结果—复盘”五格完成拆解。",
      deliverable: "一份带有判断依据的案例卡片。",
    },
    {
      phase: "刻意练习",
      title: "把知识转成一次有反馈的练习",
      objective: "完成一次小而完整的应用循环",
      concepts: ["刻意练习", "反馈信号", "迭代"],
      explanation: `阅读会制造熟悉感，练习才暴露理解的空洞。为 ${subject} 设计一个时间受限的小任务：先做出版本，再根据明确反馈修一次。`,
      example: "反馈不必等于他人评价。能否解释选择、能否复现结果、是否符合事先标准，都是可以使用的反馈信号。",
      practice: "用 45 分钟完成一个小练习；最后留 10 分钟列出一个有效点、一个不确定点和下一次要改的动作。",
      deliverable: "练习版本 + 一份三条复盘记录。",
    },
    {
      phase: "迁移",
      title: "做出自己的小项目并教回知识",
      objective: "把方法迁移到一个新场景，并形成可复用说明",
      concepts: ["迁移", "项目闭环", "教回"],
      explanation: `课程的终点不是“看完”，而是你能在新场景中独立判断。选择一个和原案例不同、但足够小的项目，把学习成果做成别人能看懂的说明。`,
      example: "如果发现做不下去，通常不是能力不足，而是项目边界太大；优先缩小输入、减少步骤或降低交付粒度。",
      practice: `完成一个与 ${subject} 相关的迷你项目，并录制或写下 3 分钟的“我如何做出取舍”的教回说明。`,
      deliverable: "可运行/可展示的小项目 + 教回笔记 + 下一阶段学习清单。",
    },
  ];

  return templates.slice(0, lessonCount).map((template, index) => {
    const id = `lesson-${index + 1}`;
    return {
      id,
      order: index + 1,
      phase: template.phase,
      title: template.title,
      durationMinutes: index === 3 ? 60 : 45,
      objective: template.objective,
      concepts: template.concepts,
      opening: `第 ${index + 1} 节先把注意力放在“${template.objective}”上，不追求一次覆盖所有资料。`,
      explanation: template.explanation,
      example: template.example,
      practice: template.practice,
      deliverable: template.deliverable,
      questions: questionSet(id, template.concepts, template.objective),
    };
  });
}

function agentLessons(goal: string, lessonCount: number): CourseLesson[] {
  const templates = [
    {
      phase: "定向",
      title: "从任务目标定义 Agent 的闭环",
      objective: "区分聊天机器人和能完成任务的 Agent，并定义最小验收",
      concepts: ["任务闭环", "验收条件", "最小 Agent"],
      explanation: "Agent 不是给模型套一个名字。它至少要知道任务目标、可用动作、完成条件和失败时怎样收束。先用一个单一任务定义闭环，后续能力才不会变成堆砌。",
      example: "“帮我整理学习记录”可拆成：读入记录、提取待办、生成晚间问题、让用户确认。每一步都能被检查，而不是只看一段漂亮回复。",
      practice: `围绕“${goal}”，写出一个 Agent 的输入、允许动作、完成条件与一个明确的不做事项。`,
      deliverable: "一份最小 Agent 任务契约。",
    },
    {
      phase: "建模",
      title: "理解模型、上下文、工具与状态",
      objective: "画出 Agent 运行时的四个核心部件及其数据流",
      concepts: ["上下文", "工具调用", "状态"],
      explanation: "模型负责理解和选择，不等于系统本身。上下文决定它看见什么，工具让它能做事，状态让多轮任务保持连续。把四者分开，才能定位问题来自推理、数据还是执行。",
      example: "同一句“把今天的笔记变成计划”，如果没有今日笔记上下文就会猜；没有写入工具就只能建议；没有状态就无法知道计划是否已创建。",
      practice: "为你的 Agent 画一张输入—上下文—模型决策—工具—状态—用户回显的数据流图。",
      deliverable: "一张六节点运行时数据流图。",
    },
    {
      phase: "工具",
      title: "把一个可靠工具接进决策流程",
      objective: "为 Agent 设计小而清晰的工具契约与回退路径",
      concepts: ["工具契约", "参数校验", "执行回显"],
      explanation: "好的工具调用不是让模型随意拼请求。工具要有清楚的名称、输入字段、校验规则和可读的结果。让规则层处理授权与验证，模型只做理解、选择和解释。",
      example: "创建待办工具可以只接受标题、日期和优先级；日期格式不合法时由代码拒绝并返回可修复提示，而不是让模型猜测后继续写入。",
      practice: "为一个真实工具写下名称、输入 JSON、允许范围、成功结果和失败结果；再列出一个不能由模型自行决定的动作。",
      deliverable: "一份可实现的工具接口卡。",
    },
    {
      phase: "工程",
      title: "让 Agent 面对错误、边界和可观察性",
      objective: "为常见失败建立可恢复、可解释的处理方式",
      concepts: ["失败收束", "人工确认", "可观察性"],
      explanation: "Agent 的质量不只由成功回答决定，也取决于它怎样拒绝、降级和留痕。外部写入、身份不确定和工具异常都应该有明确边界，而不是默默假装完成。",
      example: "当搜索工具不可用时，Agent 可以说明“当前无法验证”，保存用户问题并建议下一步；这比编造答案或无限重试更可靠。",
      practice: "为你的原型列出 3 种失败：输入不完整、工具异常、需要用户确认。分别写出系统行为和用户可见提示。",
      deliverable: "一张失败与恢复清单。",
    },
    {
      phase: "交付",
      title: "完成自己的最小 Agent 原型",
      objective: "实现、演示并复盘一个真实可运行的任务闭环",
      concepts: ["端到端验证", "评测样例", "迭代计划"],
      explanation: "最后把前四节合在一起：选一个单一场景，实现最小闭环，准备正常、边界和失败三类样例。重点不是功能数量，而是每个结果能否被用户和开发者共同验证。",
      example: "一个学习 Agent 原型可以接收随手记录，提炼今日计划，询问是否写入，再用晚报问题检验理解；任何外部写入前都必须停在确认点。",
      practice: "完成原型演示，并用三条样例跑通：正常任务、模糊输入、工具失败。给每条样例写下预期和实际。",
      deliverable: "可运行原型 + 三条验收记录 + 下一轮迭代清单。",
    },
  ];

  return templates.slice(0, lessonCount).map((template, index) => {
    const id = `lesson-${index + 1}`;
    return {
      id,
      order: index + 1,
      phase: template.phase,
      title: template.title,
      durationMinutes: index === 4 ? 75 : 50,
      objective: template.objective,
      concepts: template.concepts,
      opening: `本节只推进一个目标：${template.objective}。完成后再进入下一层，不把架构讨论停在概念层。`,
      explanation: template.explanation,
      example: template.example,
      practice: template.practice,
      deliverable: template.deliverable,
      questions: questionSet(id, template.concepts, template.objective),
    };
  });
}

function fallbackProgram(input: CourseGenerationInput): LearningProgram {
  const subject = text(input.subject, "自定主题", 180);
  const goal = text(input.goal, `建立 ${subject} 的可用能力`, 500);
  const background = text(input.background, "尚未说明基础", 500);
  const weeklyHours = Math.max(1, Math.min(20, Number(input.weeklyHours) || 4));
  const lessonCount = Math.max(3, Math.min(MAX_LESSONS, Number(input.lessonCount) || DEFAULT_LESSON_COUNT));
  const agent = isAgentSubject(`${subject} ${goal}`);

  return {
    courseId: createId("course"),
    title: agent ? "从目标到自己的 Agent" : `${subject} · 从目标到可交付成果`,
    subject,
    goal,
    background,
    weeklyHours,
    summary: agent
      ? "用一条可验证的路径理解 Agent 的任务闭环、工具、状态与工程边界，最后完成自己的最小原型。"
      : `围绕“${goal}”，先建立框架，再通过案例、练习和小项目把 ${subject} 变成可迁移的能力。`,
    outcomes: agent
      ? ["能定义一个最小 Agent 闭环", "能设计工具与状态的数据流", "能交付可验证的 Agent 原型"]
      : ["能说清核心概念的关系", "能在真实场景中使用方法", "能交付一个可展示的小成果"],
    cadence: `建议每周 ${Math.min(5, Math.max(2, Math.round(weeklyHours / 1.5)))} 次，每次 45–60 分钟；每节完成后先答题，再进入下一节。`,
    instructor: {
      name: agent ? "岚 · Agent 工程教练" : "岚 · AI 学习教练",
      role: agent ? "把抽象架构带回可运行的任务闭环" : "先帮你搭框架，再用问题逼近理解",
      style: "先确认你的思路，再用一个具体例子校正；不会直接替你完成练习。",
      openingMessage: agent
        ? "我们先不追求复杂多智能体。告诉我：你的 Agent 第一件必须可靠完成的事是什么？"
        : `我们会把“${goal}”变成一系列可完成的课。卡住时，先告诉我你已经尝试过什么。`,
    },
    lessons: agent ? agentLessons(goal, lessonCount) : genericLessons(subject, goal, lessonCount),
    mode: "rules",
    provider: "本地课程规则",
    createdAt: new Date().toISOString(),
  };
}

function readConfig(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL;
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL;
  const provider = process.env.LLM_PROVIDER || "openai-compatible";
  if (apiKey && baseUrl && model) return { apiKey, baseUrl, model, provider };

  const providerKey = process.env.DEEPSEEK_API_KEY || process.env.GLM_API_KEY || process.env.OPENAI_API_KEY;
  const providerUrl = process.env.DEEPSEEK_BASE_URL || process.env.GLM_BASE_URL || process.env.OPENAI_BASE_URL;
  const providerModel = process.env.DEEPSEEK_MODEL || process.env.GLM_MODEL || process.env.OPENAI_MODEL;
  if (providerKey && providerUrl && providerModel) {
    return { apiKey: providerKey, baseUrl: providerUrl, model: providerModel, provider };
  }
  return null;
}

async function requestLlm(
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<{ content: string; provider: string } | null> {
  const config = readConfig();
  if (!config) return null;

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.25,
        messages,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content ? { content, provider: `${config.provider} · ${config.model}` } : null;
  } catch {
    return null;
  }
}

function parseObject(content: string): UnknownRecord | null {
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return asRecord(JSON.parse(cleaned));
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return asRecord(JSON.parse(cleaned.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}

function normalizeQuestions(value: unknown, fallback: CourseQuestion[], lessonId: string): CourseQuestion[] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const kinds: CourseQuestionKind[] = ["理解", "迁移", "教回"];
  const normalized = value.slice(0, 4).map((candidate, index) => {
    const item = asRecord(candidate);
    const source = fallback[index] || fallback[fallback.length - 1];
    const kind = text(item?.kind, source.kind, 20) as CourseQuestionKind;
    return {
      id: `${lessonId}-q${index + 1}`,
      kind: kinds.includes(kind) ? kind : source.kind,
      prompt: text(item?.prompt, source.prompt, 600),
      hint: text(item?.hint, source.hint, 300),
      rubric: text(item?.rubric, source.rubric, 500),
    };
  });
  return normalized.length >= 3 ? normalized : fallback;
}

function normalizeProgram(raw: UnknownRecord, fallback: LearningProgram): LearningProgram {
  const rawLessons = Array.isArray(raw.lessons) ? raw.lessons.slice(0, MAX_LESSONS) : [];
  if (rawLessons.length < 3) return fallback;

  const lessons = rawLessons.map((candidate, index) => {
    const item = asRecord(candidate);
    const source = fallback.lessons[Math.min(index, fallback.lessons.length - 1)];
    const lessonId = `lesson-${index + 1}`;
    const concepts = stringList(item?.concepts, source.concepts, 6);
    const objective = text(item?.objective, source.objective, 400);
    return {
      id: lessonId,
      order: index + 1,
      phase: text(item?.phase, source.phase, 80),
      title: text(item?.title, source.title, 160),
      durationMinutes: Math.max(20, Math.min(120, Number(item?.durationMinutes) || source.durationMinutes)),
      objective,
      concepts,
      opening: text(item?.opening, source.opening, 500),
      explanation: (() => {
        const focus = text(item?.focus, text(item?.explanation, "", 360), 420);
        return focus ? `${focus} ${source.explanation}`.slice(0, 1600) : source.explanation;
      })(),
      example: (() => {
        const customExample = text(item?.example, "", 320);
        return customExample ? `${customExample} ${source.example}`.slice(0, 1000) : source.example;
      })(),
      practice: text(item?.practice, source.practice, 900),
      deliverable: text(item?.deliverable, source.deliverable, 500),
      questions: normalizeQuestions(item?.questions, questionSet(lessonId, concepts, objective), lessonId),
    } satisfies CourseLesson;
  });

  const instructor = asRecord(raw.instructor);
  return {
    ...fallback,
    courseId: createId("course"),
    title: text(raw.title, fallback.title, 180),
    summary: text(raw.summary, fallback.summary, 1000),
    outcomes: stringList(raw.outcomes, fallback.outcomes, 5),
    cadence: text(raw.cadence, fallback.cadence, 400),
    instructor: {
      name: text(instructor?.name, fallback.instructor.name, 100),
      role: text(instructor?.role, fallback.instructor.role, 240),
      style: text(instructor?.style, fallback.instructor.style, 400),
      openingMessage: text(instructor?.openingMessage, fallback.instructor.openingMessage, 700),
    },
    lessons,
    mode: "llm",
    provider: fallback.provider,
    createdAt: new Date().toISOString(),
  };
}

export async function generateLearningProgram(input: CourseGenerationInput): Promise<LearningProgram> {
  const fallback = fallbackProgram(input);
  const llm = await requestLlm([
    {
      role: "system",
      content:
        "你是一名通用成人教育课程编导和 AI 讲师。你能为技术、人文、语言、创作、职业技能和生活技能等不同方向设计严谨课程。课程要以可验证能力为中心：规则和安全边界由系统承担，模型负责解释、编排和反馈。不要照搬固定模板，不要假装引用未提供的资料。只输出合法 JSON。",
    },
    {
      role: "user",
      content: `为以下学习目标编排一套中文课程的“教学骨架”。课程系统会根据你的骨架补全每节讲解、练习、交付物与课后理解题，因此你需要用主题专属的概念和案例把骨架编准，而不是输出泛泛标题。\n\n学习主题：${fallback.subject}\n目标：${fallback.goal}\n学习者基础：${fallback.background}\n每周可投入：${fallback.weeklyHours} 小时\n课程节数：${fallback.lessons.length}\n\n只返回 JSON 对象，字段为：title、summary、outcomes（3-5 项）、cadence、instructor（name、role、style、openingMessage）、lessons。每节 lessons 只包含 phase、title、durationMinutes、objective、concepts（3-6 项）、focus、example。其中 focus 是一句主题专属的关键讲解（不超过 55 个汉字），example 是一个主题专属的微型案例（不超过 45 个汉字）。不要输出 questions、开场白、练习、交付物或 Markdown。整体 JSON 尽量控制在 900 个汉字以内。\n\n若主题是 Agent/智能体，必须依次覆盖任务闭环、上下文/工具/状态、工具契约、失败边界与最小原型验证。`,
    },
  ]);
  if (!llm) return fallback;
  const raw = parseObject(llm.content);
  if (!raw) return fallback;
  const program = normalizeProgram(raw, fallback);
  return { ...program, provider: llm.provider };
}

function findLesson(program: LearningProgram, lessonId: string) {
  const lesson = program.lessons.find((item) => item.id === lessonId);
  if (!lesson) throw new Error("找不到要学习的课程章节。");
  return lesson;
}

function fallbackTutor(program: LearningProgram, lesson: CourseLesson, message: string): LessonTutorReply {
  const firstConcept = lesson.concepts[0] || "本节概念";
  return {
    lessonId: lesson.id,
    reply: `你正在第 ${lesson.order} 节「${lesson.title}」。这节的关键不是记住术语，而是能用它解释一个真实选择。${lesson.explanation} 你刚才提到“${text(message, "还没有写下问题", 160)}”，可以先把它放回本节的目标：${lesson.objective}。`,
    followUp: `请先用一句话说明：在你的场景里，「${firstConcept}」解决的具体问题是什么？`,
    mode: "rules",
    provider: "本地课程规则",
  };
}

export async function askCourseInstructor(
  program: LearningProgram,
  lessonId: string,
  message: string,
): Promise<LessonTutorReply> {
  const lesson = findLesson(program, lessonId);
  const cleanMessage = text(message, "请带我理解这一节的关键点。", 1200);
  const fallback = fallbackTutor(program, lesson, cleanMessage);
  const llm = await requestLlm([
    {
      role: "system",
      content: `你是${program.instructor.name}，${program.instructor.role}。你的教学风格：${program.instructor.style}。请基于本节内容回答，不捏造课程之外的事实。先肯定或定位学习者的思路，再用一个短例子解释；不要一次给出整份标准答案；最后留一个可以马上回答的追问。回复限制在 260 个汉字以内，使用两段自然中文。`,
    },
    {
      role: "user",
      content: `课程：${program.title}\n当前章节：${lesson.title}\n目标：${lesson.objective}\n关键概念：${lesson.concepts.join("、")}\n讲解：${lesson.explanation}\n示例：${lesson.example}\n\n学习者的问题或想法：${cleanMessage}`,
    },
  ]);
  if (!llm) return fallback;
  const reply = text(llm.content, fallback.reply, 1500);
  return {
    lessonId,
    reply,
    followUp: `回到本节目标：${lesson.objective}。你现在会怎样把它用在自己的场景？`,
    mode: "llm",
    provider: llm.provider,
  };
}

function fallbackFeedback(lesson: CourseLesson, answers: Record<string, string>): CourseLessonGrade {
  const feedback: CourseQuestionFeedback[] = lesson.questions.map((question) => {
    const answer = text(answers[question.id], "", 3000);
    const normalized = answer.toLowerCase();
    const conceptHits = lesson.concepts.filter((concept) => normalized.includes(concept.toLowerCase())).length;
    const lengthScore = Math.min(42, Math.round(answer.length / 3));
    const conceptScore = Math.min(28, conceptHits * 14);
    const structureScore = /(因为|所以|例如|比如|先|然后|如果|结果)/.test(answer) ? 20 : 7;
    const score = answer ? Math.min(100, 10 + lengthScore + conceptScore + structureScore) : 0;
    return {
      questionId: question.id,
      score,
      feedback: answer
        ? `已看到你的回答。${conceptHits ? "你把关键概念放进了答案中，" : "下一次请点出本节的一个关键概念，"}${score >= 70 ? "再补一个具体场景，会更有说服力。" : "请补上“为什么这样做”和会观察什么结果。"}`
        : "还没有作答；先用本题提示写下一个具体场景，再补上你的判断依据。",
      reference: question.rubric,
    };
  });
  const score = Math.round(feedback.reduce((sum, item) => sum + item.score, 0) / Math.max(1, feedback.length));
  return {
    lessonId: lesson.id,
    score,
    summary: score >= 75 ? "你已经能把本节概念连到自己的场景。" : "你已经开始建立理解；下一步要把术语、行动和结果连成一条线。",
    nextStep: score >= 75 ? `完成本节交付物：${lesson.deliverable}` : "挑一题重答：先给结论，再写一个例子和一个验证点。",
    feedback,
    gradedBy: "rules",
    provider: "本地课程规则",
  };
}

function normalizeGrade(raw: UnknownRecord, fallback: CourseLessonGrade, lesson: CourseLesson): CourseLessonGrade {
  const rawFeedback = Array.isArray(raw.feedback) ? raw.feedback : [];
  const feedback = lesson.questions.map((question, index) => {
    const candidate = asRecord(rawFeedback[index]);
    const source = fallback.feedback[index];
    return {
      questionId: question.id,
      score: Math.max(0, Math.min(100, Number(candidate?.score) || source.score)),
      feedback: text(candidate?.feedback, source.feedback, 700),
      reference: text(candidate?.reference, source.reference, 700),
    };
  });
  return {
    ...fallback,
    score: Math.max(0, Math.min(100, Number(raw.score) || fallback.score)),
    summary: text(raw.summary, fallback.summary, 900),
    nextStep: text(raw.nextStep, fallback.nextStep, 700),
    feedback,
    gradedBy: "llm",
  };
}

export async function gradeCourseLesson(
  program: LearningProgram,
  lessonId: string,
  answers: Record<string, string>,
): Promise<CourseLessonGrade> {
  const lesson = findLesson(program, lessonId);
  const fallback = fallbackFeedback(lesson, answers);
  const answerSheet = lesson.questions.map((question) => ({
    id: question.id,
    kind: question.kind,
    prompt: question.prompt,
    rubric: question.rubric,
    answer: text(answers[question.id], "未作答", 3000),
  }));
  const llm = await requestLlm([
    {
      role: "system",
      content: "你是一名重视理解和迁移的课程教师。根据给定章节和评分标准，公平评分开放题；不因文笔华丽加分，也不要捏造学习者没有写出的内容。输出严格 JSON：score（0-100）、summary、nextStep、feedback（每题包含 score、feedback、reference）。feedback 数量必须和题目相同，中文简洁、可行动。",
    },
    {
      role: "user",
      content: `课程：${program.title}\n章节：${lesson.title}\n学习目标：${lesson.objective}\n关键概念：${lesson.concepts.join("、")}\n章节讲解：${lesson.explanation}\n\n作答与标准：${JSON.stringify(answerSheet)}`,
    },
  ]);
  if (!llm) return fallback;
  const raw = parseObject(llm.content);
  if (!raw) return fallback;
  return { ...normalizeGrade(raw, fallback, lesson), provider: llm.provider };
}

export function getLearningProgramStatus() {
  const config = readConfig();
  return {
    configured: Boolean(config),
    provider: config ? `${config.provider} · ${config.model}` : "未配置",
    fallbackAvailable: true,
  };
}
