import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockApp } from "../../mock-llm/src/app.js";
import { createProxyApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import { fingerprintRequest, normaliseFingerprintText } from "../src/loop.js";
import type { LoopConfig } from "../src/loop.js";
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

const MODEL = "test-model";

let mockHits = 0;
const mockApp = createMockApp({ model: MODEL, delayMs: 0, inputTokens: 10, outputTokens: 20 });
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
    loop?: Partial<LoopConfig>;
    remoteAddress?: () => string | undefined;
  } = {},
): Promise<void> {
  tempDir = mkdtempSync(join(tmpdir(), "promptpace-loop-"));
  dbPath = join(tempDir, "test.db");
  db = openDatabase(dbPath);

  const app = createProxyApp({
    upstreamUrl: `http://127.0.0.1:${mockPort}`,
    db,
    pricing,
    defaultSessionId: "default",
    loop: options.loop,
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
  });

  proxyServer = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => proxyServer!.once("listening", () => resolve()));
  port = (proxyServer!.address() as AddressInfo).port;
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function rows(): Array<Record<string, unknown>> {
  return db!.prepare("SELECT * FROM requests ORDER BY timestamp, rowid").all() as Array<
    Record<string, unknown>
  >;
}

/** Builds a body whose last message is always the same, with a growing history. */
function growingBody(turn: number, lastText: string) {
  const messages: unknown[] = [];
  for (let i = 0; i < turn; i += 1) {
    messages.push({ role: "user", content: `history question ${i}` });
    messages.push({ role: "assistant", content: `history answer ${i}` });
  }
  messages.push({ role: "user", content: lastText });
  return { model: MODEL, max_tokens: 100, messages };
}

describe("fingerprinting", () => {
  it("normalises line numbers and ids so the same error text matches", () => {
    const a = fingerprintRequest({
      messages: [
        {
          role: "user",
          content: "error: build failed at line 42 (id 550e8400-e29b-41d4-a716-446655440000)",
        },
      ],
    });
    const b = fingerprintRequest({
      messages: [
        {
          role: "user",
          content: "error: build failed at line 87 (id 6ba7b810-9dad-11d1-80b4-00c04fd430c8)",
        },
      ],
    });
    const different = fingerprintRequest({
      messages: [{ role: "user", content: "error: build failed at line 42 but for another reason" }],
    });

    expect(a).toBe(b);
    expect(a).not.toBe(different);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps genuinely different text apart", () => {
    const a = fingerprintRequest({ messages: [{ role: "user", content: "run the tests" }] });
    const b = fingerprintRequest({ messages: [{ role: "user", content: "run the linter" }] });
    expect(a).not.toBe(b);
  });

  it("fingerprints tool_result content as a string and as a block array", () => {
    const asString = fingerprintRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "the tool output" }],
        },
      ],
    });
    const asBlocks = fingerprintRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "the tool output" }] },
          ],
        },
      ],
    });

    expect(asString).not.toBeNull();
    expect(asString).toBe(asBlocks);
    expect(asString).toBe(
      fingerprintRequest({ messages: [{ role: "user", content: "the tool output" }] }),
    );
  });

  it("has no fingerprint when the last message has no usable text", () => {
    expect(fingerprintRequest({ messages: [{ role: "user", content: "" }] })).toBeNull();
    expect(
      fingerprintRequest({
        messages: [{ role: "user", content: [{ type: "image", source: { data: "..." } }] }],
      }),
    ).toBeNull();
    expect(fingerprintRequest({ messages: [] })).toBeNull();
    expect(fingerprintRequest({})).toBeNull();
  });

  it("normalises whitespace, case, digits and ids", () => {
    expect(normaliseFingerprintText("  Error   AT   line 12  ")).toBe("error at line #");
    expect(normaliseFingerprintText("id abcdef0123456789")).toBe("id <id>");
  });
});

describe("loop detection", () => {
  it("flags the 4th and 5th request of a growing conversation with the same last message", async () => {
    await startProxy({ loop: { threshold: 4, windowSeconds: 120, block: false } });

    for (let turn = 0; turn < 5; turn += 1) {
      const res = await post(growingBody(turn, "fix the failing test please"), {
        "x-promptpace-session": "loop-1",
      });
      expect(res.status).toBe(200);
      await res.text();
    }

    const all = rows();
    expect(all).toHaveLength(5);
    expect(all.map((row) => row.flagged)).toEqual([0, 0, 0, 1, 1]);
    // The same fingerprint throughout: only the newest content is fingerprinted.
    expect(new Set(all.map((row) => row.fingerprint)).size).toBe(1);
    expect(all[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // Flag only: the requests were still forwarded.
    expect(mockHits).toBe(5);
  });

  it("never flags requests with different last messages", async () => {
    await startProxy({ loop: { threshold: 4, windowSeconds: 120, block: false } });

    const lastMessages = ["run the tests", "fix the linter", "open a pull request", "run the build", "update the docs"];

    for (const lastMessage of lastMessages) {
      const res = await post(growingBody(lastMessages.indexOf(lastMessage), lastMessage), {
        "x-promptpace-session": "loop-2",
      });
      await res.text();
    }

    expect(rows().map((row) => row.flagged)).toEqual([0, 0, 0, 0, 0]);
    expect(new Set(rows().map((row) => row.fingerprint)).size).toBe(5);
  });

  it("does not count repeats outside the window", async () => {
    await startProxy({ loop: { threshold: 4, windowSeconds: 60, block: false } });

    for (let turn = 0; turn < 3; turn += 1) {
      await (await post(growingBody(turn, "same thing again"), { "x-promptpace-session": "loop-3" }))
        .text();
    }

    // Push the three earlier requests out of the window.
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db!.prepare("UPDATE requests SET timestamp = ?").run(old);

    await (await post(growingBody(3, "same thing again"), { "x-promptpace-session": "loop-3" })).text();

    const all = rows();
    expect(all[all.length - 1]!.flagged).toBe(0);
  });

  it("does not count repeats from another session", async () => {
    await startProxy({ loop: { threshold: 4, windowSeconds: 120, block: false } });

    for (let turn = 0; turn < 3; turn += 1) {
      await (
        await post(growingBody(turn, "same thing again"), { "x-promptpace-session": "loop-4" })
      ).text();
    }
    // A different session with the same content must not push this one over.
    await (await post(growingBody(0, "same thing again"), { "x-promptpace-session": "loop-5" })).text();

    const all = rows();
    expect(all[3]!.flagged).toBe(0);
    expect(all[3]!.session_id).toBe("loop-5");
  });

  it("blocks a loop with 422 when block mode is on", async () => {
    await startProxy({ loop: { threshold: 4, windowSeconds: 120, block: true } });

    for (let turn = 0; turn < 3; turn += 1) {
      const res = await post(growingBody(turn, "same thing again"), {
        "x-promptpace-session": "loop-6",
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    const hitsBefore = mockHits;

    const res = await post(growingBody(3, "same thing again"), {
      "x-promptpace-session": "loop-6",
    });
    expect(res.status).toBe(422);

    const json = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("loop_detected");
    expect(json.error.message).toContain("4 requests");
    expect(json.error.message).toContain("120 seconds");
    expect(json.error.message).toContain("threshold 4");

    // The upstream was never contacted.
    expect(mockHits).toBe(hitsBefore);

    const blocked = db!.prepare("SELECT * FROM requests WHERE blocked = 1").get() as Record<
      string,
      unknown
    >;
    expect(blocked.status).toBe(422);
    expect(blocked.flagged).toBe(1);
    expect(blocked.input_tokens).toBe(0);
    expect(blocked.output_tokens).toBe(0);
    expect(blocked.cost).toBe(0);
    expect(blocked.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("flags but forwards in flag only mode", async () => {
    await startProxy({ loop: { threshold: 2, windowSeconds: 120, block: false } });

    const first = await post(growingBody(0, "same thing again"), {
      "x-promptpace-session": "loop-7",
    });
    expect(first.status).toBe(200);
    await first.text();

    const second = await post(growingBody(1, "same thing again"), {
      "x-promptpace-session": "loop-7",
    });
    expect(second.status).toBe(200);
    await second.text();

    expect(mockHits).toBe(2);
    const all = rows();
    expect(all.map((row) => row.flagged)).toEqual([0, 1]);
    expect(all[1]!.blocked).toBe(0);
  });

  it("never flags a request without a fingerprint", async () => {
    await startProxy({ loop: { threshold: 2, windowSeconds: 120, block: true } });

    for (let turn = 0; turn < 4; turn += 1) {
      const res = await post(
        {
          model: MODEL,
          max_tokens: 100,
          messages: [{ role: "user", content: [{ type: "image", source: { data: "..." } }] }],
        },
        { "x-promptpace-session": "loop-8" },
      );
      expect(res.status).toBe(200);
      await res.text();
    }

    const all = rows();
    expect(all).toHaveLength(4);
    expect(all.every((row) => row.fingerprint === null)).toBe(true);
    expect(all.every((row) => row.flagged === 0)).toBe(true);
    expect(all.every((row) => row.blocked === 0)).toBe(true);
  });

  it("stores only the hash, never the message content", async () => {
    await startProxy();
    const secret = "s3cr3t-prompt-text-do-not-store";

    await (await post(growingBody(0, secret), { "x-promptpace-session": "loop-9" })).text();

    const all = rows();
    expect(all[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    const dump =
      JSON.stringify(db!.prepare("SELECT * FROM requests").all()) +
      JSON.stringify(db!.prepare("SELECT * FROM session_budgets").all());
    expect(dump).not.toContain(secret);

    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(file)) continue;
      expect(readFileSync(file).toString("binary")).not.toContain(secret);
    }
  });
});

describe("admin hardening", () => {
  it("rejects admin writes without a JSON content type", async () => {
    await startProxy();

    const res = await rawRequest("POST", "/admin/sessions/abc/reset", { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(415);

    const withText = await rawRequest(
      "POST",
      "/admin/sessions/abc/budget",
      { host: `127.0.0.1:${port}`, "content-type": "text/plain" },
      '{"cap_usd":1}',
    );
    expect(withText.status).toBe(415);
  });

  it("rejects admin requests with a foreign Host header", async () => {
    await startProxy();

    const res = await rawRequest("GET", "/admin/sessions", { host: "evil.example.com" });
    expect(res.status).toBe(403);

    const wrongPort = await rawRequest("GET", "/admin/sessions", { host: "127.0.0.1:1" });
    expect(wrongPort.status).toBe(403);
  });

  it("ignores forwarded headers when deciding the caller address", async () => {
    await startProxy({ remoteAddress: () => "203.0.113.10" });

    const res = await rawRequest("GET", "/admin/sessions", {
      host: `127.0.0.1:${port}`,
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
    });
    expect(res.status).toBe(403);
  });

  it("sends no CORS headers", async () => {
    await startProxy();

    const res = await fetch(`http://127.0.0.1:${port}/admin/sessions`, {
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(200);

    const corsHeaders = Object.keys(res.headers).filter((name) =>
      name.toLowerCase().startsWith("access-control-"),
    );
    expect(corsHeaders).toEqual([]);
  });

  it("lists recent alerts for a session", async () => {
    await startProxy({ loop: { threshold: 2, windowSeconds: 120, block: false } });

    await (await post(growingBody(0, "same thing again"), { "x-promptpace-session": "loop-10" })).text();
    await (await post(growingBody(1, "same thing again"), { "x-promptpace-session": "loop-10" })).text();

    const res = await fetch(`http://127.0.0.1:${port}/admin/sessions/loop-10/alerts`);
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      session_id: string;
      alerts: Array<{ timestamp: string; fingerprint: string; repeat_count: number; action: string }>;
    };
    expect(json.session_id).toBe("loop-10");
    expect(json.alerts).toHaveLength(1);
    expect(json.alerts[0]!.action).toBe("flagged");
    expect(json.alerts[0]!.repeat_count).toBe(2);
    expect(json.alerts[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(json.alerts[0]!.timestamp).toBeTruthy();
  });
});
