import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const miniappDir = resolve(root, "miniapp");
const serverDir = resolve(root, "server");
const children = [];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
};

if (!existsSync(resolve(miniappDir, "package.json"))) {
  console.error("Cannot preview: miniapp/package.json does not exist.");
  process.exit(1);
}

const run = (cwd, script, args = []) => {
  const child = spawn("bun", ["run", script, ...args], { cwd, stdio: "inherit", env: process.env });
  child.once("error", (error) => {
    console.error(`Could not start ${script}:`, error.message);
    stop();
    process.exitCode = 1;
  });
  children.push(child);
  return child;
};

const miniappScripts =
  JSON.parse(readFileSync(resolve(miniappDir, "package.json"), "utf8")).scripts ?? {};
if (miniappScripts.build) {
  const build = run(miniappDir, "build");
  const code = await new Promise((resolveCode) => build.once("exit", resolveCode));
  if (code !== 0) process.exit(code ?? 1);
}

// Browser preview serves the built UI without the SDK development watcher.
if (existsSync(resolve(serverDir, "package.json"))) {
  const scripts =
    JSON.parse(readFileSync(resolve(serverDir, "package.json"), "utf8")).scripts ?? {};
  const script = scripts.preview ? "preview" : scripts.dev ? "dev" : scripts.start ? "start" : null;
  if (script) run(serverDir, script);
}

const miniappScript = miniappScripts.preview ? "preview" : "dev";
if (!miniappScripts[miniappScript]) {
  console.error("miniapp/package.json needs a dev or preview script.");
  process.exit(1);
}
const dev = spawn("node", [resolve(root, "scripts/serve-preview.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
children.push(dev);
console.log("\nPreview services running. Use `bun run release` for a persistent phone install.\n");

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children) {
  child.once("exit", (code) => {
    if (!stopping) {
      stop();
      process.exitCode = code ?? 1;
    }
  });
}
