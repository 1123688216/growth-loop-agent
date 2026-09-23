import { buildChunkSet } from "./chunking.ts";
import { extractSource } from "./extract.ts";
import type {
  DocumentNodeDraft,
  ExtractedDocument,
  KnowledgeSourceKind,
  SourceChunkDraft,
  SourceChunkSetDraft,
  SourceParentChunkDraft,
} from "./types.ts";

export type KnowledgeIngestionResult = {
  extracted: ExtractedDocument;
  chunkSet: SourceChunkSetDraft | null;
  engine: "remote" | "typescript-fallback";
};

export class KnowledgeIngestionError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNode(value: unknown): value is DocumentNodeDraft {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.position)
    && (value.parentPosition === null || Number.isInteger(value.parentPosition))
    && typeof value.type === "string"
    && isNullableNumber(value.headingLevel)
    && typeof value.text === "string"
    && isStringArray(value.sectionPath)
    && isNullableNumber(value.pageStart)
    && isNullableNumber(value.pageEnd)
    && typeof value.charStart === "number"
    && typeof value.charEnd === "number"
    && isRecord(value.metadata);
}

function isExtractedDocument(value: unknown): value is ExtractedDocument {
  if (!isRecord(value)) return false;
  return ["ready", "ocr_required", "failed"].includes(String(value.status))
    && typeof value.text === "string"
    && typeof value.normalizedMarkdown === "string"
    && Array.isArray(value.pages)
    && value.pages.every((page) => isRecord(page) && Number.isInteger(page.page) && typeof page.text === "string")
    && Array.isArray(value.nodes)
    && value.nodes.every(isNode)
    && typeof value.parserName === "string"
    && typeof value.parserVersion === "string"
    && typeof value.outputFormat === "string"
    && isStringArray(value.warnings)
    && typeof value.errorMessage === "string";
}

function isParent(value: unknown): value is SourceParentChunkDraft {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.position)
    && typeof value.heading === "string"
    && isStringArray(value.sectionPath)
    && typeof value.content === "string"
    && isNullableNumber(value.pageStart)
    && isNullableNumber(value.pageEnd)
    && typeof value.charStart === "number"
    && typeof value.charEnd === "number"
    && typeof value.tokenEstimate === "number";
}

function isChunk(value: unknown): value is SourceChunkDraft {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.position)
    && Number.isInteger(value.parentPosition)
    && typeof value.heading === "string"
    && isStringArray(value.sectionPath)
    && typeof value.contextPrefix === "string"
    && typeof value.content === "string"
    && isNullableNumber(value.pageStart)
    && isNullableNumber(value.pageEnd)
    && typeof value.charStart === "number"
    && typeof value.charEnd === "number"
    && typeof value.tokenEstimate === "number"
    && isNullableNumber(value.nodeStartPosition)
    && isNullableNumber(value.nodeEndPosition)
    && isRecord(value.boundaryReason);
}

function isChunkSet(value: unknown): value is SourceChunkSetDraft {
  if (!isRecord(value)) return false;
  return typeof value.strategy === "string"
    && typeof value.strategyVersion === "string"
    && isRecord(value.config)
    && isStringArray(value.warnings)
    && Array.isArray(value.parents)
    && value.parents.every(isParent)
    && Array.isArray(value.chunks)
    && value.chunks.every(isChunk);
}

function requiredRemote() {
  return /^(1|true|yes)$/i.test(process.env.RAG_INGESTION_REQUIRED?.trim() || "");
}

function timeoutMs() {
  const parsed = Number(process.env.RAG_INGESTION_TIMEOUT_MS || 960_000);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.floor(parsed)) : 960_000;
}

async function remoteIngest(input: {
  buffer: Buffer;
  kind: KnowledgeSourceKind;
  filename: string;
  mimeType: string;
}) {
  const baseUrl = process.env.RAG_INGESTION_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) {
    if (requiredRemote()) {
      throw new KnowledgeIngestionError("已要求使用成熟 RAG 服务，但 RAG_INGESTION_URL 尚未配置。", 503);
    }
    return null;
  }
  const form = new FormData();
  form.set("kind", input.kind);
  form.set(
    "file",
    new File([new Uint8Array(input.buffer)], input.filename || `source.${input.kind}`, {
      type: input.mimeType || "application/octet-stream",
    }),
  );
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/ingest`, {
      method: "POST",
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (error) {
    throw new KnowledgeIngestionError(
      `成熟 RAG 服务不可用：${error instanceof Error ? error.message : "连接失败"}`,
      503,
    );
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.detail === "string" ? payload.detail : `HTTP ${response.status}`;
    throw new KnowledgeIngestionError(`成熟 RAG 服务处理失败：${detail}`, response.status);
  }
  if (!isRecord(payload) || !isExtractedDocument(payload.extracted) || !isChunkSet(payload.chunkSet)) {
    throw new KnowledgeIngestionError("成熟 RAG 服务返回了不兼容的数据结构。", 502);
  }
  return { extracted: payload.extracted, chunkSet: payload.chunkSet };
}

export async function ingestKnowledgeSource(input: {
  buffer: Buffer;
  kind: KnowledgeSourceKind;
  filename?: string;
  mimeType?: string;
}): Promise<KnowledgeIngestionResult> {
  try {
    const remote = await remoteIngest({
      buffer: input.buffer,
      kind: input.kind,
      filename: input.filename || `source.${input.kind}`,
      mimeType: input.mimeType || "application/octet-stream",
    });
    if (remote) return { ...remote, engine: "remote" };
  } catch (error) {
    if (requiredRemote()) throw error;
    console.warn("RAG ingestion service failed; using TypeScript fallback", error);
    const extracted = await extractSource(input.buffer, input.kind);
    extracted.warnings.push(error instanceof Error ? error.message : "成熟 RAG 服务失败，已回退本地解析。");
    return {
      extracted,
      chunkSet: extracted.status === "ready" ? buildChunkSet(extracted) : null,
      engine: "typescript-fallback",
    };
  }

  const extracted = await extractSource(input.buffer, input.kind);
  return {
    extracted,
    chunkSet: extracted.status === "ready" ? buildChunkSet(extracted) : null,
    engine: "typescript-fallback",
  };
}
