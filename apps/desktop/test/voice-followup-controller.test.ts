import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDesktopApi, VoiceEventEnvelope } from "../src/shared/ipc-contract";
import { extractNexaFollowup, VoiceFollowupController } from "../src/renderer/voice/voice-followup-controller";

function harness(transcript = "Nexa, seguí contando") {
  let listener: ((event: VoiceEventEnvelope) => void) | null = null;
  let callbacks: { onSpeechRealStart(): void; onSpeechEnd(audio: Float32Array): void; onVADMisfire(): void } | null = null;
  let finishId = "";
  const accepted = vi.fn();
  const diagnostics = vi.fn(async () => true);
  const vad = { start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), destroy: vi.fn(async () => undefined) };
  const createVad = vi.fn(async (next: NonNullable<typeof callbacks>) => { callbacks = next; return vad; });
  const voice = {
    onEvent: vi.fn((next: typeof listener) => { listener = next; return () => { listener = null; }; }),
    ptt: {
      start: vi.fn(async ({ requestId }: { requestId: string }) => ({ ok: true as const, requestId, sessionId: "session-1" })),
      finish: vi.fn(async ({ requestId }: { requestId: string }) => {
        finishId = requestId;
        return { ok: true as const, accepted: true as const, requestId, sessionId: "session-1" };
      }),
      cancel: vi.fn(async ({ requestId, sessionId, targetRequestId }: { requestId: string; sessionId: string; targetRequestId: string }) =>
        ({ ok: true as const, requestId, sessionId, targetRequestId, cancelled: true })),
    },
    recordFollowupDiagnostic: diagnostics,
  } as unknown as VoiceDesktopApi;
  const controller = new VoiceFollowupController(voice, {
    createVad, onAcceptedTranscript: accepted,
  });
  const speak = async () => {
    callbacks?.onSpeechRealStart();
    callbacks?.onSpeechEnd(new Float32Array(16_000));
    await vi.waitFor(() => expect(voice.ptt.finish).toHaveBeenCalledOnce());
  };
  const emit = (text = transcript) => listener?.({
    requestId: finishId, sessionId: "session-1", sequence: 2, turnId: "turn-1",
    event: { type: "voice.transcript.final", sessionId: "session-1", turnId: "turn-1", timestamp: 1,
      text, language: "es" },
  });
  return { controller, voice, vad, createVad, accepted, diagnostics, speak, emit, get callbacks() { return callbacks; } };
}

afterEach(() => { vi.useRealTimers(); });

describe("bounded Voice follow-up", () => {
  it("accepts useful speech without a wake word and strips optional wake words", () => {
    expect(extractNexaFollowup("¿Y mañana?")).toBe("¿Y mañana?");
    expect(extractNexaFollowup("Nexa, ¿qué hora es?")).toBe("qué hora es?");
    expect(extractNexaFollowup("  nexA: seguí")).toBe("seguí");
    expect(extractNexaFollowup("¡Mexa! Abrí Spotify")).toBe("Abrí Spotify");
    expect(extractNexaFollowup("‘NEXT’ reproducí música")).toBe("reproducí música");
    expect(extractNexaFollowup("¿nExT, cuánto falta?")).toBe("cuánto falta?");
    expect(extractNexaFollowup("Nexa, ...")).toBeNull();
    expect(extractNexaFollowup("Hola Nexa, seguí")).toBe("Hola Nexa, seguí");
    expect(extractNexaFollowup("Nexabyte, seguí")).toBe("Nexabyte, seguí");
    expect(extractNexaFollowup("Mexican food, por favor")).toBe("Mexican food, por favor");
    expect(extractNexaFollowup("Nextdoor, llamá a casa")).toBe("Nextdoor, llamá a casa");
    expect(extractNexaFollowup("Nexx, seguí")).toBe("Nexx, seguí");
    expect(extractNexaFollowup("Nexa")).toBeNull();
    expect(extractNexaFollowup("")).toBeNull();
    expect(extractNexaFollowup("¿! ...")).toBeNull();
    expect(extractNexaFollowup("123")).toBeNull();
  });

  it("records bounded follow-up outcomes without retaining transcript content", async () => {
    const h = harness();
    await h.controller.open();
    h.callbacks?.onSpeechRealStart();
    await h.speak();
    h.emit("Nexa, seguí contando información privada de prueba");
    await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledOnce());
    const outcomes = h.diagnostics.mock.calls.map(([event]) => event.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(["window_opened", "vad_speech_detected", "transcription_submitted",
      "transcript_accepted_prefix_removed", "chat_submission_requested"]));
    expect(JSON.stringify(h.diagnostics.mock.calls)).not.toContain("información privada de prueba");
    await h.controller.stop();
  });

  it("accepts Mexa and Next through the bounded follow-up path", async () => {
    for (const [wakeWord, command] of [["Mexa", "seguí contando"], ["Next", "abrí Spotify"]]) {
      const h = harness();
      await h.controller.open();
      await h.speak();
      h.emit(`${wakeWord}, ${command}`);
      await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledOnce());
      expect(h.accepted.mock.calls[0][0].text).toBe(command);
      expect(h.diagnostics.mock.calls.map(([event]) => event.outcome)).toContain("transcript_accepted_prefix_removed");
      await h.controller.stop();
    }
  });

  it("distinguishes empty and unusable transcripts from useful unprefixed speech", async () => {
    for (const [text, outcome] of [["", "transcript_empty"], ["¿! ...", "transcript_unusable"], ["123", "transcript_unusable"]]) {
      const h = harness();
      await h.controller.open();
      await h.speak();
      h.emit(text);
      await vi.waitFor(() => expect(h.controller.getSnapshot()).toBe("idle"));
      expect(h.diagnostics.mock.calls.map(([event]) => event.outcome)).toContain(outcome);
      expect(h.accepted).not.toHaveBeenCalled();
    }
    const h = harness();
    await h.controller.open();
    await h.speak();
    h.emit("¿Y mañana?");
    await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledOnce());
    expect(h.accepted.mock.calls[0][0].text).toBe("¿Y mañana?");
    expect(h.diagnostics.mock.calls.map(([event]) => event.outcome)).toContain("transcript_accepted_without_prefix");
  });

  it("records a bounded expiry when VAD detects no speech", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.diagnostics.mock.calls.map(([event]) => event.outcome)).toContain("window_expired_no_speech");
    expect(h.controller.getSnapshot()).toBe("idle");
  });

  it("expires after five seconds and cancels the Main session for ducking restoration", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.open();
    expect(h.controller.getSnapshot()).toBe("listening");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.controller.getSnapshot()).toBe("idle");
    expect(h.vad.destroy).toHaveBeenCalledOnce();
    expect(h.voice.ptt.cancel).toHaveBeenCalledOnce();
    expect(h.voice.ptt.finish).not.toHaveBeenCalled();
    h.callbacks?.onSpeechRealStart();
    h.callbacks?.onSpeechEnd(new Float32Array(16_000));
    expect(h.voice.ptt.finish).not.toHaveBeenCalled();
  });

  it("allows another intervention only after the next completed voice response opens a new window", async () => {
    const h = harness();
    await h.controller.open();
    await h.speak();
    h.emit("¿Y mañana?");
    await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledOnce());
    h.emit("seguí");
    expect(h.accepted).toHaveBeenCalledOnce();
    await h.controller.open();
    await h.speak();
    h.emit("Nexa, seguí contando");
    await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledTimes(2));
    expect(h.accepted.mock.calls.map(([value]) => value.text)).toEqual(["¿Y mañana?", "seguí contando"]);
  });

  it("does not extend the five-second window after a VAD noise misfire", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.open();
    await vi.advanceTimersByTimeAsync(4_000);
    h.callbacks?.onSpeechRealStart();
    h.callbacks?.onVADMisfire();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.getSnapshot()).toBe("idle");
    expect(h.voice.ptt.finish).not.toHaveBeenCalled();
    expect(h.voice.ptt.cancel).toHaveBeenCalledOnce();
  });

  it("lets speech continue beyond the five-second start window and sends only invoked text", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.open();
    await vi.advanceTimersByTimeAsync(4_900);
    h.callbacks?.onSpeechRealStart();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.controller.getSnapshot()).toBe("listening");
    h.callbacks?.onSpeechEnd(new Float32Array(16_000));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.voice.ptt.finish).toHaveBeenCalledOnce();
    h.emit();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.accepted).toHaveBeenCalledWith({ text: "seguí contando", sessionId: "session-1",
      requestId: expect.any(String), turnId: "turn-1" });
  });

  it("accepts speech without a name once, then drops duplicate and late events", async () => {
    const h = harness();
    await h.controller.open();
    await h.speak();
    h.emit("Estamos hablando de otra cosa");
    await vi.waitFor(() => expect(h.accepted).toHaveBeenCalledOnce());
    h.emit("Nexa, escuchá");
    expect(h.accepted).toHaveBeenCalledOnce();
    expect(h.voice.ptt.cancel).toHaveBeenCalledOnce();
  });

  it("Stop or replacement PTT closes listening without accepting stale transcription", async () => {
    const h = harness();
    await h.controller.open();
    await h.speak();
    await h.controller.stop();
    h.emit("Nexa, seguí");
    expect(h.accepted).not.toHaveBeenCalled();
    await h.controller.open();
    expect(h.voice.ptt.start).toHaveBeenCalledTimes(2);
    await h.controller.stop();
  });

  it("a user Stop during transcript cleanup prevents a late Runtime submission", async () => {
    let releaseCancellation: (() => void) | undefined;
    const h = harness();
    h.voice.ptt.cancel = vi.fn(async ({ requestId, sessionId, targetRequestId }) => {
      await new Promise<void>((resolve) => { releaseCancellation = resolve; });
      return { ok: true as const, requestId, sessionId, targetRequestId, cancelled: true };
    });
    await h.controller.open();
    await h.speak();
    h.emit("Nexa, seguí");
    const stop = h.controller.stop();
    await vi.waitFor(() => expect(releaseCancellation).toBeTypeOf("function"));
    releaseCancellation?.();
    await stop;
    await Promise.resolve();
    expect(h.accepted).not.toHaveBeenCalled();
  });

  it("does not start duplicate capture sessions", async () => {
    const h = harness();
    await Promise.all([h.controller.open(), h.controller.open()]);
    expect(h.voice.ptt.start).toHaveBeenCalledOnce();
    await h.controller.stop();
  });

  it("prepares the model during TTS without opening the microphone", async () => {
    const h = harness();
    h.controller.prepare();
    await vi.waitFor(() => expect(h.createVad).toHaveBeenCalledOnce());
    expect(h.vad.start).not.toHaveBeenCalled();
    expect(h.voice.ptt.start).not.toHaveBeenCalled();
    await h.controller.open();
    expect(h.createVad).toHaveBeenCalledOnce();
    expect(h.vad.start).toHaveBeenCalledOnce();
    await h.controller.stop();
  });

  it("releases a prepared model if Voice is cancelled before playback ends", async () => {
    const h = harness();
    h.controller.prepare();
    await h.controller.stop();
    expect(h.vad.start).not.toHaveBeenCalled();
    expect(h.vad.destroy).toHaveBeenCalledOnce();
    expect(h.voice.ptt.start).not.toHaveBeenCalled();
  });

  it("closes a microphone that finishes starting after Stop", async () => {
    let releaseStart: (() => void) | undefined;
    const h = harness();
    h.vad.start.mockImplementation(() => new Promise<void>((resolve) => { releaseStart = resolve; }));
    const opening = h.controller.open();
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf("function"));
    await h.controller.stop();
    releaseStart?.();
    await opening;
    expect(h.controller.getSnapshot()).toBe("idle");
    expect(h.vad.destroy).toHaveBeenCalledTimes(2);
    expect(h.voice.ptt.cancel).toHaveBeenCalled();
  });

  it("shows preparing until VAD confirms microphone capture, then listening", async () => {
    let finishStart: (() => void) | undefined;
    const h = harness();
    h.vad.start.mockImplementation(() => new Promise<void>((resolve) => { finishStart = resolve; }));
    const opening = h.controller.open();
    await vi.waitFor(() => expect(finishStart).toBeTypeOf("function"));
    expect(h.controller.getSnapshot()).toBe("preparing");
    expect(h.controller.getSnapshot()).not.toBe("listening");
    finishStart?.();
    await opening;
    expect(h.controller.getSnapshot()).toBe("listening");
    await h.controller.stop();
    expect(h.controller.getSnapshot()).toBe("idle");
  });

  it("reports a sanitized microphone failure and returns to idle", async () => {
    const failure = vi.fn();
    const h = harness();
    h.vad.start.mockRejectedValue(new DOMException("private device details", "NotAllowedError"));
    const controller = new VoiceFollowupController(h.voice, {
      createVad: h.createVad, onAcceptedTranscript: h.accepted, onFailure: failure,
    });
    await controller.open();
    await vi.waitFor(() => expect(controller.getSnapshot()).toBe("idle"));
    expect(failure).toHaveBeenCalledWith({ stage: "vad_start", code: "microphone_permission_denied" });
    expect(JSON.stringify(failure.mock.calls)).not.toContain("private device details");
    expect(h.voice.ptt.cancel).toHaveBeenCalledOnce();
  });
});
