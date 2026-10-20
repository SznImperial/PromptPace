import { Hono } from "hono";
import type { Context } from "hono";
import { checkSessionBudget } from "./budget.js";
import type { Db } from "./db.js";
import {
  countRepeatsAt,
  getSessionAlerts,
  getSessionBlockedCount,
  getSessionLastActivity,
  listSessionIds,
  resetSessionBaseline,
  setSessionCap,
} from "./db.js";

export interface AdminConfig {
  db: Db;
  /** Cap used for sessions without their own cap. `null` means no cap. */
  defaultCapUsd: number | null;
  /** Length of the loop-detection window, used for the repeat counts in alerts. */
  loopWindowSeconds: number;
  /** Resolves the address of the caller. */
  remoteAddress: (c: Context) => string | undefined;
  /** Resolves the port the server listens on, used for the Host check. */
  localPort: (c: Context) => number | undefined;
}

/** True for 127.0.0.0/8 and ::1 (including the IPv4-mapped form). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Reads the caller's address from the socket. No header can influence this:
 * the value comes from the TCP connection, never from X-Forwarded-For.
 */
export function nodeRemoteAddress(c: Context): string | undefined {
  const env = (c.env ?? {}) as {
    incoming?: { socket?: { remoteAddress?: string } };
  };
  return env.incoming?.socket?.remoteAddress;
}

/** Reads the port the server is listening on from the socket. */
export function nodeLocalPort(c: Context): number | undefined {
  const env = (c.env ?? {}) as {
    incoming?: { socket?: { localPort?: number } };
  };
  return env.incoming?.socket?.localPort;
}

/**
 * The Host header must name the loopback interface. The port has to be the
 * port the proxy listens on.
 */
export function isAllowedAdminHost(host: string | undefined, localPort: number | undefined): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return false;

  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (ipv6) {
    if (ipv6[1] !== "::1") return false;
    const port = ipv6[2] === undefined ? undefined : Number(ipv6[2]);
    return port === undefined || (localPort !== undefined && port === localPort);
  }

  const separator = trimmed.lastIndexOf(":");
  const hostname = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const port = separator === -1 ? undefined : Number(trimmed.slice(separator + 1));

  if (hostname !== "localhost" && hostname !== "127.0.0.1") return false;
  return port === undefined || (localPort !== undefined && port === localPort);
}

function errorBody(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase().split(";")[0]!.trim() === "application/json";
}

export function createAdminApp(config: AdminConfig): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    // 1. The caller must be on the loopback interface (socket only).
    if (!isLoopbackAddress(config.remoteAddress(c))) {
      return c.json(
        errorBody("forbidden", "The admin API is only available from loopback addresses."),
        403,
      );
    }

    // 2. The Host header must point at this proxy on the loopback interface.
    if (!isAllowedAdminHost(c.req.header("host"), config.localPort(c))) {
      return c.json(
        errorBody("forbidden", "The admin API only accepts requests addressed to the local proxy."),
        403,
      );
    }

    // 3. Admin writes must be JSON.
    if (c.req.method === "POST" && !isJsonContentType(c.req.header("content-type"))) {
      return c.json(
        errorBody("invalid_request_error", "Content-Type must be application/json."),
        415,
      );
    }

    await next();
  });

  app.get("/sessions", (c) => {
    const sessions = listSessionIds(config.db).map((id) => {
      const status = checkSessionBudget(config.db, id, config.defaultCapUsd);
      return {
        id,
        cap: status.cap,
        spent: status.spent,
        blocked: getSessionBlockedCount(config.db, id),
        last_activity: getSessionLastActivity(config.db, id),
      };
    });
    return c.json({ sessions });
  });

  app.get("/sessions/:id/alerts", (c) => {
    const id = c.req.param("id");
    const alerts = getSessionAlerts(config.db, id).map((row) => ({
      timestamp: row.timestamp,
      fingerprint: row.fingerprint,
      repeat_count: row.fingerprint
        ? countRepeatsAt(
            config.db,
            id,
            row.fingerprint,
            config.loopWindowSeconds,
            new Date(row.timestamp),
          )
        : 0,
      action: row.blocked === 1 ? "blocked" : "flagged",
      status: row.status,
      cost: row.cost,
    }));
    return c.json({ session_id: id, alerts });
  });

  app.post("/sessions/:id/budget", async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_request_error", "Body must be JSON."), 400);
    }

    const cap = (body as { cap_usd?: unknown } | null)?.cap_usd;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) {
      return c.json(
        errorBody("invalid_request_error", "cap_usd must be a number greater than or equal to 0."),
        400,
      );
    }

    setSessionCap(config.db, id, cap);
    const status = checkSessionBudget(config.db, id, config.defaultCapUsd);
    return c.json({ session_id: id, cap: status.cap, spent: status.spent });
  });

  app.post("/sessions/:id/reset", (c) => {
    const id = c.req.param("id");
    const resetAt = resetSessionBaseline(config.db, id);
    const status = checkSessionBudget(config.db, id, config.defaultCapUsd);
    return c.json({ session_id: id, reset_at: resetAt, cap: status.cap, spent: status.spent });
  });

  return app;
}
