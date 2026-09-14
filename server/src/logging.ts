import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { JsonObject } from "./types.js";

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function requestIdFor(req: IncomingMessage): string {
  const supplied = req.headers["x-inspection-request-id"];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  const sanitized =
    typeof value === "string" ? value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 128) : "";
  return sanitized || randomUUID();
}

export function withRequestContext<T>(requestId: string, callback: () => T): T {
  return requestContext.run({ requestId }, callback);
}

export function safeLogMessage(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function logEvent(event: string, fields: JsonObject = {}): void {
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

export function safeLogScalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

export function safeUpstreamExcerpt(value: string): string {
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

export function safeModelExcerpt(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return safeUpstreamExcerpt(
    text
      .replace(/<think>[\s\S]*?<\/think>/gi, "[think omitted]")
      .replace(/<think>[\s\S]*$/i, "[think omitted]"),
  );
}

export function upstreamFailureCause(cause: unknown): string {
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
