import {
  PromptPaceSession,
  RequestLogEntry,
  InFlightHold,
  GovernorTelemetryPayload,
  GovernorActionType,
} from './types';
import { calculateCostUsd } from './pricing';
import { LoopDetector } from './loopDetector';
import { persistLogToSupabase, persistSessionToSupabase } from '../supabase/client';

class GovernorEngine {
  private session: PromptPaceSession;
  private logs: RequestLogEntry[] = [];
  private activeHolds: Map<string, InFlightHold> = new Map();
  private loopDetector = new LoopDetector();
  private listeners: Set<(payload: GovernorTelemetryPayload) => void> = new Set();
  private spendHistory: Array<{ timestamp: number; cost: number; tokens: number }> = [];

  constructor() {
    this.session = {
      id: 'session-live-default',
      name: 'Agent Speed Shield Session',
      targetAgent: 'Claude Code (Anthropic) / xAI Grok',
      tripBudget: 2.00,
      spentAmount: 0.00,
      warningThresholdPct: 80,
      burnRateLimitPerMin: 0.50,
      currentBurnRatePerMin: 0.00,
      autoReloadThreshold: 10.00, // Provider auto-reloads at $10.00
      status: 'active',
      pacingDelayMs: 0,
      totalRequests: 0,
      totalTokens: 0,
      loopRiskScore: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  public getSession(): PromptPaceSession {
    this.updateBurnRate();
    return { ...this.session };
  }

  public getLogs(limit = 50): RequestLogEntry[] {
    return this.logs.slice(-limit).reverse();
  }

  public getActiveHold(): InFlightHold | null {
    if (this.activeHolds.size === 0) return null;
    const firstKey = this.activeHolds.keys().next().value;
    return firstKey ? this.activeHolds.get(firstKey) || null : null;
  }

  public getTelemetryPayload(): GovernorTelemetryPayload {
    this.updateBurnRate();
    const activeHold = this.getActiveHold();
    const maxBurn = this.session.burnRateLimitPerMin || 0.50;
    const currentBurn = this.session.currentBurnRatePerMin;

    let zone: 'safe' | 'caution' | 'danger' = 'safe';
    if (currentBurn >= maxBurn * 0.9) {
      zone = 'danger';
    } else if (currentBurn >= maxBurn * 0.65) {
      zone = 'caution';
    }

    const requestsLastMin = this.spendHistory.filter(
      (h) => Date.now() - h.timestamp < 60000
    ).length;

    const tokensLastMin = this.spendHistory
      .filter((h) => Date.now() - h.timestamp < 60000)
      .reduce((acc, curr) => acc + curr.tokens, 0);

    const bufferRemaining = Math.max(
      0,
      this.session.autoReloadThreshold - this.session.spentAmount
    );

    let shieldStatus: 'shield_active' | 'shield_engaged' | 'danger' = 'shield_active';
    if (this.session.spentAmount >= this.session.tripBudget) {
      shieldStatus = 'shield_engaged';
    } else if (bufferRemaining < 1.00) {
      shieldStatus = 'danger';
    }

    return {
      session: { ...this.session },
      recentLogs: this.getLogs(20),
      activeHold: activeHold ? activeHold.details : null,
      heldRequestId: activeHold ? activeHold.holdId : null,
      speedometer: {
        currentBurnRate: Number(currentBurn.toFixed(4)),
        maxBurnRate: Number(maxBurn.toFixed(4)),
        requestsPerMin: requestsLastMin,
        tokensPerMin: tokensLastMin,
        zone,
      },
      stripeShield: {
        providerThreshold: this.session.autoReloadThreshold,
        spentThisSession: Number(this.session.spentAmount.toFixed(4)),
        bufferRemaining: Number(bufferRemaining.toFixed(4)),
        status: shieldStatus,
      },
    };
  }

  public subscribe(listener: (payload: GovernorTelemetryPayload) => void): () => void {
    this.listeners.add(listener);
    // Emit initial payload immediately
    listener(this.getTelemetryPayload());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const payload = this.getTelemetryPayload();
    this.listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (err) {
        console.error('Error notifying telemetry listener:', err);
      }
    });
  }

  /**
   * Evaluates before sending request to AI provider.
   * If budget exceeded or loop detected, holds request in-flight.
   */
  public async preflightCheck(params: {
    model: string;
    promptSnippet: string;
    estimatedTokens?: number;
  }): Promise<{ action: 'proceed' | 'kill'; delayMs: number }> {
    // 1. Check Loop Detection
    const loopAnalysis = this.loopDetector.analyzeRequest(params.promptSnippet);
    this.session.loopRiskScore = loopAnalysis.riskScore;

    // 2. Check Throttle Pacing Delay
    const delayMs = this.session.pacingDelayMs;

    // 3. Check Session Status
    if (this.session.status === 'killed') {
      return { action: 'kill', delayMs: 0 };
    }

    const estimatedCost = calculateCostUsd(
      params.model,
      params.estimatedTokens || 1500,
      500
    );

    // 4. Budget Breaker Check
    const willExceedBudget =
      this.session.spentAmount + estimatedCost >= this.session.tripBudget;

    const shouldHold =
      willExceedBudget ||
      loopAnalysis.isLoopDetected ||
      this.session.status === 'held' ||
      this.session.status === 'paused';

    if (shouldHold) {
      let reason: InFlightHold['reason'] = 'trip_budget_exceeded';
      let message = `Trip budget ceiling of $${this.session.tripBudget.toFixed(2)} reached!`;

      if (loopAnalysis.isLoopDetected) {
        reason = 'death_loop_detected';
        message = `Autonomous loop detected: ${loopAnalysis.reason || 'Rapid repetitive prompts'}`;
      } else if (this.session.status === 'paused') {
        reason = 'manual_pause';
        message = 'Agent session manually paused by user.';
      }

      this.session.status = 'held';
      this.notifyListeners();

      // Return a Promise that holds execution in flight
      const holdResult = await this.createInFlightHold({
        reason,
        details: {
          spentAmount: this.session.spentAmount,
          tripBudget: this.session.tripBudget,
          model: params.model,
          estimatedCost,
          iterationCount: this.session.totalRequests + 1,
          message,
        },
      });

      return { action: holdResult, delayMs };
    }

    // Apply pacing delay if configured
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return { action: 'proceed', delayMs };
  }

  private createInFlightHold(params: {
    reason: InFlightHold['reason'];
    details: InFlightHold['details'];
  }): Promise<'proceed' | 'kill'> {
    return new Promise((resolve) => {
      const holdId = `hold_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const hold: InFlightHold = {
        holdId,
        sessionId: this.session.id,
        requestedAt: Date.now(),
        reason: params.reason,
        details: params.details,
        resolve: (action) => {
          this.activeHolds.delete(holdId);
          if (this.activeHolds.size === 0 && this.session.status === 'held') {
            this.session.status = 'active';
          }
          this.notifyListeners();
          resolve(action);
        },
      };

      this.activeHolds.set(holdId, hold);
      this.notifyListeners();
    });
  }

  /**
   * Records completed request metrics and updates odometer and burn rate
   */
  public recordCompletedRequest(params: {
    provider: RequestLogEntry['provider'];
    model: string;
    endpoint: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    promptSnippet?: string;
  }): RequestLogEntry {
    const cost = calculateCostUsd(
      params.model,
      params.promptTokens,
      params.completionTokens
    );

    const totalTokens = params.promptTokens + params.completionTokens;
    const now = Date.now();

    this.session.spentAmount = Number((this.session.spentAmount + cost).toFixed(6));
    this.session.totalRequests += 1;
    this.session.totalTokens += totalTokens;
    this.session.lastRequestTime = now;
    this.session.updatedAt = new Date().toISOString();

    // Check if auto-reload threshold reached
    if (this.session.spentAmount >= this.session.tripBudget) {
      this.session.status = 'exhausted';
    }

    // Add to rolling history for burn rate calculation
    this.spendHistory.push({
      timestamp: now,
      cost,
      tokens: totalTokens,
    });

    // Prune spend history older than 5 minutes
    this.spendHistory = this.spendHistory.filter((h) => now - h.timestamp < 300000);

    const logEntry: RequestLogEntry = {
      id: `log_${now}_${Math.random().toString(36).substr(2, 6)}`,
      sessionId: this.session.id,
      timestamp: new Date().toISOString(),
      provider: params.provider,
      model: params.model,
      endpoint: params.endpoint,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      totalTokens,
      costUsd: cost,
      durationMs: params.durationMs,
      status: 'completed',
      loopRiskScore: this.session.loopRiskScore,
      promptSnippet: params.promptSnippet,
    };

    this.logs.push(logEntry);
    if (this.logs.length > 200) {
      this.logs.shift();
    }

    // Persist asynchronously
    persistLogToSupabase(logEntry);
    persistSessionToSupabase(this.session);

    this.notifyListeners();
    return logEntry;
  }

  /**
   * Handles user actions from UI or Webhook
   */
  public handleAction(action: GovernorActionType, payload?: any): void {
    switch (action) {
      case 'refuel': {
        const addedAmount = Number(payload?.amount || 1.00);
        this.session.tripBudget = Number((this.session.tripBudget + addedAmount).toFixed(4));
        this.session.status = 'active';
        this.loopDetector.reset();
        this.session.loopRiskScore = 0;

        // Release any held requests
        this.activeHolds.forEach((hold) => {
          hold.resolve('proceed');
        });
        this.activeHolds.clear();
        break;
      }

      case 'pause': {
        this.session.status = 'paused';
        break;
      }

      case 'resume': {
        this.session.status = 'active';
        this.activeHolds.forEach((hold) => hold.resolve('proceed'));
        this.activeHolds.clear();
        break;
      }

      case 'throttle': {
        const delay = payload?.delayMs !== undefined ? Number(payload.delayMs) : 2500;
        this.session.pacingDelayMs = this.session.pacingDelayMs > 0 ? 0 : delay;
        break;
      }

      case 'emergency_kill': {
        this.session.status = 'killed';
        this.activeHolds.forEach((hold) => hold.resolve('kill'));
        this.activeHolds.clear();
        break;
      }

      case 'update_config': {
        if (payload?.tripBudget !== undefined) {
          this.session.tripBudget = Number(payload.tripBudget);
        }
        if (payload?.burnRateLimitPerMin !== undefined) {
          this.session.burnRateLimitPerMin = Number(payload.burnRateLimitPerMin);
        }
        if (payload?.autoReloadThreshold !== undefined) {
          this.session.autoReloadThreshold = Number(payload.autoReloadThreshold);
        }
        if (payload?.pacingDelayMs !== undefined) {
          this.session.pacingDelayMs = Number(payload.pacingDelayMs);
        }
        break;
      }

      case 'reset_trip': {
        this.session.spentAmount = 0.00;
        this.session.totalRequests = 0;
        this.session.totalTokens = 0;
        this.session.status = 'active';
        this.session.loopRiskScore = 0;
        this.spendHistory = [];
        this.loopDetector.reset();
        this.activeHolds.forEach((hold) => hold.resolve('proceed'));
        this.activeHolds.clear();
        break;
      }
    }

    persistSessionToSupabase(this.session);
    this.notifyListeners();
  }

  private updateBurnRate(): void {
    const now = Date.now();
    // Rolling 60-second window
    const recentSpends = this.spendHistory.filter(
      (entry) => now - entry.timestamp < 60000
    );

    const totalCostLastMin = recentSpends.reduce(
      (sum, entry) => sum + entry.cost,
      0
    );

    this.session.currentBurnRatePerMin = Number(totalCostLastMin.toFixed(4));
  }
}

// Global Singleton for in-memory state preservation in Next.js development and server runtime
const globalForGovernor = global as unknown as { promptPaceGovernor: GovernorEngine };
export const governorEngine = globalForGovernor.promptPaceGovernor || new GovernorEngine();
if (process.env.NODE_ENV !== 'production') {
  globalForGovernor.promptPaceGovernor = governorEngine;
}
