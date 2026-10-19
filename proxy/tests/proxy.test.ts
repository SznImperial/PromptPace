import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createProxyApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import type { PricingTable } from "../src/pricing.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const testPricing: PricingTable = {
  currency: "USD",
  unit: "per_million_tokens",
  models: {
    "test-model": {
      input_per_mtok: 1,
      output_per_mtok: 2,
      cache_creation_per_mtok: 3,
      cache_read_per_mtok: 4,
      todo_verify: true,
    },
    default: {
      input_per_mtok: 0,
      output_per_mtok: 0,
      cache_creation_per_mtok: 0,
      cache_read_per_mtok: 0,
      todo_verify: true,
    },
  },
};

let upstream: Server;
let upstreamPort = 0;
let captured: CapturedRequest | null = null;
let upstreamStatus = 200;
let upstreamBody = "";
let upstreamHeaders: Record<string, string> = {};
let db: Db;
let app: Hono;

const DEFAULT_RESPONSE_BODY = JSON.stringify({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test-model",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1500, output_tokens: 500 },
});

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      captured = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(upstreamStatus, {
        "content-type": "application/json",
        ...upstreamHeaders,
      });
      res.end(upstreamBody);
    });
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstream.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  captured = null;
  upstreamStatus = 200;
  upstreamBody = DEFAULT_RESPONSE_BODY;
  upstreamHeaders = {};
  db = openDatabase(":memory:");
  app = createProxyApp({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    db,
    pricing: testPricing,
    defaultSessionId: "default",
  });
});

afterEach(() => {
  db.close();
});

async function proxyRequest(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(
    new Request("http://proxy.local/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

describe("proxy pass-through", () => {
  it("forwards the request method, path, body and headers unchanged", async () => {
    const body = '{\n  "model": "test-model",\n  "messages": [{"role": "user", "content": "keep   spacing"}]\n}';

    const res = await proxyRequest(body, {
      authorization: "Bearer test-key",
      "x-custom": "keep me",
      "x-promptpace-session": "sess-42",
    });
    await res.text();

    expect(captured).not.toBeNull();
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/v1/messages");
    expect(captured?.body).toBe(body);
    expect(headerValue(captured!.headers, "authorization")).toBe("Bearer test-key");
    expect(headerValue(captured!.headers, "x-custom")).toBe("keep me");
    expect(headerValue(captured!.headers, "x-promptpace-session")).toBe("sess-42");
    expect(headerValue(captured!.headers, "content-type")).toBe("application/json");
    expect(headerValue(captured!.headers, "host")).toBe(`127.0.0.1:${upstreamPort}`);
    expect(headerValue(captured!.headers, "accept-encoding")).toBe("identity");
    expect(headerValue(captured!.headers, "content-length")).toBe(String(Buffer.byteLength(body)));
  });

  it("returns the upstream status, body and headers unchanged", async () => {
    upstreamStatus = 201;
    upstreamBody = '{\n  "model": "test-model",\n  "usage": { "input_tokens": 10, "output_tokens": 20 }\n}';
    upstreamHeaders = { "x-upstream-version": "1" };

    const res = await proxyRequest('{"model":"test-model","messages":[]}');

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-upstream-version")).toBe("1");
    expect(await res.text()).toBe(upstreamBody);
  });
});

describe("proxy request logging", () => {
  it("writes a SQLite row with the upstream token counts and computed cost", async () => {
    const before = Date.now();
    const res = await proxyRequest('{"model":"test-model","messages":[]}', {
      "x-promptpace-session": "sess-42",
    });
    await res.text();

    const row = db.prepare("SELECT * FROM requests").get() as {
      id: string;
      timestamp: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      cost: number;
      status: number;
      session_id: string;
      partial: number;
    };

    expect(row).toBeDefined();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(row.timestamp)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(row.timestamp)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row.model).toBe("test-model");
    expect(row.input_tokens).toBe(1500);
    expect(row.output_tokens).toBe(500);
    expect(row.cache_creation_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cost).toBe(0.0025);
    expect(row.status).toBe(200);
    expect(row.session_id).toBe("sess-42");
    expect(row.partial).toBe(0);
  });

  it("falls back to the default session id", async () => {
    const res = await proxyRequest('{"model":"test-model","messages":[]}');
    await res.text();

    const row = db.prepare("SELECT session_id FROM requests").get() as { session_id: string };
    expect(row.session_id).toBe("default");
  });

  it("logs zero tokens when the upstream response is not JSON", async () => {
    upstreamBody = "not json";

    const res = await proxyRequest('{"model":"test-model","messages":[]}');
    await res.text();

    const row = db
      .prepare("SELECT input_tokens, output_tokens, cost FROM requests")
      .get() as { input_tokens: number; output_tokens: number; cost: number };
    expect(row).toEqual({ input_tokens: 0, output_tokens: 0, cost: 0 });
  });

  it("logs the cache counters reported by a non-streaming response", async () => {
    upstreamBody = JSON.stringify({
      model: "test-model",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
    });

    const res = await proxyRequest('{"model":"test-model","messages":[]}');
    await res.text();

    const row = db
      .prepare(
        "SELECT cache_creation_tokens, cache_read_tokens, cost FROM requests",
      )
      .get() as { cache_creation_tokens: number; cache_read_tokens: number; cost: number };
    expect(row.cache_creation_tokens).toBe(30);
    expect(row.cache_read_tokens).toBe(40);
    // 10/1e6*1 + 20/1e6*2 + 30/1e6*3 + 40/1e6*4
    expect(row.cost).toBeCloseTo(0.0003, 10);
  });
});

