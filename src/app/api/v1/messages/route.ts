import { NextRequest, NextResponse } from 'next/server';
import { governorEngine } from '@/lib/governor/engine';

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const streamId = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const abortController = new AbortController();

  try {
    const body = await req.json();
    const model = body.model || 'claude-3-7-sonnet-20250219';
    const messages = body.messages || [];
    const isStream = Boolean(body.stream);

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

    // 1. Pre-flight check (Pre-authorized Trip Budget, Loop Breaker, Pacing)
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

    const apiKey = req.headers.get('x-api-key') || process.env.ANTHROPIC_API_KEY;

    // A. LIVE UPSTREAM FORWARDING
    if (apiKey && !apiKey.startsWith('mock-')) {
      governorEngine.registerStreamController(streamId, abortController);

      const upstreamRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': req.headers.get('anthropic-version') || '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!isStream) {
        governorEngine.unregisterStreamController(streamId);
        const responseData = await upstreamRes.json();
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

        return NextResponse.json(responseData, { status: upstreamRes.status });
      }

      // STREAMING MODE: Chunk-by-chunk token interception & mid-flight abort
      let accumulatedOutputTokens = 0;
      let promptTokensEstimated = 900;
      let hasAbortedMidFlight = false;

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
                provider: 'anthropic',
                model,
                endpoint: '/v1/messages',
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

            // Estimate tokens from chunk deltas
            const lines = chunkText.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                if (dataStr && dataStr !== '[DONE]') {
                  try {
                    const parsed = JSON.parse(dataStr);
                    if (parsed.type === 'message_start' && parsed.message?.usage?.input_tokens) {
                      promptTokensEstimated = parsed.message.usage.input_tokens;
                    }
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                      // ~4 characters per token estimate
                      accumulatedOutputTokens += Math.max(1, Math.ceil(parsed.delta.text.length / 4));
                    }
                    if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
                      accumulatedOutputTokens = parsed.usage.output_tokens;
                    }
                  } catch (e) {}
                }
              }
            }

            // Real-time Mid-Stream Limit Check
            const limitCheck = governorEngine.checkStreamLimit({
              model,
              promptTokens: promptTokensEstimated,
              currentOutputTokens: accumulatedOutputTokens,
            });

            if (limitCheck.shouldAbort && !hasAbortedMidFlight) {
              hasAbortedMidFlight = true;
              // 💥 Abort upstream HTTP socket immediately to cut off provider billing
              abortController.abort();

              // Inject graceful client termination chunk so agent CLI doesn't throw socket error
              const warningChunk = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\\n\\n🛑 [PromptPace Governor]: Mid-stream abort triggered. ${limitCheck.reason}"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
              controller.enqueue(encoder.encode(warningChunk));
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
        cancel() {
          abortController.abort();
          governorEngine.unregisterStreamController(streamId);
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // B. HIGH-FIDELITY SIMULATED RESPONSE (FOR ZERO-CONFIG DEV / TESTING)
    const simulatedPromptTokens = Math.floor(Math.random() * 400) + 600;
    const simulatedCompletionTokens = Math.floor(Math.random() * 250) + 150;
    const durationMs = Date.now() - startTime + 320;

    if (!isStream) {
      governorEngine.recordCompletedRequest({
        provider: 'anthropic',
        model,
        endpoint: '/v1/messages',
        promptTokens: simulatedPromptTokens,
        completionTokens: simulatedCompletionTokens,
        durationMs,
        promptSnippet: promptSnippet.slice(0, 120),
      });

      return NextResponse.json({
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
      });
    }

    // Simulated SSE Stream
    const encoder = new TextEncoder();
    const simulatedChunks = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_${Date.now()}","type":"message","role":"assistant","model":"${model}","usage":{"input_tokens":${simulatedPromptTokens},"output_tokens":1}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[PromptPace Live Stream] Executing agent iteration safely under governor supervision..."}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${simulatedCompletionTokens}}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];

    let chunkIndex = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunkIndex < simulatedChunks.length) {
          controller.enqueue(encoder.encode(simulatedChunks[chunkIndex]));
          chunkIndex++;
        } else {
          governorEngine.recordCompletedRequest({
            provider: 'anthropic',
            model,
            endpoint: '/v1/messages',
            promptTokens: simulatedPromptTokens,
            completionTokens: simulatedCompletionTokens,
            durationMs,
            isStreaming: true,
            promptSnippet: promptSnippet.slice(0, 120),
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
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
