# PromptPace walkthrough

This document is for explaining the project in an interview. It describes what happens
to a request, which files and functions are involved, and why each design decision was
made. Everything here is in the repository; nothing is aspirational.

The project is a local proxy. An AI coding tool (Claude Code, a script, anything that
speaks the Anthropic Messages API) is pointed at the proxy instead of at the provider.
The proxy forwards the request, watches what it costs, and stops runaway loops. Nothing
leaves the machine: a local SQLite file, a local mock provider, no cloud services.

```
coding tool  ──HTTP──▶  proxy (:8787)  ──HTTP──▶  provider or mock (:8788)
                              │
                              └──▶ SQLite (proxy/data/promptpace.db)
```

---

## 1. The request flow, step by step

### 1.1 Startup

`proxy/src/index.ts` is the entry point. It reads the environment, opens the database,
loads the price table and starts the HTTP server.

| What it reads | From | Default |
| --- | --- | --- |
| `PROXY_PORT` | env | `8787` |
| `UPSTREAM_URL` | env | `http://127.0.0.1:8788` (the mock) |
| `PROXY_DB_PATH` | env | `proxy/data/promptpace.db` |
| `PRICING_PATH` | env | `proxy/pricing.json` |
| `DEFAULT_SESSION_ID` | env | `default` |
| `PROMPTPACE_BUDGET_USD` | env | unset, meaning no cap |
| `PROMPTPACE_LOOP_THRESHOLD` | env | `4` |
| `PROMPTPACE_LOOP_WINDOW_SECONDS` | env | `120` |
| `PROMPTPACE_LOOP_BLOCK` | env | `false` (flag only) |
| `PROMPTPACE_LOOP_MIN_CHARS` | env | `25` |

`openDatabase()` (`proxy/src/db.ts`) creates the tables if they do not exist and adds
missing columns to tables created by an older version, so upgrading the proxy does not
require deleting the database.

### 1.2 A request arrives

`createProxyApp()` (`proxy/src/app.ts`) builds the Hono app. The route that matters is
`app.post("/v1/messages", ...)`. The handler does these things in this order:

1. **Read the body.** `await c.req.arrayBuffer()` keeps the exact bytes, so the request
   that reaches the provider is the request that arrived. The body is also parsed as
   JSON to find `model` and `stream`.
2. **Work out the session id.** `resolveSessionId()` (`proxy/src/session.ts`): the
   `x-promptpace-session` header wins; otherwise the id is the first 12 hex characters of
   the SHA-256 of the auth credential (`x-api-key` or `Authorization`); with no credential
   either, it is `default`. The raw credential is never stored or logged.
3. **Budget check.** `checkSessionBudget()` (`proxy/src/budget.ts`) sums the cost this
   session has already spent and compares it with the cap. Over the cap means the
   upstream is not contacted at all and the client gets HTTP 402. The attempt is logged
   as a row with `status = 402`, zero tokens and `blocked = 1`.
4. **Loop check.** `evaluateLoop()` (`proxy/src/loop.ts`) looks at the fingerprint of the
   request. If the same fingerprint was seen too often in the window, the request is
   either flagged or blocked (HTTP 422) depending on `PROMPTPACE_LOOP_BLOCK`.
5. **Forward.** `fetch()` to `UPSTREAM_URL` with the original body, the original headers
   minus the hop-by-hop ones, and an `AbortSignal` so a client that hangs up can cancel
   the upstream call.
6. **Copy the response.** For a normal response the body is read once and handed back
   unchanged, with the upstream status and headers.
7. **Log the row.** `recordRequest()` (`proxy/src/db.ts`) writes one row: id, timestamp,
   model, token counts, cost, status, session, and the loop/budget markers.

### 1.3 The admin API

`createAdminApp()` (`proxy/src/admin.ts`) is mounted at `/admin`. It answers three
checks before it answers anything:

- the caller is on the loopback interface, read from the TCP socket;
- the `Host` header names the local proxy on the port the proxy listens on;
- admin writes send `Content-Type: application/json`.

Endpoints:

| Endpoint | What it does |
| --- | --- |
| `GET /admin/sessions` | id, cap, spent, blocked count, last activity per session |
| `GET /admin/sessions/:id/alerts` | recent flagged and blocked rows with repeat counts |
| `POST /admin/sessions/:id/budget` | set the cap for one session |
| `POST /admin/sessions/:id/reset` | reset the spend baseline, keep the history |

---

## 2. Streaming, forwarding and backpressure

### 2.1 What the proxy does with an SSE stream

`forwardSseStream()` (`proxy/src/stream.ts`) takes the upstream `ReadableStream` and
returns a new `ReadableStream` for the client. It never waits for the whole response
before sending anything.

```ts
return new ReadableStream<Uint8Array>({
  async pull(controller) {
    const { done, value } = await reader.read();
    if (done) { parser.flush(); controller.close(); settle(!parser.sawMessageStop()); return; }
    if (value) {
      controller.enqueue(value);   // the client gets the bytes first
      parser.push(value);         // then a copy is parsed for usage
    }
  },
  cancel(reason) { abortUpstream(reason); },
});
```

### 2.2 Backpressure

The proxy reads the upstream inside `pull()`, which the streams API calls only when the
client wants more data. If the client is slow, the upstream is not read, so the upstream
is never read faster than the client consumes. `proxy/tests/stream.test.ts` proves this
with a fake upstream that counts how many chunks it produced: the client reads one chunk
and waits, and the upstream has produced at most a couple.

The alternative (reading the upstream in a tight loop and queueing) would use memory
proportional to the response size and would keep the provider billing for tokens the
client has not received yet.

### 2.3 When the client hangs up

`cancel()` is called on the response stream when the client disconnects. The proxy then
cancels the upstream body reader, aborts the upstream `fetch` through the
`AbortController`, and logs the row with `partial = 1`. `proxy/src/app.ts` also listens
to the request signal, so the cancellation happens even if the stream cancel does not
fire.

### 2.4 When the upstream dies mid-stream

The upstream body reader throws. The proxy catches it, logs the row with `partial = 1`
and the usage seen so far, and errors the client stream. The client sees a broken
stream, which is the honest thing to do: pretending the response finished would hide
truncated output.

### 2.5 When the stream ends without `message_stop`

Anthropic's stream always ends with a `message_stop` event. If the upstream closes
cleanly but that event never arrived, the stream did not finish, so the row is logged
with `partial = 1` even though nothing failed loudly. `SseUsageParser.sawMessageStop()`
tracks this.

---

## 3. How usage is extracted

Field names come from the Anthropic Messages API documentation, not from guesswork:

| Event | Where the counters are | Fields |
| --- | --- | --- |
| `message_start` | `message.usage` | `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` |
| `message_delta` | `usage` | `output_tokens` (cumulative), and the input/cache counters may be repeated |

`readUsageFields()` (`proxy/src/usage.ts`) maps those API names onto the names the
proxy stores: `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`.

`SseUsageParser` (`proxy/src/stream.ts`) is the side path. It keeps a small text buffer,
splits it into SSE events on the blank line, parses the `data:` payload as JSON and
calls `extractUsageFromSseEvent()` for each event. It only ever sees a copy of the
bytes; the bytes handed to the client are untouched. Unknown event types (`ping`,
`content_block_delta`, ...) are ignored, because the API may add new ones.

For a non-streaming response the same mapping is used on the `usage` object of the JSON
body.

---

## 4. How the budget check decides

`checkSessionBudget()` (`proxy/src/budget.ts`):

```ts
const cap = getSessionCap(db, sessionId) ?? defaultCapUsd;  // per-session cap wins
const spent = getSessionSpend(db, sessionId);                // SUM(cost) since the baseline
return { sessionId, cap, spent, blocked: cap !== null && spent >= cap };
```

- The cap comes from the session's own budget if one was set through the admin API,
  otherwise from `PROMPTPACE_BUDGET_USD`. With neither, there is no cap.
- The spend is `SUM(cost)` over the session's rows, but only rows newer than the
  session's baseline. The baseline is moved by `POST /admin/sessions/:id/reset`, which
  zeroes the spend without deleting any history.
- The comparison is `spent >= cap`, so a session that has exactly reached the cap is
  blocked. A fresh session with a spend of zero is under any positive cap.
- The 402 body is Anthropic-shaped, so a client sees a normal API error:
  `{"type":"error","error":{"type":"budget_exceeded","message":"..."}}`. The message
  states the cap, the amount spent and how to raise the cap.
- The cost per row comes from `computeCost()` (`proxy/src/pricing.ts`):
  `tokens / 1e6 * price_per_mtok` for input, output, cache creation and cache read.
  `proxy/pricing.json` holds placeholder prices (all zero, marked `todo_verify`) until
  somebody fills in the real numbers from the provider's pricing page.

---

## 5. How loop detection decides

`evaluateLoop()` (`proxy/src/loop.ts`):

```ts
const repeatCount = countRepeats(db, sessionId, fingerprint, config.windowSeconds, now) + 1;
const flagged = repeatCount >= config.threshold;
return { fingerprint, repeatCount, flagged, block: flagged && config.block };
```

`countRepeats()` counts the rows of the same session with the same fingerprint that are
newer than `now - window`. The `+ 1` is the request being decided right now.

### 5.1 The fingerprint

`fingerprintRequest()` looks only at the newest content of the request: the last message
in `messages[]`, its text blocks, and the text inside its `tool_result` blocks (a tool
result holds a string or a list of blocks, both are handled).

Before hashing, `normaliseFingerprintText()` lowercases the text, collapses whitespace,
replaces hex/uuid-like tokens with `<id>` and digit runs with `#`. So these two requests
produce the same fingerprint:

```
error: build failed at line 42 (id 550e8400-e29b-41d4-a716-446655440000)
error: build failed at line 87 (id 6ba7b810-9dad-11d1-80b4-00c04fd430c8)
```

and both become `error: build failed at line # (id <id>)`. The reason is that a runaway
loop usually repeats the same error, and the line number or request id in it changes
every time. Without the normalisation the loop would not be detected.

Only the 16 hex character hash is stored. The message content is never written to the
database; `npm run verify` and the tests check that.

### 5.2 When nothing is fingerprinted

- The last message has no usable text (empty, image only).
- The normalised text is shorter than `PROMPTPACE_LOOP_MIN_CHARS` (default 25). Short
  filler replies such as "continue" are common and repeating them ten times is not a
  runaway loop.

In both cases the fingerprint is null and the request can never be flagged.

### 5.3 Flag or block

- Default: **flag only**. The request is forwarded, the row is marked `flagged = 1`.
- With `PROMPTPACE_LOOP_BLOCK=true`: the request is not sent upstream, the client gets
  HTTP 422 with `{"type":"error","error":{"type":"loop_detected","message":"..."}}`, and
  the row is logged with `blocked = 1`, `flagged = 1` and zero tokens.

The message states the repeat count, the window and the threshold, so the developer
reading the tool output knows what happened.

---

## 6. The dashboard

The dashboard is a Next.js app in `dashboard/`. It has three views and nothing else.

| View | What it shows | Where the data comes from |
| --- | --- | --- |
| Cost over time | an inline SVG chart of cost per minute, the burn rate in $/min, spent against the cap | `GET /admin/series` and `GET /admin/sessions` |
| Live request feed | the newest requests first, with badges for blocked, flagged and partial | `GET /admin/requests` |
| Alerts | the flagged and blocked rows with their repeat count | `GET /admin/sessions/:id/alerts` |

**The browser never talks to the proxy.** The proxy sends no CORS headers and rejects
cross-site requests, so the page polls the Next route handlers in `dashboard/app/api/`
every two seconds. Those handlers call `dashboard/lib/proxy.ts`, which runs on the Next
server and calls `http://127.0.0.1:8787`. The first render happens on the server
(`dashboard/app/page.tsx`), so the page is not empty while the first poll runs.

The cost chart is a small inline SVG (`dashboard/components/cost-chart.tsx`). There is no
chart library: the data is a list of buckets, and a path plus a few grid lines is
enough.

Rows marked `partial` are labelled in the UI as a lower bound, because a partial row
only carries the usage that was seen before the stream broke.

---

## 7. Design decisions and their tradeoffs

| Decision | Why | What it costs |
| --- | --- | --- |
| SQLite with `better-sqlite3` | One file, no server, no running cost, synchronous API that keeps the code simple | One writer at a time; not for a busy multi-user setup |
| Hash the credential for the session id | Gives each API key its own budget without storing the key | The session id changes if the key changes; a shared key means a shared budget |
| Fingerprint only the newest message | A growing conversation still matches, so a loop is not hidden by a longer history | Two genuinely different requests can share a fingerprint |
| Normalise numbers and ids before hashing | A repeated error with a different line number still matches | Different requests that differ only in numbers are treated as the same |
| Flag by default, block on request | A false positive in block mode stops the tool; a false positive in flag mode only marks a row | A loop keeps burning tokens unless blocking is turned on |
| Budget checked before the upstream call | Nothing is spent on a request that is refused | The check is not atomic with the request, so parallel requests can overshoot |
| Pull-based streaming | The upstream is read at the client's pace, memory stays flat | Slightly more code than a pipe |
| Usage parsed on a side path | The bytes the client receives are never rewritten | A copy of each chunk is parsed (cheap, but not free) |
| Admin API on the same server | No second process to run, no port to open | It inherits the proxy's exposure; the loopback check is only meaningful on a real local machine |
| Loopback check reads the socket | A header can be forged, a socket address cannot | Behind Docker or a reverse proxy the check can be wrong (see the limitations) |
| Mock provider instead of a real API | No cost, no key, deterministic tests | The mock is only as good as its fidelity to the real API |

---

## 8. Known limitations

- **The budget cap is soft.** The cap is checked before the request is forwarded, but
  in-flight requests are not reserved against it. Several requests that each start under
  the cap can overshoot it together, and a running request only counts once it finishes.
- **Partial rows are lower bounds.** A partial row only carries the usage that was seen
  before the stream broke, so its cost is a lower bound on the real cost.
- **Blocked attempts count toward the loop window.** They are logged with the same
  fingerprint, so a session that keeps retrying keeps filling the window.
- **Loop detection is a heuristic.** It misses a loop that rewrites the request every
  time, and it can flag two different requests that normalise to the same text.
- **The admin API is for local use only.** Behind Docker or a reverse proxy the loopback
  check cannot be trusted: the proxy may see its own address as the client, and the
  `Host` header can be rewritten. The proxy binds to 127.0.0.1 by default, and
  `npm run verify` fails if that default ever becomes 0.0.0.0.
- **The dashboard is read-only.** It shows what the proxy recorded; it cannot change a
  cap or reset a session. That is the admin API, and it is not exposed to the browser.
- **Prices are placeholders.** `proxy/pricing.json` is all zeros until somebody fills
  in the real numbers, so the cost column is only as good as that file.
- **No dashboard yet.** The dashboard is a Next.js scaffold; the data is in SQLite and
  the admin API.
- **One process, one database, no auth.** There is no user concept; anyone who can
  reach the port can use the proxy.

---

## 9. The three files where a mistake would be most costly

1. **`proxy/src/admin.ts` — security.** It decides who may change caps, reset spend and
   read session data. A mistake here (trusting a header, accepting a foreign `Host`,
   sending CORS headers) turns a local tool into an open control panel. It is the file
   to read most carefully in a review.
2. **`proxy/src/budget.ts` and `proxy/src/pricing.ts` — money accounting.** These decide
   what a request costs and whether the session may spend it. A mistake means a cap that
   never triggers, or a cost that under-reports, and both fail quietly: the tool keeps
   running and the bill keeps growing.
3. **`proxy/src/db.ts` — data loss.** It owns the schema, the migrations and the writes.
   A mistake in a migration or in the insert silently drops columns, writes rows with the
   wrong session, or destroys history that a reset was supposed to keep.

---

## 10. Ten likely interview questions

**1. What does the proxy actually do?**
It forwards Anthropic-shaped requests to an upstream unchanged, and records what each
request cost in a local SQLite file. On top of that it can refuse a request (budget
cap, loop detection) before it reaches the provider.

**2. Why is the request body forwarded unchanged?**
Because the proxy is not the product. The tool talks to the provider exactly as it
would without the proxy, so a bug in the proxy cannot silently change the answer. The
body is read as an `ArrayBuffer` and handed to `fetch` as-is.

**3. How do you count tokens without buffering a stream?**
The bytes are handed to the client first and a copy is parsed on the side.
`SseUsageParser` splits the copy into SSE events and reads the `usage` object out of
`message_start` and `message_delta`. The client's bytes are never modified.

**4. What is backpressure and how do you get it?**
It means the producer stops when the consumer is slow. Here the upstream is read inside
the `pull()` callback of a `ReadableStream`, so the streams API only pulls more when
the client asks for more. A test counts the chunks the upstream produced to prove it.

**5. Why is the session id a hash of the API key?**
So every key gets its own budget without the proxy having to store the credential. The
proxy keeps 12 hex characters of a SHA-256; the key itself is never written down. An
explicit `x-promptpace-session` header overrides it.

**6. How can a budget check be wrong?**
It is checked before the request is forwarded, not reserved. Ten requests that start
together all pass the check and all get billed, so the session can overshoot the cap.
That is why the README calls the cap soft.

**7. Why flag loops instead of blocking them?**
Flagging is reversible and cheap. A false positive in block mode stops the tool from
working, which is much worse than an extra row in the database. Blocking is one env
variable away for anyone who wants it.

**8. How do you avoid flagging normal conversations?**
Only the newest message is fingerprinted, so a growing history does not change the
fingerprint. Numbers and ids are normalised away, and anything shorter than 25
characters is not fingerprinted at all, so "continue" repeated ten times is not a loop.

**9. How is the admin API kept private?**
Three independent checks: the client address comes from the TCP socket (never from a
header, so `X-Forwarded-For` cannot lie), the `Host` header must name the local proxy
on its own port, and admin writes must be JSON. There are no CORS headers. The limit
is that this only holds on a real local machine.

**10. How do you know it works?**
57 automated tests across the proxy and the mock provider, plus `npm run verify`, which
fails the build if a secret is tracked, if a key-shaped string is not clearly a fake
fixture, if the typecheck breaks, if a test fails, or if the admin path starts reading
forwarded headers. The mock provider can also simulate an upstream error and an
upstream that dies mid-stream, so those paths are tested without a network.
