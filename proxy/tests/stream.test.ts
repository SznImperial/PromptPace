import { describe, expect, it } from "vitest";
import { extractUsageFromSseEvent, forwardSseStream, SseUsageParser } from "../src/stream.js";

describe("extractUsageFromSseEvent", () => {
  it("reads input and cache counters from message_start", () => {
    expect(
      extractUsageFromSseEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 25,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 200,
            output_tokens: 0,
          },
        },
      }),
    ).toEqual({
      inputTokens: 25,
      cacheCreationTokens: 100,
      cacheReadTokens: 200,
      outputTokens: 0,
    });
  });

  it("reads the cumulative output counter from message_delta", () => {
    expect(
      extractUsageFromSseEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 510, input_tokens: 25 },
      }),
    ).toEqual({ outputTokens: 510, inputTokens: 25 });
  });

  it("ignores events without usage", () => {
    expect(extractUsageFromSseEvent({ type: "ping" })).toEqual({});
    expect(extractUsageFromSseEvent({ type: "content_block_delta" })).toEqual({});
  });
});

describe("SseUsageParser", () => {
  it("collects usage from events split across chunk boundaries", () => {
    const parser = new SseUsageParser();
    const bytes = new TextEncoder().encode(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_creation_input_tokens":22,"cache_read_input_tokens":33}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":44}}\n\n',
    );

    parser.push(bytes.slice(0, 30));
    parser.push(bytes.slice(30));
    parser.flush();

    expect(parser.getUsage()).toEqual({
      inputTokens: 11,
      outputTokens: 44,
      cacheCreationTokens: 22,
      cacheReadTokens: 33,
    });
  });
});

describe("forwardSseStream", () => {
  it("does not read from the upstream faster than the client consumes", async () => {
    let produced = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
    });

    const forwarded = forwardSseStream({ upstreamBody: upstream, onFinish: () => {} });
    const reader = forwarded.getReader();

    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Only the delivered chunk and the queued one were pulled from the upstream.
    expect(produced).toBeLessThanOrEqual(3);
  });

  it("passes the bytes through untouched", async () => {
    const payload = new TextEncoder().encode("event: ping\ndata: {}\n\n");
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });

    const forwarded = forwardSseStream({ upstreamBody: upstream, onFinish: () => {} });
    const reader = forwarded.getReader();
    const first = await reader.read();

    expect(first.value).toEqual(payload);
  });
});
