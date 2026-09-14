import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { config } from "../../server/src/config";
import {
  discoverProcedures,
  loadProcedure,
  snapshotDetails,
  validateProcedure,
  validateReportTermination,
} from "../../server/src/procedure";
import { imageParts, buildModelMessages } from "../../server/src/ai";
import { evaluate, ask } from "../../server/src/inspection";
import printer from "../../workflows/a1-mini.json";
import workstation from "../../workflows/workstation-readiness.json";

const original = { data: config.data, workflows: config.workflows };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mentra-workflows-"));
  config.data = join(directory, "data");
  config.workflows = join(directory, "workflows");
  await mkdir(config.workflows);
  await mkdir(join(config.data, "evidence"), { recursive: true });
  await writeFile(join(config.workflows, "printer.json"), JSON.stringify(printer));
  await writeFile(join(config.workflows, "workstation.json"), JSON.stringify(workstation));
});
afterEach(async () => {
  config.data = original.data;
  config.workflows = original.workflows;
  await rm(directory, { recursive: true, force: true });
});

test("discovers both files and retains pinned definitions after editing or removing source files", async () => {
  const found = await discoverProcedures();
  expect(found.map((p) => p.procedureId)).toEqual([printer.procedureId, workstation.procedureId]);
  await writeFile(
    join(config.workflows, "printer.json"),
    JSON.stringify({ ...printer, version: 3, title: "Changed inspection" }),
  );
  await discoverProcedures();
  const pinned = await loadProcedure({ procedureId: printer.procedureId, procedureVersion: 2 });
  expect(pinned.title).toBe(printer.title);
  await rm(join(config.workflows, "printer.json"));
  expect(
    (await loadProcedure({ procedureId: printer.procedureId, procedureVersion: 2 })).steps,
  ).toEqual(printer.steps);
});

test("same-version edits are rejected instead of changing active inspections", async () => {
  await discoverProcedures();
  await writeFile(
    join(config.workflows, "printer.json"),
    JSON.stringify({ ...printer, title: "Changed" }),
  );
  await expect(discoverProcedures()).rejects.toMatchObject({ code: "WORKFLOW_VERSION_CHANGED" });
});

test("invalid criteria, duplicate IDs, unsafe references, and unselected workflows are rejected", async () => {
  for (const p of [
    { ...printer, steps: [{ ...printer.steps[0], visualCriteria: [] }] },
    { ...printer, steps: [printer.steps[0], printer.steps[0]] },
    {
      ...printer,
      steps: [
        {
          ...printer.steps[0],
          references: [{ role: "good", caption: "Example", path: "knowledge/../server/.env.jpg" }],
        },
      ],
    },
  ])
    expect(() => validateProcedure(p)).toThrow();
  await writeFile(join(config.workflows, "duplicate.json"), JSON.stringify(printer));
  await expect(discoverProcedures()).rejects.toMatchObject({ code: "DUPLICATE_WORKFLOW" });
  await expect(
    loadProcedure({ procedureId: "../secrets", procedureVersion: 1 }),
  ).rejects.toMatchObject({ code: "WORKFLOW_REQUIRED" });
});

test("a photo check without references uses its own criteria and never the seating-specific prompt", async () => {
  const procedure = validateProcedure(workstation);
  const messages = await buildModelMessages(procedure.steps[1], undefined, procedure);
  const text = JSON.stringify(messages);
  expect(text).toContain("A screwdriver is visible.");
  expect(text).toContain("There is no current evidence image");
  expect(text).not.toContain("loose and correctly seated");
  expect(text).not.toContain("visibly displaced or not seated");
});

test("reports require all configured steps and group evidence by step", () => {
  const procedure = validateProcedure(printer);
  const steps = printer.steps.map((step) => ({ id: step.stepId, state: "passed" }));
  expect(() => validateReportTermination({ steps: steps.slice(0, 1) }, procedure)).toThrow();
  expect(validateReportTermination({ steps }, procedure)).toBeUndefined();
  expect(
    validateReportTermination(
      { steps: [], termination: { reason: " Needs follow-up " } },
      procedure,
    ),
  ).toEqual({ reason: "Needs follow-up" });
  const details = snapshotDetails(
    {
      steps,
      evidence: [
        { id: "before", stepId: "purge-limiter", kind: "initial" },
        { id: "after", stepId: "build-plate", kind: "verification" },
      ],
    },
    procedure,
  );
  const grouped = details.stepDetails as Array<{ before: unknown; after: unknown }>;
  expect(grouped[0].after).toBeNull();
  expect(grouped[2].before).toBeNull();
});

test("evaluation and guidance reject evidence from a different workflow before contacting AI", async () => {
  await discoverProcedures();
  await writeFile(
    join(config.data, "evidence", "wrong.json"),
    JSON.stringify({
      id: "wrong",
      stepId: "purge-limiter",
      procedureId: workstation.procedureId,
      procedureVersion: 1,
    }),
  );
  const body = {
    procedureId: printer.procedureId,
    procedureVersion: 2,
    stepId: "purge-limiter",
    evidenceId: "wrong",
  };
  await expect(evaluate(body)).rejects.toMatchObject({ code: "EVIDENCE_STEP_MISMATCH" });
  await expect(ask({ ...body, question: "What should I do?" })).rejects.toMatchObject({
    code: "EVIDENCE_STEP_MISMATCH",
  });
  expect(
    JSON.parse(await readFile(join(config.data, "evidence", "wrong.json"), "utf8")).evaluation,
  ).toBeUndefined();
});

test("concurrent discovery reads share complete pinned versions; malformed JSON has a clear error", async () => {
  const results = await Promise.all([discoverProcedures(), discoverProcedures()]);
  expect(results[0]).toEqual(results[1]);
  await writeFile(join(config.workflows, "broken.json"), "{");
  await expect(discoverProcedures()).rejects.toMatchObject({ code: "INVALID_WORKFLOW" });
});

// Decode the actual prepared JPEGs with the server's image dependency.
const sharp = createRequire(new URL("../../server/package.json", import.meta.url))("sharp");
test("references and evidence use separate size limits while original evidence stays intact", async () => {
  const file = join(directory, "original.jpg");
  const original = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  await writeFile(file, original);
  const evidence = {
    id: "sample",
    stepId: printer.steps[0].stepId,
    procedureId: printer.procedureId,
    procedureVersion: printer.version,
    attemptId: "sample",
    kind: "initial",
    mimeType: "image/jpeg",
    file,
    bytes: original.length,
    sourceUrl: "demo",
    photoUrl: "demo",
    url: "demo",
    createdAt: 1,
    archived: true,
  };
  const prepared = await imageParts(validateProcedure(printer).steps[0], evidence);
  expect(prepared).toHaveLength(3);
  for (const [index, image] of prepared.entries()) {
    const metadata = await sharp(
      Buffer.from(image.image_url.url.split(",")[1], "base64"),
    ).metadata();
    const limit =
      index < 2
        ? Math.min(config.aiReferenceMaxEdge, config.aiImageMaxEdge)
        : config.aiImageMaxEdge;
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(limit);
    expect(metadata.format).toBe("jpeg");
  }
  expect(await readFile(file)).toEqual(original);
});
