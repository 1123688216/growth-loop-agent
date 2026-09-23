import type { EmbeddingModelAlias } from "./embedding-profiles.ts";
import { llamaIndexUrl } from './llamaindex-client.ts';

type ServiceTiming = {
  model_load_ms: number;
  tokenize_ms: number;
  encode_ms: number;
};

type ServiceResponse = {
  model_alias: string;
  model: string;
  revision: string;
  dimension: number;
  device: string;
  dtype: string;
  normalized: boolean;
  input_tokens: number;
  vectors: number[][];
  timing: ServiceTiming;
};

export type EmbeddingBatchResult = {
  modelAlias: EmbeddingModelAlias;
  model: string;
  revision: string;
  dimension: number;
  device: string;
  dtype: string;
  normalized: boolean;
  inputTokens: number;
  vectors: number[][];
  timing: {
    modelLoadMs: number;
    tokenizeMs: number;
    encodeMs: number;
    serviceRoundtripMs: number;
  };
};

export class EmbeddingServiceError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function serviceUrl() {
  return llamaIndexUrl();
}

function timeoutMs() {
  const parsed = Number(process.env.EMBEDDING_TIMEOUT_MS || 600_000);
  return Number.isFinite(parsed) ? Math.max(10_000, Math.floor(parsed)) : 600_000;
}

function isFiniteVector(value: unknown, dimension: number): value is number[] {
  return Array.isArray(value)
    && value.length === dimension
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isServiceResponse(value: unknown): value is ServiceResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<ServiceResponse>;
  return typeof response.model_alias === "string"
    && typeof response.model === "string"
    && typeof response.revision === "string"
    && Number.isInteger(response.dimension)
    && typeof response.device === "string"
    && typeof response.dtype === "string"
    && typeof response.normalized === "boolean"
    && Number.isInteger(response.input_tokens)
    && Array.isArray(response.vectors)
    && Boolean(response.timing)
    && typeof response.timing?.model_load_ms === "number"
    && typeof response.timing?.tokenize_ms === "number"
    && typeof response.timing?.encode_ms === "number";
}

export async function embedTexts(input: {
  model: EmbeddingModelAlias;
  inputType: "document" | "query";
  texts: string[];
}): Promise<EmbeddingBatchResult> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${serviceUrl()}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        input_type: input.inputType,
        texts: input.texts,
        normalize: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (error) {
    if (error instanceof EmbeddingServiceError) throw error;
    throw new EmbeddingServiceError(
      `Embedding 服务不可用：${error instanceof Error ? error.message : "连接失败"}`,
      503,
    );
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload
      ? String((payload as { detail: unknown }).detail)
      : `HTTP ${response.status}`;
    throw new EmbeddingServiceError(`Embedding 服务处理失败：${detail}`, response.status);
  }
  if (!isServiceResponse(payload) || payload.model_alias !== input.model) {
    throw new EmbeddingServiceError("Embedding 服务返回了不兼容的数据结构。", 502);
  }
  if (payload.vectors.length !== input.texts.length
    || !payload.vectors.every((vector) => isFiniteVector(vector, payload.dimension))) {
    throw new EmbeddingServiceError("Embedding 服务返回的向量数量或维度不正确。", 502);
  }
  return {
    modelAlias: input.model,
    model: payload.model,
    revision: payload.revision,
    dimension: payload.dimension,
    device: payload.device,
    dtype: payload.dtype,
    normalized: payload.normalized,
    inputTokens: payload.input_tokens,
    vectors: payload.vectors,
    timing: {
      modelLoadMs: payload.timing.model_load_ms,
      tokenizeMs: payload.timing.tokenize_ms,
      encodeMs: payload.timing.encode_ms,
      serviceRoundtripMs: performance.now() - started,
    },
  };
}
