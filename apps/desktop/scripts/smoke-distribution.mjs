import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronExe = resolve(desktopRoot, "node_modules", "electron", "dist", "electron.exe");
const smokeRoot = await mkdtemp(resolve(tmpdir(), "nexa-desktop-smoke-"));
const stagedDesktopRoot = resolve(smokeRoot, "apps", "desktop");
const stagedDist = resolve(stagedDesktopRoot, "dist");
const stagedElectron = resolve(stagedDesktopRoot, "dist-electron");
const harnessPath = resolve(smokeRoot, "smoke-main.mjs");
const startRequestId = "10000000-0000-4000-8000-000000000001";
const startRequestIdLiteral = JSON.stringify(JSON.stringify(startRequestId));

const harness = `import { app, BrowserWindow } from "electron";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { console.error("[distribution-smoke] " + message); app.exit(1); };
void (async () => {
  console.info("[distribution-smoke] harness started");
  await import("./apps/desktop/dist-electron/main/main.js");
  console.info("[distribution-smoke] bundled Main loaded");
  try {
    console.info("[distribution-smoke] waiting for Electron ready");
    await app.whenReady();
    console.info("[distribution-smoke] Electron ready");

    const voice = await import("./apps/desktop/dist-electron/voice/index.js");
    console.info("[distribution-smoke] bundled Voice API loaded");
    if (typeof voice.createPttVoiceController !== "function" || typeof voice.createSpeechRecognizer !== "function") {
      throw new Error("bundled_voice_public_api_missing");
    }
    const fakeRecognizer = { async transcribe() { throw new Error("smoke_must_not_transcribe"); } };
    const probeController = voice.createPttVoiceController({ recognizer: fakeRecognizer });
    if (!probeController.start()?.sessionId) throw new Error("bundled_voice_controller_unavailable");
    probeController.end();

    const deadline = Date.now() + 15000;
    let window;
    while (Date.now() < deadline) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed()) break;
      await wait(50);
    }
    if (!window || window.isDestroyed()) throw new Error("bundled_main_window_not_created");

    let bridgeReady = false;
    while (Date.now() < deadline && !bridgeReady) {
      try {
        bridgeReady = await window.webContents.executeJavaScript(
          "Boolean(window.nexaDesktop?.voice?.ptt?.start && window.nexaDesktop.voice.ptt.finish && window.nexaDesktop.voice.ptt.cancel && window.nexaDesktop.voice.onEvent)"
        );
      } catch { await wait(50); }
      if (!bridgeReady) await wait(50);
    }
    if (!bridgeReady) throw new Error("packaged_voice_preload_bridge_missing");

    await window.webContents.executeJavaScript(
      "window.__nexaSmokeEvents = []; window.__nexaSmokeUnsubscribe = window.nexaDesktop.voice.onEvent(event => window.__nexaSmokeEvents.push(event)); true;"
    );
    await window.webContents.executeJavaScript(
      "window.__nexaSmokeStartDone = false; window.__nexaSmokeStartResponse = null; window.__nexaSmokeStartError = null; " +
      "window.nexaDesktop.voice.ptt.start({ requestId: " + ${startRequestIdLiteral} + " }).then(response => { window.__nexaSmokeStartResponse = response; window.__nexaSmokeStartDone = true; }).catch(error => { window.__nexaSmokeStartError = error?.message ?? String(error); window.__nexaSmokeStartDone = true; }); true;"
    );
    let startCompleted = false;
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline && !startCompleted) {
      startCompleted = await window.webContents.executeJavaScript("window.__nexaSmokeStartDone === true");
      if (!startCompleted) await wait(25);
    }
    if (!startCompleted) throw new Error("packaged_main_voice_start_timeout");
    const response = await window.webContents.executeJavaScript("window.__nexaSmokeStartResponse");
    const startError = await window.webContents.executeJavaScript("window.__nexaSmokeStartError");
    if (startError) throw new Error("packaged_main_voice_start_error:" + startError);
    if (!response?.ok || response.requestId !== ${JSON.stringify(startRequestId)} || !response.sessionId) {
      throw new Error("packaged_main_voice_start_failed");
    }
    await window.webContents.executeJavaScript(
      "window.__nexaSmokeSessionId = " + JSON.stringify(response.sessionId)
    );
    let eventReceived = false;
    const eventDeadline = Date.now() + 3000;
    while (Date.now() < eventDeadline && !eventReceived) {
      eventReceived = await window.webContents.executeJavaScript(
        "window.__nexaSmokeEvents.some(event => event.requestId === " + ${startRequestIdLiteral} + " && event.sessionId === window.__nexaSmokeSessionId && event.event?.type === 'voice.session.started')"
      ).catch(() => false);
      if (!eventReceived) await wait(25);
    }
    if (!eventReceived) throw new Error("packaged_voice_event_not_received");

    console.info("[distribution-smoke] bundled Main, preload, public Voice API and PTT start/event passed; no STT request was sent");
    app.quit();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
})();
setTimeout(() => fail("smoke_timeout"), 20000).unref();
`;

function runElectron(appPath) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.VITE_DEV_SERVER_URL;
    const child = spawn(electronExe,
      ["--no-sandbox", "--disable-gpu", "--enable-logging", `--user-data-dir=${resolve(smokeRoot, "user-data")}`, appPath],
      { cwd: smokeRoot, env, stdio: "inherit" },
    );
    const timeout = setTimeout(() => child.kill(), 25000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`electron_smoke_terminated:${signal}`));
      else if (code !== 0) reject(new Error(`electron_smoke_exit:${code}`));
      else resolvePromise();
    });
  });
}

try {
  await mkdir(stagedDesktopRoot, { recursive: true });
  await cp(resolve(desktopRoot, "dist"), stagedDist, { recursive: true, errorOnExist: true });
  await cp(resolve(desktopRoot, "dist-electron"), stagedElectron, { recursive: true, errorOnExist: true });
  await writeFile(resolve(smokeRoot, "package.json"), JSON.stringify({
    name: "nexa-desktop-external-smoke", private: true, type: "module", main: "smoke-main.mjs",
  }, null, 2));
  await writeFile(resolve(stagedDesktopRoot, "package.json"), JSON.stringify({
    name: "nexa-desktop-artifact", private: true, type: "module",
  }, null, 2));
  await writeFile(harnessPath, harness, "utf8");
  await runElectron(smokeRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(smokeRoot, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 7 || !["EBUSY", "EPERM"].includes(error?.code)) throw error;
      await delay(250);
    }
  }
}
