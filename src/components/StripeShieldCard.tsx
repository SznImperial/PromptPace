'use client';

import React from 'react';
import { CreditCard, ShieldCheck, AlertOctagon, HelpCircle } from 'lucide-react';

interface StripeShieldProps {
  providerThreshold: number; // e.g. $10.00
  spentThisSession: number;
  bufferRemaining: number;
  status: 'shield_active' | 'shield_engaged' | 'danger';
  onUpdateProviderThreshold: (threshold: number) => void;
}

export function StripeShieldCard({
  providerThreshold,
  spentThisSession,
  bufferRemaining,
  status,
  onUpdateProviderThreshold,
}: StripeShieldProps) {
  return (
    <div className="p-6 rounded-2xl bg-neutral-900/90 border border-neutral-800 shadow-xl backdrop-blur-sm flex flex-col justify-between">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-neutral-800 text-purple-400">
            <CreditCard className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Stripe Card Shield</h3>
            <p className="text-[11px] text-neutral-400 font-mono">Auto-Debit Prevention Barrier</p>
          </div>
        </div>

        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-purple-500/10 text-purple-300 border border-purple-500/30">
          <ShieldCheck className="w-3.5 h-3.5" /> CARD PROTECTED
        </span>
      </div>

      {/* Main Buffer Calculation */}
      <div className="my-5 p-4 rounded-xl bg-neutral-950/80 border border-neutral-800">
        <div className="flex justify-between items-start">
          <div>
            <span className="text-xs text-neutral-400">Safe Margin to Provider Auto-Reload</span>
            <div className="text-2xl font-bold font-mono text-emerald-400 mt-0.5">
              ${bufferRemaining.toFixed(2)}
            </div>
          </div>

          <div className="text-right">
            <span className="text-xs text-neutral-400">Card Reload Trigger</span>
            <div className="text-sm font-mono text-neutral-300 mt-1">
              ${providerThreshold.toFixed(2)} pool
            </div>
          </div>
        </div>

        <p className="text-[11px] text-neutral-400 mt-3 leading-relaxed">
          Autonomous loop cutoffs are enforced locally in PromptPace so your Anthropic/xAI balance never drops below the provider trigger, preventing silent card charges.
        </p>
      </div>

      {/* Adjust Provider Trigger */}
      <div className="flex items-center justify-between pt-3 border-t border-neutral-800/80 text-xs font-mono">
        <span className="text-neutral-400">Provider Reload Trigger:</span>
        <div className="flex gap-1.5">
          {[5, 10, 20, 50].map((val) => (
            <button
              key={val}
              onClick={() => onUpdateProviderThreshold(val)}
              className={`px-2 py-1 rounded text-xs transition-colors ${
                providerThreshold === val
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 font-bold'
                  : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              ${val}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
