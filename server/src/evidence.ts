import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { loadProcedure } from "./procedure.js";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import { logEvent } from "./logging.js";
import type { EvidenceRecord, JsonObject } from "./types.js";
import { mimeExtension, publicUrl, requiredString, safeName } from "./utils.js";

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
    if (contentLength > config.maxPhotoBytes)
      throw new RequestError(413, "PHOTO_TOO_LARGE", "Photo is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > config.maxPhotoBytes)
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

function recordResponse(record: EvidenceRecord): JsonObject {
  const { file: _file, ...response } = record;
  return response;
}

export async function archiveEvidence(req: IncomingMessage, body: JsonObject): Promise<JsonObject> {
  const attemptId = requiredString(body, "attemptId");
  const stepId = requiredString(body, "stepId");
  const procedure = await loadProcedure(body);
  if (!procedure.steps.some((step) => step.stepId === stepId))
    throw new RequestError(404, "STEP_NOT_FOUND", "Procedure step was not found");
  const sourceUrl = requiredString(body, "photoUrl");
  const kind = typeof body.kind === "string" ? body.kind : "inspection";
  const requestedMime = typeof body.mimeType === "string" ? body.mimeType : "";
  const fetched = await fetchPhoto(sourceUrl);
  const mimeType = requestedMime || fetched.mimeType;
  if (!mimeType.toLowerCase().startsWith("image/"))
    throw new RequestError(400, "INVALID_MIME_TYPE", "Evidence must be an image");
  const id = randomUUID();
  const fileName = `${id}${mimeExtension(mimeType)}`;
  const file = join(config.data, "evidence", fileName);
  const archivedUrl = publicUrl(req, `/data/evidence/${fileName}`);
  const record: EvidenceRecord = {
    id,
    attemptId,
    procedureId: procedure.procedureId,
    procedureVersion: procedure.version,
    stepId,
    kind,
    mimeType,
    sourceUrl,
    photoUrl: archivedUrl,
    photoPath: `/data/evidence/${fileName}`,
    url: archivedUrl,
    file,
    bytes: fetched.bytes.length,
    createdAt: Date.now(),
    archived: true,
  };
  await writeFile(file, fetched.bytes, { flag: "wx" });
  await writeFile(join(config.data, "evidence", `${id}.json`), JSON.stringify(record, null, 2), {
    flag: "wx",
  });
  logEvent("evidence.saved", {
    evidenceId: id,
    attemptId,
    procedureId: procedure.procedureId,
    procedureVersion: procedure.version,
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
        width: config.evidencePreviewMaxEdge,
        height: config.evidencePreviewMaxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: config.evidencePreviewJpegQuality })
      .toBuffer();
    response.previewDataUrl = `data:image/jpeg;base64,${preview.toString("base64")}`;
    logEvent("evidence.preview.saved", {
      evidenceId: id,
      bytes: preview.length,
      format: "jpeg",
      maxEdge: config.evidencePreviewMaxEdge,
      quality: config.evidencePreviewJpegQuality,
    });
  } catch {
    logEvent("evidence.preview.failure", { evidenceId: id, cause: "preview_preparation_failed" });
  }
  return response;
}

export async function readEvidence(id: string): Promise<EvidenceRecord> {
  try {
    const record = JSON.parse(
      await readFile(join(config.data, "evidence", `${safeName(id)}.json`), "utf8"),
    ) as EvidenceRecord;
    if (!record.photoPath && record.file)
      record.photoPath = `/data/evidence/${basename(record.file)}`;
    return record;
  } catch {
    throw new RequestError(404, "EVIDENCE_NOT_FOUND", "Evidence was not found");
  }
}
