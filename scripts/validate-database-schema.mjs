import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { COLUMN_ADDITIONS, DATABASE_SCHEMA, DATABASE_SCHEMA_VERSION } from "../lib/db/schema.ts";

const requiredTables = [
  "users",
  "goals",
  "tasks",
  "goal_learning_profiles",
  "goal_skills",
  "skill_mastery",
  "learning_programs",
  "course_modules",
  "course_lessons",
  "task_lesson_links",
  "diagnostic_assessments",
  "diagnostic_questions",
  "diagnostic_responses",
  "diagnostic_attempts",
  "lesson_assessment_attempts",
  "workflow_runs",
  "agent_runs",
];

const database = new DatabaseSync(":memory:");
try {
  database.exec(DATABASE_SCHEMA);
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));

  for (const table of requiredTables) {
    assert(tables.includes(table), `missing required table: ${table}`);
  }

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
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) STRICT;`),
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
