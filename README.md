# 🛡️ PromptPace

> **Cruise Control, Speed Governor & Stripe Auto-Reload Shield for Autonomous AI Agents.**  
> Prevent runaway coding agent loops from silently draining your card tokens.

[![Next.js](https://img.shields.io/badge/Next.js-16.3-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v4-38bdf8?style=flat-square&logo=tailwind-css)](https://tailwindcss.com/)
[![Supabase](https://img.shields.io/badge/Supabase-Ready-emerald?style=flat-square&logo=supabase)](https://supabase.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

---

## 🚨 The Problem PromptPace Solves

When developing with autonomous coding agents (**Claude Code**, **xAI Grok API**, **Cursor Agent**, **Aider**, **Devin**), AI models run in open-ended execution loops—editing code, running tests, failing, re-prompting, and spawning subagents.

Unlike traditional web apps, **the software itself decides how deep to go and how much to spend**.

```
[ Broken Test / Logic Loop ] ──▶ [ Rapid Retries ] ──▶ [ Balance Drops < $10 ] ──▶ [ 💳 Stripe Card Auto-Debited $20 ] ──▶ [ Repeats 10x ]
```

1. **The Death Loop**: A broken compile step or test failure can trigger dozens of automated re-prompts per minute while you step away.
2. **Stripe Tokenized Auto-Reloads**: Providers rely on stored card tokens configured to pull funds automatically without per-transaction OTP or pre-authorization.
3. **Flawed Existing Workarounds**:
   - *Manual caps in web dashboards:* Buried, rigid, and crash agents mid-task, destroying file and git states.
   - *Virtual dollar cards:* Protect bank accounts, but hitting $0 produces hard HTTP 400/500 crashes that corrupt agent contexts.

---

## ⚡ The Solution: PromptPace Architecture

PromptPace acts as an intelligent local proxy gateway and mission control cockpit positioned directly between your agent tools and the upstream AI APIs.

```
       ┌─────────────────────────────────────────────────────────┐
       │     [ Autonomous Agent (Claude Code, Grok, Devin) ]     │
       └────────────────────────────┬────────────────────────────┘
                                    │ ANTHROPIC_BASE_URL / OPENAI_BASE_URL
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │                 PROMPTPACE PROXY ENGINE                 │
       │                   (http://localhost:3000)               │
       │                                                         │
       │  ⏱️ Speed Governor: Real-time $/min burn velocity check │
       │  🛑 Pre-Flight Trip Budget: Pre-authorized spend ceiling│
       │  🔄 Death-Loop Detector: Identifies repetitive failures │
       │  💳 Stripe Shield: Stops BEFORE provider trips reload   │
       └────────────────────────────┬────────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
        [ Within Boundaries ]              [ Threshold Triggered ]
       Forward to Anthropic / xAI          ⏸️ HOLD REQUEST IN-FLIGHT
                                           🔔 Sound Mission Alarm
                                           ✋ Interactive Refuel Gate UI
```

---

## ✨ Key Features

### 1. ⏱️ Burn-Rate Speedometer
- Real-time animated SVG dial calculating token spend velocity in **`$/minute`**.
- Color-coded safety tiers: **Cruise Safe (Green)**, **Accelerating (Amber)**, and **High-Burn Alert (Red)**.
- Live telemetry for request frequency (`reqs/min`) and token throughput (`tok/min`).

### 2. 🛑 Pre-Flight "Trip Budget" & Odometer
- Set a strict session ceiling (e.g., `$2.00 max for this refactor`).
- Visual 80% warning threshold marker to alert you before limits are reached.
- Odometer tracks exact spent dollars vs. authorized fuel.

### 3. ⏸️ In-Flight "Refuel Gate" (Zero State Loss)
- When a threshold is hit or a death loop is detected, PromptPace **does not crash the agent**.
- It **holds the HTTP connection suspended in-flight**, sounds an emergency audio alarm, and opens the Refuel Gate in your browser:
  - **`⚡ +$1.00 Refuel & Resume`**: Instantly resolves the pending request and continues.
  - **`🐢 Throttle Pace`**: Injects 3-second deliberate cooldowns between agent tool runs.
  - **`🛑 Emergency Kill`**: Safely terminates the session without charging further tokens.

### 4. 🔄 Death-Loop & Burst Circuit Breaker
- Heuristic algorithm analyzing rolling prompt hash signatures, recurring error stack traces, and burst spikes (> 5 reqs / 10s).

### 5. 💳 Stripe Auto-Reload Shield
- Calculates and visualizes the exact dollar buffer remaining before your Anthropic or xAI account balance drops below the auto-topup trigger line.

### 6. 🧪 Agent Flight Simulator Workbench
- Built directly into the dashboard to simulate normal agent tasks, runaway death loops, and continuous execution with 1-click controls.

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/your-username/PromptPace.git
cd PromptPace
npm install
```

### 2. Configure Environment (Optional)

PromptPace works **out of the box with zero configuration** (built-in in-memory state engine and high-fidelity mock stream). 

To connect live upstream providers or Supabase:

```bash
cp .env.example .env.local
```

Edit `.env.local`:
```env
# Upstream Provider Keys (Optional for live forwarding)
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
XAI_API_KEY=xai-...

# Supabase Persistence (Optional)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### 3. Start PromptPace

```bash
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** to launch the Mission Control Cockpit.

---

## 🔌 Hooking Up Your Agents

Connect your favorite autonomous CLI or IDE agent with a single environment variable:

### Claude Code (Anthropic)
```bash
export ANTHROPIC_BASE_URL="http://localhost:3000/api/v1"
claude
```

### xAI Grok / OpenAI Compatible Tools (Cursor, Aider, Devin)
```bash
export OPENAI_BASE_URL="http://localhost:3000/api/v1"
# or
export XAI_BASE_URL="http://localhost:3000/api/v1"
```

---

## 🛠️ Tech Stack

- **Framework**: [Next.js 16 (App Router)](https://nextjs.org/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Icons**: [Lucide React](https://lucide.dev/)
- **Real-Time Streaming**: Server-Sent Events (SSE)
- **Audio Engine**: Web Audio API (Zero external MP3 dependencies)
- **Database**: [Supabase](https://supabase.com/) (PostgreSQL schema in `supabase/schema.sql`) + local cache fallback

---

## 📁 Project Structure

```
PromptPace/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── v1/
│   │   │   │   ├── messages/route.ts         # Anthropic Claude Proxy
│   │   │   │   └── chat/completions/route.ts # OpenAI & xAI Grok Proxy
│   │   │   └── governor/
│   │   │       ├── telemetry/route.ts        # SSE Real-time Stream
│   │   │       ├── action/route.ts           # Refuel, Throttle, Kill Actions
│   │   │       ├── simulate/route.ts         # Flight Simulator Scenarios
│   │   │       └── state/route.ts            # State Hydration
│   │   ├── layout.tsx                        # Master Dark-Mode Layout
│   │   └── page.tsx                          # Mission Control Cockpit
│   ├── components/
│   │   ├── Speedometer.tsx                   # SVG Burn-Rate Gauge ($/min)
│   │   ├── TripOdometer.tsx                  # Trip Budget Progress Bar
│   │   ├── StripeShieldCard.tsx              # Auto-Reload Buffer Card
│   │   ├── RefuelGateModal.tsx               # In-Flight Interception Dialog
│   │   ├── ControlsPanel.tsx                 # Real-time Governor Tuner & CLI Setup
│   │   ├── TelemetryFeed.tsx                 # Intercepted Request Stream
│   │   ├── AgentSimulator.tsx                # Interactive Test Sandbox
│   │   └── Navbar.tsx                        # Status Bar & Sound Controls
│   └── lib/
│       ├── governor/
│       │   ├── engine.ts                     # In-Flight Hold & Pacing Singleton
│       │   ├── loopDetector.ts               # Heuristic Death-Loop Analyzer
│       │   ├── pricing.ts                    # LLM Pricing Matrix
│       │   └── types.ts                      # Core Governor TypeScript Types
│       ├── sound.ts                          # Web Audio Synthesizer
│       └── supabase/
│           └── client.ts                     # Supabase Persistence Client
└── supabase/
    └── schema.sql                            # Database Migration Schema
```

---

## 📄 License

MIT © PromptPace Contributors.
