# Contributor and agent guidance

## Documentation

Keep project documentation in `docs/`, with the root README as the public
entry point. Start with [docs/README.md](docs/README.md), then read the relevant
implementation plan, SDK notes, server reference, and validation guide before
changing their corresponding behavior. Keep links and docs aligned with code.

## Architecture

- `miniapp/src/background/` owns the Mentra SDK session, hardware/voice
  subscriptions, persistence, and background lifecycle.
- `miniapp/src/shared/` contains the shared inspection controller, workflow,
  serializable state, and typed UI channels.
- `miniapp/src/ui/` contains the React phone interface and browser adapter.
- `server/` owns evidence archival, upstream AI credentials, guidance,
  reports, escalation packages, and video uploads.
- `workflows/` and `knowledge/` contain sample procedure configuration and
  reference evidence. The current workflow is explicitly selected in code;
  do not describe additional steps or workflow discovery as implemented.

## Contracts

Archive evidence separately from AI evaluation. Leave failed/unavailable
checks pending and preserve retry state. Never fabricate AI findings, mark
untouched checks passed, or claim an image proves hidden mechanical safety.
Escalation creates a local package only; external delivery requires an
explicit feature and user action. Preserve recording stop/upload behavior
across save, early end, pause, close, and in-flight recording starts.

Keep AI credentials in ignored server configuration. Use generic example
hosts and sample metadata in committed files. Exclude personal correspondence,
private URLs, local credentials, runtime evidence, and generated bundles.
Record SDK source findings separately from actual device observations.

## Verification

Run `bun run check`, `bun run build`, both packages' `typecheck` scripts, and
`bun test miniapp/tests` for relevant code changes. Use Biome for formatting.
Report physical-device and upstream AI checks only when they actually ran.
