#!/usr/bin/env bash
#
# PromptPace demo.
#
# Starts the mock provider, the proxy and the dashboard, then drives three kinds
# of traffic so all three views have something to show:
#   1. normal traffic      -> 200 responses, the cost chart and the feed fill up
#   2. a budget block      -> 402 budget_exceeded, a blocked row in the feed
#   3. a loop detection    -> 422 loop_detected, an entry in the alerts list
#
# The demo uses a temporary pricing file with clearly fake prices, because
# proxy/pricing.json holds placeholders (all zero) until real prices are added.
#
# Ctrl-C stops everything.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

MOCK_PORT="${MOCK_PORT:-8788}"
PROXY_PORT="${PROXY_PORT:-8787}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
BUDGET_USD="${PROMPTPACE_BUDGET_USD:-0.003}"
LOOP_THRESHOLD="${PROMPTPACE_LOOP_THRESHOLD:-3}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/promptpace-demo.XXXXXX")"
PRICING_FILE="$WORK_DIR/pricing.json"

cat > "$PRICING_FILE" <<'JSON'
{
  "currency": "USD",
  "unit": "per_million_tokens",
  "_comment": "DEMO PRICES - fake numbers, not real provider prices.",
  "models": {
    "mock-claude": {
      "input_per_mtok": 1,
      "output_per_mtok": 5,
      "cache_creation_per_mtok": 0,
      "cache_read_per_mtok": 0,
      "todo_verify": true
    },
    "default": {
      "input_per_mtok": 1,
      "output_per_mtok": 5,
      "cache_creation_per_mtok": 0,
      "cache_read_per_mtok": 0,
      "todo_verify": true
    }
  }
}
JSON

PIDS=()

cleanup() {
  printf '\nStopping demo processes...\n'
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null
  done
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

wait_for() {
  local url="$1" name="$2" attempts="${3:-120}"
  for _ in $(seq 1 "$attempts"); do
    if curl -sf -o /dev/null "$url"; then
      printf '  %s is up\n' "$name"
      return 0
    fi
    sleep 1
  done
  printf '  %s did not come up: %s\n' "$name" "$url" >&2
  return 1
}

send() {
  # send <session> <message> -> prints the HTTP status
  local session="$1" message="$2" body status
  body=$(printf '{"model":"mock-claude","max_tokens":100,"messages":[{"role":"user","content":"%s"}]}' "$message")
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$PROXY_PORT/v1/messages" \
    -H 'content-type: application/json' \
    -H "x-promptpace-session: $session" \
    --data-binary "$body")
  printf '%s' "$status"
}

printf '\nPromptPace demo\n'
printf '  mock      http://127.0.0.1:%s\n' "$MOCK_PORT"
printf '  proxy     http://127.0.0.1:%s\n' "$PROXY_PORT"
printf '  dashboard http://127.0.0.1:%s\n' "$DASHBOARD_PORT"
printf '  budget    $%s per session, loop threshold %s (blocking)\n\n' "$BUDGET_USD" "$LOOP_THRESHOLD"

MOCK_PORT="$MOCK_PORT" npm run start --workspace mock-llm >"$WORK_DIR/mock.log" 2>&1 &
PIDS+=($!)

PROXY_PORT="$PROXY_PORT" \
MOCK_PORT="$MOCK_PORT" \
PRICING_PATH="$PRICING_FILE" \
PROMPTPACE_BUDGET_USD="$BUDGET_USD" \
PROMPTPACE_LOOP_BLOCK=true \
PROMPTPACE_LOOP_THRESHOLD="$LOOP_THRESHOLD" \
PROMPTPACE_LOOP_WINDOW_SECONDS=600 \
  npm run start --workspace proxy >"$WORK_DIR/proxy.log" 2>&1 &
PIDS+=($!)

DASHBOARD_PORT="$DASHBOARD_PORT" \
PROMPTPACE_PROXY_URL="http://127.0.0.1:$PROXY_PORT" \
  npm run dev --workspace dashboard >"$WORK_DIR/dashboard.log" 2>&1 &
PIDS+=($!)

printf 'Waiting for the services...\n'
wait_for "http://127.0.0.1:$MOCK_PORT/health" "mock-llm" || exit 1
wait_for "http://127.0.0.1:$PROXY_PORT/health" "proxy" || exit 1
wait_for "http://127.0.0.1:$DASHBOARD_PORT" "dashboard" 180 || exit 1

printf '\n1. Normal traffic (session demo-normal)\n'
for message in "please run the unit tests" "please fix the linter errors"; do
  status=$(send "demo-normal" "$message")
  printf '   request -> %s\n' "$status"
  sleep 0.4
done

printf '\n2. Budget block (session demo-budget, cap $%s)\n' "$BUDGET_USD"
# Different messages on purpose: identical ones would trip the loop check first.
BUDGET_MESSAGES=(
  "please summarise the repository for the release notes"
  "please update the changelog with the new features"
  "please list the open pull requests for review"
  "please check the dependencies for security updates"
)
index=1
for message in "${BUDGET_MESSAGES[@]}"; do
  status=$(send "demo-budget" "$message")
  printf '   request %s -> %s\n' "$index" "$status"
  index=$((index + 1))
  sleep 0.4
done

printf '\n3. Loop detection (session demo-loop, threshold %s)\n' "$LOOP_THRESHOLD"
# The budget is checked before the loop check, so give this session room.
curl -s -o /dev/null -X POST "http://127.0.0.1:$PROXY_PORT/admin/sessions/demo-loop/budget" \
  -H 'content-type: application/json' -d '{"cap_usd": 1.0}'
for n in 1 2 3; do
  status=$(send "demo-loop" "please fix the failing test at line 42 in the build script")
  printf '   request %s -> %s\n' "$n" "$status"
  sleep 0.4
done

printf '\n4. Streaming request (session demo-stream)\n'
stream_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H 'x-promptpace-session: demo-stream' \
  --data-binary '{"model":"mock-claude","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"please stream the build log to me"}]}')
printf '   stream request -> %s\n' "$stream_status"
sleep 0.4

printf '\nWhat the dashboard should show:\n'
printf '   View 1  cost chart rising, burn rate, spent vs the $%s cap\n' "$BUDGET_USD"
printf '   View 2  the feed with a 402 row (blocked) and a 422 row (flagged and blocked)\n'
printf '   View 3  the alerts list with the loop entries\n\n'
printf 'Open http://127.0.0.1:%s in a browser. Ctrl-C stops the demo.\n\n' "$DASHBOARD_PORT"

wait
