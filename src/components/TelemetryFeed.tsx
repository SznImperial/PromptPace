'use client';

import React from 'react';
import { Activity, ShieldCheck, AlertCircle, ArrowUpRight, Clock, Hash } from 'lucide-react';
import { RequestLogEntry } from '@/lib/governor/types';

interface TelemetryFeedProps {
  logs: RequestLogEntry[];
}

export function TelemetryFeed({ logs }: TelemetryFeedProps) {
  const getProviderBadge = (provider: RequestLogEntry['provider']) => {
    switch (provider) {
      case 'anthropic':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/30">
            ANTHROPIC
          </span>
        );
      case 'xai':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
            xAI GROK
          </span>
        );
      case 'openai':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            OPENAI
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-neutral-800 text-neutral-300 border border-neutral-700">
            PROXY
          </span>
        );
    }
  };

  return (
    <div className="p-6 rounded-2xl bg-neutral-900/90 border border-neutral-800 shadow-xl backdrop-blur-sm flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-neutral-800 text-cyan-400">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Live Agent Telemetry</h3>
            <p className="text-[11px] text-neutral-400 font-mono">Intercepted Token Stream & Costs</p>
          </div>
        </div>

        <span className="text-xs font-mono text-neutral-500">
          Showing last {logs.length} calls
        </span>
      </div>

      {/* Log Feed List */}
      <div className="flex flex-col gap-2 max-h-[380px] overflow-y-auto pr-1">
        {logs.length === 0 ? (
          <div className="p-8 text-center rounded-xl bg-neutral-950/60 border border-dashed border-neutral-800 flex flex-col items-center justify-center gap-2">
            <Activity className="w-6 h-6 text-neutral-600 animate-pulse" />
            <p className="text-xs text-neutral-400 font-mono">
              Waiting for agent requests...
            </p>
            <p className="text-[11px] text-neutral-500 max-w-xs">
              Point your Claude Code, Grok, or Cursor agent to the PromptPace proxy or use the simulator below.
            </p>
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className="p-3 rounded-xl bg-neutral-950/80 border border-neutral-800/80 hover:border-neutral-700 transition-colors flex flex-col gap-2 text-xs"
            >
              {/* Row 1: Badges & Cost */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  {getProviderBadge(log.provider)}
                  <span className="font-mono text-neutral-300 font-medium truncate max-w-[150px] sm:max-w-[220px]">
                    {log.model}
                  </span>
                  {log.loopRiskScore >= 75 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse">
                      LOOP FLAGGED
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-emerald-400">
                    +${log.costUsd.toFixed(5)}
                  </span>
                </div>
              </div>

              {/* Row 2: Prompt snippet if available */}
              {log.promptSnippet && (
                <p className="text-[11px] text-neutral-400 font-mono truncate bg-neutral-900/60 px-2 py-1 rounded border border-neutral-800/50">
                  {log.promptSnippet}
                </p>
              )}

              {/* Row 3: Token breakdown & Latency */}
              <div className="flex items-center justify-between text-[10px] font-mono text-neutral-500">
                <div className="flex items-center gap-3">
                  <span>In: {log.promptTokens} tok</span>
                  <span>Out: {log.completionTokens} tok</span>
                  <span>Total: {log.totalTokens} tok</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3 text-neutral-600" />
                    {log.durationMs}ms
                  </span>
                  <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
