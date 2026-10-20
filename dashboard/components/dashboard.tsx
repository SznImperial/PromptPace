"use client";

import { useEffect, useMemo, useState } from "react";
import { CostChart } from "@/components/cost-chart";
import type { Alert, RequestRow, SeriesPoint, SessionSummary } from "@/lib/proxy";

const POLL_INTERVAL_MS = 2000;
const BURN_RATE_WINDOW_MINUTES = 5;

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function tokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function clockTime(iso: string): string {
  return iso.slice(11, 19);
}

function Badge({ kind, children }: { kind: "blocked" | "flagged" | "partial"; children: React.ReactNode }) {
  const styles = {
    blocked: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
    flagged: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    partial: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  }[kind];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${styles}`}
    >
      {children}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-zinc-100">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

interface Props {
  initialSessions: SessionSummary[];
  initialRequests: RequestRow[];
  initialSeries: SeriesPoint[];
  initialAlerts: Alert[];
  initialError: string | null;
}

export function Dashboard({
  initialSessions,
  initialRequests,
  initialSeries,
  initialAlerts,
  initialError,
}: Props) {
  const [session, setSession] = useState<string>("all");
  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions);
  const [requests, setRequests] = useState<RequestRow[]>(initialRequests);
  const [series, setSeries] = useState<SeriesPoint[]>(initialSeries);
  const [alerts, setAlerts] = useState<Alert[]>(initialAlerts);
  const [error, setError] = useState<string | null>(initialError);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const query = session === "all" ? "" : `&session=${encodeURIComponent(session)}`;
      try {
        const [requestsRes, seriesRes, sessionsRes, alertsRes] = await Promise.all([
          fetch(`/api/requests?limit=25${query}`, { cache: "no-store" }),
          fetch(`/api/series?minutes=15${query}`, { cache: "no-store" }),
          fetch("/api/sessions", { cache: "no-store" }),
          fetch(`/api/alerts?session=${encodeURIComponent(session)}`, { cache: "no-store" }),
        ]);

        if (cancelled) return;

        if (!requestsRes.ok || !seriesRes.ok) {
          throw new Error(`proxy returned ${requestsRes.status || seriesRes.status}`);
        }

        const requestsJson = (await requestsRes.json()) as { requests: RequestRow[] };
        const seriesJson = (await seriesRes.json()) as { series: SeriesPoint[] };
        const sessionsJson = (await sessionsRes.json()) as { sessions: SessionSummary[] };
        const alertsJson = (await alertsRes.json()) as { alerts: Alert[] };

        setRequests(requestsJson.requests);
        setSeries(seriesJson.series);
        setSessions(sessionsJson.sessions);
        setAlerts(alertsJson.alerts);
        setError(null);
        setUpdatedAt(new Date().toISOString());
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "could not reach the proxy");
        }
      }
    }

    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session]);

  const selected = useMemo(
    () => sessions.find((entry) => entry.id === session) ?? null,
    [sessions, session],
  );

  const totalSpent = useMemo(
    () => sessions.reduce((sum, entry) => sum + entry.spent, 0),
    [sessions],
  );

  // Burn rate: the cost of the last five minutes, divided by five.
  const burnRate = useMemo(() => {
    const cutoff = Date.now() - BURN_RATE_WINDOW_MINUTES * 60_000;
    const recent = series.filter((point) => new Date(point.minute).getTime() >= cutoff - 60_000);
    const cost = recent.reduce((sum, point) => sum + point.cost, 0);
    return cost / BURN_RATE_WINDOW_MINUTES;
  }, [series]);

  const spent = selected ? selected.spent : totalSpent;
  const cap = selected ? selected.cap : null;
  const capRatio = cap && cap > 0 ? Math.min(spent / cap, 1) : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-teal-300">
            PromptPace
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-zinc-50">Spend dashboard</h1>
        </div>

        <div className="flex items-end gap-3">
          <label className="text-xs text-zinc-500" htmlFor="session">
            Session
          </label>
          <select
            id="session"
            value={session}
            onChange={(event) => setSession(event.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-teal-500"
          >
            <option value="all">all sessions</option>
            {sessions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          </select>
        </div>
      </header>

      <p className="mt-2 text-xs text-zinc-600">
        {error
          ? `proxy unreachable: ${error}`
          : `polling every 2s from the Next server (the browser never calls the proxy directly)${
              updatedAt ? ` — updated ${clockTime(updatedAt)}` : ""
            }`}
      </p>

      {/* View 1: cost over time */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          View 1 — cost over time
        </h2>
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <CostChart points={series} />
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Burn rate"
              value={`${usd(burnRate)}/min`}
              hint={`cost of the last ${BURN_RATE_WINDOW_MINUTES} minutes divided by ${BURN_RATE_WINDOW_MINUTES}`}
            />
            <Stat
              label="Spent"
              value={usd(spent)}
              hint={selected ? `session ${selected.id}` : `all ${sessions.length} session(s)`}
            />
            <Stat
              label="Cap"
              value={cap === null ? "no cap" : usd(cap)}
              hint={cap === null ? "PROMPTPACE_BUDGET_USD is not set" : "per-session cap"}
            />
          </div>
          {capRatio !== null ? (
            <div className="mt-4">
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-teal-400"
                  style={{ width: `${Math.round(capRatio * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {Math.round(capRatio * 100)}% of the cap used
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {/* View 2: request feed */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          View 2 — live request feed
        </h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900/80 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Model</th>
                <th className="px-4 py-2 font-medium">Tokens</th>
                <th className="px-4 py-2 font-medium">Cost</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Session</th>
                <th className="px-4 py-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-zinc-600">
                    no requests yet
                  </td>
                </tr>
              ) : (
                requests.map((row) => (
                  <tr key={row.id} className="text-zinc-300">
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500">
                      {clockTime(row.timestamp)}
                    </td>
                    <td className="px-4 py-2">{row.model}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {tokens(row.input_tokens)} in / {tokens(row.output_tokens)} out
                    </td>
                    <td
                      className="px-4 py-2 font-mono text-xs"
                      title={row.partial === 1 ? "lower bound: the stream was cut short" : undefined}
                    >
                      {usd(row.cost)}
                    </td>
                    <td
                      className="px-4 py-2 font-mono text-xs"
                      style={{
                        color:
                          row.status >= 400
                            ? "rgb(253 164 175)"
                            : row.status === 200
                              ? "rgb(134 239 172)"
                              : undefined,
                      }}
                    >
                      {row.status}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500">{row.session_id}</td>
                    <td className="px-4 py-2">
                      <span className="flex flex-wrap gap-1">
                        {row.blocked === 1 ? <Badge kind="blocked">blocked</Badge> : null}
                        {row.flagged === 1 ? <Badge kind="flagged">flagged</Badge> : null}
                        {row.partial === 1 ? <Badge kind="partial">partial</Badge> : null}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-zinc-600">
          Rows marked <span className="text-sky-300">partial</span> only carry the usage that
          was seen before the stream broke, so their cost is a lower bound.
        </p>
      </section>

      {/* View 3: alerts */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          View 3 — alerts
        </h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
          {alerts.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-zinc-600">
              no flagged or blocked requests
            </p>
          ) : (
            <ul className="divide-y divide-zinc-800/80">
              {alerts.map((alert) => (
                <li
                  key={`${alert.timestamp}-${alert.fingerprint}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-zinc-300"
                >
                  <span className="font-mono text-xs text-zinc-500">
                    {clockTime(alert.timestamp)}
                  </span>
                  {alert.action === "blocked" ? (
                    <Badge kind="blocked">blocked</Badge>
                  ) : (
                    <Badge kind="flagged">flagged</Badge>
                  )}
                  <span className="text-zinc-400">
                    {alert.repeat_count} repeats in the window
                  </span>
                  <span className="font-mono text-xs text-zinc-600">
                    {alert.fingerprint ?? "no fingerprint"}
                  </span>
                  <span className="ml-auto font-mono text-xs text-zinc-500">
                    status {alert.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
