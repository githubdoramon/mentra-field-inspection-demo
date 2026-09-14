import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, relative } from "node:path";
const root = resolve(import.meta.dirname, "../miniapp/dist/ui");
const publicRoot = resolve(import.meta.dirname, "../miniapp/public");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const base = path.startsWith("/public/") ? publicRoot : root;
    const assetPath = base === publicRoot ? path.slice("/public".length) : path;
    const file = resolve(
      base,
      `.${assetPath === "/" ? "/index.html" : decodeURIComponent(assetPath)}`,
    );
    if (relative(base, file).startsWith("..")) throw new Error("Invalid path");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(3180, "0.0.0.0", () => console.log("Browser preview: http://localhost:3180/"));
