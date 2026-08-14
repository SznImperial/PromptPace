'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from '@/components/Navbar';
import { Speedometer } from '@/components/Speedometer';
import { TripOdometer } from '@/components/TripOdometer';
import { StripeShieldCard } from '@/components/StripeShieldCard';
import { ControlsPanel } from '@/components/ControlsPanel';
import { TelemetryFeed } from '@/components/TelemetryFeed';
import { AgentSimulator } from '@/components/AgentSimulator';
import { RefuelGateModal } from '@/components/RefuelGateModal';
import { GovernorTelemetryPayload, PromptPaceSession } from '@/lib/governor/types';
import { soundFX } from '@/lib/sound';

export default function PromptPaceMissionControl() {
  const [telemetry, setTelemetry] = useState<GovernorTelemetryPayload | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // 1. Initial State Hydration
  const fetchInitialState = useCallback(async () => {
    try {
      const res = await fetch('/api/governor/state');
      if (res.ok) {
        const data = await res.json();
        setTelemetry(data);
      }
    } catch (e) {
      console.warn('Initial state fetch error:', e);
    }
  }, []);

  // 2. Real-time SSE Connection
  useEffect(() => {
    fetchInitialState();

    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource('/api/governor/telemetry');

      eventSource.onopen = () => {
        setIsConnected(true);
      };

      eventSource.onmessage = (event) => {
        try {
          const data: GovernorTelemetryPayload = JSON.parse(event.data);
          setTelemetry(data);
        } catch (err) {
          console.error('Error parsing SSE telemetry:', err);
        }
      };

      eventSource.onerror = () => {
        setIsConnected(false);
      };
    } catch (e) {
      console.error('SSE initialization error:', e);
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [fetchInitialState]);

  // Handle user actions (Refuel, Pause, Resume, Kill, Throttle, Config Update)
  const sendGovernorAction = async (action: string, payload?: any) => {
    try {
      const res = await fetch('/api/governor/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.telemetry) {
          setTelemetry(data.telemetry);
        }
      }
    } catch (e) {
      console.error('Failed to send governor action:', e);
    }
  };

  const handleRefuel = (amount: number) => {
    if (soundEnabled) soundFX.playRefuelChime();
    sendGovernorAction('refuel', { amount });
  };

  const handleThrottle = () => {
    sendGovernorAction('throttle', { delayMs: 3000 });
  };

  const handleKill = () => {
    if (soundEnabled) soundFX.playKillBuzzer();
    sendGovernorAction('emergency_kill');
  };

  const handleResetTrip = () => {
    sendGovernorAction('reset_trip');
  };

  const handleUpdateBudget = (tripBudget: number) => {
    sendGovernorAction('update_config', { tripBudget });
  };

  const handleUpdateConfig = (config: Partial<PromptPaceSession>) => {
    sendGovernorAction('update_config', config);
  };

  const handleTogglePause = () => {
    if (!telemetry) return;
    if (telemetry.session.status === 'paused') {
      sendGovernorAction('resume');
    } else {
      sendGovernorAction('pause');
    }
  };

  const handleTriggerSimulate = async (mode: 'normal' | 'runaway_loop' | 'burst') => {
    await fetch('/api/governor/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  };

  if (!telemetry) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center text-neutral-400 gap-4 font-mono">
        <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        <span>Initializing PromptPace Governor Engine...</span>
      </div>
    );
  }

  const { session, speedometer, stripeShield, recentLogs, activeHold } = telemetry;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-300">
      {/* Interactive In-Flight Refuel Gate Modal */}
      <RefuelGateModal
        activeHold={activeHold}
        onRefuel={handleRefuel}
        onThrottle={handleThrottle}
        onKill={handleKill}
        soundEnabled={soundEnabled}
        onPlayAlarm={() => soundFX.playHoldAlarm()}
      />

      {/* Top Navbar */}
      <Navbar
        session={session}
        isConnected={isConnected}
        onReset={handleResetTrip}
        soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled(!soundEnabled)}
      />

      {/* Main Mission Control Cockpit */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
        
        {/* Row 1: Core Telemetry Gauges (Speedometer, Trip Odometer, Stripe Shield) */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Speedometer
            currentBurnRate={speedometer.currentBurnRate}
            maxBurnRate={speedometer.maxBurnRate}
            requestsPerMin={speedometer.requestsPerMin}
            tokensPerMin={speedometer.tokensPerMin}
            zone={speedometer.zone}
          />

          <TripOdometer
            session={session}
            onUpdateBudget={handleUpdateBudget}
          />

          <StripeShieldCard
            providerThreshold={stripeShield.providerThreshold}
            spentThisSession={stripeShield.spentThisSession}
            bufferRemaining={stripeShield.bufferRemaining}
            status={stripeShield.status}
            onUpdateProviderThreshold={(autoReloadThreshold) =>
              handleUpdateConfig({ autoReloadThreshold })
            }
          />
        </section>

        {/* Row 2: Governor Controls & Agent Flight Simulator */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ControlsPanel
            session={session}
            onUpdateConfig={handleUpdateConfig}
            onTogglePause={handleTogglePause}
          />

          <AgentSimulator
            onTriggerSimulate={handleTriggerSimulate}
            isHeld={Boolean(activeHold)}
          />
        </section>

        {/* Row 3: Live Agent Telemetry Feed */}
        <section>
          <TelemetryFeed logs={recentLogs} />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-neutral-900 bg-neutral-950 py-4 px-6 text-center text-xs font-mono text-neutral-500 flex flex-wrap items-center justify-between gap-4 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span>PromptPace Proxy running on <code className="text-neutral-300">http://localhost:3000/api/v1</code></span>
        </div>
        <div>
          Autonomous Agent Speed Governor &bull; Stripe Auto-Reload Shield
        </div>
      </footer>
    </div>
  );
}
