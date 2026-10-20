import { Dashboard } from "@/components/dashboard";
import type { Alert, RequestRow, SeriesPoint, SessionSummary } from "@/lib/proxy";
import { getAlerts, getRequests, getSeries, getSessions } from "@/lib/proxy";

// The page reads the proxy on the server; the browser only talks to Next.
export const dynamic = "force-dynamic";

export default async function Page() {
  let sessions: SessionSummary[] = [];
  let requests: RequestRow[] = [];
  let series: SeriesPoint[] = [];
  let alerts: Alert[] = [];
  let error: string | null = null;

  try {
    [sessions, requests, series] = await Promise.all([
      getSessions(),
      getRequests({ limit: 25 }),
      getSeries({ minutes: 15 }),
    ]);
    alerts = await getAlerts(null);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "the proxy is not reachable";
  }

  return (
    <Dashboard
      initialSessions={sessions}
      initialRequests={requests}
      initialSeries={series}
      initialAlerts={alerts}
      initialError={error}
    />
  );
}
