import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "./db.js";
import { recordRequest } from "./db.js";
import { buildClientResponseHeaders, buildUpstreamHeaders } from "./headers.js";
import type { PricingTable } from "./pricing.js";
import { computeCost } from "./pricing.js";
import { forwardSseStream } from "./stream.js";
import type { TokenUsage } from "./usage.js";
import { ZERO_USAGE, mergeUsage, readUsageFields } from "./usage.js";

export interface ProxyConfig {
  upstreamUrl: string;
  db: Db;
  pricing: PricingTable;
  defaultSessionId: string;
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

function errorResponse(c: Context, status: 400 | 501 | 502, type: string, message: string) {
  return c.json({ type: "error", error: { type, message } }, status);
}

export function createProxyApp(config: ProxyConfig): Hono {
  const app = new Hono();
  const upstreamUrl = new URL("/v1/messages", config.upstreamUrl).toString();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "proxy", upstream: config.upstreamUrl }),
  );

  app.post("/v1/messages", async (c) => {
    const requestBody = await c.req.arrayBuffer();
    const requestJson = parseJsonObject(Buffer.from(requestBody).toString("utf8"));
    const isStreaming = requestJson?.stream === true;

    const model =
      (typeof requestJson?.model === "string" ? requestJson.model : undefined) ?? "unknown";
    const sessionId = c.req.header("x-promptpace-session")?.trim() || config.defaultSessionId;

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

    const writeRow = (usage: TokenUsage, partial: boolean, status: number): void => {
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
      });
    };

    if (isStreaming) {
      // An error status arrives before any stream starts: pass it through untouched.
      if (!upstream.ok) {
        const body = await upstream.arrayBuffer();
        writeRow(ZERO_USAGE, false, upstream.status);
        return new Response(body, {
          status: upstream.status,
          headers: buildClientResponseHeaders(upstream.headers),
        });
      }

      if (!upstream.body) {
        writeRow(ZERO_USAGE, true, upstream.status);
        return errorResponse(c, 502, "upstream_error", "Upstream returned an empty stream.");
      }

      const stream = forwardSseStream({
        upstreamBody: upstream.body,
        signal: c.req.raw.signal,
        onFinish: (usage, partial) => writeRow(usage, partial, upstream.status),
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

    writeRow(usage, false, upstream.status);

    return new Response(responseBody, {
      status: upstream.status,
      headers: buildClientResponseHeaders(upstream.headers),
    });
  });

  return app;
}
