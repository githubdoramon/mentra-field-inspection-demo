import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const apps = ["server", "miniapp"];
const missing = apps.filter((name) => !existsSync(resolve(root, name, "package.json")));

if (missing.length) {
  console.error(
    `Missing package.json: ${missing.join(", ")}. Wait for the app folders to be scaffolded.`,
  );
  process.exit(1);
}

for (const name of apps) {
  console.log(`\nInstalling ${name} dependencies...`);
  const result = spawnSync("bun", ["install"], {
    cwd: resolve(root, name),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nSetup complete. Copy server/.env.example to server/.env, then run: bun run dev");
