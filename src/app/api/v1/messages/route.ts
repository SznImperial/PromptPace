import { NextRequest, NextResponse } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await req.json();
    const model = body.model || 'claude-3-7-sonnet-20250219';
    const messages = body.messages || [];
    
    // Extract last message text snippet for loop detection
    let promptSnippet = '';
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (typeof lastMsg.content === 'string') {
        promptSnippet = lastMsg.content;
      } else if (Array.isArray(lastMsg.content)) {
        promptSnippet = lastMsg.content
          .map((c: any) => c.text || JSON.stringify(c))
          .join(' ');
      }
    }

    // 1. Pre-flight check (Budget limits, death-loop detector, throttle pacing, in-flight pause)
    const preflight = await governorEngine.preflightCheck({
      model,
      promptSnippet,
      estimatedTokens: 1200,
    });

    if (preflight.action === 'kill') {
      return NextResponse.json(
        {
          type: 'error',
          error: {
            type: 'promptpace_budget_limit_killed',
            message: '🛑 PromptPace Governor: Session halted or terminated by user in Mission Control.',
          },
        },
        { status: 402 }
      );
    }

    // Check upstream Anthropic API Key
    const apiKey = req.headers.get('x-api-key') || process.env.ANTHROPIC_API_KEY;

    // If live API key is present, forward upstream
    if (apiKey && !apiKey.startsWith('mock-')) {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': req.headers.get('anthropic-version') || '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const responseData = await anthropicRes.json();
      const durationMs = Date.now() - startTime;

      const promptTokens = responseData.usage?.input_tokens || 850;
      const completionTokens = responseData.usage?.output_tokens || 280;

      governorEngine.recordCompletedRequest({
        provider: 'anthropic',
        model,
        endpoint: '/v1/messages',
        promptTokens,
        completionTokens,
        durationMs,
        promptSnippet: promptSnippet.slice(0, 120),
      });

      return NextResponse.json(responseData, {
        status: anthropicRes.status,
      });
    }

    // Simulated high-fidelity Claude response for zero-config testing
    const simulatedPromptTokens = Math.floor(Math.random() * 400) + 600;
    const simulatedCompletionTokens = Math.floor(Math.random() * 250) + 150;
    const durationMs = Date.now() - startTime + 350;

    // Record usage in governor
    governorEngine.recordCompletedRequest({
      provider: 'anthropic',
      model,
      endpoint: '/v1/messages',
      promptTokens: simulatedPromptTokens,
      completionTokens: simulatedCompletionTokens,
      durationMs,
      promptSnippet: promptSnippet.slice(0, 120),
    });

    const mockResponse = {
      id: `msg_${Math.random().toString(36).substr(2, 16)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [
        {
          type: 'text',
          text: `[PromptPace Protected Proxy] Processed execution step for model ${model}. Agent state verified within safe budget boundaries.`,
        },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: simulatedPromptTokens,
        output_tokens: simulatedCompletionTokens,
      },
    };

    return NextResponse.json(mockResponse);
  } catch (error: any) {
    console.error('Error in PromptPace /v1/messages proxy:', error);
    return NextResponse.json(
      {
        type: 'error',
        error: {
          type: 'promptpace_proxy_error',
          message: error.message || 'Internal proxy error',
        },
      },
      { status: 500 }
    );
  }
}
