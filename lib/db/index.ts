import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COLUMN_ADDITIONS, DATABASE_SCHEMA, DATABASE_SCHEMA_VERSION } from "./schema";

type GlobalWithDatabase = typeof globalThis & {
  growthLoopDatabase?: DatabaseSync;
};

const globalWithDatabase = globalThis as GlobalWithDatabase;

/** 幂等补列：只给缺失的列执行 ALTER，已经存在的跳过。 */
function applyColumnAdditions(database: DatabaseSync) {
  for (const { table, column, ddl } of COLUMN_ADDITIONS) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((existing) => existing.name === column)) {
      database.exec(ddl);
    }
  }
}

function openDatabase() {
  const configuredPath = process.env.SQLITE_DATABASE_PATH?.trim();
  const databasePath = configuredPath
    ? path.resolve(configuredPath)
    : path.join(process.cwd(), "data", "growth-loop.sqlite");

  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(DATABASE_SCHEMA);
  applyColumnAdditions(database);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(DATABASE_SCHEMA_VERSION, new Date().toISOString());
  return database;
}

export function getDatabase() {
  if (!globalWithDatabase.growthLoopDatabase) {
    globalWithDatabase.growthLoopDatabase = openDatabase();
  }
  return globalWithDatabase.growthLoopDatabase;
}

/** 单层事务：跨表写入要么全部成功，要么全部回滚。不要嵌套调用。 */
export function withTransaction<T>(run: (database: DatabaseSync) => T): T {
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite 可能已经自动回滚，此时不要用回滚错误覆盖真正的失败原因。
    }
    throw error;
  }
}
