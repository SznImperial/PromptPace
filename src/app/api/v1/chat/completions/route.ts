import { NextRequest, NextResponse } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await req.json();
    const model = body.model || 'grok-2-1212';
    const messages = body.messages || [];

    // Extract prompt snippet
    let promptSnippet = '';
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      promptSnippet = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
    }

    const isXai = model.toLowerCase().includes('grok') || req.headers.get('host')?.includes('xai');
    const provider = isXai ? 'xai' : 'openai';

    // 1. Pre-flight check
    const preflight = await governorEngine.preflightCheck({
      model,
      promptSnippet,
      estimatedTokens: 1000,
    });

    if (preflight.action === 'kill') {
      return NextResponse.json(
        {
          error: {
            message: '🛑 PromptPace Governor: Session halted or terminated by user in Mission Control.',
            type: 'promptpace_budget_limit_killed',
            code: 402,
          },
        },
        { status: 402 }
      );
    }

    // Check upstream authorization
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader ? authHeader.replace('Bearer ', '') : (isXai ? process.env.XAI_API_KEY : process.env.OPENAI_API_KEY);

    if (apiKey && !apiKey.startsWith('mock-')) {
      const upstreamUrl = isXai
        ? 'https://api.x.ai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';

      const upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const responseData = await upstreamRes.json();
      const durationMs = Date.now() - startTime;

      const promptTokens = responseData.usage?.prompt_tokens || 700;
      const completionTokens = responseData.usage?.completion_tokens || 200;

      governorEngine.recordCompletedRequest({
        provider,
        model,
        endpoint: '/v1/chat/completions',
        promptTokens,
        completionTokens,
        durationMs,
        promptSnippet: promptSnippet.slice(0, 120),
      });

      return NextResponse.json(responseData, {
        status: upstreamRes.status,
      });
    }

    // Simulated response for immediate zero-config testing
    const simulatedPromptTokens = Math.floor(Math.random() * 300) + 500;
    const simulatedCompletionTokens = Math.floor(Math.random() * 200) + 120;
    const durationMs = Date.now() - startTime + 280;

    governorEngine.recordCompletedRequest({
      provider,
      model,
      endpoint: '/v1/chat/completions',
      promptTokens: simulatedPromptTokens,
      completionTokens: simulatedCompletionTokens,
      durationMs,
      promptSnippet: promptSnippet.slice(0, 120),
    });

    const mockResponse = {
      id: `chatcmpl-${Math.random().toString(36).substr(2, 16)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `[PromptPace Protected Proxy] Response generated safely under governor supervision. Model: ${model}`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: simulatedPromptTokens,
        completion_tokens: simulatedCompletionTokens,
        total_tokens: simulatedPromptTokens + simulatedCompletionTokens,
      },
    };

    return NextResponse.json(mockResponse);
  } catch (error: any) {
    console.error('Error in PromptPace /v1/chat/completions proxy:', error);
    return NextResponse.json(
      {
        error: {
          message: error.message || 'Internal proxy error',
          type: 'promptpace_proxy_error',
        },
      },
      { status: 500 }
    );
  }
}
