import workflow from "../../../workflows/purge-limiter.json";
import type { InspectionSnapshot, ProcedureStep } from "./types";

const implementedStep = workflow.steps.find((step) => step.status === "implemented");
if (!implementedStep) throw new Error("Workflow must include an implemented inspection step");
export const STEP_ID = implementedStep.stepId;
export const createSnapshot = (serverUrl = "http://192.168.1.42:8787"): InspectionSnapshot => ({
  version: 1,
  workOrder: workflow.workOrder.id,
  asset: {
    id: workflow.asset.id,
    model: workflow.asset.name,
    location: workflow.workOrder.location,
  },
  technician: workflow.asset.technician,
  status: "ready",
  currentStepId: STEP_ID,
  steps: workflow.steps.map(
    (step, index): ProcedureStep => ({
      id: step.stepId,
      number: index + 1,
      title: step.title,
      instruction: step.instruction,
      references:
        "references" in step
          ? {
              loose: `/api/reference?stepId=${encodeURIComponent(step.stepId)}&role=loose`,
              seated: `/api/reference?stepId=${encodeURIComponent(step.stepId)}&role=seated`,
            }
          : undefined,
      state: step.stepId === STEP_ID ? "current" : "pending",
    }),
  ),
  attempts: [],
  evidence: [],
  recording: { status: "idle" },
  serverUrl,
  transcript: "",
});
