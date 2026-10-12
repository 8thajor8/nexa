import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const runElectronNativeAudioTest = process.platform === "win32";

describe("native Electron PTT acoustic and transport path", () => {
  it.skipIf(!runElectronNativeAudioTest)("preserves a deterministic tone through capture, native resampling, WAV, Preload, Main, and public Voice to a fake provider", async () => {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const rootDirectory = resolve(testDirectory, "../../..");
    const captureEntry = resolve(testDirectory, "../src/renderer/audio/ptt-microphone-capture.ts");
    const preloadEntry = resolve(testDirectory, "../src/preload.ts");
    const mainIpcEntry = resolve(testDirectory, "../src/main/voice-ipc.ts");
    const [captureBundle, preloadBundle, mainBundle] = await Promise.all([
      build({ entryPoints: [captureEntry], bundle: true, format: "iife", globalName: "NexaCapture", platform: "browser", target: "chrome124", write: false }),
      build({ entryPoints: [preloadEntry], bundle: true, format: "cjs", platform: "node", external: ["electron"], write: false }),
      build({ entryPoints: [mainIpcEntry], bundle: true, format: "cjs", platform: "node", external: ["electron"], write: false }),
    ]);
    const electronExecutable = createRequire(import.meta.url)("electron") as string;
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "nexa-ptt-native-e2e-"));

    try {
      await writeFile(join(temporaryDirectory, "package.json"), JSON.stringify({
        name: "nexa-ptt-native-e2e", version: "1.0.0", main: "main.cjs",
      }));
      await writeFile(join(temporaryDirectory, "capture.iife.js"), captureBundle.outputFiles[0].contents);
      await writeFile(join(temporaryDirectory, "preload.cjs"), preloadBundle.outputFiles[0].contents);
      await writeFile(join(temporaryDirectory, "voice-ipc.cjs"), mainBundle.outputFiles[0].contents);
      await writeFile(join(temporaryDirectory, "renderer.html"), "<!doctype html><html><body>PTT synthetic integration test</body></html>");
      await writeFile(join(temporaryDirectory, "renderer-test.js"), `
        (async () => {
          const { PttMicrophoneCapture } = window.NexaCapture;
          const desktopVoice = window.nexaDesktop.voice;
          const eventLog = [];
          let resolveFinal;
          const finalEvent = new Promise((resolve) => { resolveFinal = resolve; });
          const unsubscribe = desktopVoice.onEvent((envelope) => {
            eventLog.push({ requestId: envelope.requestId, sessionId: envelope.sessionId,
              turnId: envelope.turnId ?? null, sequence: envelope.sequence, type: envelope.event.type });
            if (envelope.event.type === "voice.transcript.final") resolveFinal(envelope);
          });

          const calls = { start: 0, finish: 0, cancel: 0 };
          let rendererAudioBytes = [];
          const voiceApi = {
            onEvent: (listener) => desktopVoice.onEvent(listener),
            ptt: {
              start(request) { calls.start += 1; return desktopVoice.ptt.start(request); },
              finish(request) {
                calls.finish += 1;
                rendererAudioBytes = Array.from(request.audio);
                return desktopVoice.ptt.finish(request);
              },
              cancel(request) { calls.cancel += 1; return desktopVoice.ptt.cancel(request); },
            },
          };

          let stoppedTracks = 0;
          let closedContexts = 0;
          let audioCallback = null;
          const track = { stop() { stoppedTracks += 1; }, addEventListener() {} };
          const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
          const processor = {
            set onaudioprocess(callback) { audioCallback = callback; },
            get onaudioprocess() { return audioCallback; },
            connect() {}, disconnect() {},
          };
          const context = {
            sampleRate: 48000, destination: {},
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; },
            createScriptProcessor() { return processor; },
            createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; },
            async resume() {}, async close() { closedContexts += 1; },
          };
          let requestCounter = 0;
          const capture = new PttMicrophoneCapture(voiceApi, {
            mediaDevices: { async getUserMedia() { return stream; } },
            createAudioContext: () => context,
            createRequestId: () => "native-request-" + (++requestCounter),
          });

          const session = await capture.start();
          const sourceRate = 48000;
          const source = Float32Array.from({ length: sourceRate }, (_, index) =>
            0.5 * Math.sin(2 * Math.PI * 1000 * index / sourceRate));
          audioCallback({ inputBuffer: {
            length: source.length, numberOfChannels: 1, getChannelData: () => source,
          } });
          const ack = await capture.finish("es");
          const final = await Promise.race([
            finalEvent,
            new Promise((_, reject) => setTimeout(() => reject(new Error("final_event_timeout")), 10_000)),
          ]);
          unsubscribe();
          return {
            session, ack, final: {
              requestId: final.requestId, sessionId: final.sessionId, turnId: final.turnId,
              eventType: final.event.type, text: final.event.text,
            }, eventLog, calls, rendererAudioBytes, stoppedTracks, closedContexts,
          };
        })()
      `);
      await writeFile(join(temporaryDirectory, "main.cjs"), `
        const { app, BrowserWindow } = require("electron");
        const fs = require("node:fs");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        const { registerVoiceIpcHandlers, removeVoiceIpcHandlers } = require(path.join(__dirname, "voice-ipc.cjs"));
        let providerCalls = 0;
        let providerAudio = Buffer.alloc(0);
        let testWindow;
        app.whenReady().then(async () => {
          try {
            const repositoryRoot = ${JSON.stringify(rootDirectory)};
            app.setPath("userData", path.join(__dirname, "userData"));
            const expectedRendererUrl = pathToFileURL(path.join(__dirname, "renderer.html")).href;
            const voiceModule = await import(pathToFileURL(path.join(repositoryRoot, "src/voice/index.js")).href);
            const recognizer = voiceModule.createSpeechRecognizer({ provider: {
              async transcribe(input) {
                providerCalls += 1;
                providerAudio = Buffer.from(input.audio);
                return { text: "synthetic transcript", language: "es" };
              },
            } });
            const loadVoiceApi = async () => ({
              createSpeechRecognizer: () => recognizer,
              createPttVoiceController: (options) => voiceModule.createPttVoiceController(options),
            });
            registerVoiceIpcHandlers(() => testWindow, expectedRendererUrl, loadVoiceApi);
            testWindow = new BrowserWindow({
              show: false, width: 64, height: 64,
              webPreferences: {
                preload: path.join(__dirname, "preload.cjs"),
                sandbox: true, contextIsolation: true, nodeIntegration: false,
              },
            });
            await testWindow.loadFile(path.join(__dirname, "renderer.html"));
            const captureBundle = fs.readFileSync(path.join(__dirname, "capture.iife.js"), "utf8");
            await testWindow.webContents.executeJavaScript(captureBundle);
            const rendererScript = fs.readFileSync(path.join(__dirname, "renderer-test.js"), "utf8");
            const result = await testWindow.webContents.executeJavaScript(rendererScript);

            const audio = Buffer.from(result.rendererAudioBytes);
            const text = (offset) => audio.toString("ascii", offset, offset + 4);
            const sampleCount = audio.readUInt32LE(40) / 2;
            const samples = Array.from({ length: sampleCount }, (_, index) => audio.readInt16LE(44 + index * 2) / 32768);
            const peak = samples.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
            const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
            const maxStep = samples.slice(1).reduce((value, sample, index) => Math.max(value, Math.abs(sample - samples[index])), 0);
            const positiveCrossings = samples.slice(1).reduce((count, sample, index) => count + (samples[index] < 0 && sample >= 0 ? 1 : 0), 0);
            const providerMatchesBytes = Buffer.compare(providerAudio, audio) === 0;
            const report = {
              sourceSampleRate: 48000, outputSampleRate: audio.readUInt32LE(24), sourceSamples: 48000,
              outputSamples: sampleCount, duration: sampleCount / audio.readUInt32LE(24),
              peak, rms, maxStep, positiveCrossings,
              wav: {
                riff: text(0), wave: text(8), format: audio.readUInt16LE(20), channels: audio.readUInt16LE(22),
                byteRate: audio.readUInt32LE(28), blockAlign: audio.readUInt16LE(32), bitsPerSample: audio.readUInt16LE(34),
                totalBytes: audio.length, dataBytes: audio.readUInt32LE(40),
                riffLengthMatches: audio.readUInt32LE(4) === audio.length - 8,
              },
              providerCalls, providerBytes: providerAudio.length, providerMatchesBytes,
              ack: result.ack, session: result.session, final: result.final, events: result.eventLog,
              calls: result.calls, stoppedTracks: result.stoppedTracks, closedContexts: result.closedContexts,
            };
            const finalCount = result.eventLog.filter((event) => event.type === "voice.transcript.final").length;
            if (!providerMatchesBytes || providerCalls !== 1 || finalCount !== 1 || result.calls.start !== 1
              || result.calls.finish !== 1 || result.calls.cancel !== 0 || result.stoppedTracks !== 1
              || result.closedContexts !== 1) throw new Error("native_ptt_e2e_invariant_failed");
            console.log("NEXA_NATIVE_E2E=" + JSON.stringify(report));
            removeVoiceIpcHandlers();
            testWindow.close();
            app.exit(0);
          } catch (error) {
            console.error("NEXA_NATIVE_E2E_ERROR=" + String(error && error.stack || error));
            removeVoiceIpcHandlers();
            if (testWindow && !testWindow.isDestroyed()) testWindow.destroy();
            app.exit(1);
          }
        });
      `);

      const output = await new Promise<string>((resolveOutput, rejectOutput) => {
        const child = spawn(electronExecutable, ["--disable-gpu", temporaryDirectory], { windowsHide: true });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
          child.kill();
          rejectOutput(new Error(`native_ptt_e2e_timeout:${stderr.slice(-3000)}`));
        }, 40_000);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", (error) => { clearTimeout(timeout); rejectOutput(error); });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          if (code !== 0) rejectOutput(new Error(`native_ptt_e2e_exit_${code}:${stderr.slice(-4000)}`));
          else resolveOutput(stdout);
        });
      });
      const marker = output.split("\n").find((line) => line.startsWith("NEXA_NATIVE_E2E="));
      expect(marker, output.slice(-4000)).toBeDefined();
      const report = JSON.parse(marker!.slice("NEXA_NATIVE_E2E=".length)) as {
        sourceSampleRate: number; outputSampleRate: number; sourceSamples: number; outputSamples: number;
        duration: number; peak: number; rms: number; maxStep: number; positiveCrossings: number;
        wav: Record<string, number | string | boolean>; providerCalls: number; providerBytes: number;
        providerMatchesBytes: boolean; ack: Record<string, unknown>; session: Record<string, unknown>;
        final: Record<string, unknown>; events: Array<Record<string, unknown>>; calls: Record<string, number>;
        stoppedTracks: number; closedContexts: number;
      };
      expect(report).toMatchObject({
        sourceSampleRate: 48_000, outputSampleRate: 16_000, sourceSamples: 48_000,
        outputSamples: 16_000, duration: 1, peak: expect.any(Number), rms: expect.any(Number),
        wav: {
          riff: "RIFF", wave: "WAVE", format: 1, channels: 1, byteRate: 32_000,
          blockAlign: 2, bitsPerSample: 16, totalBytes: 32_044, dataBytes: 32_000,
          riffLengthMatches: true,
        },
        providerCalls: 1, providerBytes: 32_044, providerMatchesBytes: true,
        ack: { ok: true, accepted: true, requestId: "native-request-2" },
        final: { requestId: "native-request-2", eventType: "voice.transcript.final", text: "synthetic transcript" },
        calls: { start: 1, finish: 1, cancel: 0 }, stoppedTracks: 1, closedContexts: 1,
      });
      expect(report.peak).toBeGreaterThan(0.48);
      expect(report.peak).toBeLessThanOrEqual(0.501);
      expect(report.rms).toBeCloseTo(Math.sqrt(0.125), 2);
      expect(report.maxStep).toBeLessThan(0.22);
      expect(report.positiveCrossings).toBeGreaterThanOrEqual(999);
      expect(report.positiveCrossings).toBeLessThanOrEqual(1001);
      expect(report.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(report.events.filter((event) => event.type === "voice.transcript.final")).toHaveLength(1);
      expect(report.events.every((event) => event.sessionId === report.session.sessionId)).toBe(true);
      expect(report.final.sessionId).toBe(report.session.sessionId);
      expect(report.final.turnId).toBeTypeOf("string");
    } finally {
      const tempRoot = resolve(tmpdir()) + sep;
      const resolvedTestDirectory = resolve(temporaryDirectory);
      if (!resolvedTestDirectory.startsWith(tempRoot)) throw new Error("temporary_path_outside_temp_root");
      await rm(resolvedTestDirectory, { recursive: true, force: true });
    }
  }, 50_000);
});
