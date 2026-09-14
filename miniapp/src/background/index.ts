import { configuredServerUrl } from "../shared/server-url";
import { registerMiniapp } from "@mentra/miniapp/background";
import { InspectionController } from "../shared/controller";
import type { Channels } from "../shared/channels";
const STORAGE_KEY = "inspection:real:v1";

function safeError(error: unknown): {
  error: string;
  code?: string;
  cause?: string;
  stage?: string;
  transport?: string;
} {
  const object =
    error && typeof error === "object"
      ? (error as {
          message?: unknown;
          code?: unknown;
          cause?: unknown;
          stage?: unknown;
          transport?: unknown;
        })
      : undefined;
  const raw =
    typeof object?.message === "string"
      ? object.message
      : typeof error === "string"
        ? error
        : "Unknown error";
  const sanitize = (value: string) =>
    value
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/data:[^\s,]+,[^\s]*/gi, "[media]")
      .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(
        /(?:token|authorization|api[-_ ]?key|prompt|question|text)\s*[:=]\s*\S+/gi,
        "[redacted]",
      )
      .slice(0, 240);
  const message = sanitize(raw);
  const cause =
    object?.cause !== undefined
      ? sanitize(
          typeof object.cause === "string"
            ? object.cause
            : object.cause instanceof Error
              ? object.cause.message
              : "Unknown cause",
        )
      : undefined;
  const code =
    typeof object?.code === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(object.code)
      ? object.code
      : undefined;
  const stage =
    typeof object?.stage === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(object.stage)
      ? object.stage
      : undefined;
  const transport =
    typeof object?.transport === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(object.transport)
      ? object.transport
      : undefined;
  return {
    error: message,
    ...(code ? { code } : {}),
    ...(cause ? { cause } : {}),
    ...(stage ? { stage } : {}),
    ...(transport ? { transport } : {}),
  };
}

function diagnostic(event: string, fields: Record<string, unknown> = {}) {
  console.info("[inspection]", { event, ...fields });
}

registerMiniapp<Channels>((session) => {
  const instanceId = `background-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let active = true;
  let buttonPending = false;
  let lastButtonAt = 0;
  session.onBeforeDisconnect(() => {
    active = false;
    diagnostic("background:stop", { instanceId });
  });
  diagnostic("background:start", {
    instanceId,
    hasCamera: Boolean(session.capabilities?.hasCamera),
    hasPermission: Boolean(session.camera.hasPermission),
  });
  const controller = new InspectionController({
    load: async () => {
      await session.waitForReady();
      return session.storage.get(STORAGE_KEY);
    },
    save: (value) => session.storage.set(STORAGE_KEY, value),
    snapshot: (value) => session.ui.send("inspection:snapshot", value),
    toast: (kind, text) => session.ui.send("inspection:toast", { kind, text }),
    requestEndReason: () => session.ui.send("inspection:request-end-reason", {}),
    openInspection: () => session.ui.send("inspection:show-inspection", {}),
    capture: async () => {
      const startedAt = Date.now();
      const hasCamera = Boolean(session.capabilities?.hasCamera);
      const hasPermission = Boolean(session.camera.hasPermission);
      diagnostic("camera:capture-start", {
        instanceId,
        hasCamera,
        hasPermission,
        size: "medium",
        recordingStatus: controller.state.recording.status,
      });
      if (!hasPermission || !hasCamera) {
        const error = new Error("Connect Mentra Live and allow the camera permission.");
        diagnostic("camera:capture-failure", {
          ...safeError(error),
          reason: !hasCamera ? "camera-unavailable" : "permission-denied",
        });
        throw error;
      }
      try {
        const photo = await session.camera.takePhoto({
          size: "medium",
          compress: "medium",
          sound: true,
          saveToGallery: true,
        });
        diagnostic("camera:photo-ready", {
          instanceId,
          mimeType: photo.mimeType,
          elapsedMs: Date.now() - startedAt,
        });
        return photo;
      } catch (error) {
        diagnostic("camera:capture-failure", {
          instanceId,
          ...safeError(error),
          elapsedMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
    stopSpeech: () => session.speaker.stop(),
    speak: async (text) => {
      await session.speaker.speak(text, { stopOtherAudio: true });
    },
    startRecording: () => session.camera.startVideoRecording({ fps: 30, save: true, sound: true }),
    stopRecording: (id, uploadUrl) => session.camera.stopVideoRecording(id, { uploadUrl }),
  });
  const ready = controller.init(configuredServerUrl, true);
  const run = (action: () => Promise<unknown>) => {
    void ready
      .then(() => (active ? action() : undefined))
      .catch((error) => {
        diagnostic("background:unexpected", { instanceId, ...safeError(error) });
        session.ui.send("inspection:toast", {
          kind: "error",
          text: "Something went wrong. Please try again.",
        });
      });
  };
  session.ui.on("inspection:request-snapshot", () => run(() => controller.publish()));
  session.ui.on("inspection:refresh-workflows", () => run(() => controller.refreshWorkflows()));
  session.ui.on("inspection:select-workflow", ({ id }) => run(() => controller.selectWorkflow(id)));
  session.ui.on("inspection:select-step", ({ id }) => run(() => controller.selectStep(id)));
  session.ui.on("inspection:skip-step", () => run(() => controller.skipStep()));
  session.ui.on("inspection:start", ({ workflowId }) => run(() => controller.begin(workflowId)));
  session.ui.on("inspection:pause", () => {
    void controller
      .pause()
      .catch((error) => diagnostic("inspection:pause-failure", safeError(error)));
  });
  session.ui.on("inspection:capture", ({ kind }) => run(() => controller.capture(kind)));
  session.ui.on("inspection:retry-check", () => run(() => controller.retryCheck()));
  session.ui.on("inspection:ask", ({ question }) => run(() => controller.ask(question)));
  session.ui.on("inspection:escalate", () => run(() => controller.escalate()));
  session.ui.on("inspection:finish", ({ reason }) => run(() => controller.finish(reason)));
  session.ui.on("inspection:reset", () => run(() => controller.reset()));
  session.ui.on("inspection:set-server", ({ url }) => run(() => controller.setServer(url)));
  session.ui.handle("inspection:health", async () => {
    await ready;
    return controller.health();
  });
  session.ui.handle("inspection:report", async () => {
    await ready;
    return controller.state;
  });
  session.ui.onOpen(() => run(() => controller.publish()));
  const pauseOnLeave = () => {
    void controller
      .pause()
      .catch((error) =>
        diagnostic("inspection:pause-failure", { instanceId, ...safeError(error) }),
      );
  };
  session.ui.onClose(pauseOnLeave);
  session.onVisibilityChange((visibility) => {
    if (visibility === "background") pauseOnLeave();
  });
  session.onBeforeDisconnect(pauseOnLeave);
  session.input.onButtonPress(({ pressType, buttonId }) => {
    const status = controller.state.status;
    const now = Date.now();
    const blockedBy = !active
      ? "disconnected"
      : controller.state.pausedAt
        ? "paused"
        : buttonPending || controller.busy
          ? "busy"
          : now - lastButtonAt < 750
            ? "duplicate"
            : ["ready", "report"].includes(status)
              ? status
              : pressType === "short"
                ? undefined
                : "press-type";
    const accepted = blockedBy === undefined;
    diagnostic("button:press", {
      instanceId,
      buttonId,
      pressType,
      action: accepted ? "accepted" : "ignored",
      ...(blockedBy ? { reason: blockedBy } : {}),
      status,
    });
    if (accepted) {
      buttonPending = true;
      lastButtonAt = now;
      void ready
        .then(() =>
          active
            ? controller.capture(
                controller.state.evidence.some(
                  (evidence) => evidence.stepId === controller.state.currentStepId,
                )
                  ? "verification"
                  : "initial",
              )
            : undefined,
        )
        .catch((error) => diagnostic("background:unexpected", { instanceId, ...safeError(error) }))
        .finally(() => {
          buttonPending = false;
        });
    }
  });
  session.transcription.on((data) => {
    const english = !data.language || /^en(?:-|$)/i.test(data.language);
    diagnostic("voice:transcript", {
      instanceId,
      isFinal: data.isFinal,
      language: data.language,
      textLength: data.text?.length || 0,
      action: english ? "received" : "ignored",
    });
    if (english && data.isFinal && data.text?.trim()) run(() => controller.transcript(data.text));
  });
  void ready.then(async () => {
    if (!active) return;
    try {
      await session.transcription.configure({
        languageHints: ["en"],
        vocabulary: ["start inspection", "verify", "escalate", "finish inspection"],
      });
      diagnostic("voice:ready", {
        instanceId,
        language: "en",
        hasPermission: session.transcription.hasPermission,
      });
    } catch (error) {
      diagnostic("voice:configuration-failure", { instanceId, ...safeError(error) });
    }
  });
});
