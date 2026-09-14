# Field Inspection for MentraOS

A glasses-first field inspection miniapp with a local companion server. It
combines guided procedures, photo evidence, AI-assisted visual checks, and
inspection records while keeping the phone available for review and recovery.

## Features

- Guided work orders with asset context, numbered procedure steps, and saved progress.
- Glasses-button photo capture and English voice commands for starting,
  verifying, asking for guidance, escalating, and finishing an inspection.
- Visual evaluation against authored instructions and reference images, with
  `pass`, `adjustment_required`, and `evidence_unclear` outcomes.
- Evidence archival independent of AI evaluation: failed checks remain pending
  and can be retried without inventing a result.
- Inspection recording through the native SDK, with finished clips uploaded to
  the companion server where the device/runtime supports it.
- Saved reports and explicit expert-review packages containing inspection
  context and evidence. Escalation saves a local package; it sends no message.
- A browser preview that uses reference images or uploaded photos with the same
  controller and real server evaluation routes.

The included Bambu Lab A1 mini purge-limiter workflow is the first sample.
Currently, only its purge-limiter check is implemented; the other listed checks
remain pending. The project is intended to grow with additional equipment and
procedures. Adding a workflow today requires updating the code that selects it;
there is no automatic multi-workflow discovery yet.

## Run it

Requirements: Bun 1.3+, Node 20+, and, for native use, an Android phone with
MentraOS and connected Mentra glasses. Put the phone and server on the same Wi-Fi.

```sh
bun run setup
# Only if server/.env does not already exist:
cp server/.env.example server/.env
# Configure the server and AI provider in server/.env.
bun run dev
```

`bun run dev` starts the companion API and a LAN development QR. Enable the
miniapp developer tools in MentraOS settings and scan the QR. The exact menu
path depends on the installed app version; see [SDK notes](docs/sdk-notes.md).
Set the miniapp's inspection server URL to your laptop's reachable LAN address.

For browser use, run `bun run preview` and open
[the local preview](http://localhost:3180/). It builds once and runs the phone
interface with the companion server. Browser photo input uses real AI
requests; it does not emulate hardware recording or fabricate results.

To start over, open the inspection overflow menu and choose **Reset inspection**.
After confirmation, the phone snapshot returns to the first step. Server-side
evidence, recordings, reports, and escalations remain available for review.
`bun run release` serves an installable release QR. Stop preview before
starting dev or release because they share port 3180. The companion server
must remain reachable even after installing a release.

The miniapp pins `@mentra/miniapp@3.2.0-dev.227` and
`@mentra/miniapp-cli@0.1.0-dev.1`. Keep this pair pinned and verify installed
runtime compatibility separately from build success.

## Configuration

There are three configuration layers:

| Location | Purpose |
| --- | --- |
| `server/.env` | Server networking, upstream AI connection, and image-processing settings. |
| Miniapp connection settings | The phone-facing inspection server URL; use your laptop's LAN address, not `localhost`. |
| `workflows/` and `knowledge/` | Work-order and asset metadata, procedure steps, visual criteria, reference images, and authored guidance. |

Copy [server/.env.example](server/.env.example) to `server/.env` and set:

- `HOST` / `PORT`: listener address and port, defaulting to `0.0.0.0:8787`.
- `PUBLIC_BASE_URL`: the server URL reachable from the phone, for example
  `http://192.168.1.42:8787`. Match it to the miniapp connection setting.
- `AI_BASE_URL`: the OpenAI-compatible service root. The server appends
  `/v1/chat/completions`, so omit that suffix and `/v1` from this value.
  The default `http://localhost:11434` assumes an AI service on the server machine.
- `AI_BEARER_TOKEN` / `AI_MODEL`: the provider credential and exact model identifier.
  Use a model and endpoint that support image input and structured JSON results.
- `AI_TIMEOUT_MS`, `AI_EVALUATION_MAX_TOKENS`, and `AI_ENABLE_THINKING`: request
  timeout, response budget, and optional provider-specific reasoning behavior.
- `AI_IMAGE_MAX_EDGE` / `AI_IMAGE_JPEG_QUALITY`: AI-input resizing, defaulting to
  a 640-pixel maximum edge and JPEG quality 80. Original archived evidence is preserved.

Restart the server after changing `.env`. Keep credentials on the server;
`.env` and runtime `data/` are ignored by Git. Without a token, the server
archives evidence but leaves evaluation pending.

The sample configuration is [workflows/purge-limiter.json](workflows/purge-limiter.json).
Both the miniapp and server currently select that file explicitly. To add a
procedure, update those selection points and the server's procedure handling,
and supply matching knowledge/reference assets and supported step behavior.
Changing JSON alone does not implement additional checks. Reference images live
only in `knowledge/` and are served by the companion API. The miniapp needs a
server connection to display them; image updates do not require a miniapp rebuild.

## Development

```sh
bun run check          # lint and formatting
bun run build          # build the miniapp
bun run --cwd miniapp typecheck
bun run --cwd server typecheck
bun test miniapp/tests
```

Biome enforces two-space indentation, a 100-character line width, double
quotes, and semicolons. Use `bun run format` to format and `bun run lint:fix`
for safe lint fixes. Generated bundles, dependencies, media, and inspection
data are excluded.

## Documentation

See [docs/README.md](docs/README.md) for architecture, server routes, SDK
findings, and the sample validation procedure. Contributor and agent guidance
is in [AGENTS.md](AGENTS.md).

Mentra's public camera API may return cloud-backed signed photo URLs. Local
archival does not establish a fully offline media path. The project maintainer
confirmed upstream AI and physical Live validation on the tested setup on
2026-09-14; see [validation notes](docs/sample-validation.md). A visual
pass establishes visible criteria only, not hidden fastening strength or
machine safety.
