import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { buildModelMessages, callAI, imageParts, parseModelJson } from "./ai.js";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import { readEvidence } from "./evidence.js";
import { logEvent, safeModelExcerpt } from "./logging.js";
import { loadProcedure } from "./procedure.js";
import type { AICallResult, EvaluationStatus, EvidenceRecord, JsonObject } from "./types.js";
import { requiredString } from "./utils.js";

export async function evaluate(body: JsonObject): Promise<JsonObject> {
  const stepId = requiredString(body, "stepId");
  const evidenceId = requiredString(body, "evidenceId");
  logEvent("evaluation.start", { evidenceId, stepId });
  const procedure = await loadProcedure();
  const step = procedure.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) throw new RequestError(404, "STEP_NOT_FOUND", "Procedure step was not found");
  const evidence = await readEvidence(evidenceId);
  if (evidence.stepId !== stepId)
    throw new RequestError(
      409,
      "EVIDENCE_STEP_MISMATCH",
      "Evidence belongs to another procedure step",
    );
  let modelResult: JsonObject;
  let aiResult: AICallResult | undefined;
  try {
    aiResult = await callAI(
      await buildModelMessages(step, evidence),
      config.aiEvaluationMaxTokens,
      {
        responseFormat: true,
      },
    );
    modelResult = parseModelJson(aiResult.content);
  } catch (cause) {
    if (cause instanceof RequestError) throw cause;
    if (aiResult)
      logEvent("ai.result.parse_failure", {
        status: aiResult.status,
        finishReason: aiResult.finishReason,
        contentType: aiResult.contentType,
        contentLength: aiResult.contentLength,
        outputType: aiResult.outputType,
        outputChars: aiResult.outputChars,
        durationMs: aiResult.durationMs,
        excerpt: aiResult.rawExcerpt || safeModelExcerpt(aiResult.content),
      });
    throw new RequestError(
      502,
      "AI_INVALID_RESULT",
      "AI returned a response that could not be parsed",
    );
  }
  const status = modelResult.status;
  if (status !== "pass" && status !== "adjustment_required" && status !== "evidence_unclear")
    throw new RequestError(
      502,
      "AI_INVALID_RESULT",
      "AI returned an unsupported evaluation status",
    );
  const finding = modelResult.finding;
  const recommendedAction = modelResult.recommendedAction;
  const confidence = modelResult.confidence;
  if (
    typeof finding !== "string" ||
    finding.trim() === "" ||
    typeof recommendedAction !== "string" ||
    recommendedAction.trim() === ""
  )
    throw new RequestError(
      502,
      "AI_INVALID_RESULT",
      "AI result is missing finding or recommendedAction",
    );
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    throw new RequestError(
      502,
      "AI_INVALID_RESULT",
      "AI result confidence must be a number between 0 and 1",
    );
  const result: JsonObject = {
    status: status as EvaluationStatus,
    finding: finding.trim(),
    recommendedAction: recommendedAction.trim(),
    stepId,
    procedureReference: `${procedure.procedureId}:v${procedure.version}#${stepId}`,
    evidenceId,
    evaluatedAt: Date.now(),
    confidence,
  };
  evidence.evaluation = result;
  await writeFile(
    join(config.data, "evidence", `${evidence.id}.json`),
    JSON.stringify(evidence, null, 2),
  );
  logEvent("evaluation.result", { evidenceId, stepId, status, confidence });
  return result;
}

export async function ask(body: JsonObject): Promise<JsonObject> {
  const question = requiredString(body, "question");
  const stepId = typeof body.stepId === "string" ? body.stepId : "purge-limiter";
  const procedure = await loadProcedure();
  const step = procedure.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) throw new RequestError(404, "STEP_NOT_FOUND", "Procedure step was not found");
  let evidence: EvidenceRecord | undefined;
  if (typeof body.evidenceId === "string" && body.evidenceId.trim())
    evidence = await readEvidence(body.evidenceId);
  const currentFinding = evidence?.evaluation;
  const findingContext = currentFinding
    ? `Current AI finding: ${String(currentFinding.finding || "")}. Recommended action: ${String(currentFinding.recommendedAction || "")}.`
    : "There is no saved AI finding for this evidence yet.";
  const askText = `Answer this technician question in concise English using only the private procedure and asset context below. If the question is outside the procedure, say that clearly. Asset: ${String(procedure.asset.name || "Bambu Lab A1 mini")} (${String(procedure.asset.id || "A1M-0042")}). Procedure step: ${step.title}. Instruction: ${step.instruction}. Visible criteria: ${(step.visualCriteria || []).join("; ")}. ${findingContext} The attached image is the current evidence. Question: ${question}`;
  const contentParts = await imageParts(step, evidence);
  const content = (
    await callAI(
      [{ role: "user", content: [{ type: "text", text: askText }, ...contentParts] }],
      300,
    )
  ).content;
  const answer = typeof content === "string" ? content.trim() : parseModelJson(content).answer;
  if (typeof answer !== "string" || !answer)
    throw new RequestError(502, "AI_INVALID_RESULT", "AI returned no answer");
  return { answer, procedureReference: `${procedure.procedureId}:v${procedure.version}#${stepId}` };
}
