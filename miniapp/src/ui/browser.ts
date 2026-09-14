import { InspectionController } from "../shared/controller";
import type { Photo } from "../shared/controller";
import type { MentraTyped } from "@mentra/miniapp/ui";
import type { Channels } from "../shared/channels";

// The browser supplies image bytes; all workflow decisions and persistence
// use the same controller/server as the Mentra background.
export function installBrowserBridge(): boolean {
  if (globalThis.mentra) return false;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emit = (channel: string, payload: unknown) => {
    listeners.get(channel)?.forEach((callback) => {
      callback(payload);
    });
  };
  const controller = new InspectionController({
    load: async () => localStorage.getItem("inspection:real:browser:v1"),
    save: async (value) => localStorage.setItem("inspection:real:browser:v1", value),
    snapshot: (value) => emit("inspection:snapshot", value),
    toast: (kind, text) => emit("inspection:toast", { kind, text }),
    requestEndReason: () => emit("inspection:request-end-reason", {}),
    openInspection: () => emit("inspection:show-inspection", {}),
    capture: async () => {
      throw new Error("Photo capture requires connected glasses inside MentraOS.");
    },
    stopSpeech: () => {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    },
    speak: async (text) => {
      if (!("speechSynthesis" in window)) return;
      speechSynthesis.cancel();
      const speech = new SpeechSynthesisUtterance(text);
      speech.lang = "en-US";
      speechSynthesis.speak(speech);
    },
  });
  const ready = controller.init(`http://${location.hostname || "localhost"}:8787`);
  const run = (action: () => Promise<unknown>) =>
    void ready
      .then(action)
      .catch((error) => emit("inspection:toast", { kind: "error", text: String(error) }));
  const bridge = {
    send(channel: string, payload: unknown) {
      const data = payload as {
        id?: string;
        stepId?: string;
        workflowId?: string;
        kind?: "initial" | "verification";
        photo?: Photo;
        question?: string;
        url?: string;
        reason?: string;
      };
      if (channel === "inspection:request-snapshot") run(() => controller.publish());
      else if (channel === "inspection:refresh-workflows") run(() => controller.refreshWorkflows());
      else if (channel === "inspection:select-workflow")
        run(() => controller.selectWorkflow(data.id || ""));
      else if (channel === "inspection:select-step")
        run(() => controller.selectStep(data.id || ""));
      else if (channel === "inspection:skip-step") run(() => controller.skipStep());
      else if (channel === "inspection:start") run(() => controller.begin(data.workflowId));
      else if (channel === "inspection:pause") run(() => controller.pause());
      else if (channel === "inspection:capture")
        run(() => controller.capture(data.kind || "initial"));
      else if (channel === "inspection:retry-check") run(() => controller.retryCheck());
      else if (channel === "inspection:upload")
        run(() => controller.capture(data.kind || "initial", data.photo, data.stepId));
      else if (channel === "inspection:ask") run(() => controller.ask(data.question));
      else if (channel === "inspection:escalate") run(() => controller.escalate());
      else if (channel === "inspection:finish") run(() => controller.finish(data.reason));
      else if (channel === "inspection:reset") run(() => controller.reset());
      else if (channel === "inspection:set-server") run(() => controller.setServer(data.url || ""));
    },
    on(channel: string, callback: (payload: unknown) => void) {
      const set = listeners.get(channel) || new Set();
      set.add(callback);
      listeners.set(channel, set);
      return () => {
        set.delete(callback);
      };
    },
    async request(channel: string) {
      await ready;
      return channel === "inspection:health" ? controller.health() : controller.state;
    },
    onOpen(callback: () => void) {
      void ready.then(callback);
      return () => {};
    },
    onClose() {
      return () => {};
    },
    ready() {
      run(() => controller.publish());
    },
  };
  globalThis.mentra = bridge as MentraTyped<Channels>;
  return true;
}
