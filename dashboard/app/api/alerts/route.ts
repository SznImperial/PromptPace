import { NextResponse } from "next/server";
import { getAlerts } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = url.searchParams.get("session");

  try {
    const alerts = await getAlerts(session && session !== "all" ? session : null);
    return NextResponse.json({ alerts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "proxy request failed" },
      { status: 502 },
    );
  }
}
