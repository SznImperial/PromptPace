'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Play, Flame, AlertOctagon, RefreshCw, Bot, Sparkles, StopCircle } from 'lucide-react';

interface AgentSimulatorProps {
  onTriggerSimulate: (mode: 'normal' | 'runaway_loop' | 'burst') => Promise<void>;
  isHeld: boolean;
}

export function AgentSimulator({ onTriggerSimulate, isHeld }: AgentSimulatorProps) {
  const [loadingMode, setLoadingMode] = useState<string | null>(null);
  const [isContinuous, setIsContinuous] = useState(false);
  const continuousTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleSimulate = async (mode: 'normal' | 'runaway_loop' | 'burst') => {
    setLoadingMode(mode);
    try {
      await onTriggerSimulate(mode);
    } finally {
      setLoadingMode(null);
    }
  };

  // Continuous loop handler
  useEffect(() => {
    if (isContinuous && !isHeld) {
      continuousTimerRef.current = setInterval(() => {
        onTriggerSimulate('normal');
      }, 1800);
    } else {
      if (continuousTimerRef.current) {
        clearInterval(continuousTimerRef.current);
      }
    }

    return () => {
      if (continuousTimerRef.current) {
        clearInterval(continuousTimerRef.current);
      }
    };
  }, [isContinuous, isHeld, onTriggerSimulate]);

  return (
    <div className="p-6 rounded-2xl bg-neutral-900/90 border border-neutral-800 shadow-xl backdrop-blur-sm flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-neutral-800 text-purple-400">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Agent Flight Simulator</h3>
            <p className="text-[11px] text-neutral-400 font-mono">Test Governor & Circuit Breakers</p>
          </div>
        </div>

        <button
          onClick={() => setIsContinuous(!isContinuous)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            isContinuous
              ? 'bg-red-500/20 text-red-300 border border-red-500/40 animate-pulse'
              : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
          }`}
        >
          {isContinuous ? (
            <>
              <StopCircle className="w-3.5 h-3.5 text-red-400" /> Stop Continuous Run
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 text-emerald-400" /> Continuous Auto-Agent
            </>
          )}
        </button>
      </div>

      <p className="text-xs text-neutral-400 leading-relaxed">
        Test how PromptPace intercepts agent spend in real-time before connecting your live Claude Code or xAI CLI.
      </p>

      {/* Simulator Action Buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Normal Iteration */}
        <button
          disabled={loadingMode !== null || isHeld}
          onClick={() => handleSimulate('normal')}
          className="flex flex-col items-start p-3.5 rounded-xl bg-neutral-950/80 border border-neutral-800 hover:border-emerald-500/50 transition-all text-left group disabled:opacity-50 cursor-pointer"
        >
          <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-semibold mb-1">
            <Sparkles className="w-3.5 h-3.5" />
            Normal Agent Step
          </div>
          <span className="text-[11px] text-neutral-400 leading-tight">
            Fires 1 standard coding iteration with Claude 3.7 Sonnet.
          </span>
        </button>

        {/* Runaway Loop Simulator */}
        <button
          disabled={loadingMode !== null || isHeld}
          onClick={() => handleSimulate('runaway_loop')}
          className="flex flex-col items-start p-3.5 rounded-xl bg-neutral-950/80 border border-neutral-800 hover:border-amber-500/50 transition-all text-left group disabled:opacity-50 cursor-pointer"
        >
          <div className="flex items-center gap-1.5 text-amber-400 text-xs font-semibold mb-1">
            <AlertOctagon className="w-3.5 h-3.5" />
            Runaway Death Loop
          </div>
          <span className="text-[11px] text-neutral-400 leading-tight">
            Fires repeating error traces to trigger the Loop Breaker.
          </span>
        </button>

        {/* High Speed Burst */}
        <button
          disabled={loadingMode !== null || isHeld}
          onClick={() => handleSimulate('burst')}
          className="flex flex-col items-start p-3.5 rounded-xl bg-neutral-950/80 border border-neutral-800 hover:border-red-500/50 transition-all text-left group disabled:opacity-50 cursor-pointer"
        >
          <div className="flex items-center gap-1.5 text-red-400 text-xs font-semibold mb-1">
            <Flame className="w-3.5 h-3.5" />
            High-Speed Burst
          </div>
          <span className="text-[11px] text-neutral-400 leading-tight">
            Fires rapid parallel queries to test burn-rate speedometer.
          </span>
        </button>
      </div>
    </div>
  );
}
