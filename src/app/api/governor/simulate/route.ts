import { NextRequest, NextResponse } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';

export async function POST(req: NextRequest) {
  try {
    const { mode } = await req.json(); // 'normal' | 'runaway_loop' | 'burst'

    if (mode === 'normal') {
      // Simulate standard step
      const model = 'claude-3-7-sonnet-20250219';
      const prompt = `Reviewing test failures in src/auth.ts and applying fixes for session expiration handling. Step ${Date.now()}`;
      
      const preflight = await governorEngine.preflightCheck({
        model,
        promptSnippet: prompt,
        estimatedTokens: 900,
      });

      if (preflight.action === 'kill') {
        return NextResponse.json({ status: 'killed', message: 'Governor killed session' });
      }

      const promptTokens = Math.floor(Math.random() * 300) + 700;
      const completionTokens = Math.floor(Math.random() * 200) + 150;

      governorEngine.recordCompletedRequest({
        provider: 'anthropic',
        model,
        endpoint: '/v1/messages',
        promptTokens,
        completionTokens,
        durationMs: 420,
        promptSnippet: prompt,
      });

      return NextResponse.json({ status: 'success', message: 'Simulated 1 normal iteration' });
    }

    if (mode === 'runaway_loop') {
      // Simulate an agent caught in an identical error loop
      const model = 'claude-3-5-sonnet-20241022';
      const repeatingPrompt = `[FATAL RUNAWAY LOOP SIMULATION] Error: Jest test failed at auth.test.ts:44. TypeError: Cannot read properties of undefined. Retrying fix iteration...`;

      const preflight = await governorEngine.preflightCheck({
        model,
        promptSnippet: repeatingPrompt,
        estimatedTokens: 1400,
      });

      if (preflight.action === 'kill') {
        return NextResponse.json({ status: 'killed', message: 'Governor killed session' });
      }

      governorEngine.recordCompletedRequest({
        provider: 'anthropic',
        model,
        endpoint: '/v1/messages',
        promptTokens: 1200,
        completionTokens: 350,
        durationMs: 250,
        promptSnippet: repeatingPrompt,
      });

      return NextResponse.json({ 
        status: 'simulated_loop_step',
        message: 'Fired loop step. Governor analyzed loop risk.' 
      });
    }

    if (mode === 'burst') {
      // Fire 5 rapid steps to spike speedometer
      const model = 'grok-2-1212';
      for (let i = 0; i < 4; i++) {
        const prompt = `Agent rapid subtask #${i + 1}: parallel search codebase for references to token governor.`;
        const preflight = await governorEngine.preflightCheck({
          model,
          promptSnippet: prompt,
          estimatedTokens: 1100,
        });

        if (preflight.action === 'kill') break;

        governorEngine.recordCompletedRequest({
          provider: 'xai',
          model,
          endpoint: '/v1/chat/completions',
          promptTokens: 1100,
          completionTokens: 280,
          durationMs: 180,
          promptSnippet: prompt,
        });
      }

      return NextResponse.json({ status: 'burst_completed', message: 'Fired rapid agent burst' });
    }

    return NextResponse.json({ error: 'Unknown simulation mode' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Simulation error' },
      { status: 500 }
    );
  }
}
