# Local inspection server

This small Node/TypeScript service runs on the laptop and is reachable by the
Mentra phone over the same Wi-Fi. It archives evidence and finished recordings
locally, and is the only component that sends images to the configured OpenAI-compatible
AI endpoint.

From the repository root:

```sh
bun run setup
# Only if server/.env does not already exist:
cp server/.env.example server/.env
# Set AI_BASE_URL, AI_BEARER_TOKEN, AI_MODEL, and PUBLIC_BASE_URL.
bun run server
```

The default listener is `0.0.0.0:8787`. `PUBLIC_BASE_URL` should be the
laptop's LAN URL, such as `http://192.168.1.42:8787`, so URLs returned to the
phone are reachable. The upstream endpoint is configured with
`AI_BASE_URL`, `AI_BEARER_TOKEN`, and `AI_MODEL`; the miniapp never receives the bearer token; the server sends it only
to the configured AI provider.

Routes used by the miniapp:

- `GET /api/health`
- `GET /api/context` (includes server-hosted reference URLs per step)
- `GET /api/reference?stepId=...&role=loose|seated`
- `POST /api/evidence`
- `POST /api/evaluate`
- `POST /api/ask`
- `POST /api/reports`
- `GET /api/report?id=...`
- `POST /api/escalations`
- `POST /api/video/upload?sessionId=...` (multipart field `video`)
- `GET /api/video/status?sessionId=...`

Runtime files are written beneath the repository's `data/` directory. The
purge-limiter procedure and two visual references are in `workflows/` and
`knowledge/`.

The server entrypoint is intentionally small. Runtime concerns are split across
`config.ts`, `logging.ts`, and `storage.ts` (process setup and storage layout),
`http.ts` and `routes.ts` (request handling), `procedure.ts` and `records.ts` (workflow/report shaping),
`evidence.ts` (photo archival), `ai.ts` and `inspection.ts` (AI transport and
inspection actions), and `video.ts` plus `static-files.ts` (recordings and
local artifacts).

Reference images have one source in `knowledge/`. The reference route serves
only images declared by the active workflow, not arbitrary knowledge files.
The miniapp loads these through its configured server URL; viewing references
requires a reachable companion server. UI illustrations remain bundled assets.
