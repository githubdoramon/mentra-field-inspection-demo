import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import type { JsonObject, Procedure } from "./types.js";

export function validateProcedure(value: unknown): Procedure {
  const invalid = () => {
    throw new RequestError(
      400,
      "INVALID_WORKFLOW",
      "Workflow requires a unique ID, version, asset, work order, and photo steps with criteria",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const p = value as Procedure;
  if (
    typeof p.procedureId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(p.procedureId) ||
    !Number.isInteger(p.version) ||
    p.version < 1 ||
    typeof p.title !== "string" ||
    !p.title.trim() ||
    !p.asset ||
    !p.workOrder ||
    !Array.isArray(p.steps) ||
    !p.steps.length
  )
    return invalid();
  for (const [object, keys] of [
    [p.asset, ["id", "name", "technician"]],
    [p.workOrder, ["id", "location"]],
  ] as const)
    for (const key of keys)
      if (typeof object[key] !== "string" || !String(object[key]).trim()) return invalid();
  const ids = new Set<string>();
  for (const step of p.steps) {
    if (
      !step ||
      typeof step.stepId !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(step.stepId) ||
      ids.has(step.stepId) ||
      typeof step.title !== "string" ||
      !step.title.trim() ||
      typeof step.instruction !== "string" ||
      !step.instruction.trim() ||
      !Array.isArray(step.visualCriteria) ||
      !step.visualCriteria.length ||
      step.visualCriteria.some((c) => typeof c !== "string" || !c.trim())
    )
      return invalid();
    ids.add(step.stepId);
    for (const key of ["captureInstruction", "successMessage"] as const)
      if (step[key] !== undefined && typeof step[key] !== "string") return invalid();
    if (
      step.limitations !== undefined &&
      (!Array.isArray(step.limitations) || step.limitations.some((c) => typeof c !== "string"))
    )
      return invalid();
    if (
      step.references !== undefined &&
      (!Array.isArray(step.references) ||
        step.references.some(
          (r) =>
            !r ||
            !["good", "bad"].includes(r.role) ||
            typeof r.caption !== "string" ||
            !r.caption.trim() ||
            typeof r.path !== "string" ||
            !/^knowledge\/[a-zA-Z0-9_./-]+\.(jpeg|jpg|png|webp)$/.test(r.path) ||
            r.path.split("/").includes(".."),
        ))
    )
      return invalid();
  }
  return p;
}

let discovery: Promise<Procedure[]> | undefined;
export async function discoverProcedures(): Promise<Procedure[]> {
  if (!discovery)
    discovery = readProcedures().finally(() => {
      discovery = undefined;
    });
  return discovery;
}

async function readProcedures(): Promise<Procedure[]> {
  const procedures: Procedure[] = [];
  const ids = new Set<string>();
  await mkdir(join(config.data, "workflows"), { recursive: true });
  for (const file of (await readdir(config.workflows)).filter((f) => f.endsWith(".json")).sort()) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(config.workflows, file), "utf8"));
    } catch {
      throw new RequestError(
        400,
        "INVALID_WORKFLOW",
        `Cannot read valid workflow JSON from ${file}`,
      );
    }
    const procedure = validateProcedure(value);
    if (ids.has(procedure.procedureId))
      throw new RequestError(400, "DUPLICATE_WORKFLOW", "Workflow IDs must be unique");
    ids.add(procedure.procedureId);
    const path = join(
      config.data,
      "workflows",
      `${procedure.procedureId}-v${procedure.version}.json`,
    );
    const encoded = JSON.stringify(procedure);
    try {
      await writeFile(path, encoded, { flag: "wx" });
    } catch (cause) {
      if ((cause as { code?: string }).code !== "EEXIST") throw cause;
      if (JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !== encoded)
        throw new RequestError(
          409,
          "WORKFLOW_VERSION_CHANGED",
          `Increment the version of ${procedure.procedureId} after editing its definition`,
        );
    }
    procedures.push(procedure);
  }
  return procedures;
}

export async function loadProcedure(identity: JsonObject = {}): Promise<Procedure> {
  if (
    typeof identity.procedureId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(identity.procedureId) ||
    !Number.isInteger(identity.procedureVersion) ||
    Number(identity.procedureVersion) < 1
  )
    throw new RequestError(
      400,
      "WORKFLOW_REQUIRED",
      "procedureId and procedureVersion are required",
    );
  try {
    return validateProcedure(
      JSON.parse(
        await readFile(
          join(
            config.data,
            "workflows",
            `${identity.procedureId}-v${identity.procedureVersion}.json`,
          ),
          "utf8",
        ),
      ),
    );
  } catch (cause) {
    if (cause instanceof RequestError) throw cause;
    throw new RequestError(
      404,
      "WORKFLOW_NOT_FOUND",
      "Discover workflows before selecting a workflow version",
    );
  }
}

export function procedureContext(procedure: Procedure, _req?: IncomingMessage): JsonObject {
  return {
    id: procedure.procedureId,
    version: procedure.version,
    title: procedure.title,
    asset: procedure.asset,
    workOrder: procedure.workOrder,
    steps: procedure.steps.map(({ references, ...step }) => ({
      ...step,
      references: (references || []).map((r, index) => ({
        role: r.role,
        caption: r.caption,
        url: `/api/reference?procedureId=${encodeURIComponent(procedure.procedureId)}&procedureVersion=${procedure.version}&stepId=${encodeURIComponent(step.stepId)}&index=${index}`,
      })),
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
      stepId: attempt.stepId,
      attemptId: attempt.id,
      evidenceId: attempt.evidenceId || null,
      status: attempt.status,
      finding: (attempt.finding as JsonObject | undefined)?.finding || null,
      recommendedAction: (attempt.finding as JsonObject | undefined)?.recommendedAction || null,
    }));
  const resolutions = attempts
    .filter((attempt) => attempt.status === "pass")
    .map((attempt) => ({
      stepId: attempt.stepId,
      attemptId: attempt.id,
      evidenceId: attempt.evidenceId || null,
      finding: (attempt.finding as JsonObject | undefined)?.finding || null,
      action: (attempt.finding as JsonObject | undefined)?.recommendedAction || null,
    }));
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
    stepDetails: procedure.steps.map((step) => {
      const stepEvidence = evidence.filter((item) => item.stepId === step.stepId);
      return {
        stepId: step.stepId,
        title: step.title,
        state: steps.find((item) => item.id === step.stepId)?.state || "pending",
        escalation: steps.find((item) => item.id === step.stepId)?.escalation || null,
        attempts: attempts.filter((item) => item.stepId === step.stepId),
        evidence: stepEvidence,
        before: stepEvidence.find((item) => item.kind === "initial") || null,
        after: [...stepEvidence].reverse().find((item) => item.kind === "verification") || null,
      };
    }),
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
  const steps = objectArray(body, "steps");
  const allPassed = procedure.steps.every((expected) =>
    steps.some((step) => step.id === expected.stepId && step.state === "passed"),
  );
  const supplied = Object.hasOwn(body, "termination");
  if (!supplied && !allPassed)
    throw new RequestError(
      400,
      "TERMINATION_REASON_REQUIRED",
      "A termination reason is required while inspection steps remain unfinished",
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
