import { NextResponse } from "next/server";
import { getSeries } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const minutes = Number(url.searchParams.get("minutes") ?? 15);
  const session = url.searchParams.get("session");

  try {
    const series = await getSeries({
      minutes: Number.isFinite(minutes) ? minutes : 15,
      session: session && session !== "all" ? session : null,
    });
    return NextResponse.json({ series });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "proxy request failed" },
      { status: 502 },
    );
  }
}
