'use client';

import React, { useEffect } from 'react';
import { ShieldAlert, Zap, PauseCircle, XOctagon, Plus, Clock, AlertTriangle } from 'lucide-react';
import confetti from 'canvas-confetti';
import { InFlightHold } from '@/lib/governor/types';

interface RefuelGateModalProps {
  activeHold: InFlightHold['details'] | null;
  onRefuel: (amount: number) => void;
  onThrottle: () => void;
  onKill: () => void;
  soundEnabled: boolean;
  onPlayAlarm: () => void;
}

export function RefuelGateModal({
  activeHold,
  onRefuel,
  onThrottle,
  onKill,
  soundEnabled,
  onPlayAlarm,
}: RefuelGateModalProps) {
  useEffect(() => {
    if (activeHold && soundEnabled) {
      onPlayAlarm();
    }
  }, [activeHold, soundEnabled, onPlayAlarm]);

  if (!activeHold) return null;

  const handleRefuel = (amount: number) => {
    confetti({
      particleCount: 50,
      spread: 60,
      origin: { y: 0.6 },
    });
    onRefuel(amount);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl rounded-3xl bg-neutral-900 border-2 border-amber-500/80 p-6 md:p-8 shadow-2xl shadow-amber-500/20 flex flex-col gap-6">
        
        {/* Pulsing Alert Badge */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse">
              <ShieldAlert className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                  IN-FLIGHT REQUEST HELD
                </span>
                <span className="text-xs text-neutral-400 font-mono">Iteration #{activeHold.iterationCount}</span>
              </div>
              <h2 className="text-xl font-extrabold text-white mt-1">
                Refuel Gate Interception
              </h2>
            </div>
          </div>
        </div>

        {/* Reason Banner */}
        <div className="p-4 rounded-2xl bg-neutral-950 border border-neutral-800 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-amber-400 text-sm font-semibold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{activeHold.message}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-neutral-800 text-xs font-mono">
            <div>
              <span className="text-neutral-500">Model</span>
              <p className="text-neutral-200 font-medium truncate">{activeHold.model}</p>
            </div>
            <div>
              <span className="text-neutral-500">Total Spent</span>
              <p className="text-amber-400 font-bold">${activeHold.spentAmount.toFixed(4)}</p>
            </div>
            <div>
              <span className="text-neutral-500">Trip Limit</span>
              <p className="text-neutral-200 font-bold">${activeHold.tripBudget.toFixed(2)}</p>
            </div>
          </div>
        </div>

        <p className="text-xs text-neutral-300 leading-relaxed">
          The autonomous agent loop has been cleanly suspended mid-request without losing memory or file states. Authorize additional fuel to proceed or terminate the run immediately.
        </p>

        {/* Refuel Actions */}
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono font-medium text-neutral-400 uppercase tracking-wider">
            Authorize Refuel & Resume:
          </span>

          <div className="grid grid-cols-3 gap-3">
            {[0.50, 1.00, 2.00].map((amt) => (
              <button
                key={amt}
                onClick={() => handleRefuel(amt)}
                className="flex items-center justify-center gap-1.5 py-3 px-4 rounded-xl bg-gradient-to-b from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white font-bold text-sm shadow-lg shadow-emerald-500/25 transition-all active:scale-95 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                +${amt.toFixed(2)}
              </button>
            ))}
          </div>
        </div>

        {/* Safety Options: Throttle or Emergency Kill */}
        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-neutral-800">
          <button
            onClick={onThrottle}
            className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium border border-neutral-700 transition-colors cursor-pointer"
          >
            <Clock className="w-4 h-4 text-cyan-400" />
            Throttle Pace (+3s delays)
          </button>

          <button
            onClick={onKill}
            className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs font-bold border border-red-500/40 transition-colors cursor-pointer"
          >
            <XOctagon className="w-4 h-4 text-red-400" />
            Emergency Kill Session
          </button>
        </div>
      </div>
    </div>
  );
}
