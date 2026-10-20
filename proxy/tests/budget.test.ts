import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockApp } from "../../mock-llm/src/app.js";
import { isLoopbackAddress } from "../src/admin.js";
import { createProxyApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import type { PricingTable } from "../src/pricing.js";
import { deriveSessionId } from "../src/session.js";

const pricing: PricingTable = {
  currency: "USD",
  unit: "per_million_tokens",
  models: {
    "test-model": {
      input_per_mtok: 1,
      output_per_mtok: 2,
      cache_creation_per_mtok: 3,
      cache_read_per_mtok: 4,
    },
  },
};

const REQUEST_BODY = JSON.stringify({
  model: "test-model",
  max_tokens: 100,
  messages: [{ role: "user", content: "spend some money" }],
});

const STREAM_BODY = JSON.stringify({
  model: "test-model",
  max_tokens: 100,
  stream: true,
  messages: [{ role: "user", content: "spend some money" }],
});

// 1500 input tokens * 1 + 500 output tokens * 2 = 0.0025 USD
const USAGE_HEADERS = {
  "x-mock-input-tokens": "1500",
  "x-mock-output-tokens": "500",
};

let mockHits = 0;
const mockApp = createMockApp({ model: "test-model", delayMs: 0, inputTokens: 10, outputTokens: 20 });
const countedMock = new Hono();
countedMock.post("/v1/messages", async (c) => {
  mockHits += 1;
  return mockApp.fetch(c.req.raw);
});

let mockServer: ServerType;
let mockPort = 0;

let proxyServer: ServerType | null = null;
let db: Db | null = null;
let dbPath = "";
let tempDir = "";
let port = 0;

beforeAll(async () => {
  mockServer = serve({ fetch: countedMock.fetch, port: 0 });
  await new Promise<void>((resolve) => mockServer.once("listening", () => resolve()));
  mockPort = (mockServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    mockServer.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  mockHits = 0;
});

afterEach(async () => {
  if (proxyServer) {
    await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
    proxyServer = null;
  }
  db?.close();
  db = null;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

async function startProxy(
  options: {
    budgetUsd?: number | null;
    remoteAddress?: (c: Context) => string | undefined;
  } = {},
): Promise<void> {
  tempDir = mkdtempSync(join(tmpdir(), "promptpace-"));
  dbPath = join(tempDir, "test.db");
  db = openDatabase(dbPath);

  const app = createProxyApp({
    upstreamUrl: `http://127.0.0.1:${mockPort}`,
    db,
    pricing,
    defaultSessionId: "default",
    budgetUsd: options.budgetUsd ?? null,
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
  });

  proxyServer = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => proxyServer!.once("listening", () => resolve()));
  port = (proxyServer!.address() as AddressInfo).port;
}

function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    // Admin writes require a JSON content type.
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rows(): Array<Record<string, unknown>> {
  return db!.prepare("SELECT * FROM requests ORDER BY timestamp").all() as Array<
    Record<string, unknown>
  >;
}

describe("session id derivation", () => {
  it("derives a stable id from the credential, keeps it out of the database and lets the header win", async () => {
    await startProxy();

    const key = "sk-fake-secret-value-123";
    await post(REQUEST_BODY, { "x-api-key": key });
    await post(REQUEST_BODY, { "x-api-key": key });
    await post(REQUEST_BODY, { "x-api-key": "sk-fake-other-key-456" });
    await post(REQUEST_BODY, { "x-api-key": key, "x-promptpace-session": "explicit-session" });

    const all = rows();
    expect(all).toHaveLength(4);

    const derived = all[0]!.session_id as string;
    expect(derived).toMatch(/^[0-9a-f]{12}$/);
    expect(all[1]!.session_id).toBe(derived);
    expect(all[2]!.session_id).not.toBe(derived);
    expect(all[3]!.session_id).toBe("explicit-session");
    expect(deriveSessionId(key, "default")).toBe(derived);

    // The raw credential is nowhere in the database.
    const dump =
      JSON.stringify(db!.prepare("SELECT * FROM requests").all()) +
      JSON.stringify(db!.prepare("SELECT * FROM session_budgets").all()) +
      JSON.stringify(db!.prepare("SELECT * FROM session_baselines").all());
    expect(dump).not.toContain(key);
    expect(dump).not.toContain("sk-fake-other-key-456");

    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(file)) continue;
      expect(readFileSync(file).toString("binary")).not.toContain(key);
    }
  });
});

describe("budget cap", () => {
  it("passes a request under the cap and blocks the next one with 402 without touching the upstream", async () => {
    await startProxy({ budgetUsd: 0.002 });

    const first = await post(REQUEST_BODY, { "x-api-key": "sk-fake-test-1", ...USAGE_HEADERS });
    expect(first.status).toBe(200);
    const hitsAfterFirst = mockHits;
    expect(hitsAfterFirst).toBe(1);

    const second = await post(REQUEST_BODY, { "x-api-key": "sk-fake-test-1", ...USAGE_HEADERS });
    expect(second.status).toBe(402);

    const json = (await second.json()) as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("budget_exceeded");
    expect(json.error.message).toContain("$0.0020"); // the cap
    expect(json.error.message).toContain("$0.0025"); // the amount spent
    expect(json.error.message).toContain("/admin/sessions/"); // how to raise it
    expect(json.error.message).toContain("PROMPTPACE_BUDGET_USD");

    // The upstream was never contacted for the blocked request.
    expect(mockHits).toBe(hitsAfterFirst);

    const blocked = db!.prepare("SELECT * FROM requests WHERE blocked = 1").get() as Record<
      string,
      unknown
    >;
    expect(blocked.status).toBe(402);
    expect(blocked.input_tokens).toBe(0);
    expect(blocked.output_tokens).toBe(0);
    expect(blocked.cost).toBe(0);
    expect(blocked.partial).toBe(0);
  });

  it("blocks a streaming request with 402 and opens no upstream connection", async () => {
    await startProxy({ budgetUsd: 0.002 });

    const first = await post(REQUEST_BODY, { "x-api-key": "sk-fake-test-1", ...USAGE_HEADERS });
    expect(first.status).toBe(200);
    const hits = mockHits;

    const res = await post(STREAM_BODY, { "x-api-key": "sk-fake-test-1", ...USAGE_HEADERS });
    expect(res.status).toBe(402);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("budget_exceeded");
    expect(mockHits).toBe(hits);

    const blocked = db!.prepare("SELECT * FROM requests WHERE blocked = 1").get() as Record<
      string,
      unknown
    >;
    expect(blocked.status).toBe(402);
    expect(blocked.cost).toBe(0);
  });

  it("lets a per-session cap override the env default", async () => {
    await startProxy({ budgetUsd: 0.001 });

    const key = "sk-fake-test-2";
    const sessionId = deriveSessionId(key, "default");

    // The first request is under the cap, the second one is over it.
    expect((await post(REQUEST_BODY, { "x-api-key": key, ...USAGE_HEADERS })).status).toBe(200);
    expect((await post(REQUEST_BODY, { "x-api-key": key, ...USAGE_HEADERS })).status).toBe(402);

    // Raise the cap for this session only.
    const set = await admin("POST", `/admin/sessions/${sessionId}/budget`, { cap_usd: 10 });
    expect(set.status).toBe(200);
    const setJson = (await set.json()) as { cap: number };
    expect(setJson.cap).toBe(10);

    const allowed = await post(REQUEST_BODY, { "x-api-key": key, ...USAGE_HEADERS });
    expect(allowed.status).toBe(200);

    // Another session is still held to the env default.
    expect((await post(REQUEST_BODY, { "x-api-key": "sk-fake-test-3", ...USAGE_HEADERS })).status).toBe(200);
    expect((await post(REQUEST_BODY, { "x-api-key": "sk-fake-test-3", ...USAGE_HEADERS })).status).toBe(402);
  });

  it("resets the spend baseline without deleting history", async () => {
    await startProxy({ budgetUsd: 0.002 });

    const key = "sk-fake-test-4";
    const sessionId = deriveSessionId(key, "default");

    expect((await post(REQUEST_BODY, { "x-api-key": key, ...USAGE_HEADERS })).status).toBe(200);
    expect((await post(REQUEST_BODY, { "x-api-key": key, ...USAGE_HEADERS })).status).toBe(402);

    const reset = await admin("POST", `/admin/sessions/${sessionId}/reset`);
    expect(reset.status).toBe(200);

    expect((await post(REQUEST_BODY, { "x-api-key": key, ...USAGE_HEADERS })).status).toBe(200);

    // History is intact: the first request, the blocked one and the third one.
    const all = rows();
    expect(all).toHaveLength(3);
    expect(all.filter((row) => row.blocked === 1)).toHaveLength(1);
    expect(all[0]!.cost).toBeCloseTo(0.0025, 8);

    // Only the spend after the reset counts.
    const list = (await (await admin("GET", "/admin/sessions")).json()) as {
      sessions: Array<{ id: string; cap: number; spent: number; blocked: number; last_activity: string }>;
    };
    const session = list.sessions.find((entry) => entry.id === sessionId)!;
    expect(session.spent).toBeCloseTo(0.0025, 8);
    expect(session.cap).toBe(0.002);
    expect(session.blocked).toBe(1);
    expect(session.last_activity).toBeTruthy();
  });
});

describe("admin api", () => {
  it("rejects requests that do not come from a loopback address", async () => {
    await startProxy({ remoteAddress: () => "203.0.113.10" });

    const list = await admin("GET", "/admin/sessions");
    expect(list.status).toBe(403);
    expect(((await list.json()) as { error: { type: string } }).error.type).toBe("forbidden");

    const set = await admin("POST", "/admin/sessions/abc/budget", { cap_usd: 1 });
    expect(set.status).toBe(403);

    const reset = await admin("POST", "/admin/sessions/abc/reset");
    expect(reset.status).toBe(403);
  });

  it("accepts requests from loopback and reports the session state", async () => {
    await startProxy();

    await post(REQUEST_BODY, { "x-api-key": "sk-fake-admin-test", ...USAGE_HEADERS });

    const res = await admin("GET", "/admin/sessions");
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      sessions: Array<{ id: string; cap: number | null; spent: number; blocked: number; last_activity: string }>;
    };
    const session = json.sessions.find((entry) => entry.id === deriveSessionId("sk-fake-admin-test", "default"));
    expect(session).toBeDefined();
    expect(session!.cap).toBeNull();
    expect(session!.spent).toBeCloseTo(0.0025, 8);
    expect(session!.blocked).toBe(0);
    expect(session!.last_activity).toBeTruthy();
  });

  it("rejects an invalid cap", async () => {
    await startProxy();

    const res = await admin("POST", "/admin/sessions/abc/budget", { cap_usd: "lots" });
    expect(res.status).toBe(400);
  });
});

describe("isLoopbackAddress", () => {
  it("accepts loopback addresses only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.5.5")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("203.0.113.10")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});
