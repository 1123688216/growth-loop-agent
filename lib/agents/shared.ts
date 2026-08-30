type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
};

export type AgentResult<T> = {
  data: T;
  mode: "llm" | "rules";
  provider: string;
  model: string;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** 走了本地回退时的原因；mode 为 llm 时是空字符串。写入 agent_runs.error_message。 */
  fallbackReason: string;
};

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

export function cleanText(value: unknown, fallback = "", max = 1200) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, max) : fallback;
}

export function cleanList(value: unknown, fallback: string[], maxItems = 8) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => cleanText(item, "", 180)).filter(Boolean).slice(0, maxItems);
  return items.length ? items : fallback;
}

function readConfig(): LlmConfig | null {
  if (["demo", "rules", "local"].includes((process.env.LLM_PROVIDER || "").trim().toLowerCase())) return null;
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.GLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || process.env.GLM_BASE_URL;
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || process.env.GLM_MODEL;
  const provider = process.env.LLM_PROVIDER || "openai-compatible";
  return apiKey && baseUrl && model ? { apiKey, baseUrl, model, provider } : null;
}

function parseObject(content: string) {
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

export const LLM_TIMEOUT_MS = 60_000;

/**
 * 把回退原因归成可统计的短标签。超时和 HTTP 错误是不同的问题，
 * 混在一起看不出该调超时、该加重试还是该改 Prompt。
 */
function describeFailure(error: unknown, timeoutMs: number) {
  if (error instanceof Error) {
    // AbortSignal.timeout 抛出的是 name 为 TimeoutError 的 DOMException。
    if (error.name === "TimeoutError") return `timeout_${timeoutMs}ms`;
    if (error.name === "AbortError") return "aborted";
    return error.message.slice(0, 300);
  }
  return "unknown_error";
}

const RULES_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function rulesResult<T>(data: T, latencyMs: number, fallbackReason: string): AgentResult<T> {
  return { data, mode: "rules", provider: "本地规则", model: "", latencyMs, usage: RULES_USAGE, fallbackReason };
}

export async function requestStructured<T>(input: {
  system: string;
  user: string;
  fallback: T;
  normalize: (raw: UnknownRecord, fallback: T) => T | null;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}): Promise<AgentResult<T>> {
  const config = readConfig();
  // 未配置模型不是失败，单独标记，避免把"故意关掉"和"调用挂了"混进同一个回退率。
  if (!config) return rulesResult(input.fallback, 0, "llm_disabled");

  const startedAt = Date.now();
  const timeoutMs = Math.max(10_000, Math.min(120_000, input.timeoutMs || LLM_TIMEOUT_MS));
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: input.temperature ?? 0.2,
        ...(input.maxTokens ? { max_tokens: Math.max(256, Math.min(6000, input.maxTokens)) } : {}),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const body = await response.json() as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string; reasoning_content?: string };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content || "";
    const raw = parseObject(content);
    if (!raw) {
      if (content) throw new Error("unparsable_json");
      const choice = body.choices?.[0];
      const finishReason = cleanText(choice?.finish_reason, "unknown", 40);
      const reasoningLength = choice?.message?.reasoning_content?.length || 0;
      const completionTokens = Math.max(0, body.usage?.completion_tokens || 0);
      throw new Error(`empty_completion_${finishReason}_reasoning${reasoningLength}_tokens${completionTokens}`);
    }
    const normalized = input.normalize(raw, input.fallback);
    if (!normalized) throw new Error("validation_failed");
    return {
      data: normalized,
      mode: "llm",
      provider: config.provider,
      model: config.model,
      latencyMs: Date.now() - startedAt,
      usage: {
        promptTokens: Math.max(0, body.usage?.prompt_tokens || 0),
        completionTokens: Math.max(0, body.usage?.completion_tokens || 0),
        totalTokens: Math.max(0, body.usage?.total_tokens || 0),
      },
      fallbackReason: "",
    };
  } catch (error) {
    return rulesResult(input.fallback, Date.now() - startedAt, describeFailure(error, timeoutMs));
  }
}
