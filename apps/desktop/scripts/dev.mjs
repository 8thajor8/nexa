import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const tsconfig = resolve(appRoot, "node_modules", "typescript", "bin", "tsc");
const vite = resolve(appRoot, "node_modules", "vite", "bin", "vite.js");
const esbuild = resolve(appRoot, "node_modules", "esbuild", "bin", "esbuild");
const electron = resolve(appRoot, "node_modules", "electron", "cli.js");
const rendererUrl = "http://127.0.0.1:5173";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: appRoot, stdio: "inherit", ...options });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0 || signal) resolvePromise(code ?? 0);
      else rejectPromise(new Error(command + " exited with code " + code));
    });
  });
}
function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: appRoot, stdio: "inherit", ...options });
  child.once("error", (error) => { console.error(error); process.exitCode = 1; });
  return child;
}
async function waitForRenderer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Vite dev server stopped unexpectedly");
    try {
      if ((await fetch(rendererUrl)).ok) return;
    } catch { await delay(250); continue; }
    await delay(250);
  }
  throw new Error("Vite dev server did not become ready");
}
let renderer;
let desktop;
function stopChildren() {
  if (desktop && desktop.exitCode === null) desktop.kill();
  if (renderer && renderer.exitCode === null) renderer.kill();
}
process.once("SIGINT", () => { stopChildren(); process.exit(130); });
process.once("SIGTERM", () => { stopChildren(); process.exit(143); });

try {
  await run(node, [tsconfig, "-p", resolve(appRoot, "tsconfig.electron.json")]);
  await run(node, [esbuild, "src/preload.ts", "--bundle", "--platform=node",
    "--format=cjs", "--external:electron", "--outfile=dist-electron/preload.cjs",
    "--target=node22"]);
  renderer = start(node, [vite, "--host", "127.0.0.1", "--strictPort"]);
  await waitForRenderer(renderer);
  desktop = start(node, [electron, "."], {
    env: { ...process.env, VITE_DEV_SERVER_URL: rendererUrl },
  });
  process.exitCode = await new Promise((resolvePromise, rejectPromise) => {
    desktop.once("error", rejectPromise);
    desktop.once("exit", (code) => resolvePromise(code ?? 0));
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { stopChildren(); }