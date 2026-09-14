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
  references?: { loose: string; seated: string };
}

export interface RecordingState {
  recordingId?: string;
  startedAt?: number;
  status: "idle" | "recording" | "stopped" | "uploading" | "uploaded" | "interrupted" | "error";
  sessionId?: string;
  uploadUrl?: string;
  clips?: Array<Omit<RecordingState, "clips">>;
}

export interface InspectionSnapshot {
  version: 1;
  workOrder: string;
  asset: { id: string; model: string; location: string };
  technician: string;
  startedAt?: number;
  pausedAt?: number;
  finishedAt?: number;
  termination?: { reason: string; endedAt: number };
  status: InspectionStatus;
  currentStepId: string | null;
  operation?: "start" | "capture" | "ask" | "escalate" | "finish" | "reset";
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

export interface ServerHealth {
  ok: boolean;
  aiConfigured?: boolean;
  model?: string;
  message?: string;
}
