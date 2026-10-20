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
  fingerprint: string | null;
  flagged: boolean;
}

export interface AlertRow {
  timestamp: string;
  fingerprint: string | null;
  status: number;
  blocked: number;
  flagged: number;
  cost: number;
}

const TABLE = "requests";
const SESSION_BUDGETS = "session_budgets";
const SESSION_BASELINES = "session_baselines";

const COLUMNS: Array<[string, string]> = [
  ["cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["partial", "INTEGER NOT NULL DEFAULT 0"],
  ["blocked", "INTEGER NOT NULL DEFAULT 0"],
  ["fingerprint", "TEXT"],
  ["flagged", "INTEGER NOT NULL DEFAULT 0"],
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
      blocked INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT,
      flagged INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON ${TABLE} (timestamp);
    CREATE INDEX IF NOT EXISTS idx_requests_session ON ${TABLE} (session_id);
    CREATE INDEX IF NOT EXISTS idx_requests_fingerprint ON ${TABLE} (session_id, fingerprint);

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
      (id, timestamp, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost, status, session_id, partial, blocked, fingerprint, flagged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    record.fingerprint,
    record.flagged ? 1 : 0,
  );
}

/** How many requests with the same fingerprint the session made in the window. */
export function countRepeats(
  db: Db,
  sessionId: string,
  fingerprint: string,
  windowSeconds: number,
  now: Date = new Date(),
): number {
  const since = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE} WHERE session_id = ? AND fingerprint = ? AND timestamp > ?`,
    )
    .get(sessionId, fingerprint, since) as { count: number };
  return row.count;
}

/** How many requests with the same fingerprint the session had at a point in time. */
export function countRepeatsAt(
  db: Db,
  sessionId: string,
  fingerprint: string,
  windowSeconds: number,
  at: Date,
): number {
  const since = new Date(at.getTime() - windowSeconds * 1000).toISOString();
  const atIso = at.toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE}
       WHERE session_id = ? AND fingerprint = ? AND timestamp <= ? AND timestamp > ?`,
    )
    .get(sessionId, fingerprint, atIso, since) as { count: number };
  return row.count;
}

/** Recent flagged or blocked rows for a session, newest first. */
export function getSessionAlerts(db: Db, sessionId: string, limit = 50): AlertRow[] {
  return db
    .prepare(
      `SELECT timestamp, fingerprint, status, blocked, flagged, cost FROM ${TABLE}
       WHERE session_id = ? AND (flagged = 1 OR blocked = 1)
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(sessionId, limit) as AlertRow[];
}

export interface RequestListRow {
  id: string;
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost: number;
  status: number;
  partial: number;
  flagged: number;
  blocked: number;
  session_id: string;
}

/**
 * The most recent request rows, newest first. Only the columns listed here
 * are returned; no message content is stored and none is served.
 */
export function listRequests(
  db: Db,
  options: { limit: number; sessionId: string | null },
): RequestListRow[] {
  return db
    .prepare(
      `SELECT id, timestamp, model, input_tokens, output_tokens, cache_creation_tokens,
              cache_read_tokens, cost, status, partial, flagged, blocked, session_id
       FROM ${TABLE}
       WHERE (? IS NULL OR session_id = ?)
       ORDER BY timestamp DESC, rowid DESC
       LIMIT ?`,
    )
    .all(options.sessionId, options.sessionId, options.limit) as RequestListRow[];
}

export interface SeriesBucket {
  /** The start of the minute, ISO-8601 UTC. */
  minute: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

/**
 * Cost and token totals bucketed per minute over the last `minutes` minutes.
 * Empty minutes are included so the series is continuous.
 */
export function getCostSeries(
  db: Db,
  options: { minutes: number; sessionId: string | null },
): SeriesBucket[] {
  const now = Date.now();
  const since = new Date(now - options.minutes * 60_000).toISOString();

  const rows = db
    .prepare(
      `SELECT timestamp, cost, input_tokens, output_tokens FROM ${TABLE}
       WHERE timestamp >= ? AND (? IS NULL OR session_id = ?)`,
    )
    .all(since, options.sessionId, options.sessionId) as Array<{
    timestamp: string;
    cost: number;
    input_tokens: number;
    output_tokens: number;
  }>;

  const minuteKey = (iso: string): string => `${iso.slice(0, 16)}:00.000Z`;
  const buckets = new Map<string, SeriesBucket>();

  for (let i = options.minutes; i >= 0; i -= 1) {
    const key = minuteKey(new Date(now - i * 60_000).toISOString());
    buckets.set(key, { minute: key, cost: 0, input_tokens: 0, output_tokens: 0, requests: 0 });
  }

  for (const row of rows) {
    const key = minuteKey(row.timestamp);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.cost += row.cost;
    bucket.input_tokens += row.input_tokens;
    bucket.output_tokens += row.output_tokens;
    bucket.requests += 1;
  }

  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, cost: Number(bucket.cost.toFixed(8)) }))
    .sort((a, b) => a.minute.localeCompare(b.minute));
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
