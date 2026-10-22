import { mkdirSync, chmodSync } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

/**
 * 运行期用 createRequire 加载 node:sqlite。
 *
 * 不写成静态 `import { DatabaseSync } from "node:sqlite"` 的原因：vite/vitest 的
 * 转换器内置外置表未收录该模块，会把说明符改写为裸 "sqlite" 导致加载失败；
 * 通过 require 调用则原样交给 Node 解析。同时屏蔽 SQLite 的 ExperimentalWarning。
 */
function loadSqlite(): { DatabaseSync: new (file: string) => unknown } {
  const require = createRequire(import.meta.url);
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as { DatabaseSync: new (file: string) => unknown };
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const { DatabaseSync } = loadSqlite();

/**
 * node:sqlite 的类型声明在 @types/node 22 中尚不完整（不同小版本差异较大），
 * 这里给出一个最小可用视图，避免 `tsc -b` 因声明缺失而失败。
 */
export interface SqliteStatement {
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqliteValue[]): Record<string, unknown> | undefined;
  all(...params: SqliteValue[]): Record<string, unknown>[];
}

export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** 打开（并初始化）SQLite 数据库：WAL + 外键 + busy_timeout。 */
export function openDatabase(file: string): SqliteDatabase {
  if (file !== ":memory:") {
    const dir = path.dirname(path.resolve(file));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 权限调整失败（非 POSIX / 无权限）不影响可用性。
    }
  }
  const db = new DatabaseSync(file) as unknown as SqliteDatabase;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** 当前 schema 版本。 */
export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls_json TEXT,
      tool_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      input TEXT,
      started_at TEXT,
      finished_at TEXT,
      termination_reason TEXT,
      error_code TEXT,
      error_summary TEXT,
      steps INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      call_id TEXT,
      tool_name TEXT,
      arguments_json TEXT,
      result_json TEXT,
      status TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      error_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id);
  `,
};

function getUserVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"] ?? 0;
  return typeof value === "number" ? value : Number(value ?? 0);
}

/**
 * 版本化迁移：按 PRAGMA user_version 逐版本应用，每个版本一个事务。
 * 可重复调用（幂等）；失败时回滚并把错误抛出。
 */
export function migrate(db: SqliteDatabase): number {
  let version = getUserVersion(db);
  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    const sql = MIGRATIONS[next];
    if (!sql) throw new Error(`missing migration for schema version ${next}`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      // PRAGMA 不接受参数绑定，版本号来自本地常量，拼接是安全的。
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 回滚失败时保留原始错误。
      }
      throw err;
    }
    version = next;
  }
  return version;
}
