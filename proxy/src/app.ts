import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { createAdminApp, nodeLocalPort, nodeRemoteAddress } from "./admin.js";
import { checkSessionBudget, formatBudgetMessage } from "./budget.js";
import type { Db } from "./db.js";
import { recordRequest } from "./db.js";
import { buildClientResponseHeaders, buildUpstreamHeaders } from "./headers.js";
import { DEFAULT_LOOP_CONFIG, evaluateLoop, fingerprintRequest, formatLoopMessage } from "./loop.js";
import type { LoopConfig } from "./loop.js";
import type { PricingTable } from "./pricing.js";
import { computeCost } from "./pricing.js";
import { resolveSessionId } from "./session.js";
import { forwardSseStream } from "./stream.js";
import type { TokenUsage } from "./usage.js";
import { ZERO_USAGE, mergeUsage, readUsageFields } from "./usage.js";

export interface ProxyConfig {
  upstreamUrl: string;
  db: Db;
  pricing: PricingTable;
  defaultSessionId: string;
  /** Cap per session in USD from PROMPTPACE_BUDGET_USD. `null`/unset means no cap. */
  budgetUsd?: number | null;
  /** Loop detection settings. */
  loop?: Partial<LoopConfig>;
  /** Resolves the caller's address. Only used by the admin API. */
  remoteAddress?: (c: Context) => string | undefined;
  /** Resolves the port the server listens on. Only used by the admin API. */
  localPort?: (c: Context) => number | undefined;
}

type JsonObject = Record<string, unknown>;

function parseJsonObject(raw: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function errorResponse(c: Context, status: 400 | 402 | 422 | 500 | 502, type: string, message: string) {
  return c.json({ type: "error", error: { type, message } }, status);
}

export function createProxyApp(config: ProxyConfig): Hono {
  const app = new Hono();
  const upstreamUrl = new URL("/v1/messages", config.upstreamUrl).toString();
  const defaultCapUsd = config.budgetUsd ?? null;
  const loopConfig: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...config.loop };

  app.get("/health", (c) =>
    c.json({ ok: true, service: "proxy", upstream: config.upstreamUrl }),
  );

  app.route(
    "/admin",
    createAdminApp({
      db: config.db,
      defaultCapUsd,
      loopWindowSeconds: loopConfig.windowSeconds,
      remoteAddress: config.remoteAddress ?? nodeRemoteAddress,
      localPort: config.localPort ?? nodeLocalPort,
    }),
  );

  app.post("/v1/messages", async (c) => {
    const requestBody = await c.req.arrayBuffer();
    const requestJson = parseJsonObject(Buffer.from(requestBody).toString("utf8"));
    const isStreaming = requestJson?.stream === true;

    const model =
      (typeof requestJson?.model === "string" ? requestJson.model : undefined) ?? "unknown";
    const sessionId = resolveSessionId(c.req.raw.headers, config.defaultSessionId);

    const writeRow = (
      usage: TokenUsage,
      partial: boolean,
      status: number,
      options: { blocked?: boolean; fingerprint?: string | null; flagged?: boolean } = {},
    ): void => {
      recordRequest(config.db, {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cost: computeCost(config.pricing, model, usage),
        status,
        sessionId,
        partial,
        blocked: options.blocked ?? false,
        fingerprint: options.fingerprint ?? null,
        flagged: options.flagged ?? false,
      });
    };

    // Budget gate: the upstream is never contacted when the session is over its cap.
    const budget = checkSessionBudget(config.db, sessionId, defaultCapUsd);
    if (budget.blocked) {
      writeRow(ZERO_USAGE, false, 402, { blocked: true });
      return errorResponse(c, 402, "budget_exceeded", formatBudgetMessage(budget));
    }

    // Loop detection: only the newest content of the request is fingerprinted.
    const fingerprint = fingerprintRequest(requestJson, loopConfig.minChars);
    const loop = evaluateLoop(config.db, sessionId, fingerprint, loopConfig);
    if (loop.block) {
      writeRow(ZERO_USAGE, false, 422, { blocked: true, fingerprint, flagged: true });
      return errorResponse(c, 422, "loop_detected", formatLoopMessage(loop, loopConfig));
    }

    const abortController = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: buildUpstreamHeaders(c.req.raw.headers),
        body: requestBody,
        signal: abortController.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      return errorResponse(c, 502, "upstream_error", message);
    }

    if (isStreaming) {
      // An error status arrives before any stream starts: pass it through untouched.
      if (!upstream.ok) {
        const body = await upstream.arrayBuffer();
        writeRow(ZERO_USAGE, false, upstream.status, { fingerprint, flagged: loop.flagged });
        return new Response(body, {
          status: upstream.status,
          headers: buildClientResponseHeaders(upstream.headers),
        });
      }

      if (!upstream.body) {
        writeRow(ZERO_USAGE, true, upstream.status, { fingerprint, flagged: loop.flagged });
        return errorResponse(c, 502, "upstream_error", "Upstream returned an empty stream.");
      }

      const stream = forwardSseStream({
        upstreamBody: upstream.body,
        signal: c.req.raw.signal,
        onFinish: (usage, partial) =>
          writeRow(usage, partial, upstream.status, { fingerprint, flagged: loop.flagged }),
        onClientAbort: () => abortController.abort(),
      });

      return new Response(stream, {
        status: upstream.status,
        headers: buildClientResponseHeaders(upstream.headers),
      });
    }

    const responseBody = await upstream.arrayBuffer();
    const responseJson = parseJsonObject(Buffer.from(responseBody).toString("utf8"));
    const usage = mergeUsage(ZERO_USAGE, readUsageFields(responseJson?.usage));

    writeRow(usage, false, upstream.status, { fingerprint, flagged: loop.flagged });

    return new Response(responseBody, {
      status: upstream.status,
      headers: buildClientResponseHeaders(upstream.headers),
    });
  });

  return app;
}
