# Sample inspection validation

The included A1 mini procedure implements the purge-limiter seating check.
All other procedure steps must remain pending in the UI and saved reports.

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
