import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { config } from "./config.js";
import { error, corsHeaders } from "./http.js";

function contentTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".json": "application/json; charset=utf-8",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
    }[extension] || "image/jpeg"
  );
}

export async function serveStaticData(res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith("/data/")) return false;
  const requested = decodeURIComponent(path.slice("/data/".length));
  const target = normalize(join(config.data, requested));
  const targetRelative = relative(config.data, target);
  if (targetRelative.startsWith("..") || targetRelative.includes("..")) {
    error(res, 404, "NOT_FOUND", "Not found");
    return true;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      error(res, 404, "NOT_FOUND", "Not found");
      return true;
    }
    res.writeHead(200, {
      "content-type": contentTypeFor(target),
      "content-length": info.size,
      "cache-control": "no-store",
      ...corsHeaders(),
    });
    createReadStream(target).pipe(res);
  } catch {
    error(res, 404, "NOT_FOUND", "Not found");
  }
  return true;
}
