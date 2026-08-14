import fs from 'fs';
import path from 'path';
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

const CACHE_FILE_PATH = path.join(process.cwd(), '.promptpace-cache.json');

class GovernorEngine {
  private session: PromptPaceSession;
  private logs: RequestLogEntry[] = [];
  private activeHolds: Map<string, InFlightHold> = new Map();
  private loopDetector = new LoopDetector();
  private listeners: Set<(payload: GovernorTelemetryPayload) => void> = new Set();
  private spendHistory: Array<{ timestamp: number; cost: number; tokens: number }> = [];
  private activeStreamControllers: Map<string, AbortController> = new Map();

  constructor() {
    this.session = this.loadPersistedState() || {
      id: 'session-live-default',
      name: 'Agent Speed Shield Session',
      targetAgent: 'Claude Code (Anthropic) / xAI Grok',
      tripBudget: 2.00,
      spentAmount: 0.00,
      warningThresholdPct: 80,
      burnRateLimitPerMin: 0.50,
      currentBurnRatePerMin: 0.00,
      autoReloadThreshold: 10.00, // Configured reload threshold line
      providerMonthlyLimit: 100.00,
      status: 'active',
      pacingDelayMs: 0,
      totalRequests: 0,
      totalTokens: 0,
      loopRiskScore: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private loadPersistedState(): PromptPaceSession | null {
    try {
      if (fs.existsSync(CACHE_FILE_PATH)) {
        const raw = fs.readFileSync(CACHE_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.session) {
          return parsed.session;
        }
      }
    } catch (e) {
      console.warn('Could not read .promptpace-cache.json:', e);
    }
    return null;
  }

  private savePersistedState(): void {
    try {
      fs.writeFileSync(
        CACHE_FILE_PATH,
        JSON.stringify(
          {
            session: this.session,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch (e) {
      // Non-critical file cache write
    }
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
      providerShield: {
        autoReloadThreshold: this.session.autoReloadThreshold,
        spentThisSession: Number(this.session.spentAmount.toFixed(4)),
        bufferRemaining: Number(bufferRemaining.toFixed(4)),
        monthlyLimit: this.session.providerMonthlyLimit,
        status: shieldStatus,
      },
    };
  }

  public subscribe(listener: (payload: GovernorTelemetryPayload) => void): () => void {
    this.listeners.add(listener);
    listener(this.getTelemetryPayload());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public notifyListeners(): void {
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
   * Pre-flight governor check before starting a request
   */
  public async preflightCheck(params: {
    model: string;
    promptSnippet: string;
    estimatedTokens?: number;
  }): Promise<{ action: 'proceed' | 'kill'; delayMs: number }> {
    const loopAnalysis = this.loopDetector.analyzeRequest(params.promptSnippet);
    this.session.loopRiskScore = loopAnalysis.riskScore;

    const delayMs = this.session.pacingDelayMs;

    if (this.session.status === 'killed') {
      return { action: 'kill', delayMs: 0 };
    }

    const estimatedCost = calculateCostUsd(
      params.model,
      params.estimatedTokens || 1200,
      400
    );

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
        message = `Autonomous loop detected: ${loopAnalysis.reason || 'Repeating error patterns'}`;
      } else if (this.session.status === 'paused') {
        reason = 'manual_pause';
        message = 'Agent session manually paused by user.';
      }

      this.session.status = 'held';
      this.notifyListeners();

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

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return { action: 'proceed', delayMs };
  }

  /**
   * Mid-stream chunk budget check.
   * If a streaming call balloons past remaining trip budget, returns shouldAbort = true.
   */
  public checkStreamLimit(params: {
    model: string;
    promptTokens: number;
    currentOutputTokens: number;
  }): { shouldAbort: boolean; currentCost: number; reason?: string } {
    const currentCost = calculateCostUsd(
      params.model,
      params.promptTokens,
      params.currentOutputTokens
    );

    // If current spend + this call's cost exceeds trip budget, trigger mid-flight abort
    if (this.session.spentAmount + currentCost >= this.session.tripBudget) {
      return {
        shouldAbort: true,
        currentCost,
        reason: `Streaming response breached trip budget ($${this.session.tripBudget.toFixed(2)}) mid-flight!`,
      };
    }

    // Safety ceiling: If a SINGLE call consumes > 50% of the entire trip budget, flag runaway
    const singleCallMax = this.session.tripBudget * 0.5;
    if (currentCost > singleCallMax && singleCallMax > 0.5) {
      return {
        shouldAbort: true,
        currentCost,
        reason: `Single streaming response consumed >50% of trip budget ($${currentCost.toFixed(3)}). Aborted mid-flight.`,
      };
    }

    return { shouldAbort: false, currentCost };
  }

  public registerStreamController(streamId: string, controller: AbortController): void {
    this.activeStreamControllers.set(streamId, controller);
  }

  public unregisterStreamController(streamId: string): void {
    this.activeStreamControllers.delete(streamId);
  }

  public abortAllActiveStreams(): void {
    this.activeStreamControllers.forEach((controller) => {
      try {
        controller.abort();
      } catch (e) {}
    });
    this.activeStreamControllers.clear();
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
   * Records completed request metrics and persists state to disk + Supabase
   */
  public recordCompletedRequest(params: {
    provider: RequestLogEntry['provider'];
    model: string;
    endpoint: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    isStreaming?: boolean;
    status?: RequestLogEntry['status'];
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

    if (this.session.spentAmount >= this.session.tripBudget) {
      this.session.status = 'exhausted';
    }

    this.spendHistory.push({
      timestamp: now,
      cost,
      tokens: totalTokens,
    });

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
      status: params.status || 'completed',
      isStreaming: params.isStreaming || false,
      loopRiskScore: this.session.loopRiskScore,
      promptSnippet: params.promptSnippet,
    };

    this.logs.push(logEntry);
    if (this.logs.length > 200) {
      this.logs.shift();
    }

    this.savePersistedState();
    persistLogToSupabase(logEntry);
    persistSessionToSupabase(this.session);

    this.notifyListeners();
    return logEntry;
  }

  public handleAction(action: GovernorActionType, payload?: any): void {
    switch (action) {
      case 'refuel': {
        const addedAmount = Number(payload?.amount || 1.00);
        this.session.tripBudget = Number((this.session.tripBudget + addedAmount).toFixed(4));
        this.session.status = 'active';
        this.loopDetector.reset();
        this.session.loopRiskScore = 0;

        this.activeHolds.forEach((hold) => hold.resolve('proceed'));
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
        this.abortAllActiveStreams();
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
        if (payload?.providerMonthlyLimit !== undefined) {
          this.session.providerMonthlyLimit = Number(payload.providerMonthlyLimit);
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
        this.abortAllActiveStreams();
        this.activeHolds.forEach((hold) => hold.resolve('proceed'));
        this.activeHolds.clear();
        break;
      }
    }

    this.savePersistedState();
    persistSessionToSupabase(this.session);
    this.notifyListeners();
  }

  private updateBurnRate(): void {
    const now = Date.now();
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

const globalForGovernor = global as unknown as { promptPaceGovernor: GovernorEngine };
export const governorEngine = globalForGovernor.promptPaceGovernor || new GovernorEngine();
if (process.env.NODE_ENV !== 'production') {
  globalForGovernor.promptPaceGovernor = governorEngine;
}
