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

export async function requestStructured<T>(input: {
  system: string;
  user: string;
  fallback: T;
  normalize: (raw: UnknownRecord, fallback: T) => T | null;
}): Promise<AgentResult<T>> {
  const config = readConfig();
  if (!config) {
    return { data: input.fallback, mode: "rules", provider: "本地规则", model: "", latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const raw = parseObject(body.choices?.[0]?.message?.content || "");
    const normalized = raw ? input.normalize(raw, input.fallback) : null;
    if (!normalized) throw new Error("LLM output validation failed");
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
    };
  } catch {
    return { data: input.fallback, mode: "rules", provider: "本地规则", model: "", latencyMs: Date.now() - startedAt, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
}
