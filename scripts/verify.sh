#!/usr/bin/env bash
#
# PromptPace verification.
#
# Runs the checks that matter before the code is shown to somebody else:
#   1. no database, env or key files are tracked by git
#   2. no API-key-shaped strings outside clearly fake test fixtures
#   3. the TypeScript typecheck passes
#   4. all tests pass
#   5. the admin / loopback path does not read forwarded headers
#
# Exits 0 when everything passes, 1 when any check fails.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0

section() {
  printf '\n%s\n' "$1"
}

pass() {
  printf '  PASS  %s\n' "$1"
}

fail() {
  printf '  FAIL  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

printf 'PromptPace verify - %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ---------------------------------------------------------------------------
section "1. No database, env or key files are tracked by git"
BAD_FILES="$(git ls-files | grep -Ei '(^|/)(\.env($|\.)|[^/]*\.(db|db-wal|db-shm|key|pem|p12)$)' || true)"
if [ -z "$BAD_FILES" ]; then
  pass "git ls-files has no .db, .db-wal, .db-shm, .env or *.key"
else
  fail "these files must not be committed:"
  printf '%s\n' "$BAD_FILES" | sed 's/^/          /'
fi

# ---------------------------------------------------------------------------
section "2. No API-key-shaped strings outside clearly fake test fixtures"
KEY_PATTERN='sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{24,}'
KEY_HITS="$(git grep -nEI "$KEY_PATTERN" -- . || true)"
# A hit is allowed when the line is clearly marked as a fake fixture.
REAL_KEY_HITS="$(printf '%s\n' "$KEY_HITS" | grep -viE 'fake' || true)"
if [ -z "$REAL_KEY_HITS" ]; then
  pass "no key-shaped strings outside fake fixtures"
else
  fail "key-shaped strings found:"
  printf '%s\n' "$REAL_KEY_HITS" | sed 's/^/          /'
fi

# ---------------------------------------------------------------------------
section "3. Typecheck"
if npm run --silent typecheck >"$LOG" 2>&1; then
  pass "npm run typecheck"
else
  fail "npm run typecheck"
  tail -n 30 "$LOG" | sed 's/^/          /'
fi

# ---------------------------------------------------------------------------
section "4. Tests"
if npm test >"$LOG" 2>&1; then
  pass "npm test"
  grep -E 'Test Files|Tests ' "$LOG" | sed 's/^/          /'
else
  fail "npm test"
  tail -n 40 "$LOG" | sed 's/^/          /'
fi

# ---------------------------------------------------------------------------
section "5. The admin / loopback path does not read forwarded headers"
FORWARDED_PATTERN="x-forwarded-for|x-real-ip|[\"']forwarded[\"']"
FORWARDED_HITS="$(git grep -nEI "$FORWARDED_PATTERN" -- proxy/src || true)"
# Comment-only lines are documentation, not code.
CODE_HITS="$(printf '%s\n' "$FORWARDED_HITS" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|/\*)' || true)"
if [ -z "$CODE_HITS" ]; then
  pass "proxy/src never reads x-forwarded-for, x-real-ip or forwarded"
else
  fail "the admin / loopback path must not read forwarded headers:"
  printf '%s\n' "$CODE_HITS" | sed 's/^/          /'
fi

# ---------------------------------------------------------------------------
section "6. The proxy binds to the loopback interface by default"
BIND_DEFAULT="$(git grep -n 'DEFAULT_BIND_HOST = ' -- proxy/src/config.ts || true)"
if [ -z "$BIND_DEFAULT" ]; then
  fail "could not find the default bind address in proxy/src/config.ts"
elif printf '%s' "$BIND_DEFAULT" | grep -q '"127\.0\.0\.1"'; then
  pass "the default bind address is 127.0.0.1"
else
  fail "the default bind address must be 127.0.0.1:"
  printf '%s\n' "$BIND_DEFAULT" | sed 's/^/          /'
fi

WILDCARD_BIND="$(git grep -n '"0\.0\.0\.0"' -- proxy/src || true)"
if [ -z "$WILDCARD_BIND" ]; then
  pass "proxy/src never binds to 0.0.0.0"
else
  fail "proxy/src must not bind to 0.0.0.0:"
  printf '%s\n' "$WILDCARD_BIND" | sed 's/^/          /'
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf 'All checks passed.\n'
  exit 0
fi

printf '%d check(s) failed.\n' "$FAILURES"
exit 1
