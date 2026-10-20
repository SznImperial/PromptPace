/**
 * Server-side access to the proxy admin API.
 *
 * The browser never talks to the proxy: the proxy sends no CORS headers, so
 * the page fetches these Next route handlers instead and they call the proxy
 * from the server. Only the server side may import this module.
 */

export const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";

export interface SessionSummary {
  id: string;
  cap: number | null;
  spent: number;
  blocked: number;
  last_activity: string | null;
}

export interface RequestRow {
  id: string;
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost: number;
  status: number;
  partial: number;
  flagged: number;
  blocked: number;
  session_id: string;
}

export interface SeriesPoint {
  minute: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

export interface Alert {
  timestamp: string;
  fingerprint: string | null;
  repeat_count: number;
  action: string;
  status: number;
  cost: number;
  /** The session the alert belongs to. */
  session: string;
}

export function proxyBaseUrl(): string {
  return process.env.PROMPTPACE_PROXY_URL?.trim() || DEFAULT_PROXY_URL;
}

async function proxyFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${proxyBaseUrl()}${path}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`proxy admin request ${path} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getSessions(): Promise<SessionSummary[]> {
  const json = await proxyFetch<{ sessions: SessionSummary[] }>("/admin/sessions");
  return json.sessions;
}

export async function getRequests(options: {
  limit?: number;
  session?: string | null;
}): Promise<RequestRow[]> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 25));
  if (options.session) params.set("session", options.session);
  const json = await proxyFetch<{ requests: RequestRow[] }>(`/admin/requests?${params}`);
  return json.requests;
}

export async function getSeries(options: {
  minutes?: number;
  session?: string | null;
}): Promise<SeriesPoint[]> {
  const params = new URLSearchParams();
  params.set("minutes", String(options.minutes ?? 15));
  if (options.session) params.set("session", options.session);
  const json = await proxyFetch<{ series: SeriesPoint[] }>(`/admin/series?${params}`);
  return json.series;
}

export async function getAlerts(session: string | null): Promise<Alert[]> {
  if (session) {
    const json = await proxyFetch<{ alerts: Omit<Alert, "session">[] }>(
      `/admin/sessions/${encodeURIComponent(session)}/alerts`,
    );
    return json.alerts.map((alert) => ({ ...alert, session }));
  }

  // "All sessions": the alerts endpoint works per session, so merge them.
  const sessions = await getSessions();
  const lists = await Promise.all(
    sessions.map((entry) =>
      getAlerts(entry.id).catch(() => [] as Alert[]),
    ),
  );
  return lists
    .flat()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
