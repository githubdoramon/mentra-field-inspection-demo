import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export async function ensureDataDirs(): Promise<void> {
  await Promise.all(
    ["evidence", "videos", "reports", "escalations", "workflows", "video-timing"].map((directory) =>
      mkdir(join(config.data, directory), { recursive: true }),
    ),
  );
}
