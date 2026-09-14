import { readdir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { extname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import type { JsonObject, MultipartPart } from "./types.js";
import { mimeExtension, publicUrl, safeName } from "./utils.js";

const runFile = promisify(execFile);

export async function probeDuration(
  file: string,
): Promise<{ durationSeconds: number | null; durationStatus: "available" | "unavailable" }> {
  try {
    const { stdout } = await runFile(
      config.ffprobe,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        file,
      ],
      { timeout: 15000, maxBuffer: 65536 },
    );
    const duration = Number(JSON.parse(stdout).format?.duration);
    if (Number.isFinite(duration) && duration > 0)
      return { durationSeconds: duration, durationStatus: "available" };
  } catch {
    /* Keep archival successful even without ffprobe or valid duration metadata. */
  }
  return { durationSeconds: null, durationStatus: "unavailable" };
}

function timestamp(value: unknown, name: string): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
    throw new RequestError(400, "INVALID_VIDEO_TIMING", `${name} must be a positive integer`);
  return number;
}

function uploadTiming(req: IncomingMessage): JsonObject {
  const url = new URL(req.url || "/", "http://localhost");
  const result: JsonObject = { timingSource: "app_wall_clock", timestampUnit: "unix_ms" };
  for (const name of ["inspectionId", "recordingId"]) {
    const value = url.searchParams.get(name);
    if (value !== null) {
      if (!value.trim() || value.length > 200)
        throw new RequestError(400, "INVALID_VIDEO_TIMING", `${name} is invalid`);
      result[name] = value;
    }
  }
  for (const name of ["clipIndex", "startRequestedAt", "startedAt", "stopRequestedAt"]) {
    const value = url.searchParams.get(name);
    if (value !== null) result[name] = timestamp(value, name);
  }
  if (
    typeof result.startRequestedAt === "number" &&
    typeof result.startedAt === "number" &&
    result.startedAt < result.startRequestedAt
  )
    throw new RequestError(
      400,
      "INVALID_VIDEO_TIMING",
      "Start confirmation precedes start request",
    );
  if (
    typeof result.startedAt === "number" &&
    typeof result.stopRequestedAt === "number" &&
    result.stopRequestedAt < result.startedAt
  )
    throw new RequestError(400, "INVALID_VIDEO_TIMING", "Stop request precedes start confirmation");
  return result;
}

async function atomicJson(file: string, value: JsonObject): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
  await rename(temporary, file);
}

async function savedTiming(sessionId: string): Promise<JsonObject> {
  try {
    return JSON.parse(
      await readFile(join(config.data, "video-timing", `${safeName(sessionId)}.json`), "utf8"),
    ) as JsonObject;
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") throw cause;
    return {};
  }
}

export async function saveVideoTiming(body: JsonObject): Promise<JsonObject> {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || sessionId.length > 200)
    throw new RequestError(400, "INVALID_VIDEO_TIMING", "sessionId is invalid");
  const stopConfirmedAt = timestamp(body.stopConfirmedAt, "stopConfirmedAt");
  const status = await videoStatus(sessionId);
  const latest = status.latest as JsonObject | null;
  if (!latest) throw new RequestError(404, "VIDEO_NOT_FOUND", "Video has not uploaded yet");
  if (typeof latest.stopRequestedAt === "number" && stopConfirmedAt < latest.stopRequestedAt)
    throw new RequestError(400, "INVALID_VIDEO_TIMING", "Stop confirmation precedes stop request");
  await mkdir(join(config.data, "video-timing"), { recursive: true });
  await atomicJson(join(config.data, "video-timing", `${sessionId}.json`), { stopConfirmedAt });
  // Keep each upload's sidecar self-contained for later merging.
  const entries = await readdir(join(config.data, "videos"));
  for (const entry of entries.filter((file) => file.endsWith(".json"))) {
    const file = join(config.data, "videos", entry);
    let record: JsonObject;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as JsonObject;
    } catch {
      continue;
    }
    if (record.sessionId === sessionId) await atomicJson(file, { ...record, stopConfirmedAt });
  }
  return { sessionId, stopConfirmedAt };
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
    const nameMatch = headerText.match(/(?:^|;)\s*name="([^"]*)"/i);
    const filenameMatch = headerText.match(/(?:^|;)\s*filename="([^"]*)"/i);
    if (nameMatch) {
      const contentTypeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1],
        contentType: contentTypeMatch?.[1]?.trim(),
        data: body.subarray(headerEnd + 4, next - 2),
      });
    }
    cursor = next;
  }
  return parts;
}

export async function uploadVideo(
  req: IncomingMessage,
  body: Buffer,
  sessionId: string,
): Promise<JsonObject> {
  const timing = uploadTiming(req);
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
  await writeFile(join(config.data, "videos", fileName), part.data, { flag: "wx" });
  const media = await probeDuration(join(config.data, "videos", fileName));
  const response = {
    ...timing,
    ...(await savedTiming(sessionId)),
    ...media,
    id,
    sessionId,
    filename: fileName,
    mimeType,
    bytes: part.data.length,
    url: publicUrl(req, `/data/videos/${fileName}`),
    uploadedAt: new Date().toISOString(),
  };
  await writeFile(join(config.data, "videos", `${id}.json`), JSON.stringify(response, null, 2), {
    flag: "wx",
  });
  return response;
}

export async function videoStatus(sessionId: string): Promise<JsonObject> {
  const entries = await readdir(join(config.data, "videos"));
  const metadata: Array<JsonObject> = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const record = JSON.parse(
        await readFile(join(config.data, "videos", entry), "utf8"),
      ) as JsonObject;
      if (record.sessionId === sessionId)
        metadata.push({ ...record, ...(await savedTiming(sessionId)) });
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
