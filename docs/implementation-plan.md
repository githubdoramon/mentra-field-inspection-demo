# Inspection miniapp implementation plan

Implementation scope recorded on 2026-09-13. On 2026-09-14, the project
maintainer confirmed that all outstanding integration, upstream AI, and
physical Live validation checks passed on the tested setup. The plan below
records the original scope and contracts; its implementation gates are
historical rather than outstanding work.

## First vertical slice

Asset A1M-0042 is a Bambu Lab A1 mini. Technician: Sample technician. Implement one complete
inspection of the added **purge limiter**. Show the other procedure steps as
normal pending steps, without disabled/unimplemented badges. Do not continue
into those steps in v1. Keep the completed check and remaining pending checks
accurate in the stored record; do not mark untouched checks passed.

Confirmed references:
- `knowledge/purge-limiter-loose.jpeg`: loose/displaced state.
- `knowledge/purge-limiter-seated.jpeg`: correctly fitted state.

Author a small sample procedure, not a manufacturer claim:

> Align the purge limiter with its mounting slot, then slide it horizontally
> into place until fully seated. Confirm that the gray mounting section fits
> into the matching cutout, with no visible gap or displacement.

Use both reference images and explicit visual criteria. A photograph can
establish visible seating, not hidden fastening strength or machine safety.

## Interaction and state

1. Launch Inspection; select the inspection task and asset. V0 can preselect
   the A1 mini work order, but the selection is part of the real flow.
2. Show the numbered procedure list with every step available as normal
   pending work. Expand the purge-limiter step as the focused current step and
   keep the remaining steps pending.
3. “Start inspection” activates the purge-limiter check, announces the
   instruction, and starts recording.
4. Short glasses-button press captures and evaluates the current check.
5. Evaluate into one of `pass`, `adjustment_required`, or `evidence_unclear`.
   Incorrect seating prompts an adjustment; unclear framing prompts a new
   photo. Neither completes the step.
6. “What should I do?” retrieves the authored procedure and gives concise,
   English guidance grounded in the current finding and evidence.
7. “Verify” requests a fresh native camera capture and evaluates the repaired
   state. A pass automatically completes the check and announces success.
8. Update visible procedure progress after the real pass while leaving every
   other step pending. Keep connection settings secondary to the focused
   procedure view.
9. “Escalate” explicitly creates an expert-help package from the clear bottom
   action. Escalation is manual and creates no external message; retries remain
   available.
10. After the purge-limiter pass, “Save inspection” persists the checkpoint,
    stops the demo recording, and opens its report with every other step still
    pending.
11. Early end is a secondary overflow action that requires a reason; persist
    that reason in the report. If voice Finish is used while the implemented
    check is unresolved, open the required-reason prompt and do not silently
    close the inspection.
12. The inspection overflow menu can reset the phone snapshot after explicit
    confirmation. Reset stops an active recording first and leaves server-side
    evidence, recordings, reports, and escalations intact.

Support equivalent phone actions for development and recovery. The production
screen has no visible photo chooser or capture button: the short glasses
button performs captures, and voice Verify can request a native capture. In
browser integration mode, an adapter can provide an uploaded image or one of
the supplied reference images as input to the same laptop server and model; it
does not substitute a fabricated check result. The earlier
“Next step” idea is reserved for later implemented steps; v1 ends here.
Voice commands operate on final English transcripts, with duplicate-event
suppression and protection against treating spoken app responses as commands.

Persist a versioned snapshot through session.storage after each meaningful
transition: work order, asset, current step, completed checks, attempts,
findings, notes, evidence metadata, verification, escalation and recording
metadata. Serialise commands, prevent duplicate captures, correlate every
result with its attempt, and ignore stale AI responses.

Track capture, evidence archival, AI processing and video upload separately.
When AI is unavailable, retain archived evidence and leave evaluation pending
for retry. An expired photo URL without archived bytes requires recapture;
never present metadata alone as saved image evidence.

## Architecture

Use Mentra's current two-layer miniapp model:
- `miniapp/src/background/`: SDK session, hardware/voice subscriptions,
  workflow state, persistence, server requests and UI snapshots.
- `miniapp/src/ui/`: React phone interface; typed messages to background,
  no direct hardware access or ownership of ongoing work.
- `miniapp/src/shared/`: serializable channels, workflow and result types.
- `server/`: local Node/TypeScript server on laptop Wi-Fi; AI adapter,
  evidence archival, knowledge retrieval, reports, escalation and video uploads.
- `workflows/`, `assets/`, `knowledge/`: validated configuration and authored
  purge-limiter procedure/reference assets.
- ignored runtime `data/`: images, recordings, reports and escalation JSON.

The miniapp contacts the Node server; the server contacts the configurable
Ollama-compatible AI endpoint. Configure the endpoint, bearer secret and exact model identifier in `server/.env`. Keep upstream credentials on
the server. Verify the endpoint protocol, image support and structured-output
support with real requests when changing providers. These checks passed for
the tested endpoint/model, as confirmed by the maintainer.

Proposed server routes: health/config readiness, evidence archival, evaluate,
ask, report creation/read, escalation creation/read and multipart video upload.
Use stable attempt IDs and idempotent archival/report writes. A small local
readiness view and documented start command should eliminate terminal work
during the actual demo.

For one workflow, retrieval can select the applicable versioned procedure
from asset/step identifiers. Return supporting excerpts and procedure IDs;
do not introduce a vector database until retrieval actually needs one.
Validate AI result schemas and referenced procedure IDs. Model confidence
alone must not substitute for adequate evidence and explicit visual criteria.

## Interface

Clean industrial, beautiful and consistent with Mentra. Official Play Store
screenshots show light surfaces, soft gray rounded panels, dark typography and
green branding. Current official Captions source uses Red Hat Display,
`#f4f4f5` background and a muted teal primary (`#6daea6`). Use these as direction,
not evidence that every installed Mentra screen has identical styling.

Prioritise task and asset selection, a numbered procedure list, a prominent
expanded current instruction, clear capture/evaluation state, before/after
evidence, progress after a real pass, concise finding/action and a credible
report. Keep connection settings secondary and put escalation at the bottom of
the workflow. Honour Mentra safe areas and host chrome. Reports and expert
packages live in the miniapp and as JSON/images on the laptop.

## Recording and audio

Start recording with the inspection and stop when the user saves the inspection or completes a reasoned early end. Request the saved recording
and use the SDK stop upload destination to archive the finished video on the
laptop. Retain footage as evidence; training-data processing is out of scope.
Report upload completion only after the server has committed the file.

Prefer native Mentra speech/playback first. Native speak currently uses cloud
TTS; arbitrary audio URLs can use session.speaker.play. Check actual glasses
audio routing on hardware when changing the setup; routing on the tested
setup was confirmed by the maintainer. If native synthesis is unsuitable, evaluate a server-side synthesis fallback.
Hardware access must remain with the Mentra Miniapp SDK.

## Original implementation order and gates

The technical implementation and validation gates below have been completed,
as confirmed by the maintainer. They remain a reference for future changes;
the demonstration packaging notes describe the original delivery plan.

1. Integration spike: identify phone OS, Mentra app version, Live firmware
   and available SDK package; pin compatible versions. Install the official
   current example/local miniapp. Prove button, photo, English transcription,
   speech routing, persistence and laptop fetch. Prove recording+photos+voice
   together and authenticated finished-video upload. Resolve incompatibilities
   before depending on continuous recording in the workflow.
2. Build the configurable state machine and Node service. Archive photos
   independently of AI evaluation; implement private procedure retrieval,
   schema-validated analysis, retry, verification and explicit escalation.
3. Build the polished miniapp UI and report from the same persisted state.
   Show the remaining steps normally while stopping the implemented flow.
4. Validate on actual Live: loose state → guidance → repair → pass → save inspection (or reasoned early end);
   unclear image; AI outage/retry; interruption/relaunch; duplicate commands;
   video upload and before/after archival. Check that untouched steps remain
   pending. Run meaningful state/result/server tests plus build/type checks.
5. Package an installed release, rehearse the roughly 90-second demonstration,
   and document actual SDK/privacy/latency observations and clean repo setup.

## Validated integration topics

The maintainer confirmed that the following checks were completed on the
tested setup. Recheck them when changing hardware, runtime, or AI provider:
- Installed phone/runtime versions versus current source and registry SDK.
- Recording/photo/microphone concurrency and button ownership on Live.
- Video Wi-Fi reachability and preservation/retry after upload failure.
- Actual STT local/cloud routing and glasses speaker routing.
- Photo object retention versus signed download URL expiry.
- Supported background fetch response bodies; no Node filesystem APIs on phone.
- Exact supplied endpoint/model capabilities and authentication.
