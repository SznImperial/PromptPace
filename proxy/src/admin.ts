import { Hono } from "hono";
import type { Context } from "hono";
import { checkSessionBudget } from "./budget.js";
import type { Db } from "./db.js";
import {
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
  /** Resolves the address of the caller. */
  remoteAddress: (c: Context) => string | undefined;
}

/** True for 127.0.0.0/8 and ::1 (including the IPv4-mapped form). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/** Reads the caller's address from the Node server environment. */
export function nodeRemoteAddress(c: Context): string | undefined {
  const env = (c.env ?? {}) as {
    incoming?: { socket?: { remoteAddress?: string } };
  };
  return env.incoming?.socket?.remoteAddress;
}

function errorBody(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

export function createAdminApp(config: AdminConfig): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!isLoopbackAddress(config.remoteAddress(c))) {
      return c.json(
        errorBody("forbidden", "The admin API is only available from loopback addresses."),
        403,
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
