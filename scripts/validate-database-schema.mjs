import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { COLUMN_ADDITIONS, DATABASE_SCHEMA, DATABASE_SCHEMA_VERSION } from "../lib/db/schema.ts";
import {
  KNOWLEDGE_CHUNK_INDEX_SCHEMA,
  migrateKnowledgeChunkSchema,
  rebuildKnowledgeChunkFts,
} from "../lib/db/knowledge-schema.ts";

const requiredTables = [
  "lesson_answer_drafts",
  "web_research_runs",
  "web_research_actions",
  "web_search_candidates",
  "web_source_imports",
  "users",
  "goals",
  "tasks",
  "goal_learning_profiles",
  "goal_skills",
  "skill_mastery",
  "learning_programs",
  "course_modules",
  "course_lessons",
  "lesson_content_versions",
  "lesson_quality_reports",
  "lesson_block_sources",
  "task_lesson_links",
  "diagnostic_assessments",
  "diagnostic_questions",
  "diagnostic_responses",
  "diagnostic_attempts",
  "lesson_assessment_attempts",
  "workflow_runs",
  "workflow_events",
  "agent_runs",
  "knowledge_sources",
  "source_versions",
  "document_parse_runs",
  "document_nodes",
  "source_chunk_sets",
  "source_parent_chunks",
  "source_chunks",
  "source_chunks_fts",
  "embedding_profiles",
  "pipeline_runs",
  "pipeline_stage_metrics",
  "embedding_runs",
  "source_chunk_embeddings",
  "goal_source_links",
  "retrieval_runs",
  "retrieval_run_items",
  "question_source_links",
];

const database = new DatabaseSync(":memory:");
try {
  database.exec(DATABASE_SCHEMA);
  database.exec(KNOWLEDGE_CHUNK_INDEX_SCHEMA);
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));

  for (const table of requiredTables) {
    assert(tables.includes(table), `missing required table: ${table}`);
  }

  database.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
    VALUES ('schema-user', 'schema-user', 'hash', 'Schema User', '2026-01-01', '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO knowledge_sources (
      id, user_id, title, kind, content_hash, status, current_version_id, active_chunk_set_id, chunk_count,
      char_count, created_at, updated_at
    ) VALUES ('source-1', 'schema-user', 'FTS 测试资料', 'text', 'hash-1', 'ready', 'version-1', NULL, 1, 8, '2026-01-01', '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO source_versions (
      id, source_id, user_id, version, raw_blob, extracted_text, text_hash,
      parser_version, status, created_at
    ) VALUES ('version-1', 'source-1', 'schema-user', 1, ?, '状态机 检索测试', 'text-hash', 'test', 'ready', '2026-01-01')
  `).run(Buffer.from("状态机 检索测试"));
  database.prepare(`
    INSERT INTO document_parse_runs (
      id, source_version_id, source_id, user_id, parser_name, parser_version,
      status, normalized_markdown, text_hash, node_count, created_at, completed_at
    ) VALUES ('parse-1', 'version-1', 'source-1', 'schema-user', 'test', 'test-v1',
      'ready', '状态机 检索测试', 'text-hash', 1, '2026-01-01', '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO document_nodes (
      id, parse_run_id, source_version_id, source_id, user_id, position,
      node_type, text, char_end, created_at
    ) VALUES ('node-1', 'parse-1', 'version-1', 'source-1', 'schema-user', 0,
      'paragraph', '状态机 检索测试', 8, '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO source_chunk_sets (
      id, source_version_id, source_id, user_id, parse_run_id, strategy,
      strategy_version, parent_count, child_count, created_at, activated_at
    ) VALUES ('set-1', 'version-1', 'source-1', 'schema-user', 'parse-1',
      'structure-recursive-parent-child', 'test-v1', 1, 1, '2026-01-01', '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO source_parent_chunks (
      id, chunk_set_id, source_version_id, source_id, user_id, position,
      heading, content, char_end, token_estimate, content_hash, created_at
    ) VALUES ('parent-1', 'set-1', 'version-1', 'source-1', 'schema-user', 0,
      '状态机', '状态机 检索测试', 8, 8, 'parent-hash', '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO source_chunks (
      id, chunk_set_id, parent_chunk_id, source_version_id, source_id, user_id,
      position, heading, context_prefix, content, char_end, token_estimate,
      content_hash, created_at
    ) VALUES ('chunk-1', 'set-1', 'parent-1', 'version-1', 'source-1', 'schema-user',
      0, '状态机', '系统设计 > 状态机', '状态机 检索测试', 8, 8, 'chunk-hash', '2026-01-01')
  `).run();
  database.prepare("UPDATE knowledge_sources SET active_chunk_set_id = 'set-1' WHERE id = 'source-1'").run();
  const ftsHit = database.prepare(`
    SELECT chunk_id FROM source_chunks_fts
    WHERE source_chunks_fts MATCH '状态机' AND user_id = 'schema-user'
  `).get();
  assert.equal(ftsHit?.chunk_id, "chunk-1", "FTS5 trigger did not index source chunk");

  const integrity = database.prepare("PRAGMA integrity_check").get();
  assert.equal(integrity?.integrity_check, "ok");

  // 新库走 CREATE TABLE、老库走 ALTER，两条路必须收敛到同一形状：
  // COLUMN_ADDITIONS 里的每一列都应该已经写进了建表语句，否则新库会缺列。
  for (const { table, column } of COLUMN_ADDITIONS) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert(
      columns.includes(column),
      `COLUMN_ADDITIONS 声明了 ${table}.${column}，但建表语句里没有；新建的数据库会缺这一列`,
    );
  }

  console.log(JSON.stringify({
    schemaVersion: DATABASE_SCHEMA_VERSION,
    tableCount: tables.length,
    requiredTableCount: requiredTables.length,
    columnAdditions: COLUMN_ADDITIONS.length,
    integrity: "ok",
  }));
} finally {
  database.close();
}

// 在模拟的老库上验证补列逻辑：缺列时能补上，重复执行不报错。
for (const { table, column, ddl } of COLUMN_ADDITIONS) {
  // 同一张表可能连续新增多列；每个用例使用独立老库，避免前一个 CREATE IF NOT EXISTS
  // 让后一个用例误读到已经创建的表。
  const legacy = new DatabaseSync(":memory:");
  try {
    const create = DATABASE_SCHEMA.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) (?:WITHOUT ROWID, )?STRICT;`),
    );
    assert(create, `找不到 ${table} 的建表语句`);

    // 去掉待补的那一列，还原成升级前的表结构。
    const withoutColumn = create[0]
      .split("\n")
      .filter((line) => !new RegExp(`\\b${column}\\b`).test(line))
      .join("\n");
    legacy.exec("PRAGMA foreign_keys = OFF;");
    legacy.exec(withoutColumn.replace(/REFERENCES \w+\(\w+\)( ON DELETE \w+( \w+)?)?/g, ""));

    const before = legacy.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert(!before.includes(column), `模拟老库时没能去掉 ${table}.${column}`);

    legacy.exec(ddl);
    const after = legacy.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert(after.includes(column), `ALTER 之后 ${table}.${column} 仍然不存在`);

    // 幂等：真实流程会先检查再补，这里确认重复 ALTER 确实会被 SQLite 拒绝，
    // 也就是说 applyColumnAdditions 的存在性检查不能省。
    assert.throws(() => legacy.exec(ddl), /duplicate column name/i);
  } finally {
    legacy.close();
  }
}

// Schema V8 -> V9 rebuild: old chunk ids and downstream evidence references must survive.
const legacyKnowledge = new DatabaseSync(":memory:");
try {
  legacyKnowledge.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE knowledge_sources (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      current_version_id TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE source_versions (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      version INTEGER NOT NULL,
      extracted_text TEXT NOT NULL DEFAULT '',
      text_hash TEXT NOT NULL DEFAULT '',
      parser_version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE source_chunks (
      id TEXT PRIMARY KEY,
      source_version_id TEXT NOT NULL REFERENCES source_versions(id),
      source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      position INTEGER NOT NULL,
      heading TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      char_start INTEGER NOT NULL DEFAULT 0,
      char_end INTEGER NOT NULL DEFAULT 0,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_version_id, position)
    ) STRICT;
    CREATE TABLE evidence (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES source_chunks(id)
    ) STRICT;
    CREATE VIRTUAL TABLE source_chunks_fts USING fts5(
      chunk_id UNINDEXED, source_id UNINDEXED, user_id UNINDEXED, title, content
    );
    CREATE TRIGGER source_chunks_fts_insert AFTER INSERT ON source_chunks BEGIN
      INSERT INTO source_chunks_fts(chunk_id, source_id, user_id, title, content)
      VALUES (new.id, new.source_id, new.user_id, new.heading, new.content);
    END;

    INSERT INTO users VALUES ('legacy-user');
    INSERT INTO knowledge_sources VALUES ('legacy-source', 'legacy-user', '旧资料', 'legacy-version', 1, '2026-01-01');
    INSERT INTO source_versions VALUES (
      'legacy-version', 'legacy-source', 'legacy-user', 1, '第一章\n\n旧切片内容',
      'text-hash', 'source-parser-v1', 'ready', '[]', '2026-01-01'
    );
    INSERT INTO source_chunks VALUES (
      'legacy-chunk', 'legacy-version', 'legacy-source', 'legacy-user', 0,
      '第一章', '旧切片内容', NULL, NULL, 0, 5, 5, 'chunk-hash', '2026-01-01'
    );
    INSERT INTO evidence VALUES ('evidence-1', 'legacy-chunk');
  `);
  assert.equal(migrateKnowledgeChunkSchema(legacyKnowledge), true);
  rebuildKnowledgeChunkFts(legacyKnowledge);
  const migrated = legacyKnowledge.prepare(`
    SELECT sc.id, sc.chunk_set_id, sc.parent_chunk_id, ks.active_chunk_set_id
    FROM source_chunks sc JOIN knowledge_sources ks ON ks.id = sc.source_id
  `).get();
  assert.equal(migrated?.id, "legacy-chunk", "V8 chunk id changed during migration");
  assert.equal(migrated?.chunk_set_id, migrated?.active_chunk_set_id, "legacy chunk set was not activated");
  assert(migrated?.parent_chunk_id, "legacy parent chunk was not created");
  assert.equal(legacyKnowledge.prepare("SELECT chunk_id FROM evidence").get()?.chunk_id, "legacy-chunk");
  assert.equal(legacyKnowledge.prepare("PRAGMA foreign_key_check").all().length, 0, "migration broke foreign keys");
  assert.equal(migrateKnowledgeChunkSchema(legacyKnowledge), false, "V9 migration is not idempotent");
} finally {
  legacyKnowledge.close();
}
