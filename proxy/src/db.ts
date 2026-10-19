import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export interface RequestRecord {
  id: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  status: number;
  sessionId: string;
  partial: boolean;
}

const TABLE = "requests";

const COLUMNS: Array<[string, string]> = [
  ["cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["partial", "INTEGER NOT NULL DEFAULT 0"],
];

export function openDatabase(filePath: string): Db {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      status INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      partial INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON ${TABLE} (timestamp);
  `);

  // Bring databases created before the cache/partial columns up to date.
  const existing = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>;
  for (const [name, ddl] of COLUMNS) {
    if (!existing.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${ddl}`);
    }
  }

  return db;
}

export function recordRequest(db: Db, record: RequestRecord): void {
  db.prepare(
    `INSERT INTO ${TABLE}
      (id, timestamp, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost, status, session_id, partial)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.timestamp,
    record.model,
    record.inputTokens,
    record.outputTokens,
    record.cacheCreationTokens,
    record.cacheReadTokens,
    record.cost,
    record.status,
    record.sessionId,
    record.partial ? 1 : 0,
  );
}
