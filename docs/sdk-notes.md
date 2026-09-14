# Mentra SDK notes and validation

Inspected official MentraOS source on 2026-09-13 at commit
`fc86f650fdae5bcf974c9d4816b3e9c490f54150`.
The source findings below describe that inspected commit. On 2026-09-14,
the project maintainer confirmed that all previously outstanding AI and
physical-device validation checks passed on the tested setup. This confirmation
is separate from the earlier source investigation and local automated checks.

## V0 dependency selection

Registry inspection during V0 found `latest` tags pointing to older packages.
The current source labels itself 3.2.0, but that exact SDK version is not
published. V0 targets the published `@mentra/miniapp@3.2.0-dev.227` and
`@mentra/miniapp-cli@0.1.0-dev.1` pair. Build verification and device compatibility were checked separately.
The maintainer confirmed compatibility on the tested phone/runtime and glasses;
this does not establish compatibility with every release or device.

During the initial investigation, build/type checks and packaging passed.
Local server health, evidence archival and multipart video upload/status were
exercised. An early simulated browser fixture flow passed loose → seated →
report; that result was not upstream AI or physical-device validation.
Subsequent upstream AI and real-glasses checks passed, as confirmed by the
maintainer on 2026-09-14. The CLI dev process rebuilt on changes despite
our no-hot-reload invocation, racing packaging; browser preview now uses
a small static server and packaging is performed with dev stopped.

## Architecture and development

### Real-flow implementation update

The browser fixture adapter has been removed. Both native Mentra background
and browser photo upload now use `miniapp/src/shared/controller.ts` and the
same server evidence/evaluation/guidance/escalation/report routes. Native
initialization waits for SDK readiness before reading persisted state.
Captured evidence is archived before AI runs, pending evaluations can retry,
and model failures never substitute a fixed finding. Browser mode does not
simulate glasses recording.

Build/type checks and packaging passed. A real server-backed controller run
archived the supplied loose photo, left AI pending with no finding when the
bearer token was empty, and saved an escalation and unresolved report with
zero passed checks. Subsequent model/image evaluation and physical Live
testing passed, including the inspection flow and failure/recovery paths,
as confirmed by the maintainer.

`sdk/docs/two-layer.md` recommends background JavaScriptContext plus on-demand
WebView UI. Use `@mentra/miniapp/background` and `@mentra/miniapp/ui` entry points,
typed UI channels and `init(session)`; background owns hardware and durable
work. Background provides fetch, timers and selected web primitives but no
DOM or Node fs/path/process. Earlier bare-import WebView examples are stale
relative to this architecture.

`sdk/miniapp-cli/README.md`: dev builds/serves a LAN development QR and live
reload; release builds/packs/serves an install QR. Phone path: Settings →
Developer settings → Mini App Development → Scan Mini App QR Code. Installed
release keeps the bundle after laptop shutdown; our AI server still needs
the laptop. Check installed runtime compatibility before pinning packages.

Official examples: `miniapps/captions/` is a current two-layer example;
`sdk/example-miniapp/` is referenced by SDK docs (verify current checkout
location before using). CAMERA and MICROPHONE permissions are required.

## Photos: privacy and reliability limitation

Actual CameraModule source returns `{requestId, photoUrl, mimeType, size}`;
it exposes neither raw image bytes nor a local file URI. `takePhoto` supports
auto/direct/BLE transfer. BLE is a transfer choice, not a cloud bypass.
PhonePhotoCoordinator includes cloud presigning; its tests confirm a presign
failure skips BLE capture. Therefore capture success cannot currently be
treated as independent of cloud/upload availability through this public API.

CameraModule describes a roughly 30-minute signed download URL. The older
camera documentation describes 24-hour cloud storage TTL. These refer to
different lifetimes: signed URL expiry must not be equated with object
deletion. The maintainer confirmed retention/expiry checks on the tested
setup; these historical source values are not a universal retention policy.
Archive successful photo URLs to laptop bytes promptly, before AI processing.
Persist pending URL metadata, but label durable evidence saved only after
archival succeeds. Gallery options do not expose a miniapp file-read API.

## Video: newer source extends the documentation

`startVideoRecording({width,height,fps,sound,save})` returns a recordingId.
Current source additionally has
`stopVideoRecording(recordingId,{uploadUrl,uploadAuthToken})`, allowing direct
glasses multipart POST (`video` part) to a customer endpoint with bearer auth.
The older camera doc omits these stop options. PhoneVideoCoordinator forwards
them. Use `save:true` for retention. The maintainer confirmed finished-video
upload and recovery, glasses Wi-Fi reachability, and the recording/photo/voice
workflow on hardware. This includes the app’s stop-before-photo and recording
resume behavior; it does not imply simultaneous camera operations.

## Input, persistence and speech

`session.input.onButtonPress` receives buttonId and short/long pressType.
`session.storage` get/set/delete/list stores strings locally scoped by user
and package. The app persists JSON snapshots and archives image bytes on
the server; it does not depend on image-byte storage through `session.storage`.
Transcription docs support `forLanguage("en-US", handler)` with isFinal and
describe cloud STT. The maintainer confirmed transcription and routing checks
on the tested runtime; the app is not described as an offline speech pipeline.

`session.speaker.speak` uses the cloud TTS pipeline; `play({audioUrl})` plays
an arbitrary audio URL via phone playback. The maintainer confirmed actual
Live speaker routing on hardware. A server-side speech synthesis service is a possible fallback. Hardware
access stays with the Miniapp SDK.

Stream documentation explicitly calls its runtime path deferred/placeholders;
do not choose RTMP streaming based only on SDK method presence.

## Visual references

Inspected official Play Store screenshot showing white interface, soft gray
rounded panels, black text and green Mentra branding. Current Captions UI CSS
uses Red Hat Display, light `#f4f4f5` background and muted teal primary.
Use source tokens and host-safe-area adapters alongside industrial workflow UI.

## Sources

- [Official source at inspected commit](https://github.com/Mentra-Community/MentraOS/tree/fc86f650fdae5bcf974c9d4816b3e9c490f54150)
- [Official app screenshots](https://play.google.com/store/apps/details?id=com.mentra.mentra)
- [Official SDK access guidance](https://mentrahelp.zendesk.com/hc/en-us/articles/47582365021588-Can-I-access-the-SDK-for-development-or-integration)

Keep future source findings and device observations separate. Revalidate
compatibility and routing when changing the SDK, phone runtime, or firmware.

## Developer-menu correction after setup interview

Current `mobile/src/app/miniapps/settings/main.tsx` exposes Miniapp Developer
Settings under Advanced without a debugMode condition. Its `miniapp-dev.tsx`
screen exposes a QR scanner, URL loader and a toggle for showing development
tools on the home screen. This differs from the CLI README's older menu path.
The public app inspected during initial setup did not show the originally
described menu. Developer setup and installation were subsequently validated,
as confirmed by the maintainer. Menu paths remain dependent on the installed
app version; the initial source observation is historical.
