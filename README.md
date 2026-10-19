# PromptPace

Local proxy that sits between AI coding tools and LLM provider APIs. It tracks spend,
enforces budgets and detects runaway request loops. No cloud services, no paid APIs.

**Status:** monorepo scaffold, mock provider, pass-through proxy (streaming and
non-streaming), SQLite request log, per-session budget cap with a loopback-only admin
API, tests. Loop detection and live dashboard data are not built yet.

## Layout

```
proxy/       Hono on Node + better-sqlite3. Pass-through proxy, request log, pricing.
mock-llm/    Fake Anthropic-shaped provider: normal + streaming responses, usage numbers.
dashboard/   Next.js + Tailwind scaffold. Reads the proxy HTTP API (phase 2).
pricing.json Proxy price table. Placeholder values, see Pricing below.
```

## Run

```bash
npm install
npm run dev        # mock-llm :8788, proxy :8787, dashboard :3000
```

Other commands:

```bash
npm run dev:core   # mock-llm + proxy only
npm test           # vitest across proxy and mock-llm
npm run typecheck  # tsc --noEmit everywhere
npm run build      # dashboard production build
```

## Use it

Point any Anthropic-compatible tool at the proxy instead of the provider:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

The proxy forwards `POST /v1/messages` to `UPSTREAM_URL` (default
`http://127.0.0.1:8788`, the mock) and returns the upstream response unchanged.

```bash
curl -X POST http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-promptpace-session: my-session' \
  -d '{"model":"mock-claude","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

Session id comes from the `x-promptpace-session` header. Without that header the id is
derived from the auth credential (`x-api-key` or `Authorization`): the first 12 hex
characters of its SHA-256 hash. The raw credential is never stored or logged. With no
credential either, the id is `default`.

## Budgets

`PROMPTPACE_BUDGET_USD` sets a default spend cap per session (unset = no cap). Before a
request is forwarded the proxy sums the session's cost from SQLite; at or over the cap
the upstream is not contacted and the client gets HTTP 402:

```json
{"type":"error","error":{"type":"budget_exceeded","message":"Session budget exceeded: spent $0.0025 of the $0.0020 cap for session 4f2a1c9b7d30. Raise it with POST /admin/sessions/4f2a1c9b7d30/budget {\"cap_usd\": <usd>} or set PROMPTPACE_BUDGET_USD."}}
```

Blocked requests are logged like any other request: status 402, zero tokens, `blocked = 1`.
The check runs for streaming and non-streaming requests alike.

### Admin API

Loopback callers only (127.0.0.0/8 and ::1); anything else gets HTTP 403.

| Endpoint | Effect |
| --- | --- |
| `GET /admin/sessions` | id, cap, spent, blocked count, last activity per session |
| `POST /admin/sessions/:id/budget` `{"cap_usd": 2.5}` | set the cap for one session (overrides the env default) |
| `POST /admin/sessions/:id/reset` | reset the spend baseline, history is kept |

```bash
curl -X POST http://127.0.0.1:8787/admin/sessions/4f2a1c9b7d30/budget \
  -H 'content-type: application/json' -d '{"cap_usd": 2.5}'
```

## Environment

| Variable | Default | Where |
| --- | --- | --- |
| `PROXY_PORT` | `8787` | proxy |
| `UPSTREAM_URL` | `http://127.0.0.1:8788` | proxy |
| `PROXY_DB_PATH` | `proxy/data/promptpace.db` | proxy |
| `PRICING_PATH` | `proxy/pricing.json` | proxy |
| `DEFAULT_SESSION_ID` | `default` | proxy |
| `PROMPTPACE_BUDGET_USD` | unset (no cap) | proxy |
| `MOCK_PORT` | `8788` | mock-llm |
| `MOCK_DELAY_MS` | `80` | mock-llm |
| `MOCK_INPUT_TOKENS` / `MOCK_OUTPUT_TOKENS` | `120` / `240` | mock-llm |

Per-request overrides for the mock:

| Header | Effect |
| --- | --- |
| `x-mock-delay-ms` | delay between SSE events |
| `x-mock-input-tokens` / `x-mock-output-tokens` | reported usage |
| `x-mock-cache-creation-tokens` / `x-mock-cache-read-tokens` | reported cache usage |
| `x-mock-error-status` | fail with this status before the stream starts |
| `x-mock-drop-after` | kill the connection after N SSE events |
| `x-mock-stop-after` | close the stream cleanly after N SSE events, without `message_stop` |

## Request log

Every request is written to the `requests` table:

| Column | Meaning |
| --- | --- |
| `id` | UUID |
| `timestamp` | ISO-8601 UTC |
| `model` | model from the request, else the upstream response |
| `input_tokens` / `output_tokens` | from the upstream `usage` object |
| `cache_creation_tokens` / `cache_read_tokens` | from the upstream `usage` object |
| `cost` | computed from `pricing.json` |
| `status` | upstream HTTP status |
| `session_id` | `x-promptpace-session` header, else the credential hash, else the default |
| `partial` | `1` when the stream did not finish cleanly (no `message_stop`, client gone, upstream died) |
| `blocked` | `1` when the request was rejected by the budget cap |

```bash
node -e "const D=require('better-sqlite3');console.log(new D('proxy/data/promptpace.db',{readonly:true}).prepare('select * from requests').all())"
```

## Streaming

`POST /v1/messages` with `"stream": true` is forwarded chunk by chunk. The upstream is
read only when the client asks for more data, so the proxy never reads faster than the
client consumes. A side-path parser copies the bytes to read token usage out of the
`message_start` and `message_delta` events; the bytes sent to the client are untouched.

| Case | Logged row |
| --- | --- |
| stream finished | full usage, `partial = 0` |
| client disconnected | usage seen so far, `partial = 1`, upstream request cancelled |
| upstream error before the stream | upstream status, zero tokens, `partial = 0` |
| upstream died mid-stream | usage seen so far, `partial = 1` |

## Pricing

`proxy/pricing.json` holds **placeholder** prices, all `0` and flagged `todo_verify`.
Fill them in from the provider's official pricing page before trusting any cost figure;
no real price is invented here. Cost = `input_tokens/1e6 * input_per_mtok +
output_tokens/1e6 * output_per_mtok + cache_creation_tokens/1e6 * cache_creation_per_mtok +
cache_read_tokens/1e6 * cache_read_per_mtok`. Unknown models fall back to the `default` entry.

## Limitations

- **The cap is soft.** The cap is checked before a request is forwarded, but concurrent
  in-flight requests are not reserved against it. Several requests that each start under
  the cap can together overshoot it, and the spend of a request that is still running is
  not counted until it finishes.
- **Partial rows are lower bounds.** A partial row (client disconnect, upstream died, no
  `message_stop`) only carries the usage that was seen before the stream broke, so the
  cost of a partial row is a lower bound on what the request actually cost.
- A stream that ends without `message_stop` is logged as partial even if the upstream
  closed cleanly.
- No loop detection, no dashboard data yet.
- No auth, no multi-user, no billing, no hosting.
