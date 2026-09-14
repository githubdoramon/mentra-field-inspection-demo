import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { config } from "../../server/src/config";
import { uploadVideo, videoStatus, saveVideoTiming } from "../../server/src/video";
const original = { data: config.data, ffprobe: config.ffprobe };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mentra-video-"));
  config.data = directory;
  await mkdir(join(directory, "videos"));
});
afterEach(async () => {
  config.data = original.data;
  config.ffprobe = original.ffprobe;
  await rm(directory, { recursive: true, force: true });
});
function request(bytes: Buffer) {
  const prefix = Buffer.from(
    '--demo\r\nContent-Disposition: form-data; name="video"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n',
  );
  return {
    req: {
      url: "/api/video/upload?sessionId=clip-1&inspectionId=inspection-1&clipIndex=1&startRequestedAt=1000&startedAt=1100&stopRequestedAt=2100",
      headers: { "content-type": "multipart/form-data; boundary=demo", host: "example.test" },
    } as IncomingMessage,
    body: Buffer.concat([prefix, bytes, Buffer.from("\r\n--demo--\r\n")]),
  };
}
test("missing ffprobe leaves archived bytes intact and stores timing separately from duration", async () => {
  config.ffprobe = join(directory, "missing-ffprobe");
  const { req, body } = request(Buffer.from("demo-video"));
  const result = await uploadVideo(req, body, "clip-1");
  expect(result.durationSeconds).toBeNull();
  expect(result.durationStatus).toBe("unavailable");
  expect(result.inspectionId).toBe("inspection-1");
  expect(result.startedAt).toBe(1100);
  await saveVideoTiming({ sessionId: "clip-1", stopConfirmedAt: 2300 });
  const sidecar = JSON.parse(
    await readFile(join(directory, "videos", `${result.id}.json`), "utf8"),
  );
  expect(sidecar.stopConfirmedAt).toBe(2300);
  expect((await videoStatus("clip-1")).latest).toMatchObject({
    clipIndex: 1,
    stopRequestedAt: 2100,
    stopConfirmedAt: 2300,
  });
  expect(await readFile(join(directory, "videos", String(result.filename)), "utf8")).toBe(
    "demo-video",
  );
  await expect(
    saveVideoTiming({ sessionId: "clip-1", stopConfirmedAt: 2000 }),
  ).rejects.toMatchObject({ code: "INVALID_VIDEO_TIMING" });
});
