import { readFileSync } from "node:fs";
import type { TokenUsage } from "./usage.js";

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_creation_per_mtok: number;
  cache_read_per_mtok: number;
  todo_verify?: boolean;
}

export interface PricingTable {
  currency: string;
  unit: "per_million_tokens";
  models: Record<string, ModelPrice>;
}

export function loadPricing(path: string): PricingTable {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PricingTable;
  if (!parsed.models || typeof parsed.models !== "object") {
    throw new Error(`Pricing file ${path} is missing a models object.`);
  }
  return parsed;
}

export function priceFor(pricing: PricingTable, model: string): ModelPrice {
  return (
    pricing.models[model] ??
    pricing.models.default ?? {
      input_per_mtok: 0,
      output_per_mtok: 0,
      cache_creation_per_mtok: 0,
      cache_read_per_mtok: 0,
    }
  );
}

export function computeCost(pricing: PricingTable, model: string, usage: TokenUsage): number {
  const price = priceFor(pricing, model);
  const cost =
    (usage.inputTokens / 1_000_000) * price.input_per_mtok +
    (usage.outputTokens / 1_000_000) * price.output_per_mtok +
    (usage.cacheCreationTokens / 1_000_000) * price.cache_creation_per_mtok +
    (usage.cacheReadTokens / 1_000_000) * price.cache_read_per_mtok;
  return Number(cost.toFixed(8));
}
