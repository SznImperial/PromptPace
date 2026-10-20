import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockApp } from "../../mock-llm/src/app.js";
import { createProxyApp } from "../../proxy/src/app.js";
import { openDatabase, type Db } from "../../proxy/src/db.js";
import { getAlerts, getRequests, getSeries, getSessions } from "../lib/proxy";

let mockServer: ServerType;
let mockPort = 0;
let proxyServer: ServerType;
let proxyPort = 0;
let db: Db;

const mockApp = createMockApp({ model: "test-model", delayMs: 0, inputTokens: 10, outputTokens: 20 });
const countedMock = new Hono();
countedMock.post("/v1/messages", async (c) => {
  return mockApp.fetch(c.req.raw);
});

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
  db = openDatabase(":memory:");
  const app = createProxyApp({
    upstreamUrl: `http://127.0.0.1:${mockPort}`,
    db,
    pricing: {
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
    },
    defaultSessionId: "default",
    loop: { threshold: 2, windowSeconds: 120, block: false, minChars: 5 },
  });
  proxyServer = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => proxyServer.once("listening", () => resolve()));
  proxyPort = (proxyServer.address() as AddressInfo).port;

  // The dashboard talks to the proxy from the server side.
  process.env.PROMPTPACE_PROXY_URL = `http://127.0.0.1:${proxyPort}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  db.close();
  delete process.env.PROMPTPACE_PROXY_URL;
});

describe("dashboard server-side fetch", () => {
  it("reads sessions, requests and the series from the running proxy", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-promptpace-session": "dash-1" },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 100,
        messages: [{ role: "user", content: "dashboard server side fetch check" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const sessions = await getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe("dash-1");

    const requests = await getRequests({ limit: 10 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("test-model");
    expect(requests[0]!.input_tokens).toBe(10);
    expect(requests[0]!.output_tokens).toBe(20);

    const series = await getSeries({ minutes: 5 });
    expect(series.length).toBe(6);
    const withData = series.filter((point) => point.requests > 0);
    expect(withData).toHaveLength(1);
    expect(withData[0]!.cost).toBeCloseTo(0.00005, 10);
  });

  it("reads the alerts of a session", async () => {
    const body = JSON.stringify({
      model: "test-model",
      max_tokens: 100,
      messages: [{ role: "user", content: "repeat this long enough to be flagged" }],
    });

    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-promptpace-session": "dash-2" },
      body,
    });
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-promptpace-session": "dash-2" },
      body,
    });

    const alerts = await getAlerts("dash-2");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.action).toBe("flagged");
    expect(alerts[0]!.repeat_count).toBe(2);
  });

  it("fails clearly when the proxy is not reachable", async () => {
    process.env.PROMPTPACE_PROXY_URL = "http://127.0.0.1:1";
    await expect(getSessions()).rejects.toThrow();
  });
});
