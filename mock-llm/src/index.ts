import { serve } from "@hono/node-server";
import { createMockApp } from "./app.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const port = envInt("MOCK_PORT", 8788);

const app = createMockApp({
  model: process.env.MOCK_MODEL ?? "mock-claude",
  delayMs: envInt("MOCK_DELAY_MS", 80),
  inputTokens: envInt("MOCK_INPUT_TOKENS", 120),
  outputTokens: envInt("MOCK_OUTPUT_TOKENS", 240),
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${info.port}`);
});
