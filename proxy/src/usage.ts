export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UsagePatch {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/**
 * Maps an Anthropic `usage` object onto the fields PromptPace stores.
 * Field names come from the Messages API docs:
 *   input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
 */
export function readUsageFields(usage: unknown): UsagePatch {
  if (typeof usage !== "object" || usage === null) return {};
  const record = usage as Record<string, unknown>;
  const patch: UsagePatch = {};

  const assign = (key: keyof UsagePatch, value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      patch[key] = Math.trunc(value);
    }
  };

  assign("inputTokens", record.input_tokens);
  assign("outputTokens", record.output_tokens);
  assign("cacheCreationTokens", record.cache_creation_input_tokens);
  assign("cacheReadTokens", record.cache_read_input_tokens);

  return patch;
}

export function mergeUsage(base: TokenUsage, patch: UsagePatch): TokenUsage {
  return {
    inputTokens: patch.inputTokens ?? base.inputTokens,
    outputTokens: patch.outputTokens ?? base.outputTokens,
    cacheCreationTokens: patch.cacheCreationTokens ?? base.cacheCreationTokens,
    cacheReadTokens: patch.cacheReadTokens ?? base.cacheReadTokens,
  };
}
