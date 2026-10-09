import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    const mainBundle = await readFile(outputs.mainOutput, "utf8");
    expect(mainBundle).toContain('resolve(appRoot, "dist-electron", "voice", "index.js")');
    expect(mainBundle).not.toContain(repositoryRoot);
    expect(mainBundle).not.toContain(repositoryRoot.replaceAll("\\", "/"));

    const bundledVoice = await import(`${pathToFileURL(outputs.voiceOutput).href}?test=${Date.now()}`);
    expect(Object.keys(bundledVoice).sort()).toEqual([
      "createPttVoiceController",
      "createSpeechRecognizer",
    ]);

    const recognizer = bundledVoice.createSpeechRecognizer({
      provider: { async transcribe() { throw new Error("injected provider must not be called"); } },
    });
    const controller = bundledVoice.createPttVoiceController({ recognizer });
    expect(controller.start().sessionId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(() => controller.end()).not.toThrow();

    for (const outputPath of outputs.voiceFiles) {
      const text = await readFile(outputPath, "utf8");
      expect(text).not.toContain(repositoryRoot);
      expect(text).not.toContain(repositoryRoot.replaceAll("\\", "/"));
      expect(text).not.toMatch(/(?:from|import)\s*["'][^"']*(?:playwright|koffi|chromium-bidi|src\/speech\/service)/iu);
    }
  }, 30000);
});
