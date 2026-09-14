# Known limitations

Recorded on 2026-09-14. These limitations distinguish platform constraints
from the current implementation scope. SDK source findings refer to the
2026-09-13 investigation documented in [SDK notes](sdk-notes.md).

## Media and speech are not fully offline or private

Mentra's public photo API returns a signed download URL rather than raw image
bytes or a local file URI. The inspected implementation involves cloud upload
and presigning, including when BLE transfer is selected. BLE does not establish
a cloud bypass. Native transcription and text-to-speech also use cloud services.

Local evidence archival does not make the entire capture path local. Signed
URL expiry and stored-object deletion are separate lifetimes; neither should
be treated as a universal retention policy. Successful captures are archived
promptly so durable evidence does not depend on the signed URL remaining valid.

## Photo capture interrupts video recording

The implemented flow stops video recording before taking a photo and resumes
recording afterward with a new clip. Inspection footage therefore contains
capture gaps rather than one uninterrupted recording. Previous clips remain
associated with the inspection. The tested workflow does not establish support
for simultaneous photo capture and video recording.

## Photo previews cannot appear immediately

The glasses must capture and transfer a photo before the app can display it.
Smaller captures and lightweight previews reduce the delay, but the app cannot
show the actual image before the SDK returns it. The processing dialog shows
a capture illustration while waiting and displays the photo once available.

## SDK and runtime compatibility are version-sensitive

During development, registry `latest` tags lagged the inspected source,
documentation omitted newer capabilities, and developer-menu instructions
differed between app versions. The project pins the tested SDK/CLI pair:
`@mentra/miniapp@3.2.0-dev.227` and `@mentra/miniapp-cli@0.1.0-dev.1`.

Build success does not establish device compatibility. Revalidate hardware
behavior when changing the SDK, phone runtime, or glasses firmware; successful
validation on one setup does not establish compatibility with every release
or device.

## The host constrains UI layout and lifecycle

Mentra owns the native minimize and close controls. Headers, dialogs, and fixed
actions must respect the host's measured control positions and safe areas.
These controls cannot be treated as ordinary elements owned by the React UI.

Closing or hiding the miniapp can tear down its runtime. Recording stop must
be dispatched promptly rather than delayed behind storage or other awaited
work. Save, early end, pause, close, and recording starts still in flight must
preserve the stop/upload lifecycle.

The background JavaScript context also has no DOM or Node filesystem APIs;
hardware and durable work belong in the background layer, while the phone
interface belongs in the WebView.

## Live streaming is not an established capability

The inspected stream documentation described deferred or placeholder runtime
paths. SDK method presence alone does not establish working RTMP streaming.
The current inspection implementation records and uploads finished clips;
it does not implement live expert video streaming.