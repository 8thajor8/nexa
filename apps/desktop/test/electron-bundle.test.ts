import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildElectron } from "../scripts/build-electron.mjs";

const outputRoot = await mkdtemp(resolve(tmpdir(), "nexa-electron-bundle-test-"));
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");

afterAll(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

describe("Electron distribution bundles", () => {
  it("resolves the public Voice API from bundled files without checkout dependencies", async () => {
    await writeFile(resolve(outputRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    const outputs = await buildElectron({ outputRoot, logLevel: "silent" });

    expect(outputs.mainOutput).toContain(resolve(outputRoot, "main", "main.js"));
    expect(outputs.preloadOutput).toContain(resolve(outputRoot, "preload.cjs"));
    expect(outputs.voiceOutput).toContain(resolve(outputRoot, "voice", "index.js"));
    expect(outputs.voiceFiles.length).toBeGreaterThan(1);
    expect(outputs.voiceFiles.some((path) => /(?:service|koffi|playwright)/iu.test(path))).toBe(false);
    expect((await readFile(resolve(outputRoot, "main", "assets", "lifeguard-costa-rica.jpg"))).byteLength).toBeGreaterThan(0);

    const mainBundle = await readFile(outputs.mainOutput, "utf8");
    expect(mainBundle).toContain("LOG-CLEANUP-01");
    expect(mainBundle).toContain("NEXA_DIAGNOSTICS");
    expect(mainBundle).toContain("spotify_unexpected_write_response");
    expect(mainBundle).toContain("responseContract");
    expect(mainBundle).toContain("sourceScaleFactor");
    expect(mainBundle).toContain("dpiAdjusted");
    expect(mainBundle).toContain("placement_started");
    expect(mainBundle).toContain("fullscreen_transition_requested");
    expect(mainBundle).toContain("fullscreen_transition_result");
    expect(mainBundle).toContain("operationId");
    expect(mainBundle).toContain("native_state_confirmed");
    expect(mainBundle).toContain("electron_event_received");
    expect(mainBundle).toContain("persistedFullscreen");
    expect(mainBundle).toContain("actualMaximized");
    expect(mainBundle).toContain("transitionTargetFullscreen");
    expect(mainBundle).toContain("responseHost");
    expect(mainBundle).toContain("outcome_uncertain");
    expect(mainBundle).toContain('createRequire as __nexaCreateRequire');
    expect(mainBundle).toContain('const require = __nexaCreateRequire(import.meta.url)');
    expect(mainBundle).toMatch(/resolve\d*\(appRoot, "dist-electron", "voice", "index\.js"\)/u);
    expect(mainBundle).not.toContain(repositoryRoot);
    expect(mainBundle).not.toContain(repositoryRoot.replaceAll("\\", "/"));

    const preloadBundle = await readFile(outputs.preloadOutput, "utf8");
    expect(preloadBundle.length).toBeGreaterThan(0);
    expect(preloadBundle).toContain("nexa:window-settings:changed");

    if (process.platform === "win32") {
      const bundledDpapiPath = resolve(outputRoot, "bin", process.arch, "dpapi.node");
      expect((await readFile(bundledDpapiPath)).byteLength).toBeGreaterThan(0);
      const requireFromMain = createRequire(outputs.mainOutput);
      expect(requireFromMain.resolve(`../bin/${process.arch}/dpapi`)).toBe(bundledDpapiPath);
      const syntheticCheck = spawnSync(process.execPath, ["-e", [
        'const { createRequire } = require("node:module");',
        'const dpapi = createRequire(process.argv[1])("../bin/" + process.arch + "/dpapi");',
        'const input = Buffer.from("nexa-dpapi-synthetic-check");',
        'const encrypted = dpapi.protectData(input, null, "CurrentUser");',
        'const recovered = dpapi.unprotectData(encrypted, null, "CurrentUser").toString();',
        'if (recovered !== input.toString()) process.exit(2);',
      ].join("\n"), outputs.mainOutput], { encoding: "utf8" });
      expect(syntheticCheck.status).toBe(0);
    }

    const bundledVoice = await import(`${pathToFileURL(outputs.voiceOutput).href}?test=${Date.now()}`);
    expect(Object.keys(bundledVoice).sort()).toEqual([
      "createPttVoiceController",
      "createSpeechRecognizer",
      "createVoiceSpeaker",
    ]);

    const recognizer = bundledVoice.createSpeechRecognizer({
      provider: { async transcribe() { throw new Error("injected provider must not be called"); } },
    });
    const controller = bundledVoice.createPttVoiceController({ recognizer });
    expect(controller.start().sessionId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(() => controller.end()).not.toThrow();

    const speechService = {
      async generate() { return { success: true, audioId: "audio_test" }; },
      async play() { return { success: true, released: true }; },
      async removeTemporary() { return true; },
    };
    const speaker = bundledVoice.createVoiceSpeaker({ speechService });
    expect(speaker).toHaveProperty("speak");
    expect(speaker).toHaveProperty("cancel");

    for (const outputPath of outputs.voiceFiles) {
      const text = await readFile(outputPath, "utf8");
      expect(text).not.toContain(repositoryRoot);
      expect(text).not.toContain(repositoryRoot.replaceAll("\\", "/"));
      expect(text).not.toMatch(/(?:from|import)\s*["'][^"']*(?:playwright|koffi|chromium-bidi|src\/speech\/service)/iu);
    }
  }, 30000);
});
