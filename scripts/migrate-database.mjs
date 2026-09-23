import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { COLUMN_ADDITIONS, DATABASE_SCHEMA, DATABASE_SCHEMA_VERSION } from "../lib/db/schema.ts";
import {
  KNOWLEDGE_CHUNK_INDEX_SCHEMA,
  migrateKnowledgeChunkSchema,
  rebuildKnowledgeChunkFts,
} from "../lib/db/knowledge-schema.ts";

const databasePath = process.env.SQLITE_DATABASE_PATH?.trim()
  ? path.resolve(process.env.SQLITE_DATABASE_PATH.trim())
  : path.resolve("data", "growth-loop.sqlite");
const database = new DatabaseSync(databasePath);

try {
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const migratedKnowledgeChunks = migrateKnowledgeChunkSchema(database);
  database.exec(DATABASE_SCHEMA);
  for (const { table, column, ddl } of COLUMN_ADDITIONS) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((existing) => existing.name === column)) database.exec(ddl);
  }
  database.exec(KNOWLEDGE_CHUNK_INDEX_SCHEMA);
  if (migratedKnowledgeChunks) rebuildKnowledgeChunkFts(database);
  database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(DATABASE_SCHEMA_VERSION, new Date().toISOString());

  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  const integrity = database.prepare("PRAGMA integrity_check").get()?.integrity_check;
  assert.equal(foreignKeyViolations.length, 0, "foreign_key_check failed");
  assert.equal(integrity, "ok", "integrity_check failed");
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_sources WHERE status != 'deleted') AS sources,
      (SELECT COUNT(*) FROM document_parse_runs) AS parse_runs,
      (SELECT COUNT(*) FROM document_nodes) AS nodes,
      (SELECT COUNT(*) FROM source_chunk_sets) AS chunk_sets,
      (SELECT COUNT(*) FROM source_parent_chunks) AS parents,
      (SELECT COUNT(*) FROM source_chunks) AS children
  `).get();
  console.log(JSON.stringify({
    databasePath,
    schemaVersion: DATABASE_SCHEMA_VERSION,
    migratedKnowledgeChunks,
    ...counts,
    integrity,
  }));
} finally {
  database.close();
}
