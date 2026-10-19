# PromptPace

Local proxy that sits between AI coding tools and LLM provider APIs. It tracks spend,
enforces budgets and detects runaway request loops. No cloud services, no paid APIs.

**Status:** monorepo scaffold, mock provider, pass-through proxy (streaming and
non-streaming), SQLite request log, tests. Budget enforcement, loop detection and live
dashboard data are not built yet.

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

Session id comes from the `x-promptpace-session` header, default `default`.

## Environment

| Variable | Default | Where |
| --- | --- | --- |
| `PROXY_PORT` | `8787` | proxy |
| `UPSTREAM_URL` | `http://127.0.0.1:8788` | proxy |
| `PROXY_DB_PATH` | `proxy/data/promptpace.db` | proxy |
| `PRICING_PATH` | `proxy/pricing.json` | proxy |
| `DEFAULT_SESSION_ID` | `default` | proxy |
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
| `session_id` | `x-promptpace-session` header or the default |
| `partial` | `1` when the stream did not finish cleanly |

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

## Not built yet

- No budgets, no runaway-loop detection, no dashboard data.
- No auth, no multi-user, no billing, no hosting.
