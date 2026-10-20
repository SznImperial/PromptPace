import { NextResponse } from "next/server";
import { getRequests } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const session = url.searchParams.get("session");

  try {
    const requests = await getRequests({
      limit: Number.isFinite(limit) ? limit : 25,
      session: session && session !== "all" ? session : null,
    });
    return NextResponse.json({ requests });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "proxy request failed" },
      { status: 502 },
    );
  }
}
