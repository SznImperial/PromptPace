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
  blocked: boolean;
}

const TABLE = "requests";
const SESSION_BUDGETS = "session_budgets";
const SESSION_BASELINES = "session_baselines";

const COLUMNS: Array<[string, string]> = [
  ["cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["partial", "INTEGER NOT NULL DEFAULT 0"],
  ["blocked", "INTEGER NOT NULL DEFAULT 0"],
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
      partial INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON ${TABLE} (timestamp);
    CREATE INDEX IF NOT EXISTS idx_requests_session ON ${TABLE} (session_id);

    CREATE TABLE IF NOT EXISTS ${SESSION_BUDGETS} (
      session_id TEXT PRIMARY KEY,
      cap_usd REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${SESSION_BASELINES} (
      session_id TEXT PRIMARY KEY,
      reset_at TEXT NOT NULL
    );
  `);

  // Bring databases created before the cache/partial/blocked columns up to date.
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
      (id, timestamp, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost, status, session_id, partial, blocked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    record.blocked ? 1 : 0,
  );
}

/** The per-session cap in USD, or null when the session has no override. */
export function getSessionCap(db: Db, sessionId: string): number | null {
  const row = db
    .prepare(`SELECT cap_usd FROM ${SESSION_BUDGETS} WHERE session_id = ?`)
    .get(sessionId) as { cap_usd: number } | undefined;
  return row ? row.cap_usd : null;
}

export function setSessionCap(db: Db, sessionId: string, capUsd: number): void {
  db.prepare(
    `INSERT INTO ${SESSION_BUDGETS} (session_id, cap_usd, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET cap_usd = excluded.cap_usd, updated_at = excluded.updated_at`,
  ).run(sessionId, capUsd, new Date().toISOString());
}

/** The timestamp the session spend baseline was last reset to, or null. */
export function getSessionBaseline(db: Db, sessionId: string): string | null {
  const row = db
    .prepare(`SELECT reset_at FROM ${SESSION_BASELINES} WHERE session_id = ?`)
    .get(sessionId) as { reset_at: string } | undefined;
  return row ? row.reset_at : null;
}

/** Resets the spend baseline. History is kept. */
export function resetSessionBaseline(db: Db, sessionId: string): string {
  const resetAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO ${SESSION_BASELINES} (session_id, reset_at)
     VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET reset_at = excluded.reset_at`,
  ).run(sessionId, resetAt);
  return resetAt;
}

/** Cumulative cost in USD for the session since its baseline. */
export function getSessionSpend(db: Db, sessionId: string): number {
  const baseline = getSessionBaseline(db, sessionId);
  const row = (
    baseline
      ? db
          .prepare(
            `SELECT COALESCE(SUM(cost), 0) AS spent FROM ${TABLE} WHERE session_id = ? AND timestamp > ?`,
          )
          .get(sessionId, baseline)
      : db.prepare(`SELECT COALESCE(SUM(cost), 0) AS spent FROM ${TABLE} WHERE session_id = ?`).get(sessionId)
  ) as { spent: number };
  return row.spent;
}

export function getSessionBlockedCount(db: Db, sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${TABLE} WHERE session_id = ? AND blocked = 1`)
    .get(sessionId) as { count: number };
  return row.count;
}

export function getSessionLastActivity(db: Db, sessionId: string): string | null {
  const row = db
    .prepare(`SELECT MAX(timestamp) AS last_activity FROM ${TABLE} WHERE session_id = ?`)
    .get(sessionId) as { last_activity: string | null };
  return row.last_activity;
}

/** Every session the proxy has seen, plus sessions that only have a cap set. */
export function listSessionIds(db: Db): string[] {
  const fromRequests = db
    .prepare(`SELECT DISTINCT session_id FROM ${TABLE}`)
    .all() as Array<{ session_id: string }>;
  const fromBudgets = db
    .prepare(`SELECT session_id FROM ${SESSION_BUDGETS}`)
    .all() as Array<{ session_id: string }>;
  return Array.from(
    new Set([...fromRequests.map((row) => row.session_id), ...fromBudgets.map((row) => row.session_id)]),
  ).sort();
}
