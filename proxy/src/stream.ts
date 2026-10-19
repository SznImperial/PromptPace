import type { TokenUsage, UsagePatch } from "./usage.js";
import { mergeUsage, readUsageFields } from "./usage.js";

/**
 * Extracts token usage from a single Anthropic SSE event payload.
 *
 * `message_start` carries the input and cache counters in `message.usage`.
 * `message_delta` carries the cumulative output counter in `usage`
 * (and may repeat the input and cache counters).
 */
export function extractUsageFromSseEvent(event: Record<string, unknown>): UsagePatch {
  if (event.type === "message_start") {
    const message = event.message;
    if (typeof message !== "object" || message === null) return {};
    return readUsageFields((message as Record<string, unknown>).usage);
  }

  if (event.type === "message_delta") {
    return readUsageFields(event.usage);
  }

  return {};
}

/**
 * Side-path SSE reader. It never touches the bytes that go to the client; it only
 * keeps a small text buffer to find event boundaries.
 */
export class SseUsageParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain();
  }

  flush(): void {
    this.buffer += this.decoder.decode();
    this.drain();
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  private drain(): void {
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    let index = this.buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.handleBlock(block);
      index = this.buffer.indexOf("\n\n");
    }
  }

  private handleBlock(block: string): void {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (data.length === 0 || data === "[DONE]") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;
    this.usage = mergeUsage(this.usage, extractUsageFromSseEvent(parsed as Record<string, unknown>));
  }
}

export interface ForwardSseOptions {
  upstreamBody: ReadableStream<Uint8Array>;
  /** Aborted when the client goes away, so the upstream request can be cancelled. */
  signal?: AbortSignal;
  /** Called once, when the stream ends, fails or is cancelled. */
  onFinish: (usage: TokenUsage, partial: boolean) => void;
  /** Called when the client aborted the response. */
  onClientAbort?: () => void;
}

/**
 * Forwards an upstream SSE body to the client chunk by chunk.
 *
 * The upstream is only read when the client asks for more data (pull based), so the
 * proxy never reads faster than the client consumes. Usage is parsed on a side path
 * from a copy of the bytes; the bytes handed to the client are untouched.
 */
export function forwardSseStream(options: ForwardSseOptions): ReadableStream<Uint8Array> {
  const reader = options.upstreamBody.getReader();
  const parser = new SseUsageParser();
  let settled = false;

  const settle = (partial: boolean): void => {
    if (settled) return;
    settled = true;
    options.onFinish(parser.getUsage(), partial);
  };

  const abortUpstream = (reason: unknown): void => {
    if (settled) return;
    void reader.cancel(reason).catch(() => {});
    options.onClientAbort?.();
    settle(true);
  };

  if (options.signal) {
    if (options.signal.aborted) {
      abortUpstream(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", () => abortUpstream(options.signal?.reason), {
        once: true,
      });
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          parser.flush();
          controller.close();
          settle(false);
          return;
        }
        if (value) {
          // Hand the bytes to the client first, then parse a copy of them.
          controller.enqueue(value);
          parser.push(value);
        }
      } catch (error) {
        settle(true);
        controller.error(error);
      }
    },
    cancel(reason) {
      abortUpstream(reason);
    },
  });
}
