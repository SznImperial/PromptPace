export type SessionStatus = 'active' | 'held' | 'paused' | 'exhausted' | 'killed' | 'completed';

export type RuleType = 'max_spend' | 'burn_rate_spike' | 'death_loop' | 'auto_reload_buffer';

export interface PromptPaceSession {
  id: string;
  name: string;
  targetAgent: string; // e.g. 'Claude Code', 'xAI Grok Agent', 'Cursor Agent', 'Devin'
  tripBudget: number; // e.g. $2.00
  spentAmount: number; // e.g. $0.45
  warningThresholdPct: number; // e.g. 80% ($1.60)
  burnRateLimitPerMin: number; // e.g. $0.50/min
  currentBurnRatePerMin: number; // live calculated $/min
  autoReloadThreshold: number; // e.g. $10.00 (configured reload trigger)
  providerMonthlyLimit?: number; // e.g. $100.00 (hard monthly limit)
  status: SessionStatus;
  pacingDelayMs: number; // injected delay for throttle mode (e.g. 2500ms)
  totalRequests: number;
  totalTokens: number;
  loopRiskScore: number; // 0 - 100
  lastRequestTime?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequestLogEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: 'anthropic' | 'openai' | 'xai' | 'deepseek' | 'mock';
  model: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  status: 'completed' | 'held' | 'throttled' | 'aborted_mid_stream' | 'rejected' | 'failed';
  isStreaming?: boolean;
  loopRiskScore: number;
  promptSnippet?: string;
  errorSignature?: string;
}

export interface InFlightHold {
  holdId: string;
  sessionId: string;
  requestedAt: number;
  reason: 'trip_budget_exceeded' | 'warning_threshold_reached' | 'burn_rate_spike' | 'death_loop_detected' | 'manual_pause' | 'mid_stream_budget_breach';
  details: {
    spentAmount: number;
    tripBudget: number;
    model: string;
    estimatedCost: number;
    iterationCount: number;
    message: string;
  };
  resolve: (action: 'proceed' | 'kill') => void;
}

export interface GovernorTelemetryPayload {
  session: PromptPaceSession;
  recentLogs: RequestLogEntry[];
  activeHold: InFlightHold['details'] | null;
  heldRequestId: string | null;
  speedometer: {
    currentBurnRate: number; // $/min
    maxBurnRate: number;
    requestsPerMin: number;
    tokensPerMin: number;
    zone: 'safe' | 'caution' | 'danger';
  };
  providerShield: {
    autoReloadThreshold: number;
    spentThisSession: number;
    bufferRemaining: number;
    monthlyLimit?: number;
    status: 'shield_active' | 'shield_engaged' | 'danger';
  };
}

export type GovernorActionType = 
  | 'refuel'
  | 'pause'
  | 'resume'
  | 'throttle'
  | 'emergency_kill'
  | 'update_config'
  | 'reset_trip';
