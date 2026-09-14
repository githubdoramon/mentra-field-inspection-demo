import type { IncomingMessage, ServerResponse } from "node:http";
import { RequestError } from "./errors.js";
import { error } from "./http.js";
import { logEvent, requestIdFor, safeLogMessage, withRequestContext } from "./logging.js";
import { handle } from "./routes.js";

export async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = requestIdFor(req);
  const startedAt = Date.now();
  const path = (req.url || "/").split("?", 1)[0];
  withRequestContext(requestId, () => {
    logEvent("http.request.start", { method: req.method || "GET", path });
    res.once("finish", () =>
      logEvent("http.request.end", {
        method: req.method || "GET",
        path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });
  try {
    await withRequestContext(requestId, () => handle(req, res));
  } catch (cause) {
    logEvent("http.request.failure", {
      method: req.method || "GET",
      path,
      status: 500,
      errorCode: cause instanceof RequestError ? cause.code : "INTERNAL_ERROR",
      message: safeLogMessage(
        cause instanceof RequestError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : cause,
      ),
    });
    if (!res.headersSent)
      error(
        res,
        cause instanceof RequestError ? cause.status : 500,
        cause instanceof RequestError ? cause.code : "INTERNAL_ERROR",
        cause instanceof RequestError ? cause.message : "The server could not complete the request",
      );
    else res.destroy();
  }
}
