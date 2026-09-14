import { configuredServerUrl } from "./server-url";
import type { InspectionSnapshot, WorkflowDefinition } from "./types";

export const createSnapshot = (
  serverUrl = configuredServerUrl || "http://192.168.1.42:8787",
  workflow?: WorkflowDefinition,
): InspectionSnapshot => ({
  version: 1,
  workflow,
  procedureId: workflow?.id,
  procedureVersion: workflow?.version,
  procedureTitle: workflow?.title,
  workOrder: workflow?.workOrder.id || "",
  asset: {
    id: workflow?.asset.id || "",
    model: workflow?.asset.name || "Choose an inspection",
    location: workflow?.workOrder.location || "",
  },
  technician: workflow?.asset.technician || "",
  status: "ready",
  currentStepId: workflow?.steps[0]?.stepId || null,
  steps:
    workflow?.steps.map(({ stepId, ...step }, index) => ({
      ...step,
      id: stepId,
      number: index + 1,
      state: index === 0 ? "current" : "pending",
    })) || [],
  attempts: [],
  evidence: [],
  recording: { status: "idle" },
  serverUrl,
  transcript: "",
});
