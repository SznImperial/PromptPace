import { NextRequest } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';
import { GovernorTelemetryPayload } from '@/lib/governor/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial state
      const initialPayload = governorEngine.getTelemetryPayload();
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(initialPayload)}\n\n`)
      );

      // Subscribe to engine state changes
      const unsubscribe = governorEngine.subscribe((payload: GovernorTelemetryPayload) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        } catch (e) {
          // Stream might be closed
        }
      });

      // Heartbeat interval to keep connection alive
      const interval = setInterval(() => {
        try {
          const payload = governorEngine.getTelemetryPayload();
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        } catch (e) {
          clearInterval(interval);
          unsubscribe();
        }
      }, 1000);

      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        unsubscribe();
        try {
          controller.close();
        } catch (e) {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
