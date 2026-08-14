#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🛡️  PromptPace CLI - Autonomous Agent Speed Governor & Auto-Reload Shield

Usage:
  npx promptpace [command] [options]

Commands:
  start                     Start the PromptPace governor proxy & mission control dashboard (default)

Options:
  --port, -p <number>       Port to run the dashboard on (default: 3000)
  --budget, -b <number>     Set initial pre-flight trip budget in USD (default: 2.00)
  --help, -h                Show this help message

Examples:
  npx promptpace
  npx promptpace start --port 4000 --budget 5.00
  `);
  process.exit(0);
}

// Parse port and budget flags
let port = 3000;
let budget = 2.00;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') {
    port = parseInt(args[i + 1], 10) || 3000;
  }
  if (args[i] === '--budget' || args[i] === '-b') {
    budget = parseFloat(args[i + 1]) || 2.00;
  }
}

// Ensure initial cache with requested trip budget
const cachePath = path.join(process.cwd(), '.promptpace-cache.json');
try {
  let existing = {};
  if (fs.existsSync(cachePath)) {
    existing = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  existing.session = existing.session || {};
  existing.session.tripBudget = budget;
  fs.writeFileSync(cachePath, JSON.stringify(existing, null, 2), 'utf-8');
} catch (e) {}

console.log(`
  \x1b[32m╔═══════════════════════════════════════════════════════════╗\x1b[0m
  \x1b[32m║\x1b[0m   \x1b[1m\x1b[37m🛡️  PromptPace Governor Engine Starting...\x1b[0m              \x1b[32m║\x1b[0m
  \x1b[32m║\x1b[0m   \x1b[90mAutonomous Agent Speed Governor & Auto-Debit Shield\x1b[0m     \x1b[32m║\x1b[0m
  \x1b[32m╚═══════════════════════════════════════════════════════════╝\x1b[0m

  \x1b[36m⚡ Pre-Flight Trip Budget:\x1b[0m $${budget.toFixed(2)}
  \x1b[36m🌐 Mission Control URL:\x1b[0m   http://localhost:${port}
  \x1b[36m🛡️  Proxy Endpoint:\x1b[0m       http://localhost:${port}/api/v1

  \x1b[33m[To hook into Claude Code]\x1b[0m
  export ANTHROPIC_BASE_URL="http://localhost:${port}/api/v1"

  \x1b[33m[To hook into xAI Grok / OpenAI]\x1b[0m
  export OPENAI_BASE_URL="http://localhost:${port}/api/v1"
`);

const nextBin = path.join(__dirname, '..', 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
