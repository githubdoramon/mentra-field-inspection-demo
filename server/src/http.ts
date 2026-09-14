import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import { currentRequestId, logEvent, safeLogMessage } from "./logging.js";
import type { JsonObject } from "./types.js";

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type, authorization, idempotency-key, x-inspection-request-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...(currentRequestId() ? { "x-inspection-request-id": currentRequestId() ?? "" } : {}),
  };
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  res.end(body);
}

export function error(res: ServerResponse, status: number, code: string, message: string): void {
  logEvent("http.failure", { status, errorCode: code, message: safeLogMessage(message) });
  json(res, status, { error: code, message });
}

export async function bodyBuffer(req: IncomingMessage, limit: number): Promise<Buffer> {
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

export async function jsonBody(req: IncomingMessage): Promise<JsonObject> {
  const body = await bodyBuffer(req, config.maxJsonBytes);
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("object required");
    return value as JsonObject;
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}
