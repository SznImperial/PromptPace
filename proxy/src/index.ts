import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createProxyApp } from "./app.js";
import { openDatabase } from "./db.js";
import { loadPricing } from "./pricing.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function envUsd(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

const port = envInt("PROXY_PORT", 8787);
const upstreamUrl = process.env.UPSTREAM_URL ?? "http://127.0.0.1:8788";
const dbPath = process.env.PROXY_DB_PATH ?? join(packageRoot, "data", "promptpace.db");
const pricingPath = process.env.PRICING_PATH ?? join(packageRoot, "pricing.json");
const defaultSessionId = process.env.DEFAULT_SESSION_ID ?? "default";
const budgetUsd = envUsd("PROMPTPACE_BUDGET_USD");

const loop = {
  threshold: envInt("PROMPTPACE_LOOP_THRESHOLD", 4),
  windowSeconds: envInt("PROMPTPACE_LOOP_WINDOW_SECONDS", 120),
  block: process.env.PROMPTPACE_LOOP_BLOCK === "true",
  minChars: envNonNegativeInt("PROMPTPACE_LOOP_MIN_CHARS", 25),
};

const db = openDatabase(dbPath);
const pricing = loadPricing(pricingPath);

const app = createProxyApp({ upstreamUrl, db, pricing, defaultSessionId, budgetUsd, loop });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[proxy] listening on http://127.0.0.1:${info.port}`);
  console.log(`[proxy] upstream ${upstreamUrl}`);
  console.log(`[proxy] sqlite ${dbPath}`);
  console.log(`[proxy] default session budget ${budgetUsd === null ? "none" : `$${budgetUsd}`}`);
  console.log(
    `[proxy] loop detection threshold ${loop.threshold} in ${loop.windowSeconds}s (${loop.block ? "block" : "flag only"}), min ${loop.minChars} chars`,
  );
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
