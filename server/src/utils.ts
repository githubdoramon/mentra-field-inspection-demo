import type { IncomingMessage } from "node:http";
import { config } from "./config.js";
import { RequestError } from "./errors.js";

export function safeName(value: string, fallback = "item"): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

export function mimeExtension(mime: string): string {
  const lower = mime.toLowerCase().split(";", 1)[0];
  if (lower === "image/png") return ".png";
  if (lower === "image/webp") return ".webp";
  if (lower === "video/mp4") return ".mp4";
  if (lower === "video/quicktime") return ".mov";
  if (lower === "video/webm") return ".webm";
  return ".jpg";
}

export function publicUrl(req: IncomingMessage, path: string): string {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  const base = configured || `http://${req.headers.host || `localhost:${config.port}`}`;
  return `${base}${path}`;
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new RequestError(400, "INVALID_REQUEST", `${key} is required`);
  return value.trim();
}
