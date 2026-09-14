import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { config, ROOT } from "./config.js";
import { archiveEvidence } from "./evidence.js";
import { error, bodyBuffer, json, jsonBody, corsHeaders } from "./http.js";
import { ask, evaluate } from "./inspection.js";
import { discoverProcedures, loadProcedure, procedureContext } from "./procedure.js";
import { readSavedSnapshot, saveSnapshot } from "./records.js";
import { serveStaticData } from "./static-files.js";
import { uploadVideo, videoStatus, saveVideoTiming } from "./video.js";
import { RequestError } from "./errors.js";

async function health(res: ServerResponse): Promise<void> {
  const procedures = await discoverProcedures();
  const aiConfigured = Boolean(process.env.AI_BEARER_TOKEN?.trim());
  json(res, 200, {
    ok: true,
    status: "ok",
    server: "mentra-inspection-v0",
    now: new Date().toISOString(),
    port: config.port,
    aiConfigured,
    model: config.aiModel,
    ai: { configured: aiConfigured, baseUrl: config.aiBaseUrl, model: config.aiModel },
    workflows: procedures.map((p) => ({ id: p.procedureId, version: p.version, title: p.title })),
  });
}

async function reference(res: ServerResponse, url: URL): Promise<void> {
  const procedure = await loadProcedure({
    procedureId: url.searchParams.get("procedureId"),
    procedureVersion: Number(url.searchParams.get("procedureVersion")),
  });
  const step = procedure.steps.find((item) => item.stepId === url.searchParams.get("stepId"));
  const index = Number(url.searchParams.get("index"));
  const referencePath =
    url.searchParams.has("index") && Number.isInteger(index) && index >= 0
      ? step?.references?.[index]?.path
      : undefined;
  if (!referencePath) {
    error(res, 404, "NOT_FOUND", "Reference image not found");
    return;
  }
  const knowledgeRoot = join(ROOT, "knowledge");
  const target = normalize(join(ROOT, referencePath));
  const targetRelative = relative(knowledgeRoot, target);
  const contentType = {
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  }[extname(target).toLowerCase()];
  if (targetRelative.startsWith("..") || !contentType) {
    error(res, 404, "NOT_FOUND", "Reference image not found");
    return;
  }
  try {
    const bytes = await readFile(target);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": bytes.length,
      "cache-control": "no-store",
      ...corsHeaders(),
    });
    res.end(bytes);
  } catch {
    error(res, 404, "NOT_FOUND", "Reference image not found");
  }
}

async function context(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const procedures = await discoverProcedures();
  json(res, 200, { ok: true, workflows: procedures.map((p) => procedureContext(p, req)) });
}

async function savedRecord(res: ServerResponse, url: URL): Promise<void> {
  const id = url.searchParams.get("id")?.trim();
  if (!id) {
    error(res, 400, "ID_REQUIRED", "id query parameter is required");
    return;
  }
  const type = url.pathname === "/api/report" ? "reports" : "escalations";
  json(res, 200, await readSavedSnapshot(type, id));
}

function sessionId(url: URL): string {
  const value = url.searchParams.get("sessionId")?.trim();
  if (!value)
    throw new RequestError(400, "SESSION_ID_REQUIRED", "sessionId query parameter is required");
  return value;
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${config.port}`}`);
  try {
    if (await serveStaticData(res, url.pathname)) return;
    if (req.method === "GET" && url.pathname === "/api/health") return health(res);
    if (req.method === "GET" && url.pathname === "/api/reference") return reference(res, url);
    if (req.method === "GET" && ["/api/context", "/api/workflows"].includes(url.pathname))
      return context(req, res);
    if (
      req.method === "GET" &&
      (url.pathname === "/api/report" || url.pathname === "/api/escalation")
    )
      return savedRecord(res, url);
    if (req.method === "GET" && url.pathname === "/api/video/status") {
      json(res, 200, await videoStatus(sessionId(url)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/evidence") {
      json(res, 201, await archiveEvidence(req, await jsonBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/evaluate") {
      json(res, 200, await evaluate(await jsonBody(req)));
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
    if (req.method === "POST" && url.pathname === "/api/video/timing") {
      json(res, 200, await saveVideoTiming(await jsonBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/video/upload") {
      json(
        res,
        201,
        await uploadVideo(req, await bodyBuffer(req, config.maxVideoBytes), sessionId(url)),
      );
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
