import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [appName, requestedScript = "dev"] = process.argv.slice(2);
const appDir = resolve(root, appName);
const manifestPath = resolve(appDir, "package.json");

if (!existsSync(manifestPath)) {
  console.error(`Cannot run ${appName}: ${appName}/package.json does not exist.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const script = manifest.scripts?.[requestedScript]
  ? requestedScript
  : requestedScript === "dev" && manifest.scripts?.start
    ? "start"
    : null;

if (!script) {
  console.error(`${appName}/package.json has no '${requestedScript}' script.`);
  process.exit(1);
}

const child = spawn("bun", ["run", script, ...process.argv.slice(3)], {
  cwd: appDir,
  stdio: "inherit",
  env: process.env,
});

const stop = (signal) => child.kill(signal);
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("error", (error) => {
  console.error(`Could not start ${appName}:`, error.message);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
