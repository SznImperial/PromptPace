import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockApp } from "../../mock-llm/src/app.js";
import { createProxyApp } from "../src/app.js";
import { DEFAULT_BIND_HOST, resolveBindHost } from "../src/config.js";
import { openDatabase, type Db } from "../src/db.js";
import type { PricingTable } from "../src/pricing.js";

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

const SECRET_TEXT = "confidential-prompt-text-must-never-be-served";

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

beforeEach(async () => {
  mockHits = 0;
  db = openDatabase(":memory:");
  const app = createProxyApp({
    upstreamUrl: `http://127.0.0.1:${mockPort}`,
    db,
    pricing,
    defaultSessionId: "default",
  });
  proxyServer = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => proxyServer!.once("listening", () => resolve()));
  port = (proxyServer!.address() as AddressInfo).port;
});

afterEach(async () => {
  if (proxyServer) {
    await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
    proxyServer = null;
  }
  db?.close();
  db = null;
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function adminGet(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers });
}

const REQUEST_BODY = {
  model: "test-model",
  max_tokens: 100,
  messages: [{ role: "user", content: SECRET_TEXT }],
};

describe("GET /admin/requests", () => {
  it("returns the recent rows newest first with only the documented fields", async () => {
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s1" })).text();
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s2" })).text();

    const res = await adminGet("/admin/requests");
    expect(res.status).toBe(200);

    const json = (await res.json()) as { requests: Array<Record<string, unknown>> };
    expect(json.requests).toHaveLength(2);

    const row = json.requests[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "blocked",
        "cache_creation_tokens",
        "cache_read_tokens",
        "cost",
        "flagged",
        "id",
        "input_tokens",
        "model",
        "output_tokens",
        "partial",
        "session_id",
        "status",
        "timestamp",
      ].sort(),
    );
    expect(row.model).toBe("test-model");
    expect(row.input_tokens).toBe(10);
    expect(row.output_tokens).toBe(20);
    expect(row.status).toBe(200);
    expect(row.partial).toBe(0);
    expect(row.flagged).toBe(0);
    expect(row.blocked).toBe(0);
    expect(typeof row.cost).toBe("number");
    expect(typeof row.timestamp).toBe("string");

    // Newest first.
    const timestamps = json.requests.map((entry) => entry.timestamp as string);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it("never returns message content", async () => {
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s1" })).text();

    const res = await adminGet("/admin/requests");
    const text = await res.text();

    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("messages");
    expect(text).not.toContain("content");
  });

  it("filters by session and honours the limit", async () => {
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s1" })).text();
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s2" })).text();
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s2" })).text();

    const filtered = (await (
      await adminGet("/admin/requests?session=s2")
    ).json()) as { requests: Array<{ session_id: string }> };
    expect(filtered.requests).toHaveLength(2);
    expect(filtered.requests.every((row) => row.session_id === "s2")).toBe(true);

    const limited = (await (await adminGet("/admin/requests?limit=1")).json()) as {
      requests: unknown[];
    };
    expect(limited.requests).toHaveLength(1);

    const clamped = (await (await adminGet("/admin/requests?limit=99999")).json()) as {
      requests: unknown[];
    };
    expect(clamped.requests.length).toBeLessThanOrEqual(500);
  });
});

describe("GET /admin/series", () => {
  it("buckets cost and tokens per minute", async () => {
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s1" })).text();

    const res = await adminGet("/admin/series?minutes=5");
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      minutes: number;
      series: Array<{
        minute: string;
        cost: number;
        input_tokens: number;
        output_tokens: number;
        requests: number;
      }>;
    };
    expect(json.minutes).toBe(5);
    expect(json.series).toHaveLength(6); // the current minute plus the five before it

    const withData = json.series.filter((bucket) => bucket.requests > 0);
    expect(withData).toHaveLength(1);
    expect(withData[0]!.input_tokens).toBe(10);
    expect(withData[0]!.output_tokens).toBe(20);
    expect(withData[0]!.cost).toBeCloseTo(0.00005, 10);
    expect(withData[0]!.minute).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);

    // The buckets are ordered and cover a continuous range.
    const minutes = json.series.map((bucket) => bucket.minute);
    expect([...minutes].sort()).toEqual(minutes);
  });

  it("filters by session", async () => {
    await (await post(REQUEST_BODY, { "x-promptpace-session": "s1" })).text();

    const json = (await (
      await adminGet("/admin/series?minutes=5&session=s2")
    ).json()) as { series: Array<{ requests: number }> };
    expect(json.series.every((bucket) => bucket.requests === 0)).toBe(true);
  });
});

describe("admin api protections", () => {
  it("rejects the new endpoints from a non-loopback address", async () => {
    const app = createProxyApp({
      upstreamUrl: `http://127.0.0.1:${mockPort}`,
      db: openDatabase(":memory:"),
      pricing,
      defaultSessionId: "default",
      remoteAddress: () => "203.0.113.10",
    });

    const requests = await app.request("/admin/requests");
    expect(requests.status).toBe(403);

    const series = await app.request("/admin/series");
    expect(series.status).toBe(403);

    const sessions = await app.request("/admin/sessions");
    expect(sessions.status).toBe(403);
  });

  it("rejects cross-site browser requests but keeps server-side fetches working", async () => {
    const crossSite = await adminGet("/admin/requests", { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);

    const sameOrigin = await adminGet("/admin/requests", { "sec-fetch-site": "same-origin" });
    expect(sameOrigin.status).toBe(200);

    const none = await adminGet("/admin/requests");
    expect(none.status).toBe(200);
  });
});

describe("bind address", () => {
  it("defaults to the loopback interface", () => {
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(resolveBindHost({ PROMPTPACE_BIND_HOST: "127.0.0.1" })).toBe("127.0.0.1");
  });

  it("can be overridden by the environment", () => {
    expect(resolveBindHost({ PROMPTPACE_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveBindHost({ PROMPTPACE_BIND_HOST: "  " })).toBe("127.0.0.1");
  });
});
