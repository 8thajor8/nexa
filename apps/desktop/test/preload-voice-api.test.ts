import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exposed: undefined as unknown,
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn((_key: string, api: unknown) => { mocks.exposed = api; }) },
  ipcRenderer: { invoke: mocks.invoke, send: mocks.send, on: mocks.on, removeListener: mocks.removeListener },
}));

function makeWav(): Uint8Array {
  const bytes = new Uint8Array(46); const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => [...value].forEach((char, index) => bytes[offset + index] = char.charCodeAt(0));
  tag(0, "RIFF"); view.setUint32(4, 38, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, 2, true); return bytes;
}

async function loadPreload() {
  mocks.exposed = undefined;
  await import("../src/preload");
  return mocks.exposed as {
    voice: {
      ptt: { start: (request: unknown) => Promise<unknown>; finish: (request: unknown) => Promise<unknown>; cancel: (request: unknown) => Promise<unknown> };
      speech: { cancel: (request: unknown) => Promise<unknown>; onEvent: (listener: (event: unknown) => void) => () => void };
      onEvent: (listener: (event: unknown) => void) => () => void;
    };
    [key: string]: unknown;
  };
}

describe("Voice preload API", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it("exposes only narrow Voice methods and invokes fixed channels with validated requests", async () => {
    const api = await loadPreload();
    expect(Object.keys(api.voice).sort()).toEqual(["onEvent", "ptt", "speech"]);
    expect(Object.keys(api.voice.ptt).sort()).toEqual(["cancel", "finish", "start"]);
    expect(Object.keys(api.voice.speech).sort()).toEqual(["cancel", "onEvent"]);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("send");

    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: "start-1", sessionId: "session-1" });
    await expect(api.voice.ptt.start({ requestId: "start-1" })).resolves.toEqual({ ok: true, requestId: "start-1", sessionId: "session-1" });
    expect(mocks.invoke).toHaveBeenLastCalledWith("voice:ptt:start", { requestId: "start-1" });

    mocks.invoke.mockResolvedValueOnce({ ok: true, accepted: true, requestId: "finish-1", sessionId: "session-1" });
    await expect(api.voice.ptt.finish({ requestId: "finish-1", sessionId: "session-1", audio: makeWav(), format: "wav" }))
      .resolves.toMatchObject({ accepted: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith("voice:ptt:finish", expect.objectContaining({ requestId: "finish-1" }));

    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: "cancel-1", sessionId: "session-1", targetRequestId: "finish-1", cancelled: true });
    await expect(api.voice.ptt.cancel({ requestId: "cancel-1", sessionId: "session-1", targetRequestId: "finish-1" }))
      .resolves.toMatchObject({ cancelled: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith("voice:ptt:cancel", { requestId: "cancel-1", sessionId: "session-1", targetRequestId: "finish-1" });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("exposes correlated speech cancellation and filters malformed playback events", async () => {
    const api = await loadPreload();
    const request = { requestId: "00000000-0000-4000-8000-000000000061" };
    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: request.requestId, cancelled: true });
    await expect(api.voice.speech.cancel(request)).resolves.toEqual({ ok: true, requestId: request.requestId, cancelled: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith("voice:speech:cancel", request);

    const received = vi.fn();
    const unsubscribe = api.voice.speech.onEvent(received);
    const listener = mocks.on.mock.calls.find(([channel]) => channel === "voice:speech:event")?.[1] as (_event: unknown, payload: unknown) => void;
    listener({}, { requestId: "invalid", state: "not-a-speech-state" });
    listener({}, { requestId: request.requestId, state: "completed" });
    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith({ requestId: request.requestId, state: "completed" });
    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith("voice:speech:event", listener);
  });

  it("rejects invalid requests and malformed responses without invoking arbitrary IPC", async () => {
    const api = await loadPreload();
    await expect(api.voice.ptt.start({ requestId: "bad", channel: "nexa:ping" })).rejects.toThrow("invalid_voice_ptt_start_request");
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: "other-request", sessionId: "session-1" });
    await expect(api.voice.ptt.start({ requestId: "start-1" })).rejects.toThrow("invalid_voice_ptt_start_response");
  });

  it("correlates finish and cancel responses to their request, session, and target operation", async () => {
    const api = await loadPreload();
    const finishRequest = { requestId: "finish-1", sessionId: "session-1", audio: makeWav(), format: "wav" as const };
    const cancelRequest = { requestId: "cancel-1", sessionId: "session-1", targetRequestId: "finish-1" };

    mocks.invoke.mockResolvedValueOnce({ ok: true, accepted: true, requestId: "finish-1", sessionId: "session-1" });
    await expect(api.voice.ptt.finish(finishRequest)).resolves.toMatchObject({ accepted: true });
    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: "cancel-1", sessionId: "session-1", targetRequestId: "finish-1", cancelled: true });
    await expect(api.voice.ptt.cancel(cancelRequest)).resolves.toMatchObject({ cancelled: true });

    mocks.invoke.mockResolvedValueOnce({ ok: true, accepted: true, requestId: "other-finish", sessionId: "session-1" });
    await expect(api.voice.ptt.finish(finishRequest)).rejects.toThrow("invalid_voice_ptt_finish_response");
    mocks.invoke.mockResolvedValueOnce({ ok: true, accepted: true, requestId: "finish-1", sessionId: "other-session" });
    await expect(api.voice.ptt.finish(finishRequest)).rejects.toThrow("invalid_voice_ptt_finish_response");

    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: "other-cancel", sessionId: "session-1", targetRequestId: "finish-1", cancelled: true });
    await expect(api.voice.ptt.cancel(cancelRequest)).rejects.toThrow("invalid_voice_ptt_cancel_response");
    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: "cancel-1", sessionId: "other-session", targetRequestId: "finish-1", cancelled: true });
    await expect(api.voice.ptt.cancel(cancelRequest)).rejects.toThrow("invalid_voice_ptt_cancel_response");
    mocks.invoke.mockResolvedValueOnce({ ok: true, requestId: "cancel-1", sessionId: "session-1", targetRequestId: "other-finish", cancelled: true });
    await expect(api.voice.ptt.cancel(cancelRequest)).rejects.toThrow("invalid_voice_ptt_cancel_response");
    expect(mocks.invoke).toHaveBeenCalledTimes(7);
  });

  it("filters invalid events, forwards the original valid envelope, and unsubscribes only its listener", async () => {
    const api = await loadPreload(); const received = vi.fn();
    const unsubscribe = api.voice.onEvent(received);
    const registeredListener = mocks.on.mock.calls[0][1] as (_event: unknown, payload: unknown) => void;
    const originalEvent = Object.freeze({ type: "voice.session.started", sessionId: "session-1", turnId: null, timestamp: 123 });
    const valid = { requestId: "start-1", sessionId: "session-1", sequence: 1, event: originalEvent };
    registeredListener({}, { ...valid, sequence: 0 });
    expect(received).not.toHaveBeenCalled();
    registeredListener({}, valid);
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0]).toBe(valid);
    unsubscribe(); unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
    expect(mocks.removeListener).toHaveBeenCalledWith("voice:event", registeredListener);
  });
});
