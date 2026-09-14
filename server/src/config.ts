import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Small dependency-free .env loader for the laptop demo. Existing shell
 * variables win, and values are never logged or returned by the API. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
loadDotEnv(join(ROOT, "server", ".env"));

export const config = {
  data: join(ROOT, "data"),
  ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  workflows: join(ROOT, "workflows"),
  port: numberEnv("PORT", 8787),
  host: process.env.HOST || "0.0.0.0",
  aiBaseUrl: (process.env.AI_BASE_URL || "http://localhost:11434").replace(/\/$/, ""),
  aiModel: process.env.AI_MODEL || "qwen3.8-27b",
  aiTimeoutMs: numberEnv("AI_TIMEOUT_MS", 90_000),
  aiEnableThinking: process.env.AI_ENABLE_THINKING === "true",
  aiImageMaxEdge: Math.max(128, Math.min(2048, Math.floor(numberEnv("AI_IMAGE_MAX_EDGE", 512)))),
  aiReferenceMaxEdge: Math.max(
    128,
    Math.min(2048, Math.floor(numberEnv("AI_REFERENCE_MAX_EDGE", 256))),
  ),
  aiImageJpegQuality: Math.max(
    1,
    Math.min(100, Math.floor(numberEnv("AI_IMAGE_JPEG_QUALITY", 70))),
  ),
  aiEvaluationMaxTokens: Math.max(
    500,
    Math.min(4_000, Math.floor(numberEnv("AI_EVALUATION_MAX_TOKENS", 500))),
  ),
  evidencePreviewMaxEdge: 768,
  evidencePreviewJpegQuality: 75,
  maxJsonBytes: 30 * 1024 * 1024,
  maxPhotoBytes: 20 * 1024 * 1024,
  maxVideoBytes: 250 * 1024 * 1024,
};
