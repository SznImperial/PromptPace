# 🛡️ PromptPace

> **Cruise control and a safety shield for your AI coding agents.**  
> Never wake up to surprise charges on your credit card.

---

## 😱 The Scary Problem (In Simple Words)

When you use autonomous AI coding tools like **Claude Code**, **xAI Grok**, **Cursor**, or **Devin**, the AI works on its own without asking you for permission on every step.

If the AI gets stuck on a broken piece of code, it will try to fix it again, and again, and again. 

### Why this drains your bank account:
1. Most AI tools ask for your credit or debit card and turn on **"Auto-Reload"** (e.g., *"Whenever my balance is under $10, automatically pull $20 from my card"*).
2. If an AI gets stuck in a loop, it can trigger that $20 reload **5 to 10 times in an hour** while you are sleeping or away from your desk.
3. Because it charges your saved card automatically, your bank won't ask you for an OTP or confirmation. You just wake up to money gone.

---

## 💡 How PromptPace Saves You

Think of PromptPace like **cruise control and a prepaid gas tank** for your AI agents. 

PromptPace sits right in between your computer and the AI company. It watches every single penny the AI tries to spend in real-time.

```
[ AI Coding Tool ]  ──▶  [ 🛡️ PROMPTPACE SHIELD ]  ──▶  [ Anthropic / xAI API ]
                              (Your Safety Guard)
```

### 1. 🛑 The "Trip Budget" (Prepaid Gas Tank)
Before you start a coding task, you choose a budget limit (like **$2.00**). The AI is physically blocked from spending more than what you allowed.

### 2. ⏱️ The Speedometer (Burn Rate)
Just like the speedometer in a car, PromptPace shows you how fast the AI is spending money right now in **dollars per minute** ($/min).
- 🟢 **Green:** Safe cruise speed.
- 🟡 **Yellow:** Running fast.
- 🔴 **Red:** Danger! High spend speed.

### 3. ⏸️ The "Refuel Gate" (Pause, Don't Crash)
If your AI hits your $2.00 limit, **it does not crash or delete your work**.  
PromptPace simply hits the pause button, rings an alarm on your screen, and asks:
> *"Hey! Your agent reached its $2.00 limit on this task. Do you want to add +$1.00 to continue, or stop it here?"*

### 4. 🔄 Death-Loop Alarm
If the AI keeps making the exact same error 3 or 4 times in a row, PromptPace detects the loop and pauses it immediately so you don't waste money.

### 5. 💳 Stripe Card Shield
Shows you how close you are to your provider's auto-reload line so your real debit/credit card never gets touched.

---

## 🚀 How to Use (3 Simple Steps)

### Step 1: Download and Start
Open your terminal in this project folder and run:
```bash
npm install
npm run dev
```

### Step 2: Open the Dashboard
Open your web browser and go to:  
👉 **[http://localhost:3000](http://localhost:3000)**

You will see your live speedometer, trip budget meter, and flight simulator!

### Step 3: Tell Your AI Agent to Use PromptPace
Copy and paste **one line** into your terminal before running your AI:

#### For Claude Code:
```bash
export ANTHROPIC_BASE_URL="http://localhost:3000/api/v1"
claude
```

#### For Grok / OpenAI tools:
```bash
export OPENAI_BASE_URL="http://localhost:3000/api/v1"
```

That's it! PromptPace will now protect every request your agent makes.

---

## 🧪 Try the Built-In Simulator (No API Key Needed)

You can test how it works right away without spending real money:
1. Open **[http://localhost:3000](http://localhost:3000)**.
2. Look for the **"Agent Flight Simulator"** box at the bottom.
3. Click **"Runaway Death Loop"** or **"Continuous Auto-Agent"**.
4. Watch the speedometer move, see the money counter go up, and watch the **Refuel Gate pop up** when the budget limit is reached!

---

## 🛠️ Tech Under The Hood

For developers who want to know what it is built with:
- **Next.js 16** (Fast, modern web framework)
- **TypeScript** (Safe, clean code)
- **Tailwind CSS** (Clean dark-mode user interface)
- **Web Audio API** (Built-in alarm sounds with zero extra files)
- **Supabase** (Database schema included in `supabase/schema.sql`)

---

## 📄 License
MIT — Free to use, modify, and protect your wallet!
