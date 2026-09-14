import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import type { JsonObject, Procedure, ProcedureStep } from "./types.js";
import { publicUrl } from "./utils.js";

export async function loadProcedure(): Promise<Procedure> {
  const value = JSON.parse(await readFile(config.procedurePath, "utf8")) as JsonObject;
  return {
    procedureId: String(value.procedureId),
    version: Number(value.version),
    title: String(value.title),
    asset: (value.asset || {}) as JsonObject,
    workOrder: (value.workOrder || {}) as JsonObject,
    steps: (value.steps || []) as ProcedureStep[],
  };
}

function referencePath(stepId: string, role: "loose" | "seated"): string {
  return `/api/reference?stepId=${encodeURIComponent(stepId)}&role=${role}`;
}

export function procedureContext(procedure: Procedure, req?: IncomingMessage): JsonObject {
  return {
    id: procedure.procedureId,
    version: procedure.version,
    title: procedure.title,
    steps: procedure.steps.map(({ references, ...step }) => ({
      ...step,
      ...(req && references
        ? {
            references: {
              loose: publicUrl(req, referencePath(step.stepId, "loose")),
              seated: publicUrl(req, referencePath(step.stepId, "seated")),
            },
          }
        : {}),
    })),
  };
}

function objectArray(snapshot: JsonObject, key: string): JsonObject[] {
  const values = snapshot[key];
  return Array.isArray(values)
    ? values.filter((value): value is JsonObject =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)),
      )
    : [];
}

export function snapshotDetails(snapshot: JsonObject, procedure: Procedure): JsonObject {
  const steps = objectArray(snapshot, "steps");
  const attempts = objectArray(snapshot, "attempts");
  const evidence = objectArray(snapshot, "evidence");
  const pendingSteps = steps.filter((step) => step.state !== "passed");
  const issues = attempts
    .filter((attempt) => attempt.status === "adjustment_required")
    .map((attempt) => ({
      attemptId: attempt.id,
      evidenceId: attempt.evidenceId || null,
      status: attempt.status,
      finding: (attempt.finding as JsonObject | undefined)?.finding || null,
      recommendedAction: (attempt.finding as JsonObject | undefined)?.recommendedAction || null,
    }));
  const resolutions = attempts
    .filter((attempt) => attempt.status === "pass")
    .map((attempt) => ({
      attemptId: attempt.id,
      evidenceId: attempt.evidenceId || null,
      finding: (attempt.finding as JsonObject | undefined)?.finding || null,
      action: (attempt.finding as JsonObject | undefined)?.recommendedAction || null,
    }));
  const before = evidence.find((item) => item.kind === "initial") || null;
  const after = [...evidence].reverse().find((item) => item.kind === "verification") || null;
  const termination =
    snapshot.termination &&
    typeof snapshot.termination === "object" &&
    !Array.isArray(snapshot.termination)
      ? (snapshot.termination as JsonObject)
      : null;
  return {
    procedure: procedureContext(procedure),
    workOrder: snapshot.workOrder || procedure.workOrder,
    asset: snapshot.asset || procedure.asset,
    currentStepId: snapshot.currentStepId || null,
    status: snapshot.status || "unknown",
    pendingSteps,
    issues,
    resolutions,
    evidenceQualityIssues: attempts.filter((attempt) => attempt.status === "evidence_unclear"),
    guidance: snapshot.guidance || null,
    beforeAfter: { before, after },
    evidence,
    recording: snapshot.recording || null,
    latestFinding: snapshot.latestFinding || null,
    termination,
    terminationReason: typeof termination?.reason === "string" ? termination.reason : null,
  };
}

export function validateReportTermination(
  body: JsonObject,
  procedure: Procedure,
): JsonObject | undefined {
  const implementedStep = procedure.steps.find((step) => step.status === "implemented");
  const steps = objectArray(body, "steps");
  const implementedPassed =
    implementedStep !== undefined &&
    steps.some((step) => step.id === implementedStep.stepId && step.state === "passed");
  const supplied = Object.hasOwn(body, "termination");
  if (!supplied && !implementedPassed)
    throw new RequestError(
      400,
      "TERMINATION_REASON_REQUIRED",
      "A termination reason is required while the implemented purge-limiter check is unresolved",
    );
  if (!supplied) return undefined;
  const value = body.termination;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "INVALID_TERMINATION", "termination must include a reason");
  const termination = value as JsonObject;
  if (typeof termination.reason !== "string" || termination.reason.trim() === "")
    throw new RequestError(400, "INVALID_TERMINATION", "termination.reason is required");
  const reason = termination.reason.trim();
  if (reason.length > 2000)
    throw new RequestError(
      400,
      "INVALID_TERMINATION",
      "termination.reason must be 2000 characters or fewer",
    );
  return { ...termination, reason };
}
