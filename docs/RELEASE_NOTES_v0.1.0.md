# PromptPace v0.1.0

The first tagged release. A local proxy that sits between an AI coding tool and an
LLM provider, records what every request costs, and stops runaway loops. No cloud
services, no paid APIs, everything on one machine.

## What is implemented

**Proxy (`proxy/`)**

- Hono on Node, SQLite through `better-sqlite3`. One request row per call: id,
  timestamp, model, token counts (input, output, cache creation, cache read), cost,
  status, session id, `partial`, `blocked`, `flagged` and the loop fingerprint.
- Non-streaming pass-through: the request body and headers reach the upstream
  unchanged, and the upstream response comes back with its status and headers intact.
- Streaming pass-through: SSE chunks are forwarded as they arrive, the upstream is read
  only when the client pulls more, and the token usage is parsed on a side path out of
  the `message_start` and `message_delta` events. The bytes the client receives are
  never rewritten.
- Session ids: the `x-promptpace-session` header wins; otherwise the id is the first 12
  hex characters of the SHA-256 of the auth credential. The raw credential is never
  stored or logged.
- Budget cap: `PROMPTPACE_BUDGET_USD` sets a cap per session, a per-session cap from
  the admin API overrides it, and a request at or over the cap never reaches the
  upstream (HTTP 402, Anthropic-shaped error body, logged with `blocked = 1`).
- Loop detection: the newest content of a request is fingerprinted (SHA-256, 16 hex
  characters, only the hash is stored). The same fingerprint seen at least
  `PROMPTPACE_LOOP_THRESHOLD` times for the same session inside
  `PROMPTPACE_LOOP_WINDOW_SECONDS` is flagged; with `PROMPTPACE_LOOP_BLOCK=true` the
  request is refused with HTTP 422 instead.
- Admin API on the same server, loopback only: `/admin/sessions`,
  `/admin/requests`, `/admin/series`, `/admin/sessions/:id/alerts`,
  `/admin/sessions/:id/budget`, `/admin/sessions/:id/reset`. It checks the caller's
  socket address, the `Host` header and the content type, rejects cross-site requests,
  and sends no CORS headers. The proxy binds to 127.0.0.1 by default.

**Mock provider (`mock-llm/`)**

- A fake Anthropic Messages API: normal and streaming responses, the Anthropic event
  names, and configurable usage numbers, delay, a pre-stream error and a mid-stream
  drop. Nothing in the test suite needs an API key.

**Dashboard (`dashboard/`)**

- Next.js and Tailwind, three views: cost over time with the burn rate and the spend
  against the cap, the live request feed with badges, and the alerts list. The browser
  never calls the proxy; the Next server does, and the page polls the route handlers
  every two seconds.

**Tooling**

- `npm run verify` (`scripts/verify.sh`): no tracked `.db`/`.env`/`*.key` files, no
  key-shaped strings outside fake fixtures, a clean typecheck, all tests green, no
  forwarded headers in the admin path, and a loopback bind address. Wired into CI.
- 69 tests (Vitest) across the proxy, the mock and the dashboard.
- `docs/WALKTHROUGH.md` explains the request flow, the streaming design, the budget and
  loop decisions, the tradeoffs and ten likely interview questions.

## Known limitations

- **Placeholder pricing.** `proxy/pricing.json` ships with zeros marked `todo_verify`,
  and the demo writes a temporary price file with clearly fake numbers. Every dollar
  figure in the dashboard is illustrative until the real prices are entered.
- **The budget cap is soft.** It is checked before a request is forwarded, but
  in-flight requests are not reserved against it, so concurrent requests can overshoot
  the cap together.
- **Local use only.** The admin API trusts the loopback socket address and the `Host`
  header. Behind Docker or a reverse proxy neither can be trusted, so the proxy should
  stay bound to 127.0.0.1 and the admin API should not be exposed.
- **Partial rows are lower bounds.** A partial row only carries the usage seen before
  the stream broke, so its cost understates the real cost.
- **Loop detection is a heuristic.** Normalisation merges requests that differ only in
  numbers or ids, and requests shorter than `PROMPTPACE_LOOP_MIN_CHARS` are not
  fingerprinted at all.
- No dashboard editing, no auth, no multi-user, no billing, no hosting.

## Running the demo

```bash
npm install
bash scripts/demo.sh
```

The script starts the mock provider, the proxy and the dashboard, then drives normal
traffic, a budget block and a loop detection, so all three views have something to
show. Open <http://127.0.0.1:3000>.

To run the pieces separately:

```bash
npm run dev          # mock :8788, proxy :8787, dashboard :3000
npm test             # 69 tests
npm run verify       # the CI checks
```

Point any Anthropic-compatible tool at the proxy with
`export ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
