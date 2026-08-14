-- PromptPace Database Schema for Supabase
-- Autonomous Agent Speed Governor & Trip Budget Shield

-- 1. PromptPace Agent Sessions
CREATE TABLE IF NOT EXISTS promptpace_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_name TEXT NOT NULL DEFAULT 'Autonomous Coding Session',
    target_agent TEXT NOT NULL DEFAULT 'Claude Code',
    trip_budget NUMERIC(10, 4) NOT NULL DEFAULT 2.0000,
    spent_amount NUMERIC(10, 4) NOT NULL DEFAULT 0.0000,
    warning_threshold_pct INTEGER NOT NULL DEFAULT 80,
    burn_rate_limit_per_min NUMERIC(10, 4) NOT NULL DEFAULT 0.5000,
    auto_reload_threshold NUMERIC(10, 4) NOT NULL DEFAULT 10.0000,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'held', 'paused', 'exhausted', 'killed', 'completed')),
    pacing_delay_ms INTEGER NOT NULL DEFAULT 0,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Intercepted Request Logs & Telemetry
CREATE TABLE IF NOT EXISTS promptpace_request_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES promptpace_sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, -- 'anthropic', 'openai', 'xai', 'mock'
    model TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0.000000,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'held', 'rejected', 'failed')),
    loop_risk_score NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    error_signature TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Circuit Breaker Rules
CREATE TABLE IF NOT EXISTS promptpace_circuit_breakers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES promptpace_sessions(id) ON DELETE CASCADE,
    rule_name TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('max_spend', 'burn_rate_spike', 'death_loop', 'auto_reload_buffer')),
    threshold_value NUMERIC(10, 4) NOT NULL,
    action TEXT NOT NULL DEFAULT 'hold_in_flight' CHECK (action IN ('hold_in_flight', 'throttle', 'kill')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for lightning queries
CREATE INDEX IF NOT EXISTS idx_promptpace_logs_session ON promptpace_request_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_promptpace_logs_created_at ON promptpace_request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_promptpace_sessions_status ON promptpace_sessions(status);
