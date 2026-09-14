# Sample inspection validation

The current printer workflow includes purge limiter, panel lubrication status,
and build plate. Workstation readiness is also discoverable. The acceptance
flow below describes the previously validated single-step demo. Its device/AI
results do not establish the new multi-step behavior.

On 2026-09-14, the project maintainer confirmed that this acceptance flow
and all recovery checks below passed with the configured AI endpoint and
physical Live glasses. The steps remain a repeatable regression checklist.

1. Select the sample inspection task and start with the purge limiter loose.
2. Start inspection. On native Mentra, capture with the short glasses button;
   in browser preview, select a reference image or upload a photo.
3. With a configured vision endpoint, the loose reference should produce an
   adjustment request. Ask “What should I do?” for authored procedure guidance.
4. Slide the limiter horizontally until seated. Say “Verify” or press the
   glasses button to capture a fresh photo. A clear fitted image should pass
   automatically and update progress.
5. Save inspection. Confirm the report contains evidence and the passed check,
   with all untouched checks pending. Ending before a pass requires a reason.

To rehearse from a clean phone state, open the inspection overflow menu, choose
**Reset inspection**, and confirm. This clears the saved snapshot on the phone;
server evidence and recordings remain available for review.

Use `knowledge/purge-limiter-loose.jpeg` and
`knowledge/purge-limiter-seated.jpeg` as the sample references. Visible seating
does not establish hidden fastening strength or machine safety.

Also check unclear framing, AI outage and retry, archival failure, duplicate
commands, interruption and resume, report persistence, and explicit escalation.
Retry check reuses saved evidence after an AI failure; Verify always captures
a fresh photo. Escalation creates a local expert package and sends no message.

Returning to the queue, hiding the inspection, or closing the miniapp pauses
it and requests recording stop/upload. Resume starts a new clip associated
with the same inspection. Hardware validation included an in-flight recording
start. Browser mode does not validate native recording behavior; those checks
were completed separately on hardware.

## Generic workflow regression checks

1. Refresh the work queue and confirm both workflow cards appear. Start each and
   confirm its metadata, steps, and criteria change. No miniapp rebuild is needed
   to discover another valid JSON definition.
2. Start printer inspection. Skip purge limiter, select build plate, and pass
   it with adequate evidence. Confirm navigation wraps to purge limiter, then
   reaches lubrication once purge limiter passes.
3. Escalate an unresolved step: confirm its local package is saved, navigation
   advances, and the original step remains unfinished.
4. Simulate an AI outage, move away, then return. Retry must evaluate the original
   step's saved evidence. Guidance and findings must refer to the selected step.
5. Pause/reopen and confirm workflow version, progress, evidence, and retries
   remain. Increment a source definition's version and refresh; an active
   inspection must retain its earlier definition.
6. Save is available when all steps pass. Early end still requires a reason.
   Reports must group photos/attempts per step and retain escalation markers.
7. Add lubrication/build-plate reference photos under `knowledge/`, caption them
   as good/bad, and increment the printer workflow version. Validate both expected
   conditions and unclear images against the configured AI endpoint and Live.

Required local checks:

```sh
bun run check
bun run build
bun run --cwd miniapp typecheck
bun run --cwd server typecheck
bun test miniapp/tests
```

The new photo checks and navigation still require device/AI acceptance testing.

For clip timing, capture a photo during recording, then save/pause. Confirm
clip indices increase, inspection ID remains stable, and each upload sidecar
contains start/stop request times plus the SDK stop confirmation after sync.
With ffprobe installed, compare `durationSeconds` to the original file's media
duration. Verify a missing ffprobe preserves upload with duration unavailable.
Check resume after interruption retries any retained stop-confirmation sync.
