import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(
  supabaseUrl && 
  supabaseAnonKey && 
  !supabaseUrl.includes('placeholder') &&
  !supabaseAnonKey.includes('placeholder')
);

let supabaseInstance: SupabaseClient | null = null;

if (isSupabaseConfigured) {
  try {
    supabaseInstance = createClient(supabaseUrl, supabaseAnonKey);
  } catch (err) {
    console.warn('Could not initialize Supabase client:', err);
    supabaseInstance = null;
  }
}

export const supabase = supabaseInstance;

// Helper to save log entry to Supabase if configured
export async function persistLogToSupabase(logEntry: {
  sessionId: string;
  provider: string;
  model: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  status: string;
  loopRiskScore: number;
}) {
  if (!supabase) return;
  try {
    await supabase.from('promptpace_request_logs').insert({
      session_id: logEntry.sessionId,
      provider: logEntry.provider,
      model: logEntry.model,
      endpoint: logEntry.endpoint,
      prompt_tokens: logEntry.promptTokens,
      completion_tokens: logEntry.completionTokens,
      total_tokens: logEntry.totalTokens,
      cost_usd: logEntry.costUsd,
      duration_ms: logEntry.durationMs,
      status: logEntry.status,
      loop_risk_score: logEntry.loopRiskScore,
    });
  } catch (e) {
    console.error('Failed to persist log to Supabase:', e);
  }
}

// Helper to update session state in Supabase if configured
export async function persistSessionToSupabase(session: {
  id: string;
  spentAmount: number;
  tripBudget: number;
  status: string;
  totalRequests: number;
  totalTokens: number;
  burnRateLimitPerMin: number;
  autoReloadThreshold: number;
}) {
  if (!supabase) return;
  try {
    await supabase.from('promptpace_sessions').upsert({
      id: session.id,
      spent_amount: session.spentAmount,
      trip_budget: session.tripBudget,
      status: session.status,
      total_requests: session.totalRequests,
      total_tokens: session.totalTokens,
      burn_rate_limit_per_min: session.burnRateLimitPerMin,
      auto_reload_threshold: session.autoReloadThreshold,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Failed to persist session to Supabase:', e);
  }
}
