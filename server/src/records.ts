import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { RequestError } from "./errors.js";
import { loadProcedure, snapshotDetails, validateReportTermination } from "./procedure.js";
import type { JsonObject } from "./types.js";
import { publicUrl, safeName } from "./utils.js";

type SnapshotType = "reports" | "escalations";

export async function saveSnapshot(
  req: IncomingMessage,
  body: JsonObject,
  type: SnapshotType,
): Promise<JsonObject> {
  const procedure = await loadProcedure();
  const termination = type === "reports" ? validateReportTermination(body, procedure) : undefined;
  const snapshot = termination ? { ...body, termination } : body;
  const headerId = req.headers["idempotency-key"];
  const suppliedId =
    typeof snapshot.id === "string"
      ? snapshot.id
      : typeof snapshot[`${type.slice(0, -1)}Id`] === "string"
        ? (snapshot[`${type.slice(0, -1)}Id`] as string)
        : typeof headerId === "string"
          ? headerId
          : "";
  const id = safeName(suppliedId, randomUUID());
  const createdAt = new Date().toISOString();
  const details = snapshotDetails(snapshot, procedure);
  const output =
    type === "reports"
      ? {
          id,
          type: "inspection_report",
          createdAt,
          snapshot,
          report: details,
          url: publicUrl(req, `/data/${type}/${id}.json`),
        }
      : {
          id,
          type: "expert_escalation",
          createdAt,
          snapshot: body,
          package: {
            ...details,
            requestedBy: body.technician || procedure.asset.technician || null,
            requestedAt: createdAt,
          },
          url: publicUrl(req, `/data/${type}/${id}.json`),
        };
  // A report can be posted again with the same id after video upload completes;
  // overwrite the saved snapshot so the late recording metadata is retained.
  await writeFile(join(config.data, type, `${id}.json`), JSON.stringify(output, null, 2));
  return output;
}

export async function readSavedSnapshot(type: SnapshotType, id: string): Promise<JsonObject> {
  try {
    return JSON.parse(
      await readFile(join(config.data, type, `${safeName(id)}.json`), "utf8"),
    ) as JsonObject;
  } catch {
    throw new RequestError(
      404,
      `${type === "reports" ? "REPORT" : "ESCALATION"}_NOT_FOUND`,
      "Saved record was not found",
    );
  }
}
