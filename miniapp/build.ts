import { rm, cp } from "node:fs/promises";
import {
  backgroundRuntimeGuardPlugin,
  reactSingletonPlugin,
} from "@mentra/miniapp-cli/build-helpers";

await rm("./dist", { recursive: true, force: true });
const define: Record<string, string> = {
  __MENTRA_SERVER_URL__: JSON.stringify(process.env.MENTRA_PUBLIC_SERVER_URL) || "undefined",
};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("MENTRA_PUBLIC_") && typeof value === "string")
    define[`process.env.${key}`] = JSON.stringify(value);
}

const background = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: "./dist/background",
  target: "browser",
  format: "iife",
  minify: false,
  plugins: [backgroundRuntimeGuardPlugin(import.meta.url)],
  define,
});
if (!background.success) {
  for (const log of background.logs) console.error(log);
  process.exit(1);
}

const ui = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: "./dist/ui",
  target: "browser",
  minify: true,
  plugins: [reactSingletonPlugin(import.meta.url)],
  define,
});
if (!ui.success) {
  for (const log of ui.logs) console.error(log);
  process.exit(1);
}
await cp("./assets", "./dist/ui/assets", { recursive: true });
console.log("Built Field Inspection miniapp");
