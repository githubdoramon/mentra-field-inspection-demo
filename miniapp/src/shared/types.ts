export type InspectionStatus =
  | "ready"
  | "recording"
  | "capturing"
  | "evaluating"
  | "adjustment_required"
  | "evidence_unclear"
  | "passed"
  | "report"
  | "error";
export type EvaluationStatus = "pass" | "adjustment_required" | "evidence_unclear";

export interface Evidence {
  id: string;
  attemptId: string;
  stepId: string;
  kind: "initial" | "verification";
  photoUrl: string;
  photoPath?: string;
  previewDataUrl?: string;
  mimeType: string;
  createdAt: number;
  archived: boolean;
}

export interface Finding {
  status: EvaluationStatus;
  finding: string;
  recommendedAction: string;
  procedureReference: string;
}

export interface Attempt {
  stepId: string;
  id: string;
  kind: "initial" | "verification";
  status: "capturing" | "pending" | EvaluationStatus;
  sourcePhoto?: { photoUrl: string; mimeType: string };
  evidenceId?: string;
  finding?: Finding;
  createdAt: number;
}

export interface ProcedureStep {
  id: string;
  number: number;
  title: string;
  instruction: string;
  state: "current" | "pending" | "passed";
  captureInstruction?: string;
  successMessage?: string;
  visualCriteria?: string[];
  limitations?: string[];
  references?: Array<{ role: "good" | "bad"; url: string; caption: string }>;
  escalation?: { id: string; createdAt: number; status: string; url?: string };
}

export interface RecordingState {
  inspectionId?: string;
  clipIndex?: number;
  startRequestedAt?: number;
  stopRequestedAt?: number;
  stopConfirmedAt?: number;
  durationSeconds?: number | null;
  durationStatus?: "available" | "unavailable";
  uploadedAt?: string;
  recordingId?: string;
  startedAt?: number;
  status: "idle" | "recording" | "stopped" | "uploading" | "uploaded" | "interrupted" | "error";
  sessionId?: string;
  uploadUrl?: string;
  clips?: Array<Omit<RecordingState, "clips">>;
}

export interface InspectionSnapshot {
  version: 1;
  procedureId?: string;
  procedureVersion?: number;
  procedureTitle?: string;
  workflow?: WorkflowDefinition;
  workflows?: WorkflowDefinition[];
  workOrder: string;
  asset: { id: string; model: string; location: string };
  technician: string;
  startedAt?: number;
  pausedAt?: number;
  finishedAt?: number;
  termination?: { reason: string; endedAt: number };
  status: InspectionStatus;
  currentStepId: string | null;
  operation?: "navigate" | "start" | "capture" | "ask" | "escalate" | "finish" | "reset";
  steps: ProcedureStep[];
  attempts: Attempt[];
  evidence: Evidence[];
  latestFinding?: Finding;
  escalation?: { id: string; createdAt: number; status: string; url?: string };
  recording: RecordingState;
  serverUrl: string;
  transcript: string;
  report?: { id: string; url: string };
  guidance?: { question: string; answer: string; procedureReference: string };
  message?: string;
  pendingPhoto?: { photoUrl: string; mimeType: string; attemptId: string };
}

export interface EvaluationResponse {
  evidenceId: string;
  stepId: string;
  status: EvaluationStatus;
  finding: string;
  recommendedAction: string;
  procedureReference: string;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  title: string;
  asset: { id: string; name: string; technician: string };
  workOrder: { id: string; location: string };
  steps: Array<Omit<ProcedureStep, "id" | "number" | "state"> & { stepId: string }>;
}

export interface ServerHealth {
  ok: boolean;
  aiConfigured?: boolean;
  model?: string;
  message?: string;
}
