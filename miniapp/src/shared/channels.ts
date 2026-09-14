import type { Rpc } from "@mentra/miniapp/ui";
import type { EvaluationResponse, InspectionSnapshot, ServerHealth } from "./types";

export interface Channels {
  "inspection:snapshot": InspectionSnapshot;
  "inspection:transcript": { text: string };
  "inspection:toast": { kind: "info" | "success" | "warning" | "error"; text: string };
  "inspection:request-snapshot": Record<string, never>;
  "inspection:show-inspection": Record<string, never>;
  "inspection:refresh-workflows": Record<string, never>;
  "inspection:select-workflow": { id: string };
  "inspection:select-step": { id: string };
  "inspection:skip-step": Record<string, never>;
  "inspection:start": { workflowId?: string };
  "inspection:pause": Record<string, never>;
  "inspection:capture": { kind: "initial" | "verification" };
  "inspection:retry-check": Record<string, never>;
  "inspection:ask": { question?: string };
  "inspection:escalate": Record<string, never>;
  "inspection:finish": { reason?: string };
  "inspection:reset": Record<string, never>;
  "inspection:request-end-reason": Record<string, never>;
  "inspection:set-server": { url: string };
  "inspection:health": Rpc<Record<string, never>, ServerHealth>;
  "inspection:report": Rpc<Record<string, never>, InspectionSnapshot>;
  "inspection:upload": {
    stepId: string;
    kind: "initial" | "verification";
    photo: { photoUrl: string; mimeType: string };
  };
}

declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>;
}

export type { EvaluationResponse };
