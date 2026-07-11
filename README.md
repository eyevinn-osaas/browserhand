# browserhand

**A reliable, deterministic web-automation API for AI agents.** browserhand runs managed headless
browser sessions and exposes them through a small, high-signal HTTP + WebSocket API: perceive a page
as a selector-free accessibility snapshot with stable element refs, act on it by ref, read content,
capture screenshots, logs, and downloads, and reuse session state. There is **no LLM inside the
service** — the calling agent does the reasoning; browserhand reliably executes and reports back.

Every endpoint maps cleanly to a single tool, so an MCP layer (such as the one Eyevinn Open Source
Cloud provides on deploy) can turn the API into agent tools automatically — or you can run it
anywhere and put your own MCP server in front of it.

## Why

Agents driving real browsers usually break on brittle CSS/XPath selectors and hidden state.
browserhand gives an agent a stable loop instead:

1. **See** — `GET …/snapshot` returns the interactive elements with durable `ref`s (and a readable
   outline). `GET …/content` and `…/screenshot` show what a reader would see.
2. **Act** — `POST …/click`, `…/type`, `…/select`, … address elements **by ref**, never by selector.
3. **Recover** — when a ref goes stale, you get a structured `stale_ref` error telling you to
   re-snapshot. Errors are instructions, not opaque codes.

## Quickstart (Docker)

```bash
docker build -t browserhand .
docker run --rm -p 8080:8080 browserhand
```

Then drive a session:

```bash
# 1. open a session
SID=$(curl -s -XPOST localhost:8080/v1/sessions -H 'content-type: application/json' -d '{}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).sessionId')

# 2. navigate
curl -s -XPOST localhost:8080/v1/sessions/$SID/navigate \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'

# 3. see the page (stable refs)
curl -s localhost:8080/v1/sessions/$SID/snapshot

# 4. act by ref (e.g. the ref of a link from the snapshot)
curl -s -XPOST localhost:8080/v1/sessions/$SID/click \
  -H 'content-type: application/json' -d '{"ref":"e5"}'

# 5. close
curl -s -XDELETE localhost:8080/v1/sessions/$SID
```

**Interactive API docs (Swagger UI):** `http://localhost:8080/documentation`
The OpenAPI spec is served at `/documentation/json` and committed to the repo as
[`openapi.json`](./openapi.json).

## The agent loop (pseudocode)

```
POST /v1/sessions                      -> { sessionId, connectUrl }
POST /v1/sessions/:id/navigate {url}
loop:
  GET  /v1/sessions/:id/snapshot       -> nodes:[{ref, role, name, value, ...}], outline
  # the agent decides what to do from the snapshot / content
  POST /v1/sessions/:id/click  {ref}
  POST /v1/sessions/:id/type   {ref, text, submit}
  GET  /v1/sessions/:id/content        -> read result / extract data
DELETE /v1/sessions/:id
```

## API overview

| Method & path | Purpose |
|---|---|
| `POST /v1/sessions` | Open a session `{ sessionId, connectUrl, status }`. Optional `viewport`, `timeoutMs`, `context`. |
| `GET /v1/sessions` · `GET /v1/sessions/:id` · `DELETE /v1/sessions/:id` | List / status / close. |
| `GET /v1/sessions/:id/snapshot` | Accessibility snapshot: elements with stable `ref`s + outline. |
| `GET /v1/sessions/:id/content` | Readable page text (`truncated` flag when clipped). |
| `GET /v1/sessions/:id/screenshot` | PNG. `?fullPage=true`, `?ref=eN` for one element. |
| `POST /v1/sessions/:id/navigate` `{url}` · `/back` · `/forward` · `/reload` | Navigation. |
| `POST /v1/sessions/:id/click` `{ref}` | Click by ref. |
| `POST /v1/sessions/:id/type` `{ref,text,submit?}` | Fill a field; optional Enter. |
| `POST /v1/sessions/:id/select` `{ref,values}` | Select option(s). |
| `POST /v1/sessions/:id/hover` `{ref}` · `/press` `{key}` · `/scroll` `{direction\|ref}` | Input. |
| `POST /v1/sessions/:id/wait` `{text?\|ref?\|timeoutMs?}` | Wait for a condition. |
| `POST /v1/sessions/:id/upload` `{ref,files[]}` | Set files on a file input (base64 contents). |
| `GET /v1/sessions/:id/logs?type=network\|console` | Captured logs (ring-buffered). |
| `GET /v1/sessions/:id/downloads` · `GET …/downloads/:downloadId` | List / fetch captured downloads. |
| `GET /v1/sessions/:id/context` | Export cookies + localStorage (pass back as `context` on create). |
| `GET /v1/connect/:id` (WebSocket) | Remote Chrome DevTools Protocol endpoint (see below). |
| `GET /healthz` · `GET /readyz` | Liveness / readiness. |

### Errors

All errors share one shape and a stable, machine-readable `code`:

```json
{ "error": { "code": "stale_ref",
  "message": "Element ref \"e5\" is no longer on the page. Call GET /v1/sessions/:id/snapshot to get fresh refs, then retry.",
  "details": { "ref": "e5" } } }
```

Common codes: `session_not_found` (404), `session_limit_reached` (429), `stale_ref` (409),
`element_not_actionable` (409), `navigation_failed` (502), `timeout` (504), `invalid_request` (400),
`unauthorized` (401).

## Remote browser (CDP)

For power users who want to drive the session with a full automation library, connect over the
Chrome DevTools Protocol using the `connectUrl` returned at creation:

```js
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('ws://localhost:8080/v1/connect/<sessionId>');
const page = browser.contexts()[0].pages()[0];
```

## Configuration

All configuration is via environment variables.

| Variable | Default | Required | Sensitive | Description |
|---|---|---|---|---|
| `PORT` | `8080` | no | no | HTTP port (binds `0.0.0.0`). |
| `BROWSERHAND_API_KEY` | — | no | **yes** | If set, every `/v1` request must send `Authorization: Bearer <token>`. |
| `MAX_CONCURRENT_SESSIONS` | `5` | no | no | Hard cap on simultaneous sessions (excess → `429`). |
| `SESSION_TIMEOUT_MS` | `300000` | no | no | Idle timeout before a session is auto-closed. |
| `LOG_LEVEL` | `info` | no | no | `trace`…`fatal` / `silent`. |
| `CDP_PORT` | `9223` | no | no | Internal Chromium debugging port backing the CDP proxy (not exposed publicly). |

## Reliability & operations

- **Stateless** — no persistent disk required; downloads and artifacts are ephemeral.
- **Concurrency cap + idle sweeping** — sessions beyond the cap are refused; idle sessions are
  reclaimed automatically.
- **Per-action timeouts and instructive errors** so an agent can always tell what to do next.
- **Graceful shutdown** on `SIGTERM` (drains sessions, closes the browser).
- **Resource note:** Chromium is memory-heavy; budget roughly 300–500 MB per concurrent session and
  size `MAX_CONCURRENT_SESSIONS` to the container.

## Security

- Optional bearer-token auth (`BROWSERHAND_API_KEY`); health checks stay open.
- browserhand **does not** solve CAPTCHAs and ships **no** anti-bot / stealth-evasion features — by
  design. Use it for legitimate automation of sites you are authorized to operate.
- Treat a deployed instance as capable of fetching arbitrary URLs on your behalf; restrict network
  access as appropriate and put it behind auth on untrusted networks.

## Roadmap

BYO / geo proxies per session · live-view screencast · session recording & replay. Contributions
welcome.

## Development

```bash
npm ci
npx playwright install chromium   # local (non-Docker) browser
npm run dev        # watch mode
npm run build      # typecheck + compile
npm test           # unit + integration (vitest)
npm run eval       # offline evaluation suite (20 tasks)
npm run openapi    # regenerate openapi.json
```

## License

[Apache-2.0](./LICENSE)
