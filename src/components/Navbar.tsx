'use client';

import React from 'react';
import { Shield, Activity, Zap, Terminal, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { PromptPaceSession } from '@/lib/governor/types';

interface NavbarProps {
  session: PromptPaceSession;
  isConnected: boolean;
  onReset: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
}

export function Navbar({ session, isConnected, onReset, soundEnabled, onToggleSound }: NavbarProps) {
  const getStatusBadge = () => {
    switch (session.status) {
      case 'active':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 animate-pulse">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            GOVERNOR ACTIVE
          </span>
        );
      case 'held':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30 animate-bounce">
            <span className="w-2 h-2 rounded-full bg-amber-400"></span>
            REQUEST HELD IN-FLIGHT
          </span>
        );
      case 'paused':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
            <span className="w-2 h-2 rounded-full bg-blue-400"></span>
            PAUSED
          </span>
        );
      case 'exhausted':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/30">
            <span className="w-2 h-2 rounded-full bg-red-400"></span>
            TRIP BUDGET REACHED
          </span>
        );
      case 'killed':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-neutral-800 text-neutral-400 border border-neutral-700">
            <span className="w-2 h-2 rounded-full bg-neutral-400"></span>
            KILLED
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <header className="sticky top-0 z-30 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-md px-4 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
      {/* Brand Identity */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-emerald-500/20 text-white font-bold">
          <Zap className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-1.5">
              Prompt<span className="text-emerald-400">Pace</span>
            </h1>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300 font-medium">
              v1.0 MVP
            </span>
          </div>
          <p className="text-xs text-neutral-400">
            Autonomous Agent Speed Governor & Stripe Card Shield
          </p>
        </div>
      </div>

      {/* Middle Status Indicators */}
      <div className="flex items-center gap-3">
        {getStatusBadge()}

        {session.pacingDelayMs > 0 && (
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
            🐢 Throttle: +{(session.pacingDelayMs / 1000).toFixed(1)}s delay
          </span>
        )}

        <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-400 px-2.5 py-1 rounded-md bg-neutral-900 border border-neutral-800">
          <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {isConnected ? 'LIVE TELEMETRY' : 'CONNECTING...'}
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleSound}
          title={soundEnabled ? 'Mute Alert Sound' : 'Enable Alert Sound'}
          className={`p-2 rounded-lg border transition-colors ${
            soundEnabled
              ? 'bg-neutral-900 border-neutral-700 text-neutral-200 hover:bg-neutral-800'
              : 'bg-neutral-900/50 border-neutral-800 text-neutral-500 hover:text-neutral-300'
          }`}
        >
          {soundEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4" />}
        </button>

        <button
          onClick={onReset}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-xs font-medium text-neutral-200 transition-all active:scale-95"
        >
          <RefreshCw className="w-3.5 h-3.5 text-neutral-400" />
          Reset Trip
        </button>
      </div>
    </header>
  );
}
