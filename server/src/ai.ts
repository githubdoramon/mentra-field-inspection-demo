import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { config, ROOT } from "./config.js";
import { RequestError } from "./errors.js";
import {
  logEvent,
  safeLogMessage,
  safeLogScalar,
  safeUpstreamExcerpt,
  upstreamFailureCause,
} from "./logging.js";

import type {
  AICallResult,
  EvidenceRecord,
  JsonObject,
  Procedure,
  ProcedureStep,
} from "./types.js";

function aiEndpoint(): string {
  try {
    const endpoint = new URL(`${config.aiBaseUrl}/v1/chat/completions`);
    return `${endpoint.origin}${endpoint.pathname}`;
  } catch {
    return "configured-endpoint";
  }
}

function countImageParts(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countImageParts(item), 0);
  if (!value || typeof value !== "object") return 0;
  const object = value as JsonObject;
  return (
    (object.type === "image_url" ? 1 : 0) +
    Object.entries(object).reduce((count, [, item]) => count + countImageParts(item), 0)
  );
}

async function prepareModelImage(
  bytes: Buffer,
  role: string,
  maxEdge = config.aiImageMaxEdge,
): Promise<{ type: "image_url"; image_url: { url: string } }> {
  try {
    const original = await sharp(bytes).metadata();
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: config.aiImageJpegQuality })
      .toBuffer({ resolveWithObject: true });
    logEvent("ai.image.prepared", {
      role,
      originalWidth: original.width,
      originalHeight: original.height,
      originalBytes: bytes.length,
      width: info.width,
      height: info.height,
      bytes: data.length,
      format: "jpeg",
      quality: config.aiImageJpegQuality,
    });
    return {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${data.toString("base64")}` },
    };
  } catch {
    logEvent("ai.image.failure", { role, cause: "image_preparation_failed" });
    throw new RequestError(
      422,
      "IMAGE_PREPARATION_FAILED",
      "The inspection image could not be prepared. Capture another photo and try again.",
    );
  }
}

export async function imageParts(
  step: ProcedureStep,
  evidence?: EvidenceRecord,
): Promise<Array<{ type: "image_url"; image_url: { url: string } }>> {
  const references: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  if (step.references) {
    for (const reference of step.references) {
      references.push(
        await prepareModelImage(
          await readFile(join(ROOT, reference.path)),
          `reference_${reference.role}`,
          Math.min(config.aiReferenceMaxEdge, config.aiImageMaxEdge),
        ),
      );
    }
  }
  if (evidence)
    references.push(await prepareModelImage(await readFile(evidence.file), "current_evidence"));
  return references;
}

export function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const object = part as JsonObject;
          return typeof object.text === "string" ? object.text : contentText(object.content) || "";
        }
        return "";
      })
      .join("\n")
      .trim();
    return text || undefined;
  }
  if (content && typeof content === "object") {
    const object = content as JsonObject;
    if (typeof object.text === "string") return object.text;
    if (object.content !== undefined) return contentText(object.content);
  }
  return undefined;
}

export function parseModelJson(content: unknown): JsonObject {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const object = content as JsonObject;
    if (
      object.status !== undefined ||
      object.finding !== undefined ||
      object.recommendedAction !== undefined
    )
      return object;
  }
  const text = contentText(content);
  if (!text) throw new Error("model content was not text or JSON");
  const withoutThink = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, withoutThink].filter((value): value is string =>
    Boolean(value),
  )) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const value: unknown = JSON.parse(candidate.slice(start, end + 1));
          if (value && typeof value === "object" && !Array.isArray(value))
            return value as JsonObject;
        } catch {
          /* try the next representation */
        }
      }
    }
  }
  throw new Error("model did not return JSON");
}

export async function buildModelMessages(
  step: ProcedureStep,
  evidence: EvidenceRecord | undefined,
  context: Procedure,
): Promise<unknown[]> {
  const criteria = (step.visualCriteria || []).map((item) => `- ${item}`).join("\n");
  const references = await imageParts(step, evidence);
  const text = `Asset: ${JSON.stringify(context.asset)}. Work order and history: ${JSON.stringify(context.workOrder)}.\nYou are evaluating a field inspection photo for a private procedure.\nProcedure step: ${step.title}\nInstruction: ${step.instruction}\nVisible criteria:\n${criteria}\n\nReference images are optional good/bad examples. Captions in image order: ${JSON.stringify(step.references || [])}. ${evidence ? "The final image is the technician's current evidence." : "There is no current evidence image; return evidence_unclear."} Assess only what is visible. If the current image is missing, too distant, obstructed, or otherwise insufficient, use evidence_unclear. Use adjustment_required when adequate evidence shows any acceptance criterion is not satisfied. Use pass only when every visible criterion is satisfied. Respect the step limitations: ${(step.limitations || []).join("; ")}. Do not infer hidden conditions or safety. Return JSON only with exactly these fields: status (pass|adjustment_required|evidence_unclear), finding (short sentence), recommendedAction (short sentence), confidence (number 0..1).`;
  return [{ role: "user", content: [{ type: "text", text }, ...references] }];
}

export async function callAI(
  messages: unknown[],
  maxTokens = 500,
  options: { responseFormat?: boolean } = {},
): Promise<AICallResult> {
  const token = process.env.AI_BEARER_TOKEN?.trim();
  if (!token)
    throw new RequestError(
      503,
      "AI_NOT_CONFIGURED",
      "AI_BEARER_TOKEN is not configured on the server",
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs);
  const startedAt = Date.now();
  const endpoint = aiEndpoint();
  logEvent("ai.request.start", {
    endpoint,
    model: config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    maxTokens,
    responseFormat: Boolean(options.responseFormat),
    imageCount: countImageParts(messages),
  });
  try {
    const response = await fetch(`${config.aiBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.aiModel,
        messages,
        temperature: 0,
        reasoning_effort: "low",
        reasoning: {
          effort: "low"
        },
        max_tokens: maxTokens,
        ...(config.aiModel.toLowerCase().startsWith("qwen")
          ? { enable_thinking: config.aiEnableThinking }
          : {}),
        ...(options.responseFormat ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") || "unknown";
    const contentLength = Buffer.byteLength(text);
    let payload: JsonObject;
    try {
      payload = JSON.parse(text) as JsonObject;
    } catch {
      logEvent("ai.upstream.response", {
        endpoint,
        model: config.aiModel,
        status: response.status,
        durationMs,
        finishReason: null,
        contentType,
        contentLength,
        outputType: "unparseable",
        outputChars: 0,
      });
      logEvent("ai.request.failure", {
        endpoint,
        model: config.aiModel,
        status: response.status,
        durationMs,
        cause: response.ok ? "invalid_json" : "upstream_http_error",
        upstreamError: safeUpstreamExcerpt(text),
      });
      throw new RequestError(
        502,
        response.ok ? "AI_INVALID_RESPONSE" : "AI_REQUEST_FAILED",
        response.ok
          ? "AI endpoint returned invalid JSON"
          : `AI endpoint returned HTTP ${response.status}`,
      );
    }
    const choices = payload.choices;
    const firstChoice =
      Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
        ? (choices[0] as JsonObject)
        : undefined;
    const finishReason = firstChoice?.finish_reason ?? null;
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
      logEvent("ai.upstream.response", {
        endpoint,
        model: config.aiModel,
        status: response.status,
        durationMs,
        finishReason: safeLogScalar(finishReason),
        contentType,
        contentLength,
        outputType: "unknown",
        outputChars: 0,
      });
      if (!response.ok) {
        logEvent("ai.request.failure", {
          endpoint,
          model: config.aiModel,
          status: response.status,
          durationMs,
          cause: "upstream_http_error",
          upstreamError: safeUpstreamExcerpt(text),
        });
        throw new RequestError(
          502,
          "AI_REQUEST_FAILED",
          `AI endpoint returned HTTP ${response.status}`,
        );
      }
      logEvent("ai.request.failure", {
        endpoint,
        model: config.aiModel,
        status: response.status,
        durationMs,
        cause: "invalid_response",
      });
      throw new RequestError(502, "AI_INVALID_RESPONSE", "AI response did not include a choice");
    }
    const message = firstChoice?.message;
    if (!message || typeof message !== "object") {
      logEvent("ai.upstream.response", {
        endpoint,
        model: config.aiModel,
        status: response.status,
        durationMs,
        finishReason: safeLogScalar(finishReason),
        contentType,
        contentLength,
        outputType: "unknown",
        outputChars: 0,
      });
      if (!response.ok) {
        logEvent("ai.request.failure", {
          endpoint,
          model: config.aiModel,
          status: response.status,
          durationMs,
          cause: "upstream_http_error",
          upstreamError: safeUpstreamExcerpt(text),
        });
        throw new RequestError(
          502,
          "AI_REQUEST_FAILED",
          `AI endpoint returned HTTP ${response.status}`,
        );
      }
      logEvent("ai.request.failure", {
        endpoint,
        model: config.aiModel,
        status: response.status,
        durationMs,
        cause: "invalid_response",
      });
      throw new RequestError(502, "AI_INVALID_RESPONSE", "AI response did not include a message");
    }
    const output = (message as JsonObject).content;
    const outputText = contentText(output);
    const outputType = output === null ? "null" : Array.isArray(output) ? "blocks" : typeof output;
    const outputChars = outputText?.length || 0;
    logEvent("ai.upstream.response", {
      endpoint,
      model: config.aiModel,
      status: response.status,
      durationMs,
      finishReason: safeLogScalar(finishReason),
      contentType,
      contentLength,
      outputType,
      outputChars,
    });
    if (!response.ok) {
      logEvent("ai.request.failure", {
        endpoint,
        model: config.aiModel,
        status: response.status,
        durationMs,
        cause: "upstream_http_error",
        upstreamError: safeUpstreamExcerpt(text),
      });
      throw new RequestError(
        502,
        "AI_REQUEST_FAILED",
        `AI endpoint returned HTTP ${response.status}`,
      );
    }
    return {
      content: output,
      status: response.status,
      finishReason: safeLogScalar(finishReason),
      contentType,
      contentLength,
      outputType,
      outputChars,
      durationMs,
      rawExcerpt: safeUpstreamExcerpt(text),
    };
  } catch (cause) {
    if (cause instanceof RequestError) throw cause;
    logEvent("ai.request.failure", {
      endpoint,
      model: config.aiModel,
      durationMs: Date.now() - startedAt,
      cause: upstreamFailureCause(cause),
      message: safeLogMessage(cause instanceof Error ? cause.message : cause),
    });
    throw new RequestError(502, "AI_UNAVAILABLE", "Could not reach the configured AI endpoint");
  } finally {
    clearTimeout(timer);
  }
}
