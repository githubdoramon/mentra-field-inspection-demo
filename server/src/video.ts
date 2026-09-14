import { readdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import type { JsonObject, MultipartPart } from "./types.js";
import { mimeExtension, publicUrl, safeName } from "./utils.js";

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
  const response = {
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
