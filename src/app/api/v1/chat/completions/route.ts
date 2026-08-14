import { NextRequest, NextResponse } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const streamId = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const abortController = new AbortController();

  try {
    const body = await req.json();
    const model = body.model || 'grok-2-1212';
    const messages = body.messages || [];
    const isStream = Boolean(body.stream);

    // Extract prompt snippet for loop detection
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

    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader
      ? authHeader.replace('Bearer ', '')
      : isXai
      ? process.env.XAI_API_KEY
      : process.env.OPENAI_API_KEY;

    // A. LIVE FORWARDING
    if (apiKey && !apiKey.startsWith('mock-')) {
      governorEngine.registerStreamController(streamId, abortController);

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
        signal: abortController.signal,
      });

      if (!isStream) {
        governorEngine.unregisterStreamController(streamId);
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

        return NextResponse.json(responseData, { status: upstreamRes.status });
      }

      // STREAMING MODE: Chunk-by-chunk token interception & strict OpenAI SDK protocol compliance
      let accumulatedOutputTokens = 0;
      let promptTokensEstimated = 750;
      let hasAbortedMidFlight = false;
      const completionId = `chatcmpl-${Date.now()}`;

      const upstreamBody = upstreamRes.body;
      if (!upstreamBody) {
        governorEngine.unregisterStreamController(streamId);
        return new Response('No upstream stream body', { status: 502 });
      }

      const reader = upstreamBody.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();

            if (done || hasAbortedMidFlight) {
              governorEngine.unregisterStreamController(streamId);
              governorEngine.recordCompletedRequest({
                provider,
                model,
                endpoint: '/v1/chat/completions',
                promptTokens: promptTokensEstimated,
                completionTokens: accumulatedOutputTokens,
                durationMs: Date.now() - startTime,
                isStreaming: true,
                status: hasAbortedMidFlight ? 'aborted_mid_stream' : 'completed',
                promptSnippet: promptSnippet.slice(0, 120),
              });
              controller.close();
              return;
            }

            const chunkText = decoder.decode(value, { stream: true });
            const lines = chunkText.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                if (dataStr && dataStr !== '[DONE]') {
                  try {
                    const parsed = JSON.parse(dataStr);
                    if (parsed.usage?.prompt_tokens) {
                      promptTokensEstimated = parsed.usage.prompt_tokens;
                    }
                    if (parsed.usage?.completion_tokens) {
                      accumulatedOutputTokens = parsed.usage.completion_tokens;
                    } else if (parsed.choices?.[0]?.delta?.content) {
                      accumulatedOutputTokens += Math.max(1, Math.ceil(parsed.choices[0].delta.content.length / 4));
                    }
                  } catch (e) {}
                }
              }
            }

            const limitCheck = governorEngine.checkStreamLimit({
              model,
              promptTokens: promptTokensEstimated,
              currentOutputTokens: accumulatedOutputTokens,
            });

            if (limitCheck.shouldAbort && !hasAbortedMidFlight) {
              hasAbortedMidFlight = true;

              // 💥 Step 1: Explicitly cancel stream reader & abort upstream TCP socket immediately
              try {
                await reader.cancel('promptpace_budget_limit_severed');
              } catch (e) {}
              abortController.abort();
              governorEngine.unregisterStreamController(streamId);

              // 🛡️ Step 2: Inject strict 3-chunk OpenAI SDK protocol sequence
              const warningMsg = `\n\n🛑 [PromptPace Governor]: Mid-stream abort triggered. ${limitCheck.reason}`;
              
              // 1. Text delta chunk
              const deltaChunk = `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: warningMsg },
                    finish_reason: null,
                  },
                ],
              })}\n\n`;

              // 2. Finish reason: "length" chunk
              const stopChunk = `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'length',
                  },
                ],
              })}\n\n`;

              // 3. Terminal [DONE] chunk
              const doneChunk = `data: [DONE]\n\n`;

              const fullAbortPayload = deltaChunk + stopChunk + doneChunk;
              controller.enqueue(encoder.encode(fullAbortPayload));
              controller.close();
              return;
            }

            controller.enqueue(value);
          } catch (streamErr: any) {
            governorEngine.unregisterStreamController(streamId);
            if (!hasAbortedMidFlight) {
              controller.error(streamErr);
            } else {
              controller.close();
            }
          }
        },
        async cancel() {
          try {
            await reader.cancel('client_disconnected');
          } catch (e) {}
          abortController.abort();
          governorEngine.unregisterStreamController(streamId);
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

    // B. SIMULATED RESPONSE
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
