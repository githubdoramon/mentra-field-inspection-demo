import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
loadDotEnv(join(ROOT, "server", ".env"));
const DATA = join(ROOT, "data");
const PROCEDURE_PATH = join(ROOT, "workflows", "purge-limiter.json");
const PORT = numberEnv("PORT", 8787);
const HOST = process.env.HOST || "0.0.0.0";
const AI_BASE_URL = (process.env.AI_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || "qwen3.8-27b";
const AI_TIMEOUT_MS = numberEnv("AI_TIMEOUT_MS", 90_000);
const AI_ENABLE_THINKING = process.env.AI_ENABLE_THINKING === "true";
const AI_IMAGE_MAX_EDGE = Math.max(
  128,
  Math.min(2048, Math.floor(numberEnv("AI_IMAGE_MAX_EDGE", 640))),
);
const AI_IMAGE_JPEG_QUALITY = Math.max(
  1,
  Math.min(100, Math.floor(numberEnv("AI_IMAGE_JPEG_QUALITY", 80))),
);
const AI_EVALUATION_MAX_TOKENS = Math.max(
  500,
  Math.min(4_000, Math.floor(numberEnv("AI_EVALUATION_MAX_TOKENS", 2_000))),
);
const EVIDENCE_PREVIEW_MAX_EDGE = 768;
const EVIDENCE_PREVIEW_JPEG_QUALITY = 75;
const MAX_JSON_BYTES = 30 * 1024 * 1024;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const requestContext = new AsyncLocalStorage<{ requestId: string }>();

type JsonObject = Record<string, unknown>;
type EvaluationStatus = "pass" | "adjustment_required" | "evidence_unclear";

function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

function safeLogMessage(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function logEvent(event: string, fields: JsonObject = {}): void {
  const requestId = currentRequestId();
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(requestId ? { requestId } : {}),
      ...fields,
    }),
  );
}

function requestIdFor(req: IncomingMessage): string {
  const supplied = req.headers["x-inspection-request-id"];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  const sanitized =
    typeof value === "string" ? value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 128) : "";
  return sanitized || randomUUID();
}

function aiEndpoint(): string {
  try {
    const endpoint = new URL(`${AI_BASE_URL}/v1/chat/completions`);
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

function safeUpstreamExcerpt(value: string): string {
  const token = process.env.AI_BEARER_TOKEN?.trim();
  const redacted = token ? value.split(token).join("[redacted]") : value;
  return safeLogMessage(
    redacted
      .replace(/data:[^\s"'<>]+/gi, "[media omitted]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(
        /(authorization|token|secret|prompt|messages|content|image_url)\s*[:=]\s*(["']?)[^,;}\n]*\2/gi,
        "$1=[redacted]",
      )
      .replace(/https?:\/\/[^\s"']+/gi, (url) => url.split("?", 1)[0]),
    500,
  );
}

function safeModelExcerpt(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return safeUpstreamExcerpt(
    text
      .replace(/<think>[\s\S]*?<\/think>/gi, "[think omitted]")
      .replace(/<think>[\s\S]*$/i, "[think omitted]"),
  );
}

function safeLogScalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function upstreamFailureCause(cause: unknown): string {
  if (cause instanceof Error && cause.name === "AbortError") return "timeout";
  const error = cause as { code?: string; cause?: { code?: string } };
  const code = error?.code || error?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") return "connect";
  if (
    typeof code === "string" &&
    (code.startsWith("CERT") || code.includes("TLS") || code.includes("SSL"))
  )
    return "tls";
  return "network";
}

/** Small dependency-free .env loader for the laptop demo. Existing shell
 * variables win, and values are never logged or returned by the API. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of requireText(path).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

function requireText(path: string): string {
  // This is only called for the tiny local .env file during process startup.
  // Node's synchronous fs API keeps configuration available before constants
  // such as AI_BASE_URL are evaluated.
  return readFileSync(path, "utf8");
}

interface ProcedureStep {
  stepId: string;
  title: string;
  instruction: string;
  status: string;
  visualCriteria?: string[];
  limitations?: string[];
  references?: { loose: string; seated: string };
}

interface EvidenceRecord {
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

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type, authorization, idempotency-key, x-inspection-request-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...(currentRequestId() ? { "x-inspection-request-id": currentRequestId() ?? "" } : {}),
  });
  res.end(body);
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  logEvent("http.failure", { status, errorCode: code, message: safeLogMessage(message) });
  json(res, status, { error: code, message });
}

async function bodyBuffer(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > limit) throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req: IncomingMessage): Promise<JsonObject> {
  const body = await bodyBuffer(req, MAX_JSON_BYTES);
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("object required");
    return value as JsonObject;
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}

class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requiredString(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new RequestError(400, "INVALID_REQUEST", `${key} is required`);
  return value.trim();
}

function safeName(value: string, fallback = "item"): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

function mimeExtension(mime: string): string {
  const lower = mime.toLowerCase().split(";", 1)[0];
  if (lower === "image/png") return ".png";
  if (lower === "image/webp") return ".webp";
  if (lower === "video/mp4") return ".mp4";
  if (lower === "video/quicktime") return ".mov";
  if (lower === "video/webm") return ".webm";
  return ".jpg";
}

function publicUrl(req: IncomingMessage, path: string): string {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  const base = configured || `http://${req.headers.host || `localhost:${PORT}`}`;
  return `${base}${path}`;
}

async function ensureDataDirs(): Promise<void> {
  await Promise.all([
    mkdir(join(DATA, "evidence"), { recursive: true }),
    mkdir(join(DATA, "videos"), { recursive: true }),
    mkdir(join(DATA, "reports"), { recursive: true }),
    mkdir(join(DATA, "escalations"), { recursive: true }),
  ]);
}

async function loadProcedure(): Promise<{
  procedureId: string;
  version: number;
  title: string;
  asset: JsonObject;
  workOrder: JsonObject;
  steps: ProcedureStep[];
}> {
  const value = JSON.parse(await readFile(PROCEDURE_PATH, "utf8")) as JsonObject;
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

function procedureContext(
  procedure: Awaited<ReturnType<typeof loadProcedure>>,
  req?: IncomingMessage,
): JsonObject {
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

function snapshotDetails(
  snapshot: JsonObject,
  procedure: Awaited<ReturnType<typeof loadProcedure>>,
): JsonObject {
  const steps = Array.isArray(snapshot.steps)
    ? snapshot.steps.filter((step): step is JsonObject =>
        Boolean(step && typeof step === "object" && !Array.isArray(step)),
      )
    : [];
  const attempts = Array.isArray(snapshot.attempts)
    ? snapshot.attempts.filter((attempt): attempt is JsonObject =>
        Boolean(attempt && typeof attempt === "object" && !Array.isArray(attempt)),
      )
    : [];
  const evidence = Array.isArray(snapshot.evidence)
    ? snapshot.evidence.filter((item): item is JsonObject =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
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

function validateReportTermination(
  body: JsonObject,
  procedure: Awaited<ReturnType<typeof loadProcedure>>,
): JsonObject | undefined {
  const implementedStep = procedure.steps.find((step) => step.status === "implemented");
  const steps = Array.isArray(body.steps)
    ? body.steps.filter((step): step is JsonObject =>
        Boolean(step && typeof step === "object" && !Array.isArray(step)),
      )
    : [];
  const implementedPassed =
    implementedStep !== undefined &&
    steps.some((step) => step.id === implementedStep.stepId && step.state === "passed");
  const supplied = Object.hasOwn(body, "termination");
  if (!supplied && !implementedPassed) {
    throw new RequestError(
      400,
      "TERMINATION_REASON_REQUIRED",
      "A termination reason is required while the implemented purge-limiter check is unresolved",
    );
  }
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

async function fetchPhoto(sourceUrl: string): Promise<{ bytes: Buffer; mimeType: string }> {
  if (sourceUrl.startsWith("data:")) {
    const match = sourceUrl.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match)
      throw new RequestError(
        400,
        "INVALID_PHOTO_URL",
        "photoUrl data URL must contain base64 image bytes",
      );
    return { mimeType: match[1], bytes: Buffer.from(match[2], "base64") };
  }
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new RequestError(
      400,
      "INVALID_PHOTO_URL",
      "photoUrl must be an absolute URL or data URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RequestError(400, "INVALID_PHOTO_URL", "photoUrl must use HTTP(S) or a data URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok)
      throw new RequestError(
        502,
        "PHOTO_FETCH_FAILED",
        `Photo source returned HTTP ${response.status}`,
      );
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_PHOTO_BYTES)
      throw new RequestError(413, "PHOTO_TOO_LARGE", "Photo is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PHOTO_BYTES)
      throw new RequestError(413, "PHOTO_TOO_LARGE", "Photo is too large");
    return {
      bytes,
      mimeType: response.headers.get("content-type")?.split(";", 1)[0] || "image/jpeg",
    };
  } catch (cause) {
    if (cause instanceof RequestError) throw cause;
    throw new RequestError(
      502,
      "PHOTO_FETCH_FAILED",
      "Could not fetch photo bytes from Mentra photo URL",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function archiveEvidence(req: IncomingMessage, body: JsonObject): Promise<JsonObject> {
  const attemptId = requiredString(body, "attemptId");
  const stepId = requiredString(body, "stepId");
  const sourceUrl = requiredString(body, "photoUrl");
  const kind = typeof body.kind === "string" ? body.kind : "inspection";
  const requestedMime = typeof body.mimeType === "string" ? body.mimeType : "";
  const fetched = await fetchPhoto(sourceUrl);
  const mimeType = requestedMime || fetched.mimeType;
  if (!mimeType.toLowerCase().startsWith("image/"))
    throw new RequestError(400, "INVALID_MIME_TYPE", "Evidence must be an image");
  const id = randomUUID();
  const extension = mimeExtension(mimeType);
  const fileName = `${id}${extension}`;
  const file = join(DATA, "evidence", fileName);
  const archivedUrl = publicUrl(req, `/data/evidence/${fileName}`);
  const photoPath = `/data/evidence/${fileName}`;
  const record: EvidenceRecord = {
    id,
    attemptId,
    stepId,
    kind,
    mimeType,
    sourceUrl,
    photoUrl: archivedUrl,
    photoPath,
    url: archivedUrl,
    file,
    bytes: fetched.bytes.length,
    createdAt: Date.now(),
    archived: true,
  };
  await writeFile(file, fetched.bytes, { flag: "wx" });
  // The internal file path is kept in the server-side index so evaluation can
  // read archived bytes after a process restart; it is removed from API responses.
  await writeFile(join(DATA, "evidence", `${id}.json`), JSON.stringify(record, null, 2), {
    flag: "wx",
  });
  logEvent("evidence.saved", {
    evidenceId: id,
    attemptId,
    stepId,
    kind,
    mimeType,
    bytes: fetched.bytes.length,
  });
  const response = recordResponse(record);
  try {
    const preview = await sharp(fetched.bytes)
      .rotate()
      .resize({
        width: EVIDENCE_PREVIEW_MAX_EDGE,
        height: EVIDENCE_PREVIEW_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: EVIDENCE_PREVIEW_JPEG_QUALITY })
      .toBuffer();
    response.previewDataUrl = `data:image/jpeg;base64,${preview.toString("base64")}`;
    logEvent("evidence.preview.saved", {
      evidenceId: id,
      bytes: preview.length,
      format: "jpeg",
      maxEdge: EVIDENCE_PREVIEW_MAX_EDGE,
      quality: EVIDENCE_PREVIEW_JPEG_QUALITY,
    });
  } catch {
    logEvent("evidence.preview.failure", { evidenceId: id, cause: "preview_preparation_failed" });
  }
  return response;
}

function recordResponse(record: EvidenceRecord): JsonObject {
  const { file: _file, ...response } = record;
  return response;
}

async function readEvidence(id: string): Promise<EvidenceRecord> {
  try {
    const record = JSON.parse(
      await readFile(join(DATA, "evidence", `${safeName(id)}.json`), "utf8"),
    ) as EvidenceRecord;
    if (!record.photoPath && record.file)
      record.photoPath = `/data/evidence/${basename(record.file)}`;
    return record;
  } catch {
    throw new RequestError(404, "EVIDENCE_NOT_FOUND", "Evidence was not found");
  }
}

async function buildModelMessages(
  step: ProcedureStep,
  evidence?: EvidenceRecord,
): Promise<unknown[]> {
  const criteria = (step.visualCriteria || []).map((item) => `- ${item}`).join("\n");
  const references = await imageParts(step, evidence);
  const context = await loadProcedure();
  const text = `Asset: ${JSON.stringify(context.asset)}. Work order and history: ${JSON.stringify(context.workOrder)}.\nYou are evaluating a field inspection photo for a private procedure.\nProcedure step: ${step.title}\nInstruction: ${step.instruction}\nVisible criteria:\n${criteria}\n\nThe first two images, if present, are loose and correctly seated references. The final image is the technician's current evidence. Assess only what is visible. If the current image is missing, too distant, obstructed, or otherwise insufficient, use evidence_unclear. Use adjustment_required when the part is visible but visibly displaced or not seated. Use pass only when every visible criterion is satisfied. Do not infer hidden fastening strength or machine safety. Return JSON only with exactly these fields: status (pass|adjustment_required|evidence_unclear), finding (short sentence), recommendedAction (short sentence), confidence (number 0..1).`;
  return [{ role: "user", content: [{ type: "text", text }, ...references] }];
}

async function prepareModelImage(
  bytes: Buffer,
  role: string,
): Promise<{ type: "image_url"; image_url: { url: string } }> {
  try {
    const original = await sharp(bytes).metadata();
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize({
        width: AI_IMAGE_MAX_EDGE,
        height: AI_IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: AI_IMAGE_JPEG_QUALITY })
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
      quality: AI_IMAGE_JPEG_QUALITY,
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

async function imageParts(
  step: ProcedureStep,
  evidence?: EvidenceRecord,
): Promise<Array<{ type: "image_url"; image_url: { url: string } }>> {
  const references: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  if (step.references) {
    for (const [role, ref] of [
      ["reference_loose", step.references.loose],
      ["reference_seated", step.references.seated],
    ]) {
      const bytes = await readFile(join(ROOT, ref));
      references.push(await prepareModelImage(bytes, role));
    }
  }
  if (evidence) {
    const bytes = await readFile(evidence.file);
    references.push(await prepareModelImage(bytes, "current_evidence"));
  }
  return references;
}

function contentText(content: unknown): string | undefined {
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

function parseModelJson(content: unknown): JsonObject {
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

interface AICallResult {
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

async function callAI(
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
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const startedAt = Date.now();
  const endpoint = aiEndpoint();
  logEvent("ai.request.start", {
    endpoint,
    model: AI_MODEL,
    timeoutMs: AI_TIMEOUT_MS,
    maxTokens,
    responseFormat: Boolean(options.responseFormat),
    imageCount: countImageParts(messages),
  });
  try {
    const response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        ...(AI_MODEL.toLowerCase().startsWith("qwen")
          ? { enable_thinking: AI_ENABLE_THINKING }
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
        model: AI_MODEL,
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
        model: AI_MODEL,
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
        model: AI_MODEL,
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
          model: AI_MODEL,
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
        model: AI_MODEL,
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
        model: AI_MODEL,
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
          model: AI_MODEL,
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
        model: AI_MODEL,
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
      model: AI_MODEL,
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
        model: AI_MODEL,
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
      model: AI_MODEL,
      durationMs: Date.now() - startedAt,
      cause: upstreamFailureCause(cause),
      message: safeLogMessage(cause instanceof Error ? cause.message : cause),
    });
    throw new RequestError(502, "AI_UNAVAILABLE", "Could not reach the configured AI endpoint");
  } finally {
    clearTimeout(timer);
  }
}

async function evaluate(_req: IncomingMessage, body: JsonObject): Promise<JsonObject> {
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
    aiResult = await callAI(await buildModelMessages(step, evidence), AI_EVALUATION_MAX_TOKENS, {
      responseFormat: true,
    });
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
  };
  result.confidence = confidence;
  evidence.evaluation = result;
  await writeFile(join(DATA, "evidence", `${evidence.id}.json`), JSON.stringify(evidence, null, 2));
  logEvent("evaluation.result", { evidenceId, stepId, status, confidence });
  return result;
}

async function ask(body: JsonObject): Promise<JsonObject> {
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

async function saveSnapshot(
  req: IncomingMessage,
  body: JsonObject,
  type: "reports" | "escalations",
): Promise<JsonObject> {
  const procedure = await loadProcedure();
  const termination = type === "reports" ? validateReportTermination(body, procedure) : undefined;
  const snapshot = termination ? { ...body, termination } : body;
  const headerId = req.headers["idempotency-key"];
  const suppliedId =
    typeof snapshot.id === "string"
      ? snapshot.id
      : typeof snapshot[`${type.slice(0, -1)}Id`] === "string"
        ? (snapshot[`${type.slice(0, -1)}Id`] as string)
        : typeof headerId === "string"
          ? headerId
          : "";
  const id = safeName(suppliedId, randomUUID());
  const createdAt = new Date().toISOString();
  const details = snapshotDetails(snapshot, procedure);
  const output =
    type === "reports"
      ? {
          id,
          type: "inspection_report",
          createdAt,
          snapshot,
          report: details,
          url: publicUrl(req, `/data/${type}/${id}.json`),
        }
      : {
          id,
          type: "expert_escalation",
          createdAt,
          snapshot: body,
          package: {
            ...details,
            requestedBy: body.technician || procedure.asset.technician || null,
            requestedAt: createdAt,
          },
          url: publicUrl(req, `/data/${type}/${id}.json`),
        };
  // A report can be posted again with the same id after video upload completes;
  // overwrite the saved snapshot so the late recording metadata is retained.
  await writeFile(join(DATA, type, `${id}.json`), JSON.stringify(output, null, 2));
  return output;
}

async function readSavedSnapshot(type: "reports" | "escalations", id: string): Promise<JsonObject> {
  try {
    return JSON.parse(
      await readFile(join(DATA, type, `${safeName(id)}.json`), "utf8"),
    ) as JsonObject;
  } catch {
    throw new RequestError(
      404,
      `${type === "reports" ? "REPORT" : "ESCALATION"}_NOT_FOUND`,
      "Saved record was not found",
    );
  }
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch)
    throw new RequestError(400, "INVALID_MULTIPART", "Multipart boundary is missing");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts: MultipartPart[] = [];
  let cursor = 0;
  while (true) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const contentStart = start + boundary.length;
    if (body.subarray(contentStart, contentStart + 2).toString() === "--") break;
    const headerStart = contentStart + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const headerText = body.subarray(headerStart, headerEnd).toString("utf8");
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const dataEnd = next - 2;
    const nameMatch = headerText.match(/(?:^|;)\s*name="([^"]*)"/i);
    const filenameMatch = headerText.match(/(?:^|;)\s*filename="([^"]*)"/i);
    if (nameMatch) {
      const contentTypeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1],
        contentType: contentTypeMatch?.[1]?.trim(),
        data: body.subarray(headerEnd + 4, dataEnd),
      });
    }
    cursor = next;
  }
  return parts;
}

async function uploadVideo(
  req: IncomingMessage,
  body: Buffer,
  sessionId: string,
): Promise<JsonObject> {
  const parts = parseMultipart(body, String(req.headers["content-type"] || ""));
  const part =
    parts.find((candidate) => candidate.name === "video" && candidate.data.length > 0) ||
    parts.find((candidate) => candidate.filename && candidate.data.length > 0);
  if (!part)
    throw new RequestError(
      400,
      "VIDEO_PART_MISSING",
      "Request must include a non-empty video part",
    );
  const mimeType = part.contentType || "video/webm";
  const originalExtension = part.filename ? extname(part.filename).toLowerCase() : "";
  const extension = /^\.(mp4|webm|mov|m4v)$/.test(originalExtension)
    ? originalExtension
    : mimeExtension(mimeType);
  const id = randomUUID();
  const fileName = `${safeName(sessionId, "inspection")}-${id}${extension}`;
  const file = join(DATA, "videos", fileName);
  await writeFile(file, part.data, { flag: "wx" });
  const response = {
    id,
    sessionId,
    filename: fileName,
    mimeType,
    bytes: part.data.length,
    url: publicUrl(req, `/data/videos/${fileName}`),
    uploadedAt: new Date().toISOString(),
  };
  await writeFile(join(DATA, "videos", `${id}.json`), JSON.stringify(response, null, 2), {
    flag: "wx",
  });
  return response;
}

async function videoStatus(_req: IncomingMessage, sessionId: string): Promise<JsonObject> {
  const entries = await readdir(join(DATA, "videos"));
  const metadata: Array<JsonObject> = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const record = JSON.parse(await readFile(join(DATA, "videos", entry), "utf8")) as JsonObject;
      if (record.sessionId === sessionId) metadata.push(record);
    } catch {
      // Ignore an incomplete metadata file while a previous upload is finishing.
    }
  }
  metadata.sort((left, right) =>
    String(right.uploadedAt || "").localeCompare(String(left.uploadedAt || "")),
  );
  return {
    sessionId,
    status: metadata.length ? "uploaded" : "pending",
    latest: metadata[0] || null,
  };
}

async function staticData(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (!path.startsWith("/data/")) return false;
  const requested = decodeURIComponent(path.slice("/data/".length));
  const root = DATA;
  const target = normalize(join(root, requested));
  if (relative(root, target).startsWith("..") || relative(root, target).includes("..")) {
    error(res, 404, "NOT_FOUND", "Not found");
    return true;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      error(res, 404, "NOT_FOUND", "Not found");
      return true;
    }
    const extension = extname(target).toLowerCase();
    const contentType =
      extension === ".json"
        ? "application/json; charset=utf-8"
        : extension === ".mp4"
          ? "video/mp4"
          : extension === ".webm"
            ? "video/webm"
            : extension === ".mov"
              ? "video/quicktime"
              : extension === ".png"
                ? "image/png"
                : extension === ".webp"
                  ? "image/webp"
                  : extension === ".gif"
                    ? "image/gif"
                    : "image/jpeg";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": info.size,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...(currentRequestId() ? { "x-inspection-request-id": currentRequestId() ?? "" } : {}),
    });
    createReadStream(target).pipe(res);
  } catch {
    error(res, 404, "NOT_FOUND", "Not found");
  }
  return true;
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requestIdFor(req);
  const startedAt = Date.now();
  const path = (req.url || "/").split("?", 1)[0];
  requestContext.run({ requestId }, () => {
    logEvent("http.request.start", { method: req.method || "GET", path });
    res.once("finish", () =>
      logEvent("http.request.end", {
        method: req.method || "GET",
        path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });
  try {
    await requestContext.run({ requestId }, () => handle(req, res));
  } catch (cause) {
    logEvent("http.request.failure", {
      method: req.method || "GET",
      path,
      status: 500,
      errorCode: cause instanceof RequestError ? cause.code : "INTERNAL_ERROR",
      message: safeLogMessage(
        cause instanceof RequestError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : cause,
      ),
    });
    if (!res.headersSent)
      error(
        res,
        cause instanceof RequestError ? cause.status : 500,
        cause instanceof RequestError ? cause.code : "INTERNAL_ERROR",
        cause instanceof RequestError ? cause.message : "The server could not complete the request",
      );
    else res.destroy();
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "content-type, authorization, idempotency-key, x-inspection-request-id",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      ...(currentRequestId() ? { "x-inspection-request-id": currentRequestId() ?? "" } : {}),
    });
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${PORT}`}`);
  if (await staticData(req, res, url.pathname)) return;
  if (req.method === "GET" && url.pathname === "/api/health") {
    const procedure = await loadProcedure();
    const aiConfigured = Boolean(process.env.AI_BEARER_TOKEN?.trim());
    json(res, 200, {
      ok: true,
      status: "ok",
      server: "mentra-inspection-v0",
      now: new Date().toISOString(),
      port: PORT,
      aiConfigured,
      model: AI_MODEL,
      ai: { configured: aiConfigured, baseUrl: AI_BASE_URL, model: AI_MODEL },
      procedure: {
        id: procedure.procedureId,
        version: procedure.version,
        implementedStep: procedure.steps.find((step) => step.status === "implemented")?.stepId,
      },
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/reference") {
    const procedure = await loadProcedure();
    const step = procedure.steps.find((item) => item.stepId === url.searchParams.get("stepId"));
    const role = url.searchParams.get("role");
    const reference = role === "loose" || role === "seated" ? step?.references?.[role] : undefined;
    if (!reference) {
      error(res, 404, "NOT_FOUND", "Reference image not found");
      return;
    }
    const knowledgeRoot = join(ROOT, "knowledge");
    const target = normalize(join(ROOT, reference));
    const relativePath = relative(knowledgeRoot, target);
    const contentType = {
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[extname(target).toLowerCase()];
    if (relativePath.startsWith("..") || !contentType) {
      error(res, 404, "NOT_FOUND", "Reference image not found");
      return;
    }
    try {
      const bytes = await readFile(target);
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": bytes.length,
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(bytes);
    } catch {
      error(res, 404, "NOT_FOUND", "Reference image not found");
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/context") {
    const procedure = await loadProcedure();
    json(res, 200, {
      ok: true,
      procedure: procedureContext(procedure, req),
      workOrder: procedure.workOrder,
      asset: procedure.asset,
      implementedStepId:
        procedure.steps.find((step) => step.status === "implemented")?.stepId || null,
    });
    return;
  }
  if (
    req.method === "GET" &&
    (url.pathname === "/api/report" || url.pathname === "/api/escalation")
  ) {
    const id = url.searchParams.get("id")?.trim();
    if (!id) {
      error(res, 400, "ID_REQUIRED", "id query parameter is required");
      return;
    }
    json(
      res,
      200,
      await readSavedSnapshot(url.pathname === "/api/report" ? "reports" : "escalations", id),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/video/status") {
    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!sessionId) {
      error(res, 400, "SESSION_ID_REQUIRED", "sessionId query parameter is required");
      return;
    }
    json(res, 200, await videoStatus(req, sessionId));
    return;
  }
  try {
    if (req.method === "POST" && url.pathname === "/api/evidence") {
      json(res, 201, await archiveEvidence(req, await jsonBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/evaluate") {
      json(res, 200, await evaluate(req, await jsonBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/ask") {
      json(res, 200, await ask(await jsonBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/reports") {
      json(res, 201, await saveSnapshot(req, await jsonBody(req), "reports"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/escalations") {
      json(res, 201, await saveSnapshot(req, await jsonBody(req), "escalations"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/video/upload") {
      const sessionId = url.searchParams.get("sessionId")?.trim();
      if (!sessionId)
        throw new RequestError(400, "SESSION_ID_REQUIRED", "sessionId query parameter is required");
      json(res, 201, await uploadVideo(req, await bodyBuffer(req, MAX_VIDEO_BYTES), sessionId));
      return;
    }
    error(res, 404, "NOT_FOUND", "Route not found");
  } catch (cause) {
    if (cause instanceof RequestError) {
      error(res, cause.status, cause.code, cause.message);
      return;
    }
    console.error(cause);
    error(res, 500, "INTERNAL_ERROR", "The server could not complete the request");
  }
}

await ensureDataDirs();
const server = createServer((req, res) => {
  void serve(req, res);
});
server.listen(PORT, HOST, () =>
  console.log(`Mentra inspection server listening on http://${HOST}:${PORT}`),
);
