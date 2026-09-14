export type JsonObject = Record<string, unknown>;
export type EvaluationStatus = "pass" | "adjustment_required" | "evidence_unclear";

export interface ProcedureStep {
  stepId: string;
  title: string;
  instruction: string;
  status: string;
  visualCriteria?: string[];
  limitations?: string[];
  references?: { loose: string; seated: string };
}

export interface Procedure {
  procedureId: string;
  version: number;
  title: string;
  asset: JsonObject;
  workOrder: JsonObject;
  steps: ProcedureStep[];
}

export interface EvidenceRecord {
  id: string;
  attemptId: string;
  stepId: string;
  kind: string;
  mimeType: string;
  sourceUrl: string;
  photoUrl: string;
  photoPath: string;
  url: string;
  file: string;
  bytes: number;
  createdAt: number;
  archived: boolean;
  evaluation?: JsonObject;
}

export interface AICallResult {
  content: unknown;
  status: number;
  finishReason: string | number | boolean | null;
  contentType: string;
  contentLength: number;
  outputType: string;
  outputChars: number;
  durationMs: number;
  rawExcerpt: string;
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}
