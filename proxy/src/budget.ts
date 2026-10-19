import type { Db } from "./db.js";
import { getSessionCap, getSessionSpend } from "./db.js";

export interface BudgetStatus {
  sessionId: string;
  /** Effective cap in USD: the per-session cap if set, otherwise the env default. `null` means no cap. */
  cap: number | null;
  /** Cumulative cost in USD since the session baseline. */
  spent: number;
  /** True when the session is at or over its cap. */
  blocked: boolean;
}

/**
 * The budget gate. A per-session cap overrides the env default; with no cap
 * anywhere every request is allowed.
 */
export function checkSessionBudget(
  db: Db,
  sessionId: string,
  defaultCapUsd: number | null,
): BudgetStatus {
  const cap = getSessionCap(db, sessionId) ?? defaultCapUsd;
  const spent = getSessionSpend(db, sessionId);
  return { sessionId, cap, spent, blocked: cap !== null && spent >= cap };
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** The message returned with HTTP 402. It states the cap, the spend and how to raise the cap. */
export function formatBudgetMessage(status: BudgetStatus): string {
  const cap = status.cap ?? 0;
  return (
    `Session budget exceeded: spent ${formatUsd(status.spent)} of the ${formatUsd(cap)} cap ` +
    `for session ${status.sessionId}. Raise it with ` +
    `POST /admin/sessions/${status.sessionId}/budget {"cap_usd": <usd>} ` +
    `or set PROMPTPACE_BUDGET_USD.`
  );
}
