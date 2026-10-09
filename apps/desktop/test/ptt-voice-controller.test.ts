import { describe, expect, it, vi } from "vitest";
import type { VoiceDesktopApi, VoiceEventEnvelope, VoicePttEvent, VoicePttFinishResponse } from "../src/shared/ipc-contract";
import { PttVoiceController, type PttCapturePort } from "../src/renderer/voice/ptt-voice-controller";

function makeEvent(
  type: VoicePttEvent["type"], sequence: number, overrides: Partial<VoiceEventEnvelope> = {},
): VoiceEventEnvelope {
  const sessionId = overrides.sessionId ?? "session-1";
  const requestId = overrides.requestId ?? "finish-1";
  const turnId = overrides.turnId ?? (type === "voice.session.started" || type === "voice.session.ended" ? undefined : "turn-1");
  let event: VoicePttEvent;
  switch (type) {
    case "voice.session.started":
    case "voice.session.ended":
      event = { type, sessionId, turnId: null, timestamp: sequence };
      break;
    case "voice.transcribing":
      event = { type, sessionId, turnId: turnId ?? "turn-1", timestamp: sequence };
      break;
    case "voice.transcript.final":
      event = { type, sessionId, turnId: turnId ?? "turn-1", timestamp: sequence, text: "texto real", language: "es" };
      break;
    case "voice.cancelled":
      event = { type, sessionId, turnId: turnId ?? "turn-1", timestamp: sequence, reason: "user" };
      break;
    case "voice.error":
      event = { type, sessionId, turnId: turnId ?? "turn-1", timestamp: sequence,
        error: { code: "VOICE_PTT_TRANSCRIPTION_FAILED", message: "STT failed" } };
      break;
  }
  return { requestId, sessionId, sequence, ...(turnId ? { turnId } : {}), event, ...overrides };
}

class FakeCapture implements PttCapturePort {
  currentSessionId = "session-1";
  readonly start = vi.fn(async () => {
    this.currentSessionId = `session-${this.starts++ + 1}`;
    return { sessionId: this.currentSessionId, requestId: "start-" + this.starts };
  });
  readonly finish = vi.fn(async (): Promise<VoicePttFinishResponse> => ({
    ok: true, accepted: true, requestId: `finish-${this.finishes++ + 1}`, sessionId: this.currentSessionId,
  }));
  readonly cancel = vi.fn(async () => {
    if (this.cancelMakesPending) this.mainCancellationPending = true;
    else this.mainCancellationPending = false;
    if (this.cancelError) throw this.cancelError;
  });
  readonly recoverMainCancellation = vi.fn(async () => {
    if (this.recoverError) throw this.recoverError;
    this.mainCancellationPending = false;
  });
  mainCancellationPending = false;
  cancelMakesPending = false;
  cancelError: unknown;
  recoverError: unknown;
  starts = 0;
  finishes = 0;
}

function makeHarness(capture = new FakeCapture()) {
  const eventListeners = new Set<(event: VoiceEventEnvelope) => void>();
  const unsubscribe = vi.fn();
  const voice = {
    ptt: {},
    onEvent(listener: (event: VoiceEventEnvelope) => void) {
      eventListeners.add(listener);
      return () => { unsubscribe(); eventListeners.delete(listener); };
    },
  } as unknown as VoiceDesktopApi;
  const createCapture = vi.fn(() => capture);
  const controller = new PttVoiceController(voice, { createCapture });
  return {
    controller, capture, createCapture, eventListeners, unsubscribe,
    emit: (event: VoiceEventEnvelope) => { for (const listener of [...eventListeners]) listener(event); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("PttVoiceController", () => {
  it("creates one capture instance, subscribes once, and starts only on explicit action", async () => {
    const harness = makeHarness();
    expect(harness.createCapture).toHaveBeenCalledOnce();
    expect(harness.capture.start).not.toHaveBeenCalled();
    expect(harness.eventListeners.size).toBe(1);
    expect(harness.controller.getSnapshot()).toEqual({ status: "idle" });

    await harness.controller.start();
    expect(harness.controller.getSnapshot()).toEqual({ status: "listening", sessionId: "session-1" });
    expect(harness.capture.start).toHaveBeenCalledOnce();
  });

  it("blocks duplicate start and finish operations and transitions through ACK to processing", async () => {
    const harness = makeHarness();
    const start = deferred<{ sessionId: string }>();
    harness.capture.start.mockReturnValueOnce(start.promise);
    const starting = harness.controller.start();
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledOnce();
    start.resolve({ sessionId: "session-1", requestId: "start-1" });
    await starting;

    const finishAck = deferred<VoicePttFinishResponse>();
    harness.capture.finish.mockReturnValueOnce(finishAck.promise);
    const finishing = harness.controller.finish("es");
    await harness.controller.finish("en");
    expect(harness.capture.finish).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().status).toBe("finishing");
    finishAck.resolve({ ok: true, accepted: true, requestId: "finish-1", sessionId: "session-1" });
    await finishing;
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "processing", sessionId: "session-1", requestId: "finish-1" });
  });

  it("buffers a bounded sequence of Voice events that arrive before the finish ACK", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    const ack = deferred<VoicePttFinishResponse>();
    harness.capture.finish.mockReturnValueOnce(ack.promise);
    const finishing = harness.controller.finish();
    harness.emit(makeEvent("voice.transcribing", 1));
    harness.emit(makeEvent("voice.transcript.final", 2));
    harness.emit(makeEvent("voice.session.ended", 3, { turnId: undefined }));
    expect(harness.controller.getSnapshot().status).toBe("finishing");

    ack.resolve({ ok: true, accepted: true, requestId: "finish-1", sessionId: "session-1" });
    await finishing;
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "transcript-ready", sessionId: "session-1", requestId: "finish-1", turnId: "turn-1",
      transcript: "texto real", language: "es",
    });
  });

  it("reports overflow instead of retaining an unbounded pre-ACK event queue", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    const ack = deferred<VoicePttFinishResponse>();
    harness.capture.finish.mockReturnValueOnce(ack.promise);
    const finishing = harness.controller.finish();
    for (let sequence = 1; sequence <= 10; sequence += 1) harness.emit(makeEvent("voice.transcribing", sequence));
    ack.resolve({ ok: true, accepted: true, requestId: "finish-1", sessionId: "session-1" });
    await finishing;
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "error", error: { code: "voice_event_buffer_overflow" } });
  });

  it("accepts a final transcript only for the active session, ACK request, turn, and fresh sequence", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    await harness.controller.finish();

    harness.emit(makeEvent("voice.transcribing", 1, { requestId: "wrong-request" }));
    harness.emit(makeEvent("voice.transcribing", 2, { sessionId: "old-session" }));
    harness.emit(makeEvent("voice.transcribing", 3));
    harness.emit(makeEvent("voice.transcribing", 4, { turnId: "turn-2" }));
    harness.emit(makeEvent("voice.transcript.final", 5, { turnId: "turn-2" }));
    expect(harness.controller.getSnapshot().status).toBe("processing");

    const valid = makeEvent("voice.transcribing", 6);
    harness.emit(valid);
    harness.emit(valid);
    harness.emit(makeEvent("voice.transcript.final", 5));
    harness.emit(makeEvent("voice.transcript.final", 7, { requestId: "stale-request" }));
    expect(harness.controller.getSnapshot().status).toBe("processing");
    harness.emit(makeEvent("voice.transcript.final", 8));
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "transcript-ready", transcript: "texto real", turnId: "turn-1" });
  });

  it("rejects malformed envelopes and events from cancelled or previous sessions", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    await harness.controller.cancel();
    expect(harness.controller.getSnapshot().status).toBe("idle");
    await harness.controller.start();
    await harness.controller.finish();
    harness.emit(makeEvent("voice.transcribing", 1, { sessionId: "session-1" }));
    harness.emit(makeEvent("voice.transcribing", 2, { sessionId: "session-2" }));
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "processing", turnId: "turn-1" });
    harness.emit(makeEvent("voice.transcribing", 3, { sessionId: "session-2", event: {
      type: "voice.transcribing", sessionId: "mismatch", turnId: "turn-2", timestamp: 2,
    } as VoicePttEvent }));
    expect(harness.controller.getSnapshot().status).toBe("processing");
    harness.emit(makeEvent("voice.transcript.final", 4, { sessionId: "session-2", turnId: "turn-2" }));
    expect(harness.controller.getSnapshot().status).toBe("processing");
    harness.emit(makeEvent("voice.transcript.final", 5, { sessionId: "session-2" }));
    expect(harness.controller.getSnapshot().status).toBe("transcript-ready");
  });

  it("cancels during capture and during STT without accepting later transcripts", async () => {
    const duringCapture = makeHarness();
    await duringCapture.controller.start();
    await duringCapture.controller.cancel();
    expect(duringCapture.capture.cancel).toHaveBeenCalledOnce();
    expect(duringCapture.controller.getSnapshot().status).toBe("idle");
    duringCapture.emit(makeEvent("voice.transcribing", 1));
    expect(duringCapture.controller.getSnapshot().status).toBe("idle");

    const duringStt = makeHarness();
    await duringStt.controller.start();
    await duringStt.controller.finish();
    await duringStt.controller.cancel();
    expect(duringStt.controller.getSnapshot().status).toBe("idle");
    duringStt.emit(makeEvent("voice.transcript.final", 1));
    expect(duringStt.controller.getSnapshot().status).toBe("idle");
  });

  it("enters recovery-required on uncertain cancellation and recovers only by explicit action", async () => {
    const capture = new FakeCapture();
    capture.cancelError = Object.assign(new Error("IPC reply unavailable"), { code: "main_cancel_unconfirmed" });
    capture.cancelMakesPending = true;
    const harness = makeHarness(capture);
    await harness.controller.start();
    await harness.controller.cancel();
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "recovery-required", sessionId: "session-1" });
    expect(harness.capture.start).toHaveBeenCalledOnce();

    capture.cancelError = undefined;
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledOnce();
    await harness.controller.recoverMainCancellation("preferred");
    expect(harness.capture.recoverMainCancellation).toHaveBeenCalledWith("preferred");
    expect(harness.controller.getSnapshot()).toEqual({ status: "idle" });
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery-required after a failed recovery and clears it only after confirmation", async () => {
    const capture = new FakeCapture();
    capture.cancelMakesPending = true;
    capture.cancelError = new Error("cancel uncertain");
    const harness = makeHarness(capture);
    await harness.controller.start();
    await harness.controller.cancel();
    capture.cancelError = undefined;
    capture.recoverError = new Error("still unavailable");
    await harness.controller.recoverMainCancellation();
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "recovery-required" });
    capture.recoverError = undefined;
    await harness.controller.recoverMainCancellation("start");
    expect(harness.controller.getSnapshot()).toEqual({ status: "idle" });
  });

  it("handles consecutive sessions and does not let a prior session event replace the new state", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    await harness.controller.finish();
    harness.emit(makeEvent("voice.transcribing", 1));
    harness.emit(makeEvent("voice.transcript.final", 2));
    harness.emit(makeEvent("voice.session.ended", 3, { turnId: undefined }));
    expect(harness.controller.getSnapshot().status).toBe("transcript-ready");
    await harness.controller.start();
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "listening", sessionId: "session-2" });
    harness.emit(makeEvent("voice.transcript.final", 4, { sessionId: "session-1" }));
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "listening", sessionId: "session-2" });
  });

  it("unsubscribes and cancels resources when destroyed during start or finish", async () => {
    const startHarness = makeHarness();
    const starting = deferred<{ sessionId: string }>();
    startHarness.capture.start.mockReturnValueOnce(starting.promise);
    const startingTask = startHarness.controller.start();
    await startHarness.controller.destroy();
    expect(startHarness.unsubscribe).toHaveBeenCalledOnce();
    expect(startHarness.eventListeners.size).toBe(0);
    expect(startHarness.capture.cancel).toHaveBeenCalledOnce();
    starting.resolve({ sessionId: "session-1", requestId: "start-1" });
    await startingTask;
    expect(startHarness.controller.getSnapshot().status).toBe("starting");

    const finishHarness = makeHarness();
    await finishHarness.controller.start();
    const finishAck = deferred<VoicePttFinishResponse>();
    finishHarness.capture.finish.mockReturnValueOnce(finishAck.promise);
    const finishing = finishHarness.controller.finish();
    await finishHarness.controller.destroy();
    expect(finishHarness.unsubscribe).toHaveBeenCalledOnce();
    expect(finishHarness.capture.cancel).toHaveBeenCalledOnce();
    finishAck.resolve({ ok: true, accepted: true, requestId: "finish-1", sessionId: "session-1" });
    await finishing;
    expect(finishHarness.controller.getSnapshot().status).toBe("finishing");
  });

  it("processes a correlated session end after a Voice error and permits a new start", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    await harness.controller.finish();
    harness.emit(makeEvent("voice.transcribing", 1));
    harness.emit(makeEvent("voice.error", 2));
    expect(harness.controller.getSnapshot().status).toBe("error");
    harness.emit(makeEvent("voice.session.ended", 3, { turnId: undefined }));
    expect(harness.controller.getSnapshot().status).toBe("error");
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledTimes(2);
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "listening", sessionId: "session-2" });
  });

  it("processes a correlated session end after Voice cancellation and permits a new start", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    await harness.controller.finish();
    harness.emit(makeEvent("voice.transcribing", 1));
    harness.emit(makeEvent("voice.cancelled", 2));
    expect(harness.controller.getSnapshot().status).toBe("error");
    harness.emit(makeEvent("voice.session.ended", 3, { turnId: undefined }));
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledTimes(2);
  });

  it("does not clear an active session for an incorrectly correlated terminal event", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    await harness.controller.finish();
    harness.emit(makeEvent("voice.session.ended", 1, { requestId: "other-request", turnId: undefined }));
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().status).toBe("processing");
    harness.emit(makeEvent("voice.session.ended", 2, { requestId: "finish-1", turnId: undefined }));
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledTimes(2);
  });

  it("keeps a session blocked when its terminal event is absent until explicit cancellation confirms cleanup", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    await harness.controller.finish();
    harness.emit(makeEvent("voice.transcribing", 1));
    harness.emit(makeEvent("voice.error", 2));
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot().status).toBe("error");

    await harness.controller.cancel();
    expect(harness.controller.getSnapshot().status).toBe("idle");
    await harness.controller.start();
    expect(harness.capture.start).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery required when an error session cannot be reconciled until explicit confirmation", async () => {
    const capture = new FakeCapture();
    const harness = makeHarness(capture);
    await harness.controller.start();
    await harness.controller.finish();
    harness.emit(makeEvent("voice.transcribing", 1));
    harness.emit(makeEvent("voice.error", 2));
    capture.cancelMakesPending = true;
    capture.cancelError = new Error("cancel response was lost");

    await harness.controller.cancel();
    expect(harness.controller.getSnapshot().status).toBe("recovery-required");
    await harness.controller.start();
    expect(capture.start).toHaveBeenCalledOnce();

    capture.cancelError = undefined;
    await harness.controller.recoverMainCancellation("finish");
    expect(harness.controller.getSnapshot().status).toBe("idle");
    await harness.controller.start();
    expect(capture.start).toHaveBeenCalledTimes(2);
  });

  it("notifies and removes subscribers exactly once", async () => {
    const harness = makeHarness();
    const subscriber = vi.fn();
    const unsubscribe = harness.controller.subscribe(subscriber);
    await harness.controller.start();
    expect(subscriber).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribe();
    await harness.controller.cancel();
    expect(subscriber).toHaveBeenCalledTimes(2);
  });
});
