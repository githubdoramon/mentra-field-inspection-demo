import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const names = ["server", "miniapp"];
const children = [];
const specs = [];
let stopping = false;
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;
const devEnvironment = { ...process.env };
if (!devEnvironment.MENTRA_PUBLIC_SERVER_URL && lanAddress)
  devEnvironment.MENTRA_PUBLIC_SERVER_URL = `http://${lanAddress}:8787`;

const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
};

for (const name of names) {
  const dir = resolve(root, name);
  const manifestPath = resolve(dir, "package.json");
  if (!existsSync(manifestPath)) {
    console.error(`Missing ${name}/package.json; run bun run setup after scaffolding the app.`);
    process.exit(1);
  }
  const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
  const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
  if (!script) {
    console.error(`${name}/package.json needs a dev or start script.`);
    process.exit(1);
  }
  specs.push({ dir, name, script });
}

for (const { dir, name, script } of specs) {
  const child = spawn("bun", ["run", script], {
    cwd: dir,
    stdio: "inherit",
    env: devEnvironment,
  });
  child.once("error", (error) => {
    console.error(`Could not start ${name}:`, error.message);
    stop("SIGTERM");
    process.exitCode = 1;
  });
  children.push(child);
}

console.log(
  `\nCompanion server for the phone: ${devEnvironment.MENTRA_PUBLIC_SERVER_URL || "configure in connection settings"}\nScan the miniapp QR in MentraOS; Ctrl+C stops both.\n`,
);

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

for (const child of children) {
  child.once("exit", (code) => {
    if (!stopping) {
      stop();
      process.exitCode = code ?? 1;
    }
  });
}
