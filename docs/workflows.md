# Photo workflows

The companion server loads every `.json` file immediately under `workflows/`
when the work queue refreshes. Each workflow appears as a card; its Start
inspection action selects and starts that workflow. One inspection
is active at a time; switching workflows is unavailable until it ends or resets.
Asset, technician, and work-order metadata remain inside each demo definition.

## Definition

Required workflow fields: unique `procedureId` (letters, digits, underscores,
hyphens), positive integer `version`, `title`, `asset` (`id`, `name`,
`technician`), `workOrder` (`id`, `location`), and a nonempty `steps` array.
Other sample work-order metadata can be retained.

Each step requires a unique `stepId`, `title`, `instruction`, and nonempty
`visualCriteria` list. Optional `captureInstruction`, `successMessage`, and
`limitations` configure phone guidance, speech, and the AI prompt. No
step-specific failure messages are needed: AI findings and actions use the
current step's criteria. Outcomes remain `pass`, `adjustment_required`, and
`evidence_unclear`. Insufficient evidence never passes.

References are optional arrays, including empty arrays:

```json
"references": [
  {
    "role": "good",
    "path": "knowledge/purge-limiter-seated.jpeg",
    "caption": "Limiter aligned and fully seated with no visible gap."
  },
  {
    "role": "bad",
    "path": "knowledge/purge-limiter-loose.jpeg",
    "caption": "Limiter displaced from its mounting slot."
  }
]
```

Multiple examples of either role are supported. Paths must stay within
`knowledge/`, using JPEG, PNG, or WebP files. The UI labels and AI image captions
use good/bad roles; filenames can still describe the actual condition. The
technician's evidence image is always identified separately from references.
Reference images are served through the companion server rather than bundled.

Use [printer inspection](../workflows/a1-mini.json) and
[workstation readiness](../workflows/workstation-readiness.json) as examples.
The lubrication check reads the printer's maintenance panel, requiring an
identifiable, readable lubrication status; absence of a warning on an unrelated
screen cannot pass. It makes no claim about physical lubrication. Build-plate
criteria currently require a visible clean, undamaged surface; refine these
criteria alongside the forthcoming reference photos. Workstation sample tools
are a hex-key set, screwdriver, and side cutters; supplies are a filament spool
and cleaning cloth. These are authored demo requirements.

## Navigation and persistence

A pass advances to the next unfinished step in file order. Skip defers a step
without completing it. Escalation saves a local expert package, keeps the step
unfinished, and advances. At the end, the app wraps to earlier unfinished steps.
If only the current step remains unfinished, it stays current. Select any step
in the phone list, including passed steps for review. Passed steps retain their
results and do not accept new captures. English voice commands include
`skip step`, `next step`, `go back`, and `previous step` alongside existing
capture, verify, guidance, escalation, and finish commands. Spoken guidance does
not hold the action lock. Skip and escalation remain available during playback
and interrupt current speech; voice skip/escalate can also interrupt narration.

Progress is automatically saved on the device; paused inspections resume.
Returning to a step restores its finding, escalation, and pending evaluation.
Retry evaluates that step's archived photo; fresh capture remains available.
Save inspection creates a final report only after every step passes. Ending
earlier requires a reason and produces an incomplete report. Escalation never
counts as a pass or sends an external message. Browser preview supports photo
upload; native capture remains owned by the glasses SDK. Recording stop/upload
and capture-gap behavior are preserved.

## Versions

Definitions are validated and archived to ignored `data/workflows/` on discovery.
Increment `version` whenever editing a discovered definition, including adding
reference photos. Editing an already archived version is rejected with a clear
version error. Existing inspections use their stored version and definition;
new inspections can select the refreshed version. Removing a source file stops
new discovery but does not remove its archived versions. Retain `data/workflows/`
while inspections or reports depend on them.

## Verification

Run the required checks listed in [sample validation](sample-validation.md).
Automated tests exercise selection, out-of-order passes, wraparound, escalation,
per-step retries/guidance, immutable versions, validation, report completion,
and cross-workflow evidence rejection. Automated checks do not establish
upstream model quality or physical-device behavior for new steps.
