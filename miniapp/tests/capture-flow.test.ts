import { expect, test } from "bun:test";
import { InspectionController, type Ports } from "../src/shared/controller";
import { STEP_ID } from "../src/shared/workflow";
import type { InspectionSnapshot } from "../src/shared/types";

function pendingCheck(overrides: Partial<Ports> = {}) {
  let captures = 0;
  const requests: Array<{ path: string; body: unknown }> = [];
  const ports: Ports = {
    load: async () => null,
    save: async () => {},
    snapshot: () => {},
    toast: () => {},
    speak: async () => {},
    capture: async () => {
      captures++;
      return { photoUrl: "data:image/jpeg;base64,new-photo", mimeType: "image/jpeg" };
    },
    ...overrides,
  };
  const controller = new InspectionController(ports);
  const previous = {
    id: "previous-photo",
    attemptId: "previous-attempt",
    stepId: STEP_ID,
    kind: "initial" as const,
    photoUrl: "previous-url",
    mimeType: "image/jpeg",
    createdAt: 1,
    archived: true,
  };
  controller.state.status = "error";
  controller.state.evidence = [previous];
  controller.state.attempts = [
    {
      id: previous.attemptId,
      kind: "initial",
      status: "pending",
      evidenceId: previous.id,
      createdAt: 1,
    },
  ];
  controller.request = async <T>(path: string, body?: unknown): Promise<T> => {
    requests.push({ path, body });
    if (path === "/api/evidence")
      return { ...previous, id: "fresh-photo", ...(body as object) } as T;
    return {
      status: "evidence_unclear",
      finding: "Mounting slot is not visible.",
      recommendedAction: "Take a closer photo.",
      evidenceId: (body as { evidenceId: string }).evidenceId,
      stepId: STEP_ID,
      procedureReference: "test",
    } as T;
  };
  return { controller, requests, captures: () => captures };
}

test("physical capture after an AI error takes and archives a fresh photo; simultaneous capture is ignored", async () => {
  const { controller, requests, captures } = pendingCheck();
  await Promise.all([controller.capture("verification"), controller.capture("verification")]);
  expect(captures()).toBe(1);
  expect(requests.map((item) => item.path)).toEqual(["/api/evidence", "/api/evaluate"]);
  expect((requests[1].body as { evidenceId: string }).evidenceId).toBe("fresh-photo");
  expect(controller.state.evidence.map((item) => item.id)).toEqual([
    "previous-photo",
    "fresh-photo",
  ]);
  expect(controller.state.status).toBe("evidence_unclear");
});

test("Retry check evaluates the saved photo without activating the camera", async () => {
  const { controller, requests, captures } = pendingCheck();
  await controller.retryCheck();
  expect(captures()).toBe(0);
  expect(requests).toEqual([
    { path: "/api/evaluate", body: { evidenceId: "previous-photo", stepId: STEP_ID } },
  ]);
});

test("captured photo reaches the UI before archival, and thumbnail bytes remain out of persisted state", async () => {
  const snapshots: InspectionSnapshot[] = [];
  const saved: string[] = [];
  const controller = new InspectionController({
    load: async () => null,
    save: async (value) => {
      saved.push(value);
    },
    snapshot: (value) => {
      snapshots.push(value);
    },
    toast: () => {},
    speak: async () => {},
    capture: async () => ({
      photoUrl: "https://photos.example/captured.jpg",
      mimeType: "image/jpeg",
    }),
  });
  controller.state.status = "recording";
  controller.request = async <T>(path: string, body?: unknown): Promise<T> => {
    if (path === "/api/evidence") {
      expect(snapshots.at(-1)?.pendingPhoto?.photoUrl).toBe("https://photos.example/captured.jpg");
      return {
        id: "new",
        ...(body as object),
        photoUrl: "http://192.168.1.255:8787/data/evidence/new.jpg",
        photoPath: "/data/evidence/new.jpg",
        previewDataUrl: "data:image/jpeg;base64,thumbnail-only",
        archived: true,
        createdAt: 1,
      } as T;
    }
    return {
      status: "evidence_unclear",
      finding: "Slot not visible.",
      recommendedAction: "Move closer.",
      procedureReference: "test",
    } as T;
  };
  await controller.capture("initial");
  expect(snapshots.at(-1)?.evidence[0].previewDataUrl).toBe(
    "data:image/jpeg;base64,thumbnail-only",
  );
  expect(controller.state.evidence[0].photoUrl).toBe(
    `${controller.state.serverUrl}/data/evidence/new.jpg`,
  );
  expect(
    saved.every((value) => !value.includes("thumbnail-only") && !JSON.parse(value).pendingPhoto),
  ).toBe(true);
});

test("voice start opens an active inspection without resetting its evidence", async () => {
  let opens = 0;
  const { controller } = pendingCheck({
    openInspection: () => {
      opens++;
    },
  });
  controller.state.evidence[0].photoUrl = "http://192.168.1.255:8787/data/evidence/previous.jpg";
  await controller.transcript("Please start inspection.");
  expect(opens).toBe(1);
  expect(controller.state.evidence[0].id).toBe("previous-photo");
  expect(controller.state.evidence[0].photoUrl).toBe(
    `${controller.state.serverUrl}/data/evidence/previous.jpg`,
  );
});

test("older saved inspections regain server references without resetting progress", async () => {
  const { controller } = pendingCheck();
  const saved = structuredClone(controller.state);
  saved.steps = saved.steps.map(({ references: _references, ...step }) => step);
  saved.steps[0].state = "passed";
  const restored = pendingCheck({ load: async () => JSON.stringify(saved) }).controller;
  await restored.init();
  expect(restored.state.steps[0].state).toBe("passed");
  expect(restored.state.evidence).toHaveLength(1);
  expect(restored.state.steps[0].references?.seated).toBe(
    `/api/reference?stepId=${encodeURIComponent(STEP_ID)}&role=seated`,
  );
  await restored.setServer("http://192.168.1.99:8787");
  expect(restored.state.serverUrl + restored.state.steps[0].references?.seated).toBe(
    `http://192.168.1.99:8787/api/reference?stepId=${encodeURIComponent(STEP_ID)}&role=seated`,
  );
});
