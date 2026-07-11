# browserhand — contributor guide

browserhand is a deterministic web-automation API for AI agents: managed headless-browser sessions
with selector-free perception (accessibility snapshot + stable refs, content, screenshots) and
structured action primitives, plus logs/downloads/context and a remote CDP WebSocket.

## Invariants (do not violate)
- **No LLM / no AI keys in the service.** Reasoning lives in the calling agent; expose deterministic
  primitives it drives.
- **Agent-Computer Interface first.** High-signal responses, stable refs (not selectors), and errors
  that state the recovery action with a stable machine `code`. Keep every endpoint MCP-mappable.
- **OSC deploy contract.** Stateless; bind `0.0.0.0:$PORT` (default 8080); one HTTP port (REST + WS);
  `/healthz` + `/readyz`; env-var config only; graceful SIGTERM.
- **Safety.** No CAPTCHA solving, no anti-bot/stealth evasion.

## Architecture
- `src/config.ts` — env config (zod); the single source of truth for the env schema.
- `src/sessions/{session,pool}.ts` — session lifecycle, concurrency cap, idle sweep, CDP endpoint.
- `src/browser/{snapshot,actions,capture,content,context}.ts` — the deterministic browser layer.
- `src/api/{routes,schemas,auth,cdp}.ts` + `src/server.ts` — Fastify HTTP+WS, Swagger, error model.

## Commands
`npm run build` · `npm test` · `npm run eval` · `npm run dev` · `npm run openapi` (regenerate + commit
`openapi.json`) · `docker build -t browserhand .`

## Rules of the repo
- Every new endpoint gets: a typed schema in `src/api/schemas.ts`, a test in `test/`, an eval task in
  `eval/tasks.json`, and README + `openapi.json` updates — in the same change.
- Keep handlers thin; business logic lives in `src/sessions` and `src/browser`.
- Browser `page.evaluate` closures must tolerate esbuild runners (see the `__name` note in
  `src/browser/snapshot.ts`). Verify with `npm run eval` (runs under tsx), not just `npm test`.
- Verify before claiming done: build, run the relevant test/eval, paste real output.
