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
- `GET /api/workflows` (discovers definitions with reference URLs; `/api/context` is an alias)
- `GET /api/reference?procedureId=...&procedureVersion=...&stepId=...&index=...`
- `POST /api/evidence`
- `POST /api/evaluate`
- `POST /api/ask`
- `POST /api/reports`
- `GET /api/report?id=...`
- `POST /api/escalations`
- `POST /api/video/timing` (syncs SDK stop confirmation to clip metadata)
- `POST /api/video/upload?sessionId=...` (multipart field `video`)
- `GET /api/video/status?sessionId=...`

Runtime files are written beneath the repository's `data/` directory. Workflow definitions and their optional visual references are in `workflows/`
and `knowledge/`.

The server entrypoint is intentionally small. Runtime concerns are split across
`config.ts`, `logging.ts`, and `storage.ts` (process setup and storage layout),
`http.ts` and `routes.ts` (request handling), `procedure.ts` and `records.ts` (workflow/report shaping),
`evidence.ts` (photo archival), `ai.ts` and `inspection.ts` (AI transport and
inspection actions), and `video.ts` plus `static-files.ts` (recordings and
local artifacts).

Reference images have one source in `knowledge/`. The reference route serves
only images declared by the requested pinned workflow version, not arbitrary knowledge files.
The miniapp loads these through its configured server URL; viewing references
requires a reachable companion server. UI illustrations remain bundled assets.

Evidence, evaluation, guidance, reports, and escalation requests include
`procedureId` and `procedureVersion`; photo actions also include `stepId`.
Evidence carries workflow identity, and evaluation/guidance reject mismatched
workflow versions or steps. Discovered definitions are archived under ignored
`data/workflows/`; these copies let existing inspections continue after a source
file is updated or removed. Reports group attempts, evidence, before/after
photos, and escalation markers per step. See [workflow authoring](workflows.md).

## Clip timing for later merging

Each recording has a stable inspection ID and a 1-based `clipIndex`. Upload
URLs carry `inspectionId`, `clipIndex`, `recordingId`, `startRequestedAt`,
`startedAt` (SDK start confirmation), and `stopRequestedAt`. These times are app
wall-clock Unix milliseconds. The SDK stop confirmation is saved as
`stopConfirmedAt` in the device snapshot and synced to each server clip's JSON
sidecar after upload. Pending sync resumes on app initialization when stop
confirmation was retained. Closing the runtime before its confirmation arrives
can leave that timestamp absent; the upload still retains the earlier times.

The server probes the archived file with `ffprobe` and stores `durationSeconds`
and `durationStatus` (`available` or `unavailable`). Set `FFPROBE_PATH` if the
executable is not on PATH. A missing executable, invalid media, or probe timeout
leaves duration null and preserves archival. Probing is bounded to 15 seconds.
`uploadedAt` remains a server upload timestamp, separate from recording timing.
Metadata is also retained in recording snapshots/reports. `data/video-timing/`
keeps stop confirmations for repeated uploads of the same clip.

Sort by inspection ID and clip index to concatenate clips. To reconstruct gaps,
use request/confirmation bounds alongside measured media duration. These are
host event timestamps, not frame-accurate device capture timestamps, and clock
changes can affect wall-clock alignment. The original video bytes are unchanged;
metadata lives in JSON sidecars. Automatic concatenation is not implemented.

AI images are resized independently: evidence defaults to a 512-pixel maximum
edge, references to 256 pixels, and JPEG quality to 70. Configure
`AI_IMAGE_MAX_EDGE`, `AI_REFERENCE_MAX_EDGE`, and `AI_IMAGE_JPEG_QUALITY` to balance
latency and visual detail. The evaluation completion budget defaults to 500
tokens; guidance remains 300. Original archived images are never resized.
All AI requests include `reasoning_effort: "none"`; Qwen requests also retain
the configured `enable_thinking` flag (disabled by default).
The server logs prepared dimensions/bytes and the number of images per request.
This reduces payload and visual processing work but does not establish that
image count was the cause of a particular upstream timeout. Insufficient detail
must yield unclear evidence, rather than a fabricated pass.
