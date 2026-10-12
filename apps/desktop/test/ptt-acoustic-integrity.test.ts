import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NexaDesktopApi, VoiceDesktopApi, VoiceEventEnvelope } from "../src/shared/ipc-contract";
import { VOICE_EVENT_CHANNEL, VOICE_PTT_CANCEL_CHANNEL, VOICE_PTT_FINISH_CHANNEL, VOICE_PTT_START_CHANNEL } from "../src/shared/ipc-contract";
import { PttMicrophoneCapture } from "../src/renderer/audio/ptt-microphone-capture";
import { createPttVoiceController, createSpeechRecognizer } from "../../../src/voice/index.js";

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  const invokes: Array<{ channel: string; payload: unknown }> = [];
  let invokeEvent: unknown;
  let exposedApi: unknown;
  const state = {
    handlers,
    listeners,
    invokes,
    setInvokeEvent(event: unknown) { invokeEvent = event; },
    getApi() { return exposedApi; },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => { handlers.set(channel, handler); }),
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
    },
    ipcRenderer: {
      invoke: vi.fn((channel: string, payload?: unknown) => {
        const transportedPayload = payload === undefined ? undefined : structuredClone(payload);
        invokes.push({ channel, payload: transportedPayload === undefined ? undefined : structuredClone(transportedPayload) });
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`missing_ipc_handler:${channel}`);
        return Promise.resolve(handler(invokeEvent, transportedPayload));
      }),
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
      }),
      removeListener: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        listeners.get(channel)?.delete(listener);
      }),
      send: vi.fn(),
    },
    contextBridge: {
      exposeInMainWorld: vi.fn((_name: string, api: unknown) => { exposedApi = api; }),
    },
  };
  return state;
});

vi.mock("electron", () => electronMock);

import "../src/preload";
import { registerVoiceIpcHandlers, removeVoiceIpcHandlers } from "../src/main/voice-ipc";

const RENDERER_URL = "http://127.0.0.1:5174";
const EXPECTED_SAMPLES = [0.125, 0.25, -0.25, 0.5];

function createOfflineContext(_channels: number, outputLength: number) {
  let input = new Float32Array();
  return {
    destination: {},
    createBuffer(_channelCount: number, length: number) {
      input = new Float32Array(length);
      return { getChannelData: () => input };
    },
    createBufferSource() {
      let buffer: { getChannelData(): Float32Array } | null = null;
      return {
        set buffer(value: typeof buffer) { buffer = value; },
        connect() {},
        start() {},
        get inputBuffer() { return buffer; },
      };
    },
    async startRendering() {
      // Native OfflineAudioContext is the only unavailable renderer primitive in this Node test.
      // This exact 3:1 fixture makes sample selection deterministic for transport verification.
      const output = new Float32Array(outputLength);
      for (let index = 0; index < outputLength; index += 1) output[index] = input[index * 3] ?? 0;
      return { getChannelData: () => output };
    },
  };
}

function decodeWav(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  const dataBytes = view.getUint32(40, true);
  const samples = Array.from({ length: dataBytes / 2 }, (_, index) => view.getInt16(44 + index * 2, true) / 32768);
  const peak = samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  const maxStep = samples.slice(1).reduce((maximum, sample, index) => Math.max(maximum, Math.abs(sample - samples[index])), 0);
  return {
    valid: tag(0) === "RIFF" && tag(8) === "WAVE" && tag(12) === "fmt " && tag(36) === "data"
      && view.getUint32(4, true) === wav.byteLength - 8 && dataBytes === wav.byteLength - 44,
    encoding: view.getUint16(20, true), channels: view.getUint16(22, true), sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true), blockAlign: view.getUint16(32, true), bitsPerSample: view.getUint16(34, true),
    dataBytes, duration: samples.length / view.getUint32(24, true), samples, peak, rms, maxStep,
  };
}

function makeCapture(voice: VoiceDesktopApi, sampleRate = 48_000) {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  let processAudio: ((event: AudioProcessingEvent) => void) | null = null;
  const processor = {
    set onaudioprocess(callback: typeof processAudio) { processAudio = callback; },
    get onaudioprocess() { return processAudio; },
    connect: vi.fn(), disconnect: vi.fn(),
  };
  const context = {
    sampleRate, destination: {},
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  let requestCounter = 0;
  const capture = new PttMicrophoneCapture(voice, {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    createAudioContext: () => context as never,
    createOfflineAudioContext: createOfflineContext as never,
    createRequestId: () => `acoustic-request-${++requestCounter}`,
  });
  return {
    capture, track, context,
    emit(samples: Float32Array) {
      if (!processAudio) throw new Error("capture_processor_not_ready");
      processAudio({ inputBuffer: {
        length: samples.length, numberOfChannels: 1, getChannelData: () => samples,
      } } as unknown as AudioProcessingEvent);
    },
  };
}

describe("Desktop acoustic integrity through Preload, Main, and public Voice PTT", () => {
  beforeEach(() => {
    removeVoiceIpcHandlers();
    electronMock.invokes.length = 0;
    for (const listeners of electronMock.listeners.values()) listeners.clear();
  });

  it("preserves deterministic samples and WAV bytes through the real capture/preload/Main/Voice path to a fake provider", async () => {
    const mainFrame = { url: `${RENDERER_URL}/` };
    const receivedEnvelopes: VoiceEventEnvelope[] = [];
    let windowRef: { webContents: unknown; isDestroyed(): boolean };
    const webContents = {
      mainFrame,
      getURL: () => `${RENDERER_URL}/`,
      isDestroyed: () => false,
      send: vi.fn((channel: string, envelope: VoiceEventEnvelope) => {
        if (channel !== VOICE_EVENT_CHANNEL) return;
        for (const listener of [...(electronMock.listeners.get(channel) ?? [])]) listener({}, structuredClone(envelope));
      }),
    };
    windowRef = { webContents, isDestroyed: () => false };
    electronMock.setInvokeEvent({ sender: webContents, senderFrame: mainFrame });

    const providerAudio: Buffer[] = [];
    const recognizer = createSpeechRecognizer({ provider: {
      async transcribe(input: { audio: Buffer }) {
        providerAudio.push(Buffer.from(input.audio));
        return { text: "synthetic transcript", language: "es" };
      },
    } });
    registerVoiceIpcHandlers(() => windowRef as never, RENDERER_URL, async () => ({
      createSpeechRecognizer: () => recognizer,
      createPttVoiceController: (options) => createPttVoiceController(options),
    }));

    const desktopApi = electronMock.getApi() as NexaDesktopApi;
    const eventTypes: string[] = [];
    const unsubscribe = desktopApi.voice.onEvent((envelope) => {
      receivedEnvelopes.push(envelope);
      eventTypes.push(envelope.event.type);
    });
    const harness = makeCapture(desktopApi.voice);
    const source = new Float32Array(EXPECTED_SAMPLES.flatMap((sample) => [sample, sample, sample]));

    await harness.capture.start();
    harness.emit(source);
    const ack = await harness.capture.finish("es");
    await vi.waitFor(() => expect(providerAudio).toHaveLength(1));
    await vi.waitFor(() => expect(eventTypes).toContain("voice.transcript.final"));

    const finishInvoke = electronMock.invokes.find((entry) => entry.channel === VOICE_PTT_FINISH_CHANNEL);
    const transported = (finishInvoke?.payload as { audio: Uint8Array }).audio;
    const decoded = decodeWav(transported);
    const finalEvents = receivedEnvelopes.filter((envelope) => envelope.event.type === "voice.transcript.final");

    expect(ack).toMatchObject({ ok: true, accepted: true, requestId: "acoustic-request-2" });
    expect(electronMock.invokes.map((entry) => entry.channel)).toEqual([
      VOICE_PTT_START_CHANNEL, VOICE_PTT_FINISH_CHANNEL,
    ]);
    expect(decoded).toMatchObject({
      valid: true, encoding: 1, channels: 1, sampleRate: 16_000, byteRate: 32_000,
      blockAlign: 2, bitsPerSample: 16, dataBytes: 8, duration: 4 / 16_000,
    });
    expect(decoded.samples).toHaveLength(EXPECTED_SAMPLES.length);
    decoded.samples.forEach((sample, index) => expect(Math.abs(sample - EXPECTED_SAMPLES[index])).toBeLessThanOrEqual(1 / 32768));
    expect(decoded.peak).toBeCloseTo(0.5, 4);
    expect(decoded.rms).toBeCloseTo(0.3125, 4);
    expect(decoded.maxStep).toBeCloseTo(0.75, 4);
    expect(providerAudio).toHaveLength(1);
    expect(Buffer.compare(providerAudio[0], Buffer.from(transported))).toBe(0);
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]).toMatchObject({ requestId: "acoustic-request-2", event: {
      type: "voice.transcript.final", text: "synthetic transcript",
    } });
    expect(finalEvents[0].sessionId).toBe((ack as { sessionId: string }).sessionId);
    expect(typeof finalEvents[0].turnId).toBe("string");
    expect(receivedEnvelopes.map((envelope) => envelope.sequence)).toEqual([1, 2, 3, 4]);
    expect(eventTypes).toEqual([
      "voice.session.started", "voice.transcribing", "voice.transcript.final", "voice.session.ended",
    ]);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    unsubscribe();
    expect(electronMock.listeners.get(VOICE_EVENT_CHANNEL)?.size).toBe(0);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledTimes(2);
    expect(VOICE_PTT_CANCEL_CHANNEL).toBe("voice:ptt:cancel");
  });
});
