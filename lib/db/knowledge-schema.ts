import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const KNOWLEDGE_CHUNK_SUPPORT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS document_parse_runs (
    id TEXT PRIMARY KEY,
    source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parser_name TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    output_format TEXT NOT NULL DEFAULT 'markdown+nodes',
    status TEXT NOT NULL CHECK (status IN ('ready', 'ocr_required', 'failed')),
    normalized_markdown TEXT NOT NULL DEFAULT '',
    text_hash TEXT NOT NULL DEFAULT '',
    node_count INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_document_parse_runs_version
    ON document_parse_runs(source_version_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS document_nodes (
    id TEXT PRIMARY KEY,
    parse_run_id TEXT NOT NULL REFERENCES document_parse_runs(id) ON DELETE CASCADE,
    source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    parent_node_id TEXT REFERENCES document_nodes(id) ON DELETE SET NULL,
    node_type TEXT NOT NULL CHECK (node_type IN (
      'title', 'heading', 'paragraph', 'list', 'code', 'table',
      'equation', 'image', 'caption'
    )),
    heading_level INTEGER CHECK (heading_level IS NULL OR heading_level BETWEEN 1 AND 6),
    text TEXT NOT NULL,
    section_path_json TEXT NOT NULL DEFAULT '[]',
    page_start INTEGER CHECK (page_start IS NULL OR page_start >= 1),
    page_end INTEGER CHECK (page_end IS NULL OR page_end >= 1),
    char_start INTEGER NOT NULL DEFAULT 0 CHECK (char_start >= 0),
    char_end INTEGER NOT NULL DEFAULT 0 CHECK (char_end >= char_start),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE(parse_run_id, position)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_document_nodes_parse_position
    ON document_nodes(parse_run_id, position);
  CREATE INDEX IF NOT EXISTS idx_document_nodes_parent
    ON document_nodes(parent_node_id, position);

  CREATE TABLE IF NOT EXISTS source_chunk_sets (
    id TEXT PRIMARY KEY,
    source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parse_run_id TEXT NOT NULL REFERENCES document_parse_runs(id) ON DELETE CASCADE,
    strategy TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('building', 'ready', 'failed')),
    parent_count INTEGER NOT NULL DEFAULT 0 CHECK (parent_count >= 0),
    child_count INTEGER NOT NULL DEFAULT 0 CHECK (child_count >= 0),
    config_json TEXT NOT NULL DEFAULT '{}',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    activated_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_source_chunk_sets_source
    ON source_chunk_sets(source_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_source_chunk_sets_version
    ON source_chunk_sets(source_version_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS source_parent_chunks (
    id TEXT PRIMARY KEY,
    chunk_set_id TEXT NOT NULL REFERENCES source_chunk_sets(id) ON DELETE CASCADE,
    source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    heading TEXT NOT NULL DEFAULT '',
    section_path_json TEXT NOT NULL DEFAULT '[]',
    content TEXT NOT NULL,
    page_start INTEGER CHECK (page_start IS NULL OR page_start >= 1),
    page_end INTEGER CHECK (page_end IS NULL OR page_end >= 1),
    char_start INTEGER NOT NULL DEFAULT 0 CHECK (char_start >= 0),
    char_end INTEGER NOT NULL DEFAULT 0 CHECK (char_end >= char_start),
    token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(chunk_set_id, position)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_source_parent_chunks_set
    ON source_parent_chunks(chunk_set_id, position);
`;

function createSourceChunksSchema(tableName: "source_chunks" | "source_chunks_v9") {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT PRIMARY KEY,
      chunk_set_id TEXT NOT NULL REFERENCES source_chunk_sets(id) ON DELETE CASCADE,
      parent_chunk_id TEXT NOT NULL REFERENCES source_parent_chunks(id) ON DELETE CASCADE,
      source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      heading TEXT NOT NULL DEFAULT '',
      section_path_json TEXT NOT NULL DEFAULT '[]',
      context_prefix TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      page_start INTEGER CHECK (page_start IS NULL OR page_start >= 1),
      page_end INTEGER CHECK (page_end IS NULL OR page_end >= 1),
      char_start INTEGER NOT NULL DEFAULT 0 CHECK (char_start >= 0),
      char_end INTEGER NOT NULL DEFAULT 0 CHECK (char_end >= char_start),
      token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
      node_start_position INTEGER CHECK (node_start_position IS NULL OR node_start_position >= 0),
      node_end_position INTEGER CHECK (
        node_end_position IS NULL OR node_start_position IS NULL OR node_end_position >= node_start_position
      ),
      boundary_reason_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(chunk_set_id, position)
    ) STRICT;
  `;
}

export const SOURCE_CHUNKS_SCHEMA = createSourceChunksSchema("source_chunks");

export const KNOWLEDGE_CHUNK_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_source_chunks_set
    ON source_chunks(chunk_set_id, position);
  CREATE INDEX IF NOT EXISTS idx_source_chunks_parent
    ON source_chunks(parent_chunk_id, position);
  CREATE INDEX IF NOT EXISTS idx_source_chunks_source
    ON source_chunks(source_id, chunk_set_id, position);
  CREATE INDEX IF NOT EXISTS idx_source_chunks_user
    ON source_chunks(user_id, source_id, chunk_set_id, position);

  CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
    chunk_id UNINDEXED,
    source_id UNINDEXED,
    user_id UNINDEXED,
    title,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS source_chunks_fts_insert AFTER INSERT ON source_chunks BEGIN
    INSERT INTO source_chunks_fts(chunk_id, source_id, user_id, title, content)
    SELECT new.id, new.source_id, new.user_id,
           knowledge_sources.title || ' ' || new.heading || ' ' || new.context_prefix,
           new.content
    FROM knowledge_sources WHERE knowledge_sources.id = new.source_id;
  END;

  CREATE TRIGGER IF NOT EXISTS source_chunks_fts_delete AFTER DELETE ON source_chunks BEGIN
    DELETE FROM source_chunks_fts WHERE chunk_id = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS source_chunks_fts_update
  AFTER UPDATE OF content, heading, context_prefix ON source_chunks BEGIN
    DELETE FROM source_chunks_fts WHERE chunk_id = old.id;
    INSERT INTO source_chunks_fts(chunk_id, source_id, user_id, title, content)
    SELECT new.id, new.source_id, new.user_id,
           knowledge_sources.title || ' ' || new.heading || ' ' || new.context_prefix,
           new.content
    FROM knowledge_sources WHERE knowledge_sources.id = new.source_id;
  END;
`;

type LegacyChunkRow = {
  id: string;
  source_version_id: string;
  source_id: string;
  user_id: string;
  position: number;
  heading: string;
  content: string;
  page_start: number | null;
  page_end: number | null;
  char_start: number;
  char_end: number;
  token_estimate: number;
  content_hash: string;
  created_at: string;
};

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function columnExists(database: DatabaseSync, table: string, column: string) {
  if (!tableExists(database, table)) return false;
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((existing) => existing.name === column);
}

/**
 * Schema V8 used one mutable list of chunks per source version. V9 rebuilds that
 * table so multiple immutable chunk sets can coexist. Existing chunk ids are
 * preserved because assessment evidence may already reference them.
 */
export function migrateKnowledgeChunkSchema(database: DatabaseSync) {
  if (!tableExists(database, "source_chunks") || columnExists(database, "source_chunks", "chunk_set_id")) {
    return false;
  }

  database.exec(KNOWLEDGE_CHUNK_SUPPORT_SCHEMA);
  if (!columnExists(database, "knowledge_sources", "active_chunk_set_id")) {
    database.exec("ALTER TABLE knowledge_sources ADD COLUMN active_chunk_set_id TEXT REFERENCES source_chunk_sets(id) ON DELETE SET NULL");
  }

  const legacyChunks = database.prepare(`
    SELECT id, source_version_id, source_id, user_id, position, heading, content,
           page_start, page_end, char_start, char_end, token_estimate, content_hash, created_at
    FROM source_chunks
    ORDER BY source_version_id, position
  `).all() as LegacyChunkRow[];
  const versionRows = database.prepare(`
    SELECT sv.id, sv.source_id, sv.user_id, sv.extracted_text, sv.text_hash, sv.parser_version,
           sv.status, sv.warnings_json, sv.created_at, ks.current_version_id
    FROM source_versions sv
    JOIN knowledge_sources ks ON ks.id = sv.source_id
    WHERE EXISTS (SELECT 1 FROM source_chunks sc WHERE sc.source_version_id = sv.id)
    ORDER BY sv.source_id, sv.version
  `).all() as Array<{
    id: string;
    source_id: string;
    user_id: string;
    extracted_text: string;
    text_hash: string;
    parser_version: string;
    status: "ready" | "ocr_required" | "failed";
    warnings_json: string;
    created_at: string;
    current_version_id: string | null;
  }>;

  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS source_chunks_fts_insert;
      DROP TRIGGER IF EXISTS source_chunks_fts_delete;
      DROP TRIGGER IF EXISTS source_chunks_fts_update;
      ${createSourceChunksSchema("source_chunks_v9")}
    `);

    const insertParseRun = database.prepare(`
      INSERT INTO document_parse_runs (
        id, source_version_id, source_id, user_id, parser_name, parser_version,
        output_format, status, normalized_markdown, text_hash, node_count,
        warnings_json, error_message, created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'legacy', ?, 'plain-text', ?, ?, ?, 0, ?, '', ?, ?)
    `);
    const insertChunkSet = database.prepare(`
      INSERT INTO source_chunk_sets (
        id, source_version_id, source_id, user_id, parse_run_id, strategy,
        strategy_version, status, parent_count, child_count, config_json,
        warnings_json, created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, 'legacy-character', 'character-boundary-v1', 'ready', ?, ?, '{}', '[]', ?, ?)
    `);
    const insertParent = database.prepare(`
      INSERT INTO source_parent_chunks (
        id, chunk_set_id, source_version_id, source_id, user_id, position,
        heading, section_path_json, content, page_start, page_end, char_start,
        char_end, token_estimate, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = database.prepare(`
      INSERT INTO source_chunks_v9 (
        id, chunk_set_id, parent_chunk_id, source_version_id, source_id, user_id,
        position, heading, section_path_json, context_prefix, content, page_start,
        page_end, char_start, char_end, token_estimate, node_start_position,
        node_end_position, boundary_reason_json, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `);
    const activate = database.prepare(`
      UPDATE knowledge_sources
      SET active_chunk_set_id = ?, chunk_count = ?, updated_at = ?
      WHERE id = ? AND current_version_id = ?
    `);

    for (const version of versionRows) {
      const chunks = legacyChunks.filter((chunk) => chunk.source_version_id === version.id);
      const parseRunId = randomUUID();
      const chunkSetId = randomUUID();
      const activatedAt = version.current_version_id === version.id ? new Date().toISOString() : null;
      insertParseRun.run(
        parseRunId, version.id, version.source_id, version.user_id,
        version.parser_version || "source-parser-v1", version.status,
        version.extracted_text, version.text_hash, version.warnings_json,
        version.created_at, version.created_at,
      );
      insertChunkSet.run(
        chunkSetId, version.id, version.source_id, version.user_id, parseRunId,
        chunks.length, chunks.length, version.created_at, activatedAt,
      );
      for (const chunk of chunks) {
        const parentId = randomUUID();
        const sectionPath = JSON.stringify(chunk.heading ? [chunk.heading] : []);
        insertParent.run(
          parentId, chunkSetId, chunk.source_version_id, chunk.source_id, chunk.user_id,
          chunk.position, chunk.heading, sectionPath, chunk.content, chunk.page_start,
          chunk.page_end, chunk.char_start, chunk.char_end, chunk.token_estimate,
          chunk.content_hash, chunk.created_at,
        );
        insertChunk.run(
          chunk.id, chunkSetId, parentId, chunk.source_version_id, chunk.source_id,
          chunk.user_id, chunk.position, chunk.heading, sectionPath, chunk.heading,
          chunk.content, chunk.page_start, chunk.page_end, chunk.char_start,
          chunk.char_end, chunk.token_estimate,
          JSON.stringify({ method: "legacy-character", migratedFrom: 8 }),
          chunk.content_hash, chunk.created_at,
        );
      }
      if (activatedAt) activate.run(chunkSetId, chunks.length, activatedAt, version.source_id, version.id);
    }

    database.exec(`
      DROP TABLE source_chunks;
      ALTER TABLE source_chunks_v9 RENAME TO source_chunks;
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
  return true;
}

export function rebuildKnowledgeChunkFts(database: DatabaseSync) {
  database.exec(KNOWLEDGE_CHUNK_INDEX_SCHEMA);
  database.exec("DELETE FROM source_chunks_fts");
  database.exec(`
    INSERT INTO source_chunks_fts(chunk_id, source_id, user_id, title, content)
    SELECT sc.id, sc.source_id, sc.user_id,
           ks.title || ' ' || sc.heading || ' ' || sc.context_prefix,
           sc.content
    FROM source_chunks sc
    JOIN knowledge_sources ks ON ks.id = sc.source_id
  `);
}
