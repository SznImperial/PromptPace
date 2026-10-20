import { NextResponse } from "next/server";
import { getSessions } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await getSessions();
    return NextResponse.json({ sessions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "proxy request failed" },
      { status: 502 },
    );
  }
}
