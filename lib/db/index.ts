import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATABASE_SCHEMA, DATABASE_SCHEMA_VERSION } from "./schema";

type GlobalWithDatabase = typeof globalThis & {
  growthLoopDatabase?: DatabaseSync;
};

const globalWithDatabase = globalThis as GlobalWithDatabase;

function openDatabase() {
  const configuredPath = process.env.SQLITE_DATABASE_PATH?.trim();
  const databasePath = configuredPath
    ? path.resolve(configuredPath)
    : path.join(process.cwd(), "data", "growth-loop.sqlite");

  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(DATABASE_SCHEMA);
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
