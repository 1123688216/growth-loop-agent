export type ParsedIntent = "quick_log" | "plan_today" | "review";
export type LearningTrack = "ai_agent";
export type ActionKind = "focus" | "learn" | "exercise" | "life" | "rest";

export type LearningGuide = {
  track: LearningTrack;
  label: string;
  goal: string;
  stage: string;
  todaySteps: string[];
  outputPrompt: string;
  quizFocus: string[];
};

export type ParsedAction = {
  intent: ParsedIntent;
  kind: ActionKind;
  topic: string;
  goal?: string;
  track?: LearningTrack;
  guide?: LearningGuide;
  minutes?: number;
  output?: string;
  isCorrection: boolean;
  missing: string[];
  confidence: number;
};

type PreviousAction = Pick<ParsedAction, "intent" | "kind" | "topic" | "goal" | "track" | "guide" | "minutes" | "output">;

const MINUTES_PATTERN = /(\d{1,3})\s*(?:分钟|分|min|m)/i;

function normalize(value: string | undefined) {
  return value?.replace(/\s+/g, " ").replace(/^[，,。；;：:]+|[，,。；;：:]+$/g, "").trim();
}

function cleanOutput(value: string | undefined) {
  return normalize(value)?.replace(/(?:重新记录|记录下来|告诉我.*|还缺什么.*)$/g, "").trim();
}

function cleanTopic(value: string | undefined) {
  return normalize(value)
    ?.replace(/^(?:请|帮我|把|将|今天的|今天要做的|今天|我今天|我|刚刚|上一条|本次的)\s*/g, "")
    .replace(/(?:安排成|安排为|安排|计划做|计划|完成了|完成|做了|学习了|听了|读了|看了)\s*$/g, "")
    .trim();
}

function cleanGoal(value: string | undefined) {
  return normalize(value)?.replace(/^(?:我想|我希望|目标是|目标为|计划就是|计划是)\s*/g, "").trim();
}

function extractGoal(message: string) {
  const matched = message.match(/(?:目标(?:是|为)|计划(?:就是|是))\s*([^，,。；;\n]+?)(?=，|,|。|；|;|请|帮我|安排|规划|$)/i);
  return cleanGoal(matched?.[1]);
}

function inferTrack(message: string, goal: string | undefined, topic: string) {
  const source = `${message} ${goal || ""} ${topic}`;
  return /AI|人工智能|Agent|agent|智能体|大模型|LLM|RAG|提示词|工具调用|工作流/i.test(source) ? "ai_agent" as const : undefined;
}

function inferKind(message: string, topic: string, previous?: ActionKind): ActionKind {
  const source = `${message} ${topic}`;
  if (/运动|锻炼|健身|跑步|骑行|游泳|力量|拉伸|瑜伽|俯卧撑|深蹲|球类|训练/i.test(source)) return "exercise";
  if (/休息|睡眠|午睡|小憩|放松|冥想|呼吸|睡前|早睡|恢复|关屏/i.test(source)) return "rest";
  if (/生活|家务|吃饭|用餐|洗澡|散步|通勤|购物|家庭|日常|整理房间/i.test(source)) return "life";
  if (/学习|课程|阅读|听力|复习|记忆|看书|知识|AI|Agent|智能体|大模型|LLM|RAG|提示词|工具调用/i.test(source)) return "learn";
  return previous || "focus";
}

function buildLearningGuide(track: LearningTrack | undefined, goal: string | undefined, minutes?: number): LearningGuide | undefined {
  if (track !== "ai_agent") return undefined;
  const duration = minutes || 45;
  const buildMinutes = Math.max(10, duration - 25);
  const resolvedGoal = goal || "学习 Agent 并开发自己的 Agent";
  return {
    track,
    label: "AI Agent 学习路线",
    goal: resolvedGoal,
    stage: "从概念理解走到最小可运行闭环",
    todaySteps: [
      `10 分钟：明确 Agent 要解决的问题和成功标准`,
      `15 分钟：拆解 LLM、工具调用、状态/记忆和评估`,
      `${buildMinutes} 分钟：做一个最小闭环并留下可运行结果`,
    ],
    outputPrompt: "画出自己的 Agent 信息→决策→工具→结果流程，并写一个验收问题",
    quizFocus: ["Agent 与普通聊天的差异", "工具调用、状态和评估各自解决什么问题", "如何把目标收敛为最小可运行 Agent"],
  };
}

function extractMinutes(message: string) {
  const match = message.match(MINUTES_PATTERN);
  return match ? Number(match[1]) : undefined;
}

function extractOutput(message: string) {
  const marked = message.match(
    /(?:输出|成果|产出|留下|记下|要求留下)(?:了)?(?:是|为|：|:)?\s*([^，,。；;]+?)(?=[，,。；;]|$)/i,
  );
  if (marked?.[1]) return cleanOutput(marked[1]);

  const count = message.match(/\d{1,3}\s*(?:个|条)\s*[^，,。；;]+/i);
  return count?.[0] ? cleanOutput(count[0]) : undefined;
}

function extractTopic(message: string, isCorrection: boolean) {
  if (isCorrection) {
    const correction = message.match(
      /不是[^，,。；;]+[，,；;]\s*(?:而是|改成|是)\s*([^，,。；;]+?)(?=\d{1,3}\s*(?:分钟|分|min|m)|输出|成果|产出|留下|记下|并|$)/i,
    );
    if (correction?.[1]) return cleanTopic(correction[1]);

    const restated = message.match(/(?:按|改为|改成)\s*([^，,。；;]+?)(?=\d{1,3}\s*(?:分钟|分|min|m)|输出|成果|产出|留下|并|$)/i);
    if (restated?.[1]) return cleanTopic(restated[1]);
  }

  const planned = message.match(/(?:今天的|今天要做的|把|将)\s*([^，,。；;]+?)\s*安排(?:成|为)/i);
  if (planned?.[1]) return cleanTopic(planned[1]);

  const completed = message.match(
    /(?:完成了|完成|做了|学习了?|听了|读了|看了)\s*([^，,。；;\n]+?)(?=，|,|。|；|;|花了|用时|耗时|\d{1,3}\s*(?:分钟|分|min|m)|输出|成果|产出|留下|记下|并|$)/i,
  );
  if (completed?.[1]) return cleanTopic(completed[1]);

  const arranged = message.match(
    /(?:计划|安排)\s*(?:做|学习|完成)?\s*([^，,。；;]+?)(?=\d{1,3}\s*(?:分钟|分|min|m)|并|要求|输出|留下|$)/i,
  );
  if (arranged?.[1]) return cleanTopic(arranged[1]);

  const fallback = message
    .replace(/(?:请|帮我|今天|我|刚刚|更正上一条|更正一下|用户纠正|复盘今天|复盘这周)/g, "")
    .split(/[，,。；;]/)[0];
  return cleanTopic(fallback) || undefined;
}

function inferIntent(message: string, isCorrection: boolean, previous?: PreviousAction) {
  if (isCorrection && previous) return previous.intent;
  if (/复盘|回顾|总结今天|总结这周|进步/.test(message)) return "review" as const;
  if (/计划|安排|排进|规划/.test(message)) return "plan_today" as const;
  return "quick_log" as const;
}

export function parseAction(message: string, previous?: PreviousAction): ParsedAction {
  const isCorrection = /更正|纠正|改成|不是[^，,。；;]+[，,；;].*(?:而是|是)/.test(message);
  const intent = inferIntent(message, isCorrection, previous);
  const extractedGoal = extractGoal(message);
  const goal = extractedGoal || previous?.goal;
  const rawTopic = extractTopic(message, isCorrection) || previous?.topic || "今日行动";
  const kind = inferKind(message, rawTopic, previous?.kind);
  const track = inferTrack(message, goal, rawTopic) || previous?.track;
  const topic = track === "ai_agent" && (goal || /Agent|智能体/i.test(rawTopic)) ? "Agent 学习与开发" : rawTopic;
  const minutes = extractMinutes(message) ?? previous?.minutes;
  const output = extractOutput(message) ?? previous?.output;
  const missing: string[] = [];

  if (intent === "plan_today" && !minutes) missing.push("时长");
  if ((intent === "quick_log" || intent === "review") && !output) missing.push("结果记录");

  const knownFields = [topic !== "今日行动", Boolean(minutes), Boolean(output)].filter(Boolean).length;
  const guide = buildLearningGuide(track, goal, minutes);
  return {
    intent,
    kind,
    topic,
    goal,
    track,
    guide,
    minutes,
    output,
    isCorrection,
    missing,
    confidence: Math.min(0.98, 0.45 + knownFields * 0.18),
  };
}

export function buildActionReply(action: ParsedAction) {
  const duration = action.minutes ? `${action.minutes} 分钟` : "时长待定";
  const evidence = action.output ? `结果记录：${action.output}` : "还缺一条可核对的结果，晚报时再补充即可";
  const correctionPrefix = action.isCorrection ? "已按你的更正更新。" : "";

  if (action.intent === "review") {
    return `${correctionPrefix}晚报开始：我会把今天的记录合在一起，依次问你三件事——1）今天最重要的行动是什么？2）哪个地方真正被你理解或用上了？3）明天要延续的最小一步是什么？先从第一件开始。`;
  }

  if (action.guide) {
    const guide = action.guide;
    if (action.intent === "plan_today") {
      return `${correctionPrefix}已把「${guide.goal}」安排为 ${duration}。今天按三步推进：${guide.todaySteps.join("；")}。完成后留下：${guide.outputPrompt}。晚报时我会把今天的记录合起来回顾。`;
    }
    return `${correctionPrefix}已记录「${guide.goal}」${action.minutes ? ` · ${duration}` : ""}。下一步画出 Agent 的信息→决策→工具→结果，并留下一个可验证结果；晚报时再统一回顾。`;
  }

  if (action.intent === "plan_today") {
    return `${correctionPrefix}已安排：${action.topic} · ${duration}。完成后留下${action.output || "一条具体结果"}。${action.missing.length ? `还需要补：${action.missing.join("、")}。` : ""}`;
  }

  if (action.kind === "exercise") {
    return `${correctionPrefix}已记录运动行动「${action.topic}」${action.minutes ? ` · ${duration}` : ""}。先从可持续的强度开始，结束后记下身体感受或一个可观察结果。`;
  }

  if (action.kind === "rest") {
    return `${correctionPrefix}已记录休息行动「${action.topic}」${action.minutes ? ` · ${duration}` : ""}。把恢复当成计划的一部分，结束后只需记下一句精神状态变化。`;
  }

  if (action.kind === "life") {
    return `${correctionPrefix}已记录生活行动「${action.topic}」${action.minutes ? ` · ${duration}` : ""}。完成后留下一条事实或感受，让生活安排也能成为成长证据。`;
  }

  return `${correctionPrefix}已记录：${action.topic}${action.minutes ? ` · ${duration}` : ""}。${evidence}。下一步先保留这条事实，晚些时候再补充应用结果。`;
}
