import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDatabase, withTransaction } from "./index.ts";
import { buildChunkSet } from "../knowledge/chunking.ts";
import { ingestKnowledgeSource } from "../knowledge/ingestion.ts";
import type {
  ExtractedDocument,
  KnowledgeSourceChunk,
  KnowledgeSourceChunkPage,
  KnowledgeSourceKind,
  KnowledgeSourceSummary,
  SourceChunkSetDraft,
} from "../knowledge/types.ts";

type KnowledgeSourceRow = {
  id: string;
  title: string;
  description: string;
  kind: KnowledgeSourceKind;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  status: KnowledgeSourceSummary["status"];
  active_chunk_set_id: string | null;
  chunk_count: number;
  parent_chunk_count: number | null;
  chunk_strategy: string | null;
  chunk_strategy_version: string | null;
  char_count: number;
  warning_message: string;
  error_message: string;
  created_at: string;
  updated_at: string;
};

type KnowledgeSourceChunkRow = {
  id: string;
  position: number;
  parent_id: string;
  parent_position: number;
  parent_heading: string;
  parent_content: string;
  parent_token_estimate: number;
  heading: string;
  section_path_json: string;
  context_prefix: string;
  content: string;
  page_start: number | null;
  page_end: number | null;
  char_start: number;
  char_end: number;
  token_estimate: number;
  node_start_position: number | null;
  node_end_position: number | null;
  boundary_reason_json: string;
};

type ChunkSetRow = {
  id: string;
  strategy: string;
  strategy_version: string;
  parent_count: number;
  child_count: number;
  created_at: string;
};

const SOURCE_SELECT = `
  SELECT ks.id, ks.title, ks.description, ks.kind, ks.original_filename, ks.mime_type,
         ks.byte_size, ks.status, ks.active_chunk_set_id, ks.chunk_count, ks.char_count,
         ks.warning_message, ks.error_message, ks.created_at, ks.updated_at,
         cs.parent_count AS parent_chunk_count, cs.strategy AS chunk_strategy,
         cs.strategy_version AS chunk_strategy_version
  FROM knowledge_sources ks
  LEFT JOIN source_chunk_sets cs ON cs.id = ks.active_chunk_set_id
`;

export class KnowledgeSourceConflictError extends Error {}
export class KnowledgeSourceChunkingError extends Error {}

function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toSummary(row: KnowledgeSourceRow): KnowledgeSourceSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    status: row.status,
    chunkCount: row.chunk_count,
    parentChunkCount: row.parent_chunk_count || 0,
    chunkStrategy: row.chunk_strategy || "",
    chunkStrategyVersion: row.chunk_strategy_version || "",
    charCount: row.char_count,
    warningMessage: row.warning_message,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChunk(row: KnowledgeSourceChunkRow): KnowledgeSourceChunk {
  return {
    id: row.id,
    position: row.position,
    parentId: row.parent_id,
    parentPosition: row.parent_position,
    parentHeading: row.parent_heading,
    parentContent: row.parent_content,
    parentTokenEstimate: row.parent_token_estimate,
    heading: row.heading,
    sectionPath: parseJson<string[]>(row.section_path_json, []),
    contextPrefix: row.context_prefix,
    content: row.content,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    charStart: row.char_start,
    charEnd: row.char_end,
    tokenEstimate: row.token_estimate,
    nodeStartPosition: row.node_start_position,
    nodeEndPosition: row.node_end_position,
    boundaryReason: parseJson<Record<string, unknown>>(row.boundary_reason_json, {}),
  };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function validateChunkSet(extracted: ExtractedDocument, chunkSet: SourceChunkSetDraft | null) {
  if (extracted.status === "ready" && (!chunkSet || chunkSet.chunks.length === 0 || chunkSet.parents.length === 0)) {
    throw new KnowledgeSourceChunkingError("资料解析成功，但未能生成完整的父子切片。");
  }
  if (!chunkSet) return;
  if (extracted.status !== "ready") {
    throw new KnowledgeSourceChunkingError("未就绪的解析结果不能携带可激活的切片集合。");
  }
  const parentByPosition = new Map(chunkSet.parents.map((parent) => [parent.position, parent]));
  if (parentByPosition.size !== chunkSet.parents.length) {
    throw new KnowledgeSourceChunkingError("父切片位置重复，拒绝保存不完整的切片集合。");
  }
  const childPositions = new Set<number>();
  for (const chunk of chunkSet.chunks) {
    if (childPositions.has(chunk.position)) {
      throw new KnowledgeSourceChunkingError("子切片位置重复，拒绝保存不完整的切片集合。");
    }
    childPositions.add(chunk.position);
    const parent = parentByPosition.get(chunk.parentPosition);
    if (!parent) throw new KnowledgeSourceChunkingError("子切片缺少对应的父切片。");
    if (!chunk.content.trim() || !parent.content.includes(chunk.content)) {
      throw new KnowledgeSourceChunkingError("子切片不在对应父切片中，无法保证父子回读正确。");
    }
    if (chunk.charStart < 0 || chunk.charEnd < chunk.charStart || chunk.tokenEstimate <= 0) {
      throw new KnowledgeSourceChunkingError("子切片范围或 Token 估算无效。");
    }
  }
}

function persistParseAndChunks(database: DatabaseSync, input: {
  sourceId: string;
  versionId: string;
  userId: string;
  extracted: ExtractedDocument;
  chunkSet: SourceChunkSetDraft | null;
  createdAt: string;
}) {
  const parseRunId = randomUUID();
  database.prepare(`
    INSERT INTO document_parse_runs (
      id, source_version_id, source_id, user_id, parser_name, parser_version,
      output_format, status, normalized_markdown, text_hash, node_count,
      warnings_json, error_message, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parseRunId, input.versionId, input.sourceId, input.userId,
    input.extracted.parserName, input.extracted.parserVersion, input.extracted.outputFormat,
    input.extracted.status, input.extracted.normalizedMarkdown,
    input.extracted.normalizedMarkdown ? hash(input.extracted.normalizedMarkdown) : "",
    input.extracted.nodes.length, JSON.stringify(input.extracted.warnings),
    input.extracted.errorMessage, input.createdAt, input.createdAt,
  );

  const nodeIds = new Map(input.extracted.nodes.map((node) => [node.position, randomUUID()]));
  const insertNode = database.prepare(`
    INSERT INTO document_nodes (
      id, parse_run_id, source_version_id, source_id, user_id, position,
      parent_node_id, node_type, heading_level, text, section_path_json,
      page_start, page_end, char_start, char_end, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const node of input.extracted.nodes) {
    insertNode.run(
      nodeIds.get(node.position)!, parseRunId, input.versionId, input.sourceId, input.userId,
      node.position, node.parentPosition === null ? null : nodeIds.get(node.parentPosition) || null,
      node.type, node.headingLevel, node.text, JSON.stringify(node.sectionPath), node.pageStart,
      node.pageEnd, node.charStart, node.charEnd, JSON.stringify(node.metadata), input.createdAt,
    );
  }

  if (!input.chunkSet) return { parseRunId, chunkSetId: null, chunkCount: 0, parentCount: 0 };

  const chunkSetId = randomUUID();
  database.prepare(`
    INSERT INTO source_chunk_sets (
      id, source_version_id, source_id, user_id, parse_run_id, strategy,
      strategy_version, status, parent_count, child_count, config_json,
      warnings_json, created_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)
  `).run(
    chunkSetId, input.versionId, input.sourceId, input.userId, parseRunId,
    input.chunkSet.strategy, input.chunkSet.strategyVersion, input.chunkSet.parents.length,
    input.chunkSet.chunks.length, JSON.stringify(input.chunkSet.config),
    JSON.stringify(input.chunkSet.warnings), input.createdAt, input.createdAt,
  );

  const parentIds = new Map(input.chunkSet.parents.map((parent) => [parent.position, randomUUID()]));
  const insertParent = database.prepare(`
    INSERT INTO source_parent_chunks (
      id, chunk_set_id, source_version_id, source_id, user_id, position,
      heading, section_path_json, content, page_start, page_end, char_start,
      char_end, token_estimate, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const parent of input.chunkSet.parents) {
    insertParent.run(
      parentIds.get(parent.position)!, chunkSetId, input.versionId, input.sourceId, input.userId,
      parent.position, parent.heading, JSON.stringify(parent.sectionPath), parent.content,
      parent.pageStart, parent.pageEnd, parent.charStart, parent.charEnd, parent.tokenEstimate,
      hash(parent.content), input.createdAt,
    );
  }

  const insertChunk = database.prepare(`
    INSERT INTO source_chunks (
      id, chunk_set_id, parent_chunk_id, source_version_id, source_id, user_id,
      position, heading, section_path_json, context_prefix, content, page_start,
      page_end, char_start, char_end, token_estimate, node_start_position,
      node_end_position, boundary_reason_json, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const chunk of input.chunkSet.chunks) {
    const parentId = parentIds.get(chunk.parentPosition);
    if (!parentId) throw new KnowledgeSourceChunkingError("子切片缺少对应的父切片。");
    insertChunk.run(
      randomUUID(), chunkSetId, parentId, input.versionId, input.sourceId, input.userId,
      chunk.position, chunk.heading, JSON.stringify(chunk.sectionPath), chunk.contextPrefix,
      chunk.content, chunk.pageStart, chunk.pageEnd, chunk.charStart, chunk.charEnd,
      chunk.tokenEstimate, chunk.nodeStartPosition, chunk.nodeEndPosition,
      JSON.stringify(chunk.boundaryReason), hash(chunk.content), input.createdAt,
    );
  }
  return {
    parseRunId,
    chunkSetId,
    chunkCount: input.chunkSet.chunks.length,
    parentCount: input.chunkSet.parents.length,
  };
}

export function listKnowledgeSources(userId: string) {
  const rows = getDatabase().prepare(`
    ${SOURCE_SELECT}
    WHERE ks.user_id = ? AND ks.status != 'deleted'
    ORDER BY ks.updated_at DESC
  `).all(userId) as KnowledgeSourceRow[];
  return rows.map(toSummary);
}

export function listKnowledgeSourceChunks(input: {
  userId: string;
  sourceId: string;
  query?: string;
  offset?: number;
  limit?: number;
}): KnowledgeSourceChunkPage | null {
  const database = getDatabase();
  const source = database.prepare(`
    ${SOURCE_SELECT}
    WHERE ks.id = ? AND ks.user_id = ? AND ks.status != 'deleted'
  `).get(input.sourceId, input.userId) as KnowledgeSourceRow | undefined;
  if (!source) return null;

  const chunkSet = source.active_chunk_set_id
    ? database.prepare(`
        SELECT id, strategy, strategy_version, parent_count, child_count, created_at
        FROM source_chunk_sets WHERE id = ? AND source_id = ? AND user_id = ?
      `).get(source.active_chunk_set_id, input.sourceId, input.userId) as ChunkSetRow | undefined
    : undefined;
  const query = input.query?.trim().slice(0, 120) || "";
  const offset = Math.max(0, Math.floor(input.offset || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit || 50)));
  if (!chunkSet) {
    return { source: toSummary(source), chunkSet: null, chunks: [], total: 0, offset, limit, query };
  }

  const whereSearch = query
    ? " AND (sc.heading LIKE ? ESCAPE '\\' COLLATE NOCASE OR sc.context_prefix LIKE ? ESCAPE '\\' COLLATE NOCASE OR sc.content LIKE ? ESCAPE '\\' COLLATE NOCASE)"
    : "";
  const parameters = query
    ? [chunkSet.id, input.userId, ...Array(3).fill(`%${escapeLike(query)}%`)]
    : [chunkSet.id, input.userId];
  const totalRow = database.prepare(`
    SELECT COUNT(*) AS total
    FROM source_chunks sc
    WHERE sc.chunk_set_id = ? AND sc.user_id = ?${whereSearch}
  `).get(...parameters) as { total: number };
  const rows = database.prepare(`
    SELECT sc.id, sc.position, sc.heading, sc.section_path_json, sc.context_prefix,
           sc.content, sc.page_start, sc.page_end, sc.char_start, sc.char_end,
           sc.token_estimate, sc.node_start_position, sc.node_end_position,
           sc.boundary_reason_json, pc.id AS parent_id, pc.position AS parent_position,
           pc.heading AS parent_heading, pc.content AS parent_content,
           pc.token_estimate AS parent_token_estimate
    FROM source_chunks sc
    JOIN source_parent_chunks pc ON pc.id = sc.parent_chunk_id
    WHERE sc.chunk_set_id = ? AND sc.user_id = ?${whereSearch}
    ORDER BY sc.position
    LIMIT ? OFFSET ?
  `).all(...parameters, limit, offset) as KnowledgeSourceChunkRow[];

  return {
    source: toSummary(source),
    chunkSet: {
      id: chunkSet.id,
      strategy: chunkSet.strategy,
      strategyVersion: chunkSet.strategy_version,
      parentCount: chunkSet.parent_count,
      childCount: chunkSet.child_count,
      createdAt: chunkSet.created_at,
    },
    chunks: rows.map(toChunk),
    total: Number(totalRow.total),
    offset,
    limit,
    query,
  };
}

export function createKnowledgeSource(input: {
  originUrl?: string;
  userId: string;
  title: string;
  description: string;
  kind: KnowledgeSourceKind;
  originalFilename: string;
  mimeType: string;
  buffer: Buffer;
  extracted: ExtractedDocument;
  chunkSet?: SourceChunkSetDraft | null;
}) {
  const contentHash = hash(input.buffer);
  const existing = getDatabase().prepare(`
    SELECT id FROM knowledge_sources
    WHERE user_id = ? AND content_hash = ? AND status != 'deleted'
  `).get(input.userId, contentHash) as { id: string } | undefined;
  if (existing) throw new KnowledgeSourceConflictError("这份资料已经在你的资料库中了。");

  const now = new Date().toISOString();
  const sourceId = randomUUID();
  const versionId = randomUUID();
  const title = input.title.trim().slice(0, 120) || input.originalFilename || "未命名资料";
  const chunkSet = input.chunkSet === undefined
    ? (input.extracted.status === "ready" ? buildChunkSet(input.extracted) : null)
    : input.chunkSet;
  validateChunkSet(input.extracted, chunkSet);

  withTransaction((database) => {
    database.prepare(`
      INSERT INTO knowledge_sources (
        id, user_id, title, description, kind, original_filename, mime_type, byte_size,
        content_hash, status, parser_version, current_version_id, active_chunk_set_id,
        chunk_count, char_count, warning_message, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?)
    `).run(
      sourceId, input.userId, title, input.description.trim().slice(0, 1_000), input.kind,
      input.originalFilename, input.mimeType, input.buffer.length, contentHash,
      input.extracted.status, input.extracted.parserVersion, versionId,
      input.extracted.normalizedMarkdown.length, input.extracted.warnings.join("；").slice(0, 1_000),
      input.extracted.errorMessage.slice(0, 1_000), now, now,
    );
    database.prepare(`
      INSERT INTO source_versions (
        id, source_id, user_id, version, raw_blob, extracted_text, text_hash,
        parser_version, status, warnings_json, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId, sourceId, input.userId, input.buffer, input.extracted.normalizedMarkdown,
      input.extracted.normalizedMarkdown ? hash(input.extracted.normalizedMarkdown) : "",
      input.extracted.parserVersion, input.extracted.status,
      JSON.stringify(input.extracted.warnings), now,
    );
    const persisted = persistParseAndChunks(database, {
      sourceId,
      versionId,
      userId: input.userId,
      extracted: input.extracted,
      chunkSet,
      createdAt: now,
    });
    database.prepare(`
      UPDATE knowledge_sources
      SET active_chunk_set_id = ?, chunk_count = ?, parser_version = ?, updated_at = ?
      WHERE id = ?
    `).run(
      persisted.chunkSetId, persisted.chunkCount,
      chunkSet ? `${input.extracted.parserVersion}+${chunkSet.strategyVersion}` : input.extracted.parserVersion,
      now, sourceId,
    );
    if (input.originUrl) database.prepare(`INSERT INTO web_source_imports
      (user_id, url, source_id, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, url) DO UPDATE SET source_id = excluded.source_id, fetched_at = excluded.fetched_at`)
      .run(input.userId, input.originUrl, sourceId, now);
  });

  const created = getDatabase().prepare(`${SOURCE_SELECT} WHERE ks.id = ? AND ks.user_id = ?`)
    .get(sourceId, input.userId) as KnowledgeSourceRow;
  return toSummary(created);
}

export async function rechunkKnowledgeSource(userId: string, sourceId: string) {
  const remote = getDatabase().prepare(`SELECT 1 FROM knowledge_sources ks
    JOIN source_chunk_sets cs ON cs.id = ks.active_chunk_set_id
    WHERE ks.id = ? AND ks.user_id = ? AND cs.strategy = 'ragflow'`).get(sourceId, userId);
  if (remote) throw new KnowledgeSourceChunkingError('此资料由 RAGFlow 管理，请在 RAGFlow 中调整切片后重新绑定快照。');
  const row = getDatabase().prepare(`
    SELECT ks.kind, ks.original_filename, ks.mime_type, ks.current_version_id, sv.raw_blob
    FROM knowledge_sources ks
    JOIN source_versions sv ON sv.id = ks.current_version_id
    WHERE ks.id = ? AND ks.user_id = ? AND ks.status != 'deleted'
  `).get(sourceId, userId) as {
    kind: KnowledgeSourceKind;
    original_filename: string;
    mime_type: string;
    current_version_id: string;
    raw_blob: Uint8Array;
  } | undefined;
  if (!row) return null;

  const ingestion = await ingestKnowledgeSource({
    buffer: Buffer.from(row.raw_blob),
    kind: row.kind,
    filename: row.original_filename || `source.${row.kind}`,
    mimeType: row.mime_type,
  });
  const { extracted, chunkSet } = ingestion;
  if (extracted.status !== "ready") {
    throw new KnowledgeSourceChunkingError(extracted.errorMessage || "资料重新解析后没有可切片的文字。");
  }
  if (!chunkSet) {
    throw new KnowledgeSourceChunkingError("资料重新解析成功，但没有生成父子切片。");
  }
  validateChunkSet(extracted, chunkSet);
  const now = new Date().toISOString();
  withTransaction((database) => {
    const persisted = persistParseAndChunks(database, {
      sourceId,
      versionId: row.current_version_id,
      userId,
      extracted,
      chunkSet,
      createdAt: now,
    });
    database.prepare(`
      UPDATE knowledge_sources
      SET active_chunk_set_id = ?, chunk_count = ?, char_count = ?, parser_version = ?,
          status = 'ready', warning_message = ?, error_message = '', updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      persisted.chunkSetId, persisted.chunkCount, extracted.normalizedMarkdown.length,
      `${extracted.parserVersion}+${chunkSet.strategyVersion}`,
      extracted.warnings.join("；").slice(0, 1_000), now, sourceId, userId,
    );
  });

  const updated = getDatabase().prepare(`${SOURCE_SELECT} WHERE ks.id = ? AND ks.user_id = ?`)
    .get(sourceId, userId) as KnowledgeSourceRow;
  return toSummary(updated);
}

export function softDeleteKnowledgeSource(userId: string, sourceId: string) {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(`
    UPDATE knowledge_sources
    SET status = 'deleted', deleted_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status != 'deleted'
  `).run(now, now, sourceId, userId);
  return Number(result.changes) > 0;
}
