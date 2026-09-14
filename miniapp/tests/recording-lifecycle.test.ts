import { expect, test } from "bun:test";
import { InspectionController, type Ports } from "../src/shared/controller";

function recorder(startRecording?: Ports["startRecording"], overrides: Partial<Ports> = {}) {
  let starts = 0;
  const stops: Array<{ id: string; url: string }> = [];
  const controller = new InspectionController({
    load: async () => null,
    save: async () => {},
    snapshot: () => {},
    toast: () => {},
    speak: async () => {},
    capture: async () => {
      throw new Error("not used");
    },
    startRecording: startRecording || (async () => ({ recordingId: `clip-${++starts}` })),
    stopRecording: async (id, url) => {
      stops.push({ id, url });
    },
    ...overrides,
  });
  controller.request = async <T>(path: string, body?: unknown): Promise<T> => {
    if (path.startsWith("/api/video/status"))
      return { status: "uploaded", latest: { url: "http://laptop/clip.mp4" } } as T;
    if (path === "/api/reports") return { id: "report", url: "http://laptop/report" } as T;
    if (path === "/api/evidence") return { ...(body as object), id: "photo", archived: true } as T;
    if (path === "/api/evaluate")
      return { status: "evidence_unclear", finding: "Retake photo" } as T;
    throw new Error(`Unexpected request: ${path}`);
  };
  return { controller, stops };
}

test("leaving stops once and uploads an unfinished inspection; resuming retains the previous clip", async () => {
  const { controller, stops } = recorder();
  await controller.begin();
  const startedAt = controller.state.startedAt;
  await Promise.all([controller.pause(), controller.pause()]);
  expect(stops.length).toBe(1);
  expect(stops[0].url).toContain("/api/video/upload?sessionId=");
  expect(controller.state.pausedAt).toBeDefined();
  expect(controller.state.finishedAt).toBeUndefined();
  expect(controller.state.termination).toBeUndefined();
  await controller.begin();
  expect(controller.state.startedAt).toBe(startedAt);
  expect(controller.state.recording.recordingId).toBe("clip-2");
  expect(controller.state.recording.clips?.[0].recordingId).toBe("clip-1");
  await controller.finish("Leaving the test inspection.");
  expect(stops.length).toBe(2);
  expect(stops[1].url).not.toBe(stops[0].url);
});

test("photo waits for recording stop confirmation, then resumes a new clip before evaluation", async () => {
  let releaseStop!: () => void;
  let signalStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    signalStop = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let captures = 0;
  const { controller } = recorder(undefined, {
    stopRecording: async () => {
      signalStop();
      await stopped;
    },
    capture: async () => {
      captures++;
      return { photoUrl: "http://laptop/photo.jpg", mimeType: "image/jpeg" };
    },
  });
  const request = controller.request.bind(controller);
  controller.request = async <T>(path: string, body?: unknown): Promise<T> => {
    if (path === "/api/evaluate") expect(controller.state.recording.recordingId).toBe("clip-2");
    return request<T>(path, body);
  };
  await controller.begin();
  const capturing = controller.capture("initial");
  await stopping;
  expect(captures).toBe(0);
  releaseStop();
  await capturing;
  expect(captures).toBe(1);
  expect(controller.state.recording.clips?.[0].recordingId).toBe("clip-1");
  expect(controller.state.recording.status).toBe("recording");
});

test("failed video stop blocks photo capture and does not start an overlapping recording", async () => {
  let captures = 0;
  const { controller } = recorder(undefined, {
    stopRecording: async () => {
      throw new Error("Stop failed");
    },
    capture: async () => {
      captures++;
      throw new Error("Must not capture");
    },
  });
  await controller.begin();
  await controller.capture("initial");
  expect(captures).toBe(0);
  expect(controller.state.recording.recordingId).toBe("clip-1");
  expect(controller.state.recording.clips).toEqual([]);
  expect(controller.state.message).toContain("recording could not be stopped");
});

test("camera failure resumes recording, but leaving during a capture prevents automatic resume", async () => {
  const failed = recorder(undefined, {
    capture: async () => {
      throw new Error("Camera failed");
    },
  });
  await failed.controller.begin();
  await failed.controller.capture("initial");
  expect(failed.controller.state.status).toBe("error");
  expect(failed.controller.state.recording.recordingId).toBe("clip-2");

  let signalCapture!: () => void;
  let releaseCapture!: (photo: { photoUrl: string; mimeType: string }) => void;
  const started = new Promise<void>((resolve) => {
    signalCapture = resolve;
  });
  const photo = new Promise<{ photoUrl: string; mimeType: string }>((resolve) => {
    releaseCapture = resolve;
  });
  const { controller } = recorder(undefined, {
    capture: () => {
      signalCapture();
      return photo;
    },
  });
  await controller.begin();
  const capturing = controller.capture("initial");
  await started;
  await controller.pause();
  releaseCapture({ photoUrl: "http://laptop/photo.jpg", mimeType: "image/jpeg" });
  await capturing;
  expect(controller.state.pausedAt).toBeDefined();
  expect(controller.state.recording.recordingId).toBe("clip-1");
  expect(controller.state.recording.status).toBe("uploaded");
});

test("leaving while recording starts stops and uploads it as soon as the native start returns", async () => {
  let resolveStart!: (value: { recordingId: string }) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const start = new Promise<{ recordingId: string }>((resolve) => {
    resolveStart = resolve;
  });
  const { controller, stops } = recorder(() => {
    signalStarted();
    return start;
  });
  const beginning = controller.begin();
  await started;
  await controller.pause();
  resolveStart({ recordingId: "late-clip" });
  await beginning;
  expect(stops.map((stop) => stop.id)).toEqual(["late-clip"]);
  expect(controller.state.pausedAt).toBeDefined();
  expect(controller.state.recording.status).toBe("uploaded");
});

test("reset clears the phone snapshot, stops the active recording, and keeps the server URL", async () => {
  const { controller, stops } = recorder();
  controller.state.serverUrl = "http://laptop:8787";
  await controller.begin();
  controller.state.evidence.push({
    id: "photo",
    attemptId: "attempt",
    stepId: "purge-limiter",
    kind: "initial",
    photoUrl: "http://laptop/photo.jpg",
    mimeType: "image/jpeg",
    createdAt: Date.now(),
    archived: true,
  });
  await controller.reset();
  expect(stops).toHaveLength(1);
  expect(controller.state.status).toBe("ready");
  expect(controller.state.evidence).toEqual([]);
  expect(controller.state.attempts).toEqual([]);
  expect(controller.state.serverUrl).toBe("http://laptop:8787");
  expect(controller.state.currentStepId).toBe("purge-limiter");
});
