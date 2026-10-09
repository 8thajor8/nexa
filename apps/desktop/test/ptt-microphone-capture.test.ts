import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceDesktopApi, VoiceEventEnvelope } from "../src/shared/ipc-contract";
import { isVoicePttFinishRequest } from "../src/shared/voice-ipc-validation";
import {
  encodePcm16MonoWav,
  PTT_MAX_AUDIO_BYTES,
  PTT_MAX_DURATION_SECONDS,
  PTT_SAMPLE_RATE,
  PttMicrophoneCapture,
  resamplePttAudio,
} from "../src/renderer/audio/ptt-microphone-capture";

const offlineInputs: Float32Array[] = [];

function offlineContext(_channels: number, length: number, _sampleRate: number) {
  return {
    destination: {},
    createBuffer(channels: number, frames: number) {
      const data = new Float32Array(frames);
      return {
        copyToChannel: (source: Float32Array) => data.set(source),
        getChannelData: () => data,
        numberOfChannels: channels,
        length: frames,
      };
    },
    createBufferSource() {
      let buffer: { getChannelData: () => Float32Array } | null = null;
      return {
        set buffer(value: typeof buffer) { buffer = value; },
        connect() {}, start() { if (buffer) offlineInputs.push(new Float32Array(buffer.getChannelData())); },
      };
    },
    async startRendering() {
      const input = offlineInputs.at(-1) ?? new Float32Array(length);
      const output = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        output[index] = input[Math.min(input.length - 1, Math.floor(index * input.length / length))] ?? 0;
      }
      return { getChannelData: () => output };
    },
  };
}

function makeAudioHarness(sampleRate = 48_000) {
  const trackListeners = new Map<string, () => void>();
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => { trackListeners.set(type, listener); }),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const processor = {
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
    connect: vi.fn(), disconnect: vi.fn(),
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const mute = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate, destination: {},
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(() => mute),
    resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  const events = new Set<(event: VoiceEventEnvelope) => void>();
  const calls: { start: unknown[]; finish: unknown[]; cancel: unknown[] } = { start: [], finish: [], cancel: [] };
  const voice = {
    ptt: {
      async start(request: unknown) {
        calls.start.push(request);
        return { ok: true as const, requestId: (request as { requestId: string }).requestId, sessionId: `session-${calls.start.length}` };
      },
      async finish(request: unknown) {
        const copied = { ...(request as Record<string, unknown>), audio: new Uint8Array((request as { audio: Uint8Array }).audio) };
        calls.finish.push(copied);
        return { ok: true as const, accepted: true as const, requestId: copied.requestId as string, sessionId: copied.sessionId as string };
      },
      async cancel(request: unknown) {
        calls.cancel.push(request);
        const value = request as { requestId: string; sessionId: string; targetRequestId: string };
        return { ok: true as const, ...value, cancelled: true };
      },
    },
    onEvent(listener: (event: VoiceEventEnvelope) => void) { events.add(listener); return () => events.delete(listener); },
  } as unknown as VoiceDesktopApi;
  let id = 0;
  const capture = new PttMicrophoneCapture(voice, {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    createAudioContext: () => context as never,
    createOfflineAudioContext: offlineContext as never,
    createRequestId: () => `request-${++id}`,
    maxDurationSeconds: 2,
    setTimeout: (() => 1 as never) as typeof globalThis.setTimeout,
    clearTimeout: vi.fn() as never,
  });
  const emitInput = (left: Float32Array, right = left) => {
    processor.onaudioprocess?.({
      inputBuffer: {
        length: left.length, numberOfChannels: right === left ? 1 : 2,
        getChannelData: (channel: number) => channel === 0 ? left : right,
      },
    } as unknown as AudioProcessingEvent);
  };
  const emit = (event: VoiceEventEnvelope) => { for (const listener of [...events]) listener(event); };
  return { capture, voice, stream, track, context, processor, source, mute, calls, emitInput, emit,
    disconnect: () => trackListeners.get("ended")?.() };
}

describe("PTT microphone capture and WAV encoding", () => {
  beforeEach(() => { offlineInputs.length = 0; });

  it("encodes valid mono PCM16 WAV with the required sample rate and byte limits", () => {
    const wav = encodePcm16MonoWav(new Float32Array([-1, 0, 1]));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(PTT_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(wav.byteLength).toBeLessThanOrEqual(PTT_MAX_AUDIO_BYTES);
    expect(isVoicePttFinishRequest({ requestId: "request", sessionId: "session", audio: wav, format: "wav" })).toBe(true);
  });

  it("downmixes stereo and resamples to 16 kHz", async () => {
    const left = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const right = new Float32Array([-0.5, -0.5, -0.5, -0.5, -0.5, -0.5]);
    const samples = await resamplePttAudio([left, right], 48_000, offlineContext as never, 2);
    expect(samples.length).toBe(2);
    expect([...samples]).toEqual([0, 0]);
    expect(offlineInputs.at(-1)).toEqual(new Float32Array(6));
  });

  it("enforces maximum duration and WAV size", async () => {
    await expect(resamplePttAudio([new Float32Array(48_001)], 1_600, offlineContext as never, 30))
      .rejects.toMatchObject({ code: "audio_too_long" });
    expect(() => encodePcm16MonoWav(new Float32Array(PTT_SAMPLE_RATE * (PTT_MAX_DURATION_SECONDS + 1))))
      .toThrowError(expect.objectContaining({ code: "audio_too_long" }));
    const maximumWav = encodePcm16MonoWav(new Float32Array(PTT_SAMPLE_RATE * PTT_MAX_DURATION_SECONDS));
    expect(maximumWav.byteLength).toBe(960_044);
    expect(maximumWav.byteLength).toBeLessThanOrEqual(PTT_MAX_AUDIO_BYTES);
    expect(PTT_MAX_DURATION_SECONDS).toBe(30);
  });

  it("starts a valid session, captures, sends WAV on finish, and releases resources", async () => {
    const harness = makeAudioHarness();
    await expect(harness.capture.start()).resolves.toEqual({ sessionId: "session-1", requestId: "request-1" });
    harness.emitInput(new Float32Array(480).fill(0.25));
    const ack = await harness.capture.finish("es");
    expect(ack).toMatchObject({ ok: true, accepted: true });
    expect(harness.calls.start).toHaveLength(1);
    expect(harness.calls.finish).toHaveLength(1);
    expect(isVoicePttFinishRequest(harness.calls.finish[0])).toBe(true);
    expect(harness.calls.finish[0]).toMatchObject({ format: "wav", language: "es", sessionId: "session-1" });
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    await expect(harness.capture.finish()).rejects.toMatchObject({ code: "voice_session_unavailable" });
  });

  it("caps captured samples at the configured duration before encoding", async () => {
    const harness = makeAudioHarness();
    await harness.capture.start();
    harness.emitInput(new Float32Array(120_000).fill(0.25));
    expect(harness.track.stop).toHaveBeenCalledOnce();
    await harness.capture.finish();
    const request = harness.calls.finish[0] as { audio: Uint8Array };
    expect(request.audio.byteLength).toBe(PTT_SAMPLE_RATE * 2 * 2 + 44);
    expect(isVoicePttFinishRequest(request)).toBe(true);
  });

  it("cancels locally, discards samples, releases the microphone, and targets the start request", async () => {
    const harness = makeAudioHarness();
    await harness.capture.start();
    harness.emitInput(new Float32Array(480).fill(0.5));
    await harness.capture.cancel();
    expect(harness.calls.cancel).toEqual([{
      requestId: "request-2", sessionId: "session-1", targetRequestId: "request-1",
    }]);
    expect(harness.calls.finish).toHaveLength(0);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    await expect(harness.capture.start()).resolves.toMatchObject({ sessionId: "session-2", requestId: expect.any(String) });
  });

  it("targets the finish request when cancelling an accepted transcription", async () => {
    const harness = makeAudioHarness();
    await harness.capture.start();
    harness.emitInput(new Float32Array(480).fill(0.3));
    await harness.capture.finish();
    await harness.capture.cancel();
    expect(harness.calls.cancel).toEqual([{
      requestId: "request-3", sessionId: "session-1", targetRequestId: "request-2",
    }]);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
  });

  it("releases local resources, reports uncertain Main cancellation, and blocks new sessions until explicit recovery", async () => {
    const harness = makeAudioHarness();
    const cancel = vi.fn(async (request: { requestId: string; sessionId: string; targetRequestId: string }) => {
      harness.calls.cancel.push(request);
      if (harness.calls.cancel.length === 1) throw new Error("IPC response lost");
      return { ok: true as const, ...request, cancelled: true };
    });
    harness.voice.ptt.cancel = cancel;
    await harness.capture.start();
    harness.emitInput(new Float32Array(480).fill(0.5));

    await expect(harness.capture.cancel()).rejects.toMatchObject({ code: "main_cancel_unconfirmed" });
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.capture.mainCancellationPending).toBe(true);
    await expect(harness.capture.start()).rejects.toMatchObject({ code: "session_cleanup_required" });
    expect(harness.calls.start).toHaveLength(1);

    await harness.capture.recoverMainCancellation();
    expect(harness.capture.mainCancellationPending).toBe(false);
    await expect(harness.capture.start()).resolves.toMatchObject({ sessionId: "session-2", requestId: expect.any(String) });
    expect(harness.calls.cancel).toHaveLength(2);
    expect(harness.calls.cancel[0]).toMatchObject({ sessionId: "session-1", targetRequestId: "request-1" });
    expect(harness.calls.cancel[1]).toMatchObject({ sessionId: "session-1", targetRequestId: "request-1" });
    await harness.capture.recoverMainCancellation();
    expect(harness.calls.cancel).toHaveLength(2);
    await harness.capture.cancel();
  });

  it("accepts correlated session_unavailable as confirmation that the pinned session is retired", async () => {
    const harness = makeAudioHarness();
    harness.voice.ptt.cancel = vi.fn(async (request) => {
      harness.calls.cancel.push(request);
      return { ok: false as const, requestId: request.requestId,
        error: { code: "session_unavailable" as const, message: "The PTT session is not active." } };
    });
    await harness.capture.start();
    await expect(harness.capture.cancel()).resolves.toBeUndefined();
    expect(harness.capture.mainCancellationPending).toBe(false);
    await expect(harness.capture.start()).resolves.toMatchObject({ sessionId: "session-2", requestId: expect.any(String) });
    await harness.capture.cancel();
  });

  it("keeps a possibly accepted finish request as the recovery target and permits an explicit start fallback", async () => {
    const harness = makeAudioHarness();
    harness.voice.ptt.finish = vi.fn(async (request) => {
      harness.calls.finish.push(request);
      throw new Error("finish response lost");
    });
    harness.voice.ptt.cancel = vi.fn(async (request) => {
      harness.calls.cancel.push(request);
      if (harness.calls.cancel.length === 1) throw new Error("cancel response lost");
      if (request.sessionId === "session-1" && request.targetRequestId !== "request-1") {
        return { ok: false as const, requestId: request.requestId,
          error: { code: "request_not_found" as const, message: "The target PTT operation is not active." } };
      }
      return { ok: true as const, ...request, cancelled: true };
    });
    await harness.capture.start();
    harness.emitInput(new Float32Array(480).fill(0.25));
    await expect(harness.capture.finish()).rejects.toMatchObject({ code: "main_cancel_unconfirmed" });
    expect(harness.calls.cancel[0]).toMatchObject({ sessionId: "session-1", targetRequestId: "request-2" });
    expect(harness.capture.mainCancellationPending).toBe(true);
    await expect(harness.capture.recoverMainCancellation()).rejects.toMatchObject({ code: "main_cancel_unconfirmed" });
    expect(harness.capture.mainCancellationPending).toBe(true);
    await expect(harness.capture.start()).rejects.toMatchObject({ code: "session_cleanup_required" });

    await harness.capture.recoverMainCancellation("start");
    expect(harness.calls.cancel[1]).toMatchObject({ sessionId: "session-1", targetRequestId: "request-2" });
    expect(harness.calls.cancel[2]).toMatchObject({ sessionId: "session-1", targetRequestId: "request-1" });
    expect(harness.capture.mainCancellationPending).toBe(false);
    await expect(harness.capture.start()).resolves.toMatchObject({ sessionId: "session-2", requestId: expect.any(String) });
    await harness.capture.cancel();
  });

  it("rejects a mismatched cancellation response and never retries without explicit recovery", async () => {
    const harness = makeAudioHarness();
    const cancel = vi.fn(async (request) => {
      harness.calls.cancel.push(request);
      return { ok: true as const, ...request, sessionId: "another-session", cancelled: true };
    });
    harness.voice.ptt.cancel = cancel as unknown as VoiceDesktopApi["ptt"]["cancel"];
    await harness.capture.start();
    await expect(harness.capture.cancel()).rejects.toMatchObject({ code: "main_cancel_unconfirmed" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(harness.capture.mainCancellationPending).toBe(true);
    await expect(harness.capture.start()).rejects.toMatchObject({ code: "session_cleanup_required" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not treat an uncorrelated session_unavailable error as confirmation", async () => {
    const harness = makeAudioHarness();
    const cancel = vi.fn(async (request) => {
      harness.calls.cancel.push(request);
      if (harness.calls.cancel.length === 1) {
        return { ok: false as const, requestId: "unrelated-request",
          error: { code: "session_unavailable" as const, message: "The PTT session is not active." } };
      }
      return { ok: true as const, ...request, cancelled: true };
    });
    harness.voice.ptt.cancel = cancel as unknown as VoiceDesktopApi["ptt"]["cancel"];
    await harness.capture.start();
    await expect(harness.capture.cancel()).rejects.toMatchObject({ code: "main_cancel_unconfirmed" });
    expect(harness.capture.mainCancellationPending).toBe(true);
    await harness.capture.recoverMainCancellation();
    expect(harness.capture.mainCancellationPending).toBe(false);
  });

  it("prevents concurrent captures and reports microphone permission failures", async () => {
    const harness = makeAudioHarness();
    await harness.capture.start();
    await expect(harness.capture.start()).rejects.toMatchObject({ code: "capture_in_progress" });
    await harness.capture.cancel();

    const denied = new PttMicrophoneCapture({} as VoiceDesktopApi, {
      mediaDevices: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); }) },
      createAudioContext: () => harness.context as never,
      createRequestId: () => "request",
    });
    await expect(denied.start()).rejects.toMatchObject({ code: "permission_denied" });

    const missing = new PttMicrophoneCapture({} as VoiceDesktopApi, {
      mediaDevices: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error(), { name: "NotFoundError" }); }) },
      createAudioContext: () => harness.context as never,
      createRequestId: () => "request",
    });
    await expect(missing.start()).rejects.toMatchObject({ code: "microphone_unavailable" });
  });

  it("cancels a pending permission request and stops a late stream without starting Voice", async () => {
    const harness = makeAudioHarness();
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const pending = new PttMicrophoneCapture({} as VoiceDesktopApi, {
      mediaDevices: { getUserMedia: () => new Promise((resolve) => { resolveStream = resolve; }) },
      createAudioContext: () => harness.context as never,
      createRequestId: () => "request",
    });
    const starting = pending.start();
    await vi.waitFor(() => expect(resolveStream).toBeTypeOf("function"));
    await pending.cancel();
    await expect(pending.start()).rejects.toMatchObject({ code: "capture_in_progress" });
    resolveStream?.(harness.stream);
    await expect(starting).rejects.toMatchObject({ code: "capture_cancelled" });
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("surfaces cancellation uncertainty when a cancelled start later returns a Main session", async () => {
    const harness = makeAudioHarness();
    let resolveFirstStart: ((value: { ok: true; requestId: string; sessionId: string }) => void) | undefined;
    harness.voice.ptt.start = vi.fn((request: { requestId: string }) => {
      harness.calls.start.push(request);
      if (harness.calls.start.length === 1) {
        return new Promise((resolve) => { resolveFirstStart = resolve; });
      }
      return Promise.resolve({ ok: true as const, requestId: request.requestId, sessionId: "session-2" });
    });
    harness.voice.ptt.cancel = vi.fn(async (request) => {
      harness.calls.cancel.push(request);
      if (harness.calls.cancel.length === 1) throw new Error("IPC response lost");
      return { ok: true as const, ...request, cancelled: true };
    });

    const starting = harness.capture.start();
    await vi.waitFor(() => expect(harness.calls.start).toHaveLength(1));
    await harness.capture.cancel();
    await expect(harness.capture.start()).rejects.toMatchObject({ code: "capture_in_progress" });
    resolveFirstStart?.({ ok: true, requestId: "request-1", sessionId: "session-1" });
    await expect(starting).rejects.toMatchObject({ code: "main_cancel_unconfirmed" });
    expect(harness.capture.mainCancellationPending).toBe(true);
    expect(harness.calls.cancel[0]).toMatchObject({ sessionId: "session-1", targetRequestId: "request-1" });

    await harness.capture.recoverMainCancellation();
    await expect(harness.capture.start()).resolves.toMatchObject({ sessionId: "session-2", requestId: expect.any(String) });
    await harness.capture.cancel();
  });

  it("reports a disconnected microphone, cancels its Voice session, and discards the recording", async () => {
    const harness = makeAudioHarness();
    await harness.capture.start();
    harness.emitInput(new Float32Array(480).fill(0.2));
    harness.disconnect();
    await expect(harness.capture.finish()).rejects.toMatchObject({ code: "microphone_unavailable" });
    expect(harness.calls.finish).toHaveLength(0);
    expect(harness.calls.cancel).toMatchObject([{ targetRequestId: "request-1", sessionId: "session-1" }]);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
  });

  it("cancels Main and clears audio if offline conversion fails", async () => {
    const harness = makeAudioHarness();
    const capture = new PttMicrophoneCapture({
      ptt: {
        start: async (request: { requestId: string }) => ({ ok: true as const, requestId: request.requestId, sessionId: "session-1" }),
        finish: vi.fn(),
        cancel: async (request: { requestId: string; sessionId: string; targetRequestId: string }) => ({
          ok: true as const, ...request, cancelled: true,
        }),
      }, onEvent: vi.fn(() => () => undefined),
    } as unknown as VoiceDesktopApi, {
      mediaDevices: { getUserMedia: vi.fn(async () => harness.stream) },
      createAudioContext: () => harness.context as never,
      createOfflineAudioContext: () => { throw new Error("resampling failed"); },
      createRequestId: (() => { let id = 0; return () => `convert-${++id}`; })(),
      setTimeout: (() => 1 as never) as typeof globalThis.setTimeout,
      clearTimeout: vi.fn() as never,
    });
    await capture.start();
    harness.emitInput(new Float32Array(480).fill(0.1));
    await expect(capture.finish()).rejects.toMatchObject({ code: "audio_conversion_failed" });
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
  });

  it("does not send a late conversion result after cancellation", async () => {
    const harness = makeAudioHarness();
    const cancel = vi.fn(async (request: { requestId: string; sessionId: string; targetRequestId: string }) => ({
      ok: true as const, ...request, cancelled: true,
    }));
    let renderStarted: (() => void) | undefined;
    let completeRender: (() => void) | undefined;
    const delayedOffline = (_channels: number, length: number) => ({
      destination: {},
      createBuffer(_numberOfChannels: number, frames: number) {
        const samples = new Float32Array(frames);
        return { getChannelData: () => samples, copyToChannel: (source: Float32Array) => samples.set(source) };
      },
      createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
      startRendering: () => {
        renderStarted?.();
        return new Promise<{ getChannelData: () => Float32Array }>((resolve) => {
          completeRender = () => resolve({ getChannelData: () => new Float32Array(length) });
        });
      },
    });
    const capture = new PttMicrophoneCapture({
      ptt: {
        start: async (request: { requestId: string }) => ({ ok: true as const, requestId: request.requestId, sessionId: "session-1" }),
        finish: vi.fn(),
        cancel,
      }, onEvent: vi.fn(() => () => undefined),
    } as unknown as VoiceDesktopApi, {
      mediaDevices: { getUserMedia: vi.fn(async () => harness.stream) },
      createAudioContext: () => harness.context as never,
      createOfflineAudioContext: delayedOffline as never,
      createRequestId: (() => { let id = 0; return () => `late-${++id}`; })(),
      maxDurationSeconds: 2,
      setTimeout: (() => 1 as never) as typeof globalThis.setTimeout,
      clearTimeout: vi.fn() as never,
    });
    let didStartRendering: (() => void) | undefined;
    renderStarted = () => didStartRendering?.();
    const renderReady = new Promise<void>((resolve) => { didStartRendering = resolve; });
    await capture.start();
    harness.emitInput(new Float32Array(480).fill(0.1));
    const finishing = capture.finish();
    await renderReady;
    await capture.cancel();
    completeRender?.();
    await expect(finishing).rejects.toMatchObject({ code: "capture_cancelled" });
    expect(harness.calls.finish).toHaveLength(0);
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ targetRequestId: "late-1" }));
  });

  it("cancels the Main session if audio graph setup fails after start", async () => {
    const harness = makeAudioHarness();
    const cancel = vi.fn(async (request: { requestId: string; sessionId: string; targetRequestId: string }) => ({
      ok: true as const, requestId: request.requestId, sessionId: request.sessionId,
      targetRequestId: request.targetRequestId, cancelled: true,
    }));
    const failing = new PttMicrophoneCapture({
      ptt: {
        start: async (request: { requestId: string }) => ({ ok: true as const, requestId: request.requestId, sessionId: "session-1" }),
        finish: vi.fn(), cancel,
      }, onEvent: vi.fn(() => () => undefined),
    } as unknown as VoiceDesktopApi, {
      mediaDevices: { getUserMedia: vi.fn(async () => harness.stream) },
      createAudioContext: () => {
        const context = harness.context as unknown as { createMediaStreamSource: () => never };
        context.createMediaStreamSource = () => { throw Object.assign(new Error(), { name: "NotSupportedError" }); };
        return harness.context as never;
      },
      createRequestId: (() => { let id = 0; return () => `id-${++id}`; })(),
    });
    await expect(failing.start()).rejects.toMatchObject({ code: "microphone_error" });
    expect((failing as unknown as { current: unknown }).current).toBeNull();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({ requestId: "id-2", sessionId: "session-1", targetRequestId: "id-1" });
  });

  it("releases the session when a real ended event arrives from the active Voice session", async () => {
    const harness = makeAudioHarness();
    await harness.capture.start();
    harness.emit({ requestId: "wrong-request", sessionId: "session-1", sequence: 1,
      event: { type: "voice.session.ended", sessionId: "session-1", turnId: null, timestamp: 1 } });
    harness.emit({ requestId: "request-1", sessionId: "session-1", sequence: 0,
      event: { type: "voice.session.ended", sessionId: "session-1", turnId: null, timestamp: 2 } });
    await expect(harness.capture.start()).rejects.toMatchObject({ code: "capture_in_progress" });
    harness.emit({ requestId: "request-1", sessionId: "session-1", sequence: 2,
      event: { type: "voice.session.ended", sessionId: "session-1", turnId: null, timestamp: 3 } });
    await expect(harness.capture.start()).resolves.toMatchObject({ sessionId: "session-2", requestId: expect.any(String) });
    harness.emit({ requestId: "request-1", sessionId: "session-1", sequence: 3,
      event: { type: "voice.session.ended", sessionId: "session-1", turnId: null, timestamp: 4 } });
    await expect(harness.capture.start()).rejects.toMatchObject({ code: "capture_in_progress" });
    await harness.capture.cancel();
  });
});
