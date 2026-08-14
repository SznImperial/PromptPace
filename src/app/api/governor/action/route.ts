import { NextRequest, NextResponse } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';
import { GovernorActionType } from '@/lib/governor/types';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action as GovernorActionType;
    const payload = body.payload;

    if (!action) {
      return NextResponse.json({ error: 'Missing action parameter' }, { status: 400 });
    }

    governorEngine.handleAction(action, payload);

    return NextResponse.json({
      success: true,
      telemetry: governorEngine.getTelemetryPayload(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to handle action' },
      { status: 500 }
    );
  }
}
