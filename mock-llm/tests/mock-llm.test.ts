import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createMockApp } from "../src/app.js";

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(raw: string): SseEvent[] {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function post(app: ReturnType<typeof createMockApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("mock-llm non-streaming", () => {
  it("returns an Anthropic Messages response with configured usage", async () => {
    const app = createMockApp({ model: "test-model", inputTokens: 10, outputTokens: 20 });

    const res = await post(
      app,
      {
        model: "test-model",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello there" }],
      },
      { "x-mock-input-tokens": "1500", "x-mock-output-tokens": "500" },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.model).toBe("test-model");
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    const content = json.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("Hello there");
  });

  it("reports cache creation and cache read tokens", async () => {
    const app = createMockApp();

    const res = await post(
      app,
      { messages: [{ role: "user", content: "cache me" }] },
      {
        "x-mock-input-tokens": "11",
        "x-mock-output-tokens": "22",
        "x-mock-cache-creation-tokens": "33",
        "x-mock-cache-read-tokens": "44",
      },
    );

    const json = (await res.json()) as { usage: unknown };
    expect(json.usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
    });
  });

  it("uses app defaults when no override headers are sent", async () => {
    const app = createMockApp({ inputTokens: 7, outputTokens: 9 });

    const res = await post(app, { messages: [{ role: "user", content: "Hi" }] });
    const json = (await res.json()) as { usage: unknown };

    expect(json.usage).toEqual({
      input_tokens: 7,
      output_tokens: 9,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("rejects invalid JSON with an Anthropic-shaped error", async () => {
    const app = createMockApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { type: string; error: { type: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("invalid_request_error");
  });
});

describe("mock-llm failure simulation", () => {
  it("returns an error response before streaming when asked to", async () => {
    const app = createMockApp();

    const res = await post(
      app,
      { stream: true, messages: [{ role: "user", content: "boom" }] },
      { "x-mock-error-status": "429" },
    );

    expect(res.status).toBe(429);
    const json = (await res.json()) as { type: string; error: { message: string } };
    expect(json.type).toBe("error");
    expect(json.error.message).toContain("Mock upstream failure");
  });

  it("drops the stream after the configured number of events", async () => {
    const app = createMockApp();
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mock-drop-after": "3" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "drop me" }] }),
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

      // The client sees the connection die instead of a clean end.
      expect(failed).toBe(true);
      expect(parseSse(received).length).toBeLessThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("mock-llm streaming", () => {
  it("streams Anthropic SSE events with usage numbers", async () => {
    const app = createMockApp();

    const res = await post(
      app,
      {
        model: "test-model",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Stream this" }],
      },
      { "x-mock-input-tokens": "300", "x-mock-output-tokens": "42" },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(await res.text());
    expect(events.slice(0, 2).map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
    ]);
    expect(events.slice(-3).map((event) => event.event)).toEqual([
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const middle = events.slice(2, -3);
    expect(middle.length).toBeGreaterThan(0);
    expect(middle.every((event) => event.event === "content_block_delta")).toBe(true);

    const start = events[0]?.data as {
      message: { usage: Record<string, number> };
    };
    expect(start.message.usage).toEqual({
      input_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });

    const delta = events.find((event) => event.event === "message_delta")?.data as {
      usage: { output_tokens: number; input_tokens: number };
      delta: { stop_reason: string };
    };
    expect(delta.delta.stop_reason).toBe("end_turn");
    expect(delta.usage.output_tokens).toBe(42);
    expect(delta.usage.input_tokens).toBe(300);

    const text = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data as { delta: { text: string } }).delta.text)
      .join("");
    expect(text).toContain("Stream this");
  });

  it("applies the configured delay between chunks", async () => {
    const app = createMockApp();
    const startedAt = Date.now();

    const res = await post(
      app,
      { stream: true, messages: [{ role: "user", content: "one two three" }] },
      { "x-mock-delay-ms": "10" },
    );
    await res.text();

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });
});
