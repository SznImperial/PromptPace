import { NextResponse } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';

export const dynamic = 'force-dynamic';

export async function GET() {
  const telemetry = governorEngine.getTelemetryPayload();
  return NextResponse.json(telemetry);
}
