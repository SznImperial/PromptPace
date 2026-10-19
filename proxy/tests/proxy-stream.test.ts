import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockApp } from "../../mock-llm/src/app.js";
import { createProxyApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import type { PricingTable } from "../src/pricing.js";

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

interface Row {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost: number;
  status: number;
  session_id: string;
  partial: number;
}

const mockState = {
  clientDisconnects: 0,
  eventsWritten: 0,
};

const mockApp = createMockApp({
  model: "test-model",
  delayMs: 0,
  inputTokens: 10,
  outputTokens: 20,
  onClientDisconnect: () => {
    mockState.clientDisconnects += 1;
  },
  onStreamEvent: (written) => {
    mockState.eventsWritten = written;
  },
});

let mockServer: ServerType;
let mockPort = 0;
let proxyServer: ServerType;
let proxyPort = 0;
let db: Db;

const STREAM_BODY = JSON.stringify({
  model: "test-model",
  max_tokens: 100,
  stream: true,
  messages: [{ role: "user", content: "stream through the proxy" }],
});

beforeAll(async () => {
  mockServer = serve({ fetch: mockApp.fetch, port: 0 });
  await new Promise<void>((resolve) => mockServer.once("listening", () => resolve()));
  mockPort = (mockServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    mockServer.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(async () => {
  mockState.clientDisconnects = 0;
  mockState.eventsWritten = 0;

  db = openDatabase(":memory:");
  const app = createProxyApp({
    upstreamUrl: `http://127.0.0.1:${mockPort}`,
    db,
    pricing: testPricing,
    defaultSessionId: "default",
  });

  proxyServer = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => proxyServer.once("listening", () => resolve()));
  proxyPort = (proxyServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  db.close();
});

function streamRequest(
  body: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal,
  });
}

async function waitForRow(timeoutMs = 2000): Promise<Row> {
  const startedAt = Date.now();
  for (;;) {
    const row = db.prepare("SELECT * FROM requests").get() as Row | undefined;
    if (row) return row;
    if (Date.now() - startedAt > timeoutMs) throw new Error("No request row was written in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("proxy streaming", () => {
  it("sends the first chunk to the client before the upstream stream finishes", async () => {
    const res = await streamRequest(STREAM_BODY, { "x-mock-delay-ms": "60" });
    const reader = res.body!.getReader();

    const startedAt = Date.now();
    const first = await reader.read();
    const firstChunkAt = Date.now() - startedAt;
    expect(first.done).toBe(false);

    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.length ?? 0;
    }
    const finishedAt = Date.now() - startedAt;

    expect(bytes).toBeGreaterThan(0);
    // The first chunk arrives long before the upstream is done.
    expect(firstChunkAt).toBeLessThan(200);
    expect(finishedAt).toBeGreaterThan(300);
  });

  it("delivers the same bytes to the client as the mock sent", async () => {
    const direct = await mockApp.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: STREAM_BODY,
    });
    const directText = await direct.text();

    const res = await streamRequest(STREAM_BODY);
    const throughText = await res.text();

    const normalize = (value: string) => value.replace(/msg_mock_[0-9a-f-]{36}/g, "msg_mock_ID");

    expect(Buffer.byteLength(throughText)).toBe(Buffer.byteLength(directText));
    expect(normalize(throughText)).toBe(normalize(directText));
  });

  it("logs the usage reported by the upstream, including the cache counters", async () => {
    const res = await streamRequest(STREAM_BODY, {
      "x-mock-input-tokens": "1500",
      "x-mock-output-tokens": "500",
      "x-mock-cache-creation-tokens": "200",
      "x-mock-cache-read-tokens": "100",
      "x-promptpace-session": "stream-session",
    });
    await res.text();

    const row = await waitForRow();
    expect(row.model).toBe("test-model");
    expect(row.input_tokens).toBe(1500);
    expect(row.output_tokens).toBe(500);
    expect(row.cache_creation_tokens).toBe(200);
    expect(row.cache_read_tokens).toBe(100);
    expect(row.partial).toBe(0);
    expect(row.status).toBe(200);
    expect(row.session_id).toBe("stream-session");
    // 1500/1e6*1 + 500/1e6*2 + 200/1e6*3 + 100/1e6*4
    expect(row.cost).toBeCloseTo(0.0035, 10);
  });

  it("logs a partial row and cancels the upstream when the client disconnects", async () => {
    const controller = new AbortController();
    const res = await streamRequest(
      STREAM_BODY,
      { "x-mock-delay-ms": "40", "x-mock-input-tokens": "1500" },
      controller.signal,
    );

    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();

    controller.abort();
    await reader.read().catch(() => undefined);

    const row = await waitForRow();
    expect(row.partial).toBe(1);
    expect(row.input_tokens).toBe(1500);
    expect(row.output_tokens).toBe(0);

    // The upstream request was cancelled too.
    await waitFor(() => mockState.clientDisconnects > 0);
    expect(mockState.clientDisconnects).toBeGreaterThan(0);
  });

  it("passes an upstream error through unchanged and logs it with zero tokens", async () => {
    const res = await streamRequest(STREAM_BODY, { "x-mock-error-status": "429" });

    expect(res.status).toBe(429);
    const json = (await res.json()) as { type: string; error: { message: string } };
    expect(json.type).toBe("error");
    expect(json.error.message).toContain("Mock upstream failure");

    const row = await waitForRow();
    expect(row.status).toBe(429);
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cache_creation_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.partial).toBe(0);
  });

  it("logs a partial row when the upstream dies mid-stream", async () => {
    const res = await streamRequest(STREAM_BODY, {
      "x-mock-drop-after": "3",
      "x-mock-input-tokens": "1500",
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    let failed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect(received).toContain("message_start");

    const row = await waitForRow();
    expect(row.partial).toBe(1);
    expect(row.input_tokens).toBe(1500);
    expect(row.output_tokens).toBe(0);
  });

  it("logs a partial row when the stream closes cleanly without message_stop", async () => {
    const res = await streamRequest(STREAM_BODY, {
      "x-mock-stop-after": "4",
      "x-mock-input-tokens": "1500",
    });

    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).not.toContain("message_stop");

    const row = await waitForRow();
    expect(row.partial).toBe(1);
    expect(row.input_tokens).toBe(1500);
    expect(row.output_tokens).toBe(0);
    expect(row.status).toBe(200);
  });
});
