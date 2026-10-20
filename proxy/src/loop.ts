import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { countRepeats } from "./db.js";

export interface LoopConfig {
  /** How many identical requests in the window count as a loop. */
  threshold: number;
  /** Length of the sliding window in seconds. */
  windowSeconds: number;
  /** Block looped requests instead of only flagging them. */
  block: boolean;
  /** Shortest normalised text that is fingerprinted at all. */
  minChars: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  threshold: 4,
  windowSeconds: 120,
  block: false,
  minChars: 25,
};

export interface LoopDecision {
  fingerprint: string | null;
  /** Number of matching requests in the window, including the current one. */
  repeatCount: number;
  flagged: boolean;
  block: boolean;
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const HEX_TOKEN_PATTERN = /\b[0-9a-f]{8,}\b/g;
const DIGIT_RUN_PATTERN = /\d+/g;

/**
 * Normalises text so that timestamps, line numbers and ids do not defeat
 * matching. Ids are replaced before digit runs, otherwise the digit
 * replacement would break the id pattern apart.
 */
export function normaliseFingerprintText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(UUID_PATTERN, "<id>")
    .replace(HEX_TOKEN_PATTERN, "<id>")
    .replace(DIGIT_RUN_PATTERN, "#")
    .trim();
}

/** Pulls the text out of a message content: a string, or an array of blocks. */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;

    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }
    if (record.type === "tool_result") {
      // A tool result holds a string or a list of blocks.
      parts.push(textFromContent(record.content));
    }
  }
  return parts.join(" ");
}

/**
 * Fingerprints the newest content of a request: the last message's text blocks
 * plus the text inside its tool_result blocks. Only the hash is kept, never
 * the content. Requests without usable text (empty, image only) or with text
 * shorter than `minChars` get no fingerprint, so short filler replies such as
 * "continue" never look like a loop.
 */
export function fingerprintRequest(
  body: unknown,
  minChars: number = DEFAULT_LOOP_CONFIG.minChars,
): string | null {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const last = messages[messages.length - 1];
  if (typeof last !== "object" || last === null) return null;

  const text = textFromContent((last as { content?: unknown }).content);
  const normalised = normaliseFingerprintText(text);
  if (normalised.length < minChars) return null;

  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

/**
 * Decides whether a request is a loop: the same fingerprint seen at least
 * `threshold` times for the session within the window, counting this request.
 */
export function evaluateLoop(
  db: Db,
  sessionId: string,
  fingerprint: string | null,
  config: LoopConfig,
  now: Date = new Date(),
): LoopDecision {
  if (!fingerprint) {
    return { fingerprint: null, repeatCount: 0, flagged: false, block: false };
  }

  const repeatCount = countRepeats(db, sessionId, fingerprint, config.windowSeconds, now) + 1;
  const flagged = repeatCount >= config.threshold;

  return { fingerprint, repeatCount, flagged, block: flagged && config.block };
}

export function formatLoopMessage(decision: LoopDecision, config: LoopConfig): string {
  return (
    `Loop detected: this request matches ${decision.repeatCount} requests with the same content ` +
    `for the same session within the last ${config.windowSeconds} seconds ` +
    `(threshold ${config.threshold}). The request was not sent upstream. ` +
    `If this is expected, raise PROMPTPACE_LOOP_THRESHOLD or set PROMPTPACE_LOOP_BLOCK=false.`
  );
}
