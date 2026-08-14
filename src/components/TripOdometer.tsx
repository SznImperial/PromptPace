'use client';

import React from 'react';
import { DollarSign, ShieldAlert, Cpu, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { PromptPaceSession } from '@/lib/governor/types';

interface TripOdometerProps {
  session: PromptPaceSession;
  onUpdateBudget: (newBudget: number) => void;
}

export function TripOdometer({ session, onUpdateBudget }: TripOdometerProps) {
  const percentage = Math.min(100, (session.spentAmount / session.tripBudget) * 100);
  const remaining = Math.max(0, session.tripBudget - session.spentAmount);

  const getProgressColor = () => {
    if (percentage >= 95) return 'bg-red-500 shadow-red-500/50';
    if (percentage >= session.warningThresholdPct) return 'bg-amber-500 shadow-amber-500/50';
    return 'bg-emerald-500 shadow-emerald-500/50';
  };

  return (
    <div className="flex flex-col justify-between p-6 rounded-2xl bg-neutral-900/90 border border-neutral-800 shadow-xl backdrop-blur-sm">
      {/* Top Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-neutral-800 text-cyan-400">
            <DollarSign className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Trip Odometer</h3>
            <p className="text-[11px] text-neutral-400 font-mono">Pre-Flight Budget Guardrail</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono text-neutral-400">Cap:</span>
          <div className="flex gap-1">
            {[1, 2, 5, 10].map((amt) => (
              <button
                key={amt}
                onClick={() => onUpdateBudget(amt)}
                className={`px-2 py-0.5 rounded text-xs font-mono transition-all ${
                  session.tripBudget === amt
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 font-bold'
                    : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200 border border-transparent'
                }`}
              >
                ${amt}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Numbers: Spent vs Limit */}
      <div className="my-6">
        <div className="flex items-baseline justify-between mb-2">
          <div className="flex flex-col">
            <span className="text-xs text-neutral-400 font-medium">Session Spent</span>
            <div className="text-4xl font-extrabold font-mono tracking-tight text-white flex items-baseline gap-1">
              <span>${session.spentAmount.toFixed(4)}</span>
            </div>
          </div>

          <div className="flex flex-col items-end">
            <span className="text-xs text-neutral-400 font-medium">Trip Ceiling</span>
            <div className="text-2xl font-bold font-mono text-neutral-300">
              ${session.tripBudget.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Progress Bar with Warning Tick */}
        <div className="relative w-full h-3.5 bg-neutral-950 rounded-full overflow-hidden border border-neutral-800 p-0.5">
          {/* Warning marker notch at 80% */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-amber-500/80 z-10"
            style={{ left: `${session.warningThresholdPct}%` }}
            title={`Warning Threshold (${session.warningThresholdPct}%)`}
          />

          <div
            className={`h-full rounded-full transition-all duration-500 ${getProgressColor()} shadow-md`}
            style={{ width: `${percentage}%` }}
          />
        </div>

        {/* Sub-label for progress */}
        <div className="flex justify-between items-center mt-2 text-xs font-mono">
          <span className="text-neutral-400">
            {percentage.toFixed(1)}% consumed
          </span>
          <span className="text-emerald-400 font-semibold">
            ${remaining.toFixed(4)} remaining
          </span>
        </div>
      </div>

      {/* Stats Bottom Bar */}
      <div className="grid grid-cols-3 gap-2 pt-4 border-t border-neutral-800/80">
        <div className="p-2.5 rounded-xl bg-neutral-950/60 border border-neutral-800 flex flex-col">
          <span className="text-[10px] text-neutral-400 font-medium">Total Requests</span>
          <span className="text-base font-bold font-mono text-neutral-200 mt-0.5">
            {session.totalRequests}
          </span>
        </div>

        <div className="p-2.5 rounded-xl bg-neutral-950/60 border border-neutral-800 flex flex-col">
          <span className="text-[10px] text-neutral-400 font-medium">Total Tokens</span>
          <span className="text-base font-bold font-mono text-neutral-200 mt-0.5">
            {session.totalTokens > 1000 ? `${(session.totalTokens / 1000).toFixed(1)}k` : session.totalTokens}
          </span>
        </div>

        <div className="p-2.5 rounded-xl bg-neutral-950/60 border border-neutral-800 flex flex-col">
          <span className="text-[10px] text-neutral-400 font-medium">Loop Risk</span>
          <div className="flex items-center gap-1 mt-0.5">
            {session.loopRiskScore >= 75 ? (
              <span className="text-sm font-bold font-mono text-red-400 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> {session.loopRiskScore}%
              </span>
            ) : session.loopRiskScore >= 40 ? (
              <span className="text-sm font-bold font-mono text-amber-400 flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400" /> {session.loopRiskScore}%
              </span>
            ) : (
              <span className="text-sm font-bold font-mono text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Safe
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
