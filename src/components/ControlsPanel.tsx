'use client';

import React, { useState } from 'react';
import { Sliders, Copy, Check, Terminal, Play, Pause, Gauge, Shield, Database } from 'lucide-react';
import { PromptPaceSession } from '@/lib/governor/types';

interface ControlsPanelProps {
  session: PromptPaceSession;
  onUpdateConfig: (config: Partial<PromptPaceSession>) => void;
  onTogglePause: () => void;
}

export function ControlsPanel({ session, onUpdateConfig, onTogglePause }: ControlsPanelProps) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const isPaused = session.status === 'paused';

  return (
    <div className="p-6 rounded-2xl bg-neutral-900/90 border border-neutral-800 shadow-xl backdrop-blur-sm flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-neutral-800 text-emerald-400">
            <Sliders className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Governor Controls</h3>
            <p className="text-[11px] text-neutral-400 font-mono">Real-Time Pacing & Proxy Config</p>
          </div>
        </div>

        <button
          onClick={onTogglePause}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            isPaused
              ? 'bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold shadow-lg shadow-emerald-500/20'
              : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40'
          }`}
        >
          {isPaused ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
          {isPaused ? 'Resume Session' : 'Pause All Agents'}
        </button>
      </div>

      {/* Burn Rate Speed Limit Slider */}
      <div className="flex flex-col gap-2 p-4 rounded-xl bg-neutral-950/80 border border-neutral-800">
        <div className="flex items-center justify-between text-xs">
          <span className="text-neutral-300 font-medium flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-emerald-400" /> Max Burn-Rate Ceiling
          </span>
          <span className="font-mono font-bold text-emerald-400">
            ${session.burnRateLimitPerMin.toFixed(2)} / min
          </span>
        </div>

        <input
          type="range"
          min="0.10"
          max="2.00"
          step="0.05"
          value={session.burnRateLimitPerMin}
          onChange={(e) =>
            onUpdateConfig({ burnRateLimitPerMin: parseFloat(e.target.value) })
          }
          className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-emerald-400"
        />

        <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
          <span>$0.10/min (Ultra-frugal)</span>
          <span>$0.50/min (Standard)</span>
          <span>$2.00/min (Unrestricted)</span>
        </div>
      </div>

      {/* Pacing Delay Slider */}
      <div className="flex flex-col gap-2 p-4 rounded-xl bg-neutral-950/80 border border-neutral-800">
        <div className="flex items-center justify-between text-xs">
          <span className="text-neutral-300 font-medium">Deliberate Throttle Delay</span>
          <span className="font-mono font-bold text-cyan-400">
            {(session.pacingDelayMs / 1000).toFixed(1)}s per call
          </span>
        </div>

        <input
          type="range"
          min="0"
          max="5000"
          step="500"
          value={session.pacingDelayMs}
          onChange={(e) =>
            onUpdateConfig({ pacingDelayMs: parseInt(e.target.value, 10) })
          }
          className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />

        <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
          <span>0s (Machine speed)</span>
          <span>2.5s (Safe pacing)</span>
          <span>5.0s (Max throttle)</span>
        </div>
      </div>

      {/* Copyable Developer Proxy Setup */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-neutral-400 font-mono">
          <span className="flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-neutral-400" /> CLI Integration
          </span>
          <span className="text-[10px] text-neutral-500">Run in your terminal</span>
        </div>

        <div className="flex flex-col gap-2 font-mono text-xs">
          {[
            {
              label: 'Claude Code Setup',
              cmd: 'export ANTHROPIC_BASE_URL="http://localhost:3000/api/v1"',
            },
            {
              label: 'OpenAI / xAI Grok Setup',
              cmd: 'export OPENAI_BASE_URL="http://localhost:3000/api/v1"',
            },
          ].map((item, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-950 border border-neutral-800/80 group hover:border-neutral-700 transition-colors"
            >
              <div className="flex flex-col truncate pr-2">
                <span className="text-[10px] text-neutral-500 font-sans">{item.label}</span>
                <span className="text-neutral-300 truncate text-[11px]">{item.cmd}</span>
              </div>
              <button
                onClick={() => copyToClipboard(item.cmd, idx)}
                className="p-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-800 transition-all shrink-0 cursor-pointer"
                title="Copy command"
              >
                {copiedIndex === idx ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
