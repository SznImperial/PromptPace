import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";

export interface MockConfig {
  model: string;
  delayMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Called when the client disconnects mid-stream. */
  onStreamAbort?: () => void;
  /** Called when the client goes away before the response finished. */
  onClientDisconnect?: () => void;
  /** Called after every SSE event is written. Receives the number of events written. */
  onStreamEvent?: (eventsWritten: number) => void;
}

export const DEFAULT_MOCK_CONFIG: MockConfig = {
  model: "mock-claude",
  delayMs: 0,
  inputTokens: 12,
  outputTokens: 24,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

interface MessagesRequest {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function headerInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

function lastUserText(request: MessagesRequest): string {
  const messages = request.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join(" ");
    }
  }
  return "";
}

function responseText(request: MessagesRequest): string {
  const prompt = lastUserText(request).trim();
  if (!prompt) return "Mock response from PromptPace.";
  const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
  return `Mock response from PromptPace. You said: ${preview}`;
}

export function createMockApp(overrides: Partial<MockConfig> = {}): Hono {
  const config: MockConfig = { ...DEFAULT_MOCK_CONFIG, ...overrides };
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "mock-llm" }));

  app.post("/v1/messages", async (c) => {
    let request: MessagesRequest;
    try {
      request = (await c.req.json()) as MessagesRequest;
    } catch {
      return c.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "Request body must be JSON." },
        },
        400,
      );
    }

    // Failure simulation: the upstream fails before the stream starts.
    const errorStatus = headerInt(c.req.header("x-mock-error-status"), 0);
    if (errorStatus > 0) {
      return c.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "Mock upstream failure before stream." },
        },
        errorStatus as ContentfulStatusCode,
      );
    }

    const delayMs = headerInt(c.req.header("x-mock-delay-ms"), config.delayMs);
    const inputTokens = headerInt(c.req.header("x-mock-input-tokens"), config.inputTokens);
    const outputTokens = headerInt(c.req.header("x-mock-output-tokens"), config.outputTokens);
    const cacheCreationTokens = headerInt(
      c.req.header("x-mock-cache-creation-tokens"),
      config.cacheCreationTokens,
    );
    const cacheReadTokens = headerInt(
      c.req.header("x-mock-cache-read-tokens"),
      config.cacheReadTokens,
    );
    // Failure simulation: the upstream dies after N SSE events.
    const dropAfter = headerInt(c.req.header("x-mock-drop-after"), 0);
    // Failure simulation: the upstream closes cleanly after N SSE events, without message_stop.
    const stopAfter = headerInt(c.req.header("x-mock-stop-after"), 0);

    const model = request.model ?? config.model;
    const id = `msg_mock_${randomUUID()}`;
    const text = responseText(request);
    const chunks = text.split(/(\s+)/).filter((chunk) => chunk.length > 0);

    const usage = {
      input_tokens: inputTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens,
      output_tokens: outputTokens,
    };

    if (request.stream === true) {
      const events: Array<{ event: string; data: unknown }> = [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { ...usage, output_tokens: 0 },
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        },
        ...chunks.map((chunk) => ({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: chunk },
          },
        })),
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage,
          },
        },
        {
          event: "message_stop",
          data: { type: "message_stop" },
        },
      ];

      return streamSSE(c, async (stream) => {
        stream.onAbort(() => {
          config.onStreamAbort?.();
        });

        const env = (c.env ?? {}) as {
          outgoing?: {
            destroy?: () => void;
            socket?: { destroy?: () => void };
            writableFinished?: boolean;
            on?: (event: string, listener: () => void) => void;
          };
        };

        let dropping = false;
        env.outgoing?.on?.("close", () => {
          if (!dropping && env.outgoing?.writableFinished === false) {
            config.onClientDisconnect?.();
          }
        });

        let written = 0;
        for (const item of events) {
          if (dropAfter > 0 && written >= dropAfter) {
            // Kill the connection mid-flight: the client sees a truncated body.
            dropping = true;
            const outgoing = env.outgoing;
            if (outgoing) {
              // Give the already written events a chance to reach the client.
              await sleep(20);
              outgoing.socket?.destroy?.();
              outgoing.destroy?.();
            } else {
              stream.abort();
            }
            return;
          }

          if (stopAfter > 0 && written >= stopAfter) {
            // Close the stream cleanly, but without the message_stop event.
            return;
          }

          await sleep(delayMs);
          await stream.writeSSE({ event: item.event, data: JSON.stringify(item.data) });
          written += 1;
          config.onStreamEvent?.(written);
        }
      });
    }

    await sleep(delayMs);
    return c.json({
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
  });

  return app;
}
