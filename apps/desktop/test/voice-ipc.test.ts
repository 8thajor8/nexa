import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VOICE_EVENT_CHANNEL,
  VOICE_PTT_CANCEL_CHANNEL,
  VOICE_PTT_FINISH_CHANNEL,
  VOICE_PTT_START_CHANNEL,
} from "../src/shared/ipc-contract";

const ipcMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { ipcMock.handlers.set(channel, handler); }),
  removeHandler: vi.fn((channel: string) => { ipcMock.handlers.delete(channel); }),
}));

vi.mock("electron", () => ({ ipcMain: ipcMock }));

import {
  cleanupVoiceWindow,
  registerVoiceIpcHandlers,
  registerVoiceMicrophonePermissions,
  removeVoiceIpcHandlers,
} from "../src/main/voice-ipc";

const RENDERER_URL = "http://127.0.0.1:5173";

function createWindow(id: string, url = `${RENDERER_URL}/`) {
  const mainFrame = { url };
  const webContents = { mainFrame, send: vi.fn(), isDestroyed: vi.fn(() => false) };
  return {
    id, webContents, isDestroyed: vi.fn(() => false),
    minimize: vi.fn(), close: vi.fn(),
  };
}

function trustedEvent(window: ReturnType<typeof createWindow>) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
}

function invoke(channel: string, event: unknown, payload: unknown) {
  const handler = ipcMock.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler(event, payload);
}

function makeVoiceFactory() {
  const controllers: Array<{
    emit: (event: object) => void;
    resolvePending: (value: unknown) => void;
    transcribe: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  const createPttVoiceController = vi.fn(() => {
    const listeners = new Set<(event: object) => void>();
    let sessionId = "";
    let turnId = "";
    let resolvePending = (_value: unknown) => undefined;
    const emit = (event: object) => { for (const listener of [...listeners]) listener(event); };
    const transcribe = vi.fn(() => new Promise((resolve) => {
      resolvePending = resolve;
      turnId = `turn-${controllers.length}`;
      emit({ type: "voice.transcribing", sessionId, turnId, timestamp: 101 });
    }));
    const cancel = vi.fn((reason = "user") => {
      if (!turnId) return false;
      emit({ type: "voice.cancelled", sessionId, turnId, timestamp: 102, reason });
      resolvePending(null);
      turnId = "";
      return true;
    });
    const end = vi.fn(() => {
      if (turnId) cancel("session_ended");
      emit({ type: "voice.session.ended", sessionId, turnId: null, timestamp: 103 });
    });
    const unsubscribe = vi.fn(() => listeners.clear());
    const controller = {
      emit, resolvePending: (value: unknown) => resolvePending(value), transcribe, cancel, end, unsubscribe,
      start: vi.fn(() => {
        sessionId = `session-${controllers.length}`;
        emit({ type: "voice.session.started", sessionId, turnId: null, timestamp: 100 });
        return { sessionId };
      }),
      subscribe: vi.fn((listener: (event: object) => void) => {
        listeners.add(listener);
        return unsubscribe;
      }),
    };
    controllers.push(controller);
    return controller;
  });
  return {
    controllers,
    createSpeechRecognizer: vi.fn(() => ({ transcribe: vi.fn() })),
    createPttVoiceController,
  };
}

function register(window: ReturnType<typeof createWindow>, voice = makeVoiceFactory()) {
  registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => voice as never);
  return voice;
}

async function startSession(window: ReturnType<typeof createWindow>, requestId = "start-1") {
  return await invoke(VOICE_PTT_START_CHANNEL, trustedEvent(window), { requestId }) as {
    ok: boolean; requestId: string; sessionId?: string;
  };
}

function makeAudio() {
  const audio = new Uint8Array(46);
  const view = new DataView(audio.buffer);
  const tag = (offset: number, value: string) => [...value].forEach((char, index) => audio[offset + index] = char.charCodeAt(0));
  tag(0, "RIFF"); view.setUint32(4, 38, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, 2, true);
  return audio;
}

function finish(window: ReturnType<typeof createWindow>, sessionId: string, requestId = "finish-1") {
  return invoke(VOICE_PTT_FINISH_CHANNEL, trustedEvent(window), {
    requestId, sessionId, audio: makeAudio(), format: "wav",
  });
}

describe("Electron Main Voice IPC", () => {
  beforeEach(() => {
    removeVoiceIpcHandlers();
    vi.clearAllMocks();
  });

  it("subscribes before start and returns a correlated session with synchronous Voice events", async () => {
    const window = createWindow("one"); const voice = register(window);
    const response = await startSession(window);
    expect(response).toEqual({ ok: true, requestId: "start-1", sessionId: "session-1" });
    expect(voice.controllers[0].start).toHaveBeenCalledOnce();
    expect(voice.controllers[0].subscribe.mock.invocationCallOrder[0])
      .toBeLessThan(voice.controllers[0].start.mock.invocationCallOrder[0]);
    expect(window.webContents.send).toHaveBeenCalledWith(VOICE_EVENT_CHANNEL, expect.objectContaining({
      requestId: "start-1", sessionId: "session-1", sequence: 1,
      event: { type: "voice.session.started", sessionId: "session-1", turnId: null, timestamp: 100 },
    }));
  });

  it("correlates turn events and returns finish ACK before STT resolves", async () => {
    const window = createWindow("one"); const voice = register(window);
    const { sessionId } = await startSession(window);
    const response = finish(window, sessionId!);
    expect(response).toEqual({ ok: true, accepted: true, requestId: "finish-1", sessionId });
    expect(voice.controllers[0].transcribe).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenLastCalledWith(VOICE_EVENT_CHANNEL, expect.objectContaining({
      requestId: "finish-1", sessionId, turnId: "turn-1", sequence: 2,
      event: { type: "voice.transcribing", sessionId, turnId: "turn-1", timestamp: 101 },
    }));

    const finalEvent = { type: "voice.transcript.final", sessionId, turnId: "turn-1", timestamp: 104, text: "real voice", language: "es" };
    voice.controllers[0].emit(finalEvent);
    expect(window.webContents.send).toHaveBeenLastCalledWith(VOICE_EVENT_CHANNEL, expect.objectContaining({
      requestId: "finish-1", event: finalEvent,
    }));
    voice.controllers[0].resolvePending({ sessionId, turnId: "turn-1", text: "real voice", language: "es" });
    await Promise.resolve(); await Promise.resolve();
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
  });

  it("rejects concurrent finishes and targets only the pending operation on cancel", async () => {
    const window = createWindow("one"); const voice = register(window);
    const { sessionId } = await startSession(window);
    expect(finish(window, sessionId!)).toMatchObject({ accepted: true });
    expect(finish(window, sessionId!, "finish-2")).toMatchObject({
      ok: false, requestId: "finish-2", error: { code: "request_conflict" },
    });
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-wrong", sessionId, targetRequestId: "finish-2",
    })).toMatchObject({ ok: false, error: { code: "request_not_found" } });
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-1", sessionId, targetRequestId: "finish-1",
    })).toEqual({ ok: true, requestId: "cancel-1", sessionId, targetRequestId: "finish-1", cancelled: true });
    expect(voice.controllers[0].cancel).toHaveBeenCalledOnce();
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
    const cancelEvent = window.webContents.send.mock.calls.find(([, envelope]) =>
      (envelope as { event?: { type?: string } }).event?.type === "voice.cancelled")?.[1] as { requestId: string };
    expect(cancelEvent.requestId).toBe("cancel-1");
  });

  it("cancels a started capture by its start request, retires it once, and permits a new session", async () => {
    const window = createWindow("one"); const voice = register(window);
    const first = await startSession(window, "start-capture-1");
    const response = invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-capture-1", sessionId: first.sessionId, targetRequestId: "start-capture-1",
    });

    expect(response).toEqual({
      ok: true, requestId: "cancel-capture-1", sessionId: first.sessionId,
      targetRequestId: "start-capture-1", cancelled: true,
    });
    expect(voice.controllers[0].cancel).toHaveBeenCalledOnce();
    expect(voice.controllers[0].cancel).toHaveBeenCalledWith("user");
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
    expect(voice.controllers[0].unsubscribe).toHaveBeenCalledOnce();
    const events = window.webContents.send.mock.calls.map(([, envelope]) =>
      (envelope as { event?: { type?: string } }).event?.type);
    expect(events.filter((type) => type === "voice.cancelled")).toHaveLength(0);
    expect(events.filter((type) => type === "voice.session.ended")).toHaveLength(1);

    const second = await startSession(window, "start-capture-2");
    expect(second.ok).toBe(true);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(voice.controllers).toHaveLength(2);
  });

  it("rejects incorrect and repeated pre-finish cancellations without affecting the active session", async () => {
    const window = createWindow("one"); const voice = register(window);
    const started = await startSession(window, "start-active");
    const invalid = invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-wrong", sessionId: started.sessionId, targetRequestId: "not-the-start",
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "request_not_found" } });
    expect(voice.controllers[0].end).not.toHaveBeenCalled();

    const validRequest = {
      requestId: "cancel-active", sessionId: started.sessionId, targetRequestId: "start-active",
    };
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), validRequest)).toMatchObject({
      ok: true, cancelled: true,
    });
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      ...validRequest, requestId: "cancel-active-again",
    })).toMatchObject({ ok: false, error: { code: "session_unavailable" } });
    expect(voice.controllers[0].cancel).toHaveBeenCalledOnce();
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
  });

  it("does not let an old session cancellation affect a newer session or forward late events", async () => {
    const window = createWindow("one"); const voice = register(window);
    const oldSession = await startSession(window, "start-old");
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-old", sessionId: oldSession.sessionId, targetRequestId: "start-old",
    })).toMatchObject({ ok: true });
    const current = await startSession(window, "start-current");

    const countBeforeStaleCancel = window.webContents.send.mock.calls.length;
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-old-again", sessionId: oldSession.sessionId, targetRequestId: "start-old",
    })).toMatchObject({ ok: false, error: { code: "session_unavailable" } });
    voice.controllers[0].emit({
      type: "voice.transcript.final", sessionId: oldSession.sessionId, turnId: "late-turn",
      timestamp: 104, text: "late", language: null,
    });
    expect(window.webContents.send).toHaveBeenCalledTimes(countBeforeStaleCancel);
    expect(voice.controllers[1].end).not.toHaveBeenCalled();
    expect(finish(window, current.sessionId!, "finish-current")).toMatchObject({ accepted: true });
  });

  it("retires an idle session and frees the window even if Voice cancellation throws", async () => {
    const window = createWindow("one"); const voice = register(window);
    const started = await startSession(window, "start-cancel-failure");
    voice.controllers[0].cancel.mockImplementation(() => { throw new Error("cancel failed"); });

    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-failure", sessionId: started.sessionId, targetRequestId: "start-cancel-failure",
    })).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
    expect(voice.controllers[0].unsubscribe).toHaveBeenCalledOnce();
    expect((await startSession(window, "start-after-failure")).ok).toBe(true);
  });

  it("cleans up a started capture when its window is destroyed", async () => {
    const window = createWindow("one"); const voice = register(window);
    await startSession(window, "start-before-close");
    cleanupVoiceWindow(window as never);
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
    expect(voice.controllers[0].unsubscribe).toHaveBeenCalledOnce();
    expect(await startSession(window, "start-after-close")).toMatchObject({
      ok: true, sessionId: "session-2",
    });
  });

  it("suppresses late results after cancel and allows a new consecutive session", async () => {
    const window = createWindow("one"); const voice = register(window);
    const first = await startSession(window);
    finish(window, first.sessionId!);
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-1", sessionId: first.sessionId, targetRequestId: "finish-1",
    })).toMatchObject({ cancelled: true });
    const eventCountAfterCancel = window.webContents.send.mock.calls.length;
    voice.controllers[0].emit({ type: "voice.transcript.final", sessionId: first.sessionId, turnId: "turn-1", timestamp: 105, text: "late", language: null });
    expect(window.webContents.send).toHaveBeenCalledTimes(eventCountAfterCancel);

    const second = await startSession(window, "start-2");
    expect(second).toEqual({ ok: true, requestId: "start-2", sessionId: "session-2" });
    expect(voice.controllers).toHaveLength(2);
  });

  it("isolates window state and rejects untrusted sender, frame, or renderer origin", async () => {
    const window = createWindow("trusted"); register(window);
    const handler = ipcMock.handlers.get(VOICE_PTT_START_CHANNEL)!;
    const otherWindow = createWindow("other");
    await expect(handler(trustedEvent(otherWindow), { requestId: "spoof" })).rejects.toThrow("untrusted_voice_ipc_sender");
    await expect(handler({ sender: window.webContents, senderFrame: { url: "http://127.0.0.1:5174/" } }, { requestId: "wrong-origin" }))
      .rejects.toThrow("untrusted_voice_ipc_sender");
    await expect(handler({ sender: window.webContents, senderFrame: { url: `${RENDERER_URL}/`, isMainFrame: false } }, { requestId: "wrong-frame" }))
      .rejects.toThrow("untrusted_voice_ipc_sender");
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("keeps session controllers and sequence counters separate for each window", async () => {
    const firstWindow = createWindow("first"); const secondWindow = createWindow("second");
    const voice = makeVoiceFactory();
    let currentWindow = firstWindow;
    registerVoiceIpcHandlers(() => currentWindow as never, RENDERER_URL, async () => voice as never);
    const first = await startSession(firstWindow, "start-first");
    currentWindow = secondWindow;
    const second = await startSession(secondWindow, "start-second");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(voice.controllers).toHaveLength(2);
    expect(firstWindow.webContents.send.mock.calls[0][1]).toMatchObject({ sequence: 1, sessionId: first.sessionId });
    expect(secondWindow.webContents.send.mock.calls[0][1]).toMatchObject({ sequence: 1, sessionId: second.sessionId });
    currentWindow = firstWindow;
    expect(finish(firstWindow, first.sessionId!, "finish-first")).toMatchObject({ accepted: true, sessionId: first.sessionId });
    currentWindow = secondWindow;
    expect(finish(secondWindow, second.sessionId!, "finish-second")).toMatchObject({ accepted: true, sessionId: second.sessionId });
    expect(voice.controllers[0].transcribe).toHaveBeenCalledOnce();
    expect(voice.controllers[1].transcribe).toHaveBeenCalledOnce();
  });

  it("cleans up the controller and listener when its window is destroyed", async () => {
    const window = createWindow("one"); const voice = register(window);
    const { sessionId } = await startSession(window);
    finish(window, sessionId!);
    cleanupVoiceWindow(window as never);
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
    expect(voice.controllers[0].unsubscribe).toHaveBeenCalledOnce();
    expect(finish(window, sessionId!, "finish-after-close")).toMatchObject({
      ok: false, error: { code: "session_unavailable" },
    });
  });

  it("grants microphone permission only to the trusted main frame and denies video or other origins", () => {
    const window = createWindow("one");
    const permissionSession = {
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    };
    registerVoiceMicrophonePermissions(permissionSession as never, () => window as never, RENDERER_URL);
    const check = permissionSession.setPermissionCheckHandler.mock.calls[0][0] as (...args: unknown[]) => boolean;
    const request = permissionSession.setPermissionRequestHandler.mock.calls[0][0] as (...args: unknown[]) => void;
    expect(check(window.webContents, "media", RENDERER_URL, {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaType: "audio",
    })).toBe(true);
    expect(check(window.webContents, "media", "http://127.0.0.1:5174", {
      isMainFrame: true, requestingUrl: "http://127.0.0.1:5174/", mediaType: "audio",
    })).toBe(false);
    expect(check(window.webContents, "media", RENDERER_URL, {
      isMainFrame: false, requestingUrl: `${RENDERER_URL}/`, mediaType: "audio",
    })).toBe(false);

    const callback = vi.fn();
    request(window.webContents, "media", callback, {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, securityOrigin: RENDERER_URL, mediaTypes: ["audio"],
    });
    expect(callback).toHaveBeenLastCalledWith(true);
    request(window.webContents, "media", callback, {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, securityOrigin: RENDERER_URL, mediaTypes: ["audio", "video"],
    });
    expect(callback).toHaveBeenLastCalledWith(false);
  });
});
