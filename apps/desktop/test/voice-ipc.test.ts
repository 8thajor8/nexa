import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VOICE_EVENT_CHANNEL,
  VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL,
  VOICE_DUCKING_END_CHANNEL,
  VOICE_SPEECH_EVENT_CHANNEL,
  VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL,
  VOICE_SPEECH_CHAT_PLAY_CHANNEL,
  VOICE_SPEECH_CANCEL_CHANNEL,
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
  cancelVoiceSpeech,
  rememberTypedChatResponse,
  discardTypedChatVoiceResponse,
  continueVoiceDuckingForRequest,
  registerVoiceWindowNavigation,
  registerVoiceIpcHandlers,
  markVoiceResponseDispatched,
  registerVoiceMicrophonePermissions,
  removeVoiceIpcHandlers,
  speakVoiceResponse,
} from "../src/main/voice-ipc";

const RENDERER_URL = "http://127.0.0.1:5174";

function createWindow(id: string, url = RENDERER_URL + "/") {
  const mainFrame = { url };
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const webContents = {
    mainFrame, send: vi.fn(), isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(listener);
      listeners.set(event, handlers);
      return webContents;
    }),
  };
  return {
    id, webContents, isDestroyed: vi.fn(() => false),
    minimize: vi.fn(), close: vi.fn(),
    emitWebContents(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
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

function register(window: ReturnType<typeof createWindow>, voice = makeVoiceFactory(), audioDucking?: {
  begin: ReturnType<typeof vi.fn>; transfer: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>;
  endExcept: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
}) {
  registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => voice as never,
    undefined, undefined, undefined, audioDucking as never);
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

  it("plays only the stored completed typed reply once, using the existing speaker and ducking", async () => {
    const window = createWindow("typed-reply");
    const audioDucking = { begin: vi.fn(async () => undefined), transfer: vi.fn(), end: vi.fn(async () => undefined),
      endExcept: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const speaker = { speak: vi.fn(async () => ({ completed: true as const })), speakPrepared: vi.fn(),
      cancel: vi.fn(() => true), on: vi.fn(() => () => undefined) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL,
      async () => ({ ...makeVoiceFactory(), createVoiceSpeaker: () => speaker }) as never,
      undefined, undefined, undefined, audioDucking);
    const requestId = "00000000-0000-4000-8000-000000000111";
    rememberTypedChatResponse(window as never, requestId, "Respuesta escrita con https://example.com");
    expect(await invoke(VOICE_SPEECH_CHAT_PLAY_CHANNEL, trustedEvent(window), { requestId })).toBe(true);
    await vi.waitFor(() => expect(speaker.speak).toHaveBeenCalledOnce());
    expect(audioDucking.begin).toHaveBeenCalledWith(requestId);
    expect(await invoke(VOICE_SPEECH_CHAT_PLAY_CHANNEL, trustedEvent(window), { requestId })).toBe(false);
    expect(speaker.speak).toHaveBeenCalledOnce();
    expect(audioDucking.end).not.toHaveBeenCalled();
    expect(invoke(VOICE_DUCKING_END_CHANNEL, trustedEvent(window), { requestId, reason: "completed" })).toBe(true);
    expect(audioDucking.end).toHaveBeenCalledWith(requestId, "completed");
    await expect(invoke(VOICE_SPEECH_CHAT_PLAY_CHANNEL, { sender: {} }, { requestId }))
      .rejects.toThrow("untrusted_voice_ipc_sender");
  });

  it("discards an obsolete typed reply and stops its audio without releasing a later owner", async () => {
    const window = createWindow("obsolete-typed-reply");
    const audioDucking = { begin: vi.fn(async () => undefined), transfer: vi.fn(), end: vi.fn(async () => undefined),
      endExcept: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const speaker = { speak: vi.fn(async () => ({ completed: true as const })), speakPrepared: vi.fn(),
      cancel: vi.fn(() => true), on: vi.fn(() => () => undefined) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL,
      async () => ({ ...makeVoiceFactory(), createVoiceSpeaker: () => speaker }) as never,
      undefined, undefined, undefined, audioDucking);
    const oldId = "00000000-0000-4000-8000-000000000112";
    const newId = "00000000-0000-4000-8000-000000000113";
    rememberTypedChatResponse(window as never, oldId, "Vieja");
    discardTypedChatVoiceResponse(window as never);
    expect(await invoke(VOICE_SPEECH_CHAT_PLAY_CHANNEL, trustedEvent(window), { requestId: oldId })).toBe(false);
    rememberTypedChatResponse(window as never, newId, "Nueva");
    expect(await invoke(VOICE_SPEECH_CHAT_PLAY_CHANNEL, trustedEvent(window), { requestId: newId })).toBe(true);
    await vi.waitFor(() => expect(speaker.speak).toHaveBeenCalledOnce());
    expect(invoke(VOICE_DUCKING_END_CHANNEL, trustedEvent(window), { requestId: oldId, reason: "stop" })).toBe(false);
    expect(audioDucking.end).not.toHaveBeenCalled();
  });

  it("restores ducking after a typed TTS failure without changing the completed chat response", async () => {
    const window = createWindow("typed-tts-error");
    const audioDucking = { begin: vi.fn(async () => undefined), transfer: vi.fn(), end: vi.fn(async () => undefined),
      endExcept: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const speaker = { speak: vi.fn(), speakPrepared: vi.fn(), cancel: vi.fn(() => true), on: vi.fn(() => () => undefined) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL,
      async () => ({ ...makeVoiceFactory(), createVoiceSpeaker: () => speaker }) as never,
      undefined, async () => makeAudio(), async () => ({ audio: null, errorCode: "voice_audio_processing_failed" }), audioDucking);
    const requestId = "00000000-0000-4000-8000-000000000114";
    rememberTypedChatResponse(window as never, requestId, "Respuesta visible");
    expect(await invoke(VOICE_SPEECH_CHAT_PLAY_CHANNEL, trustedEvent(window), { requestId })).toBe(true);
    await vi.waitFor(() => expect(audioDucking.end).toHaveBeenCalledWith(requestId, "error"));
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL,
      { requestId, state: "error", error: { code: "voice_audio_processing_failed" } });
  });

  it("accepts only bounded follow-up diagnostic outcomes from the trusted renderer", () => {
    const window = createWindow("followup-diagnostics");
    const diagnostics: Array<Record<string, unknown>> = [];
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => makeVoiceFactory() as never,
      (event) => diagnostics.push(event as unknown as Record<string, unknown>));
    const requestId = "00000000-0000-4000-8000-000000000058";
    expect(invoke(VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL, trustedEvent(window), {
      requestId, outcome: "transcript_accepted_without_prefix", durationMs: 123,
    })).toBe(true);
    expect(diagnostics[0]).toMatchObject({ requestId, stage: "followup", state: "success", durationMs: 123,
      metrics: { followupOutcome: "transcript_accepted_without_prefix" } });
    expect(() => invoke(VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL, { sender: {}, senderFrame: { url: RENDERER_URL + "/" } }, {
      requestId, outcome: "transcript_accepted_prefix_removed",
    })).toThrow("untrusted_voice_ipc_sender");
    expect(() => invoke(VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL, trustedEvent(window), {
      requestId, outcome: "transcript_accepted_prefix_removed", transcript: "must not be accepted",
    })).toThrow("invalid_voice_followup_diagnostic_request");
  });

  it("starts ducking at PTT start, transfers it to the chat request, and restores on Stop", async () => {
    const window = createWindow("audio-ducking");
    const voice = makeVoiceFactory();
    const audioDucking = {
      begin: vi.fn(async () => undefined), transfer: vi.fn(), end: vi.fn(async () => undefined),
      endExcept: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    };
    register(window, voice, audioDucking);

    const started = await startSession(window, "ptt-request");
    expect(audioDucking.begin).toHaveBeenCalledWith("ptt-request");
    expect(finish(window, started.sessionId!, "chat-request")).toMatchObject({ accepted: true });
    expect(audioDucking.transfer).toHaveBeenCalledWith("ptt-request", "chat-request");
    expect(invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "stop-request", sessionId: started.sessionId, targetRequestId: "chat-request",
    })).toMatchObject({ ok: true, cancelled: true });
    await vi.waitFor(() => expect(audioDucking.end).toHaveBeenCalledWith("chat-request", "completed"));
    expect(audioDucking.end).toHaveBeenCalledOnce();
  });

  it("retains one ducking lease across playback, follow-up, STT and the next spoken turn", async () => {
    const window = createWindow("continuous-ducking");
    const audioDucking = {
      begin: vi.fn(async () => undefined), transfer: vi.fn(), end: vi.fn(async () => undefined),
      endExcept: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    };
    const voice = makeVoiceFactory();
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let idFactory = () => "";
    const speaker = {
      speak: vi.fn(async () => {
        listeners.get("voice.speech.completed")?.({ turnId: idFactory() });
        return { completed: true as const };
      }),
      cancel: vi.fn(() => false),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener);
        return () => listeners.delete(type);
      }),
    };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL,
      async () => ({ ...voice, createVoiceSpeaker: ({ idFactory: factory }: { idFactory: () => string }) => {
        idFactory = factory; return speaker;
      } }) as never, undefined, undefined, undefined, audioDucking);

    const first = await startSession(window, "ptt-1");
    finish(window, first.sessionId!, "stt-1");
    voice.controllers[0].emit({ type: "voice.transcript.final", sessionId: first.sessionId, turnId: "turn-1",
      timestamp: 1, text: "hola", language: "es" });
    voice.controllers[0].resolvePending(null);
    await Promise.resolve();
    continueVoiceDuckingForRequest("chat-1");
    await speakVoiceResponse(window as never, "chat-1", "Primera respuesta.");
    expect(audioDucking.end).not.toHaveBeenCalled();

    const followup = await startSession(window, "followup-2");
    expect(audioDucking.transfer).toHaveBeenCalledWith("chat-1", "followup-2");
    expect(invoke(VOICE_DUCKING_END_CHANNEL, trustedEvent(window), { requestId: "chat-1", reason: "completed" })).toBe(false);
    finish(window, followup.sessionId!, "stt-2");
    voice.controllers[1].emit({ type: "voice.transcript.final", sessionId: followup.sessionId, turnId: "turn-2",
      timestamp: 2, text: "seguí", language: "es" });
    invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cleanup-2", sessionId: followup.sessionId, targetRequestId: "stt-2",
    });
    continueVoiceDuckingForRequest("chat-2");
    await speakVoiceResponse(window as never, "chat-2", "Segunda respuesta.");
    expect(audioDucking.begin).toHaveBeenCalledOnce();
    expect(audioDucking.end).not.toHaveBeenCalled();
    expect(invoke(VOICE_DUCKING_END_CHANNEL, trustedEvent(window), { requestId: "chat-2", reason: "followup_expired" })).toBe(true);
    expect(audioDucking.end).toHaveBeenCalledOnce();
    expect(audioDucking.end).toHaveBeenCalledWith("chat-2", "followup_expired");
    expect(invoke(VOICE_DUCKING_END_CHANNEL, trustedEvent(window), { requestId: "chat-2", reason: "stop" })).toBe(false);
    expect(() => invoke(VOICE_DUCKING_END_CHANNEL, trustedEvent(window), { requestId: "chat-2", reason: "invalid" }))
      .toThrow("invalid_voice_ducking_end_request");
  });

  it("synthesizes only through the Main-owned speaker and emits request-correlated playback states", async () => {
    const window = createWindow("speech");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let nextTurnId = "";
    const speaker = {
      speak: vi.fn(async (text: string, options: { style: string; persist: boolean }) => {
        const event = { turnId: nextTurnId };
        listeners.get("voice.speaking")?.(event);
        listeners.get("voice.speech.completed")?.(event);
        expect(text).toBe("Hola, soy Nexa. Mirá la guía y este sitio web.");
        expect(options).toEqual({ style: "normal", persist: false });
        return { completed: true as const };
      }),
      cancel: vi.fn(() => true),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener);
        return () => listeners.delete(type);
      }),
    };
    let idFactory = () => "";
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => {
      idFactory = options.idFactory;
      return speaker;
    }) };
    speaker.speak.mockImplementation(async (text, options) => {
      nextTurnId = idFactory();
      const event = { turnId: nextTurnId };
      listeners.get("voice.speaking")?.(event);
      listeners.get("voice.playback.started")?.(event);
      listeners.get("voice.speech.completed")?.(event);
      expect(text).toBe("Hola, soy Nexa. Mirá la guía y este sitio web.");
      expect(options).toEqual({ style: "normal", persist: false });
      return { completed: true as const };
    });
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never);

    await speakVoiceResponse(window as never, "00000000-0000-4000-8000-000000000051",
      "Hola, soy Nexa. Mirá [la guía](https://example.com/guia) y https://example.org/?x=1.");

    expect(api.createVoiceSpeaker).toHaveBeenCalledOnce();
    expect(speaker.speak).toHaveBeenCalledOnce();
    expect(window.webContents.send.mock.calls.map(([, payload]) => payload)).toEqual([
      { requestId: "00000000-0000-4000-8000-000000000051", state: "preparing" },
      { requestId: "00000000-0000-4000-8000-000000000051", state: "speaking" },
      { requestId: "00000000-0000-4000-8000-000000000051", state: "completed" },
    ]);
    expect(cancelVoiceSpeech(window as never, "user", "00000000-0000-4000-8000-000000000051")).toBe(false);
  });

  it("records response-to-synthesis, audio-ready, and playback intervals without response content", async () => {
    const window = createWindow("speech-timing");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let idFactory = () => "";
    const speaker = {
      speak: vi.fn(async () => {
        const event = { turnId: idFactory(), diagnostics: { metrics: { synthesisMs: 11, identityProcessingMs: 17 } } };
        listeners.get("voice.speaking")?.(event);
        listeners.get("voice.playback.started")?.({ ...event, diagnostics: { durationMs: 2 } });
        listeners.get("voice.speech.completed")?.(event);
        return { completed: true as const };
      }),
      cancel: vi.fn(() => true),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener);
        return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => { idFactory = options.idFactory; return speaker; }) };
    const diagnostics: Array<Record<string, unknown>> = [];
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never,
      (event) => diagnostics.push(event as unknown as Record<string, unknown>));
    const requestId = "00000000-0000-4000-8000-000000000057";
    await speakVoiceResponse(window as never, requestId, "Respuesta de prueba");
    markVoiceResponseDispatched(requestId);
    const timing = diagnostics.find((event) => event.state === "success" && event.stage === "playback"
      && typeof (event.metrics as Record<string, unknown> | undefined)?.responseDispatchToPlaybackMs === "number");
    expect(timing?.metrics).toMatchObject({
      responseDispatchToPlaybackMs: expect.any(Number),
      responseDispatchToAudioReadyMs: expect.any(Number),
      audioReadyToPlaybackMs: expect.any(Number),
    });
    expect(diagnostics.at(-1)?.state).toBe("success");
    expect(diagnostics.at(-1)?.metrics).toMatchObject({
      responseDispatchToPlaybackMs: expect.any(Number),
      responseDispatchToSynthesisMs: expect.any(Number),
      responseDispatchToAudioReadyMs: expect.any(Number),
      audioReadyToPlaybackMs: expect.any(Number),
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Respuesta de prueba");
  });

  it("retains completion timing when response dispatch is marked before playback events", async () => {
    const window = createWindow("speech-timing-dispatch-first");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let idFactory = () => "";
    const speaker = {
      speak: vi.fn(async () => {
        const turnId = idFactory();
        markVoiceResponseDispatched(turnId);
        const event = { turnId, diagnostics: { metrics: { synthesisMs: 9 } } };
        listeners.get("voice.speaking")?.(event);
        listeners.get("voice.playback.started")?.({ ...event, diagnostics: { durationMs: 2 } });
        listeners.get("voice.speech.completed")?.(event);
        return { completed: true as const };
      }),
      cancel: vi.fn(() => true),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener);
        return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => { idFactory = options.idFactory; return speaker; }) };
    const diagnostics: Array<Record<string, unknown>> = [];
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never,
      (event) => diagnostics.push(event as unknown as Record<string, unknown>));
    const requestId = "00000000-0000-4000-8000-000000000058";
    await speakVoiceResponse(window as never, requestId, "Otra respuesta de prueba");
    expect(diagnostics.at(-1)?.state).toBe("success");
    expect(diagnostics.at(-1)?.metrics).toMatchObject({
      responseDispatchToPlaybackMs: expect.any(Number),
      responseDispatchToAudioReadyMs: expect.any(Number),
      audioReadyToPlaybackMs: expect.any(Number),
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Otra respuesta de prueba");
  });

  it("remembers Stop received before the response speaker initializes and discards that late response", async () => {
    const window = createWindow("stop-before-speech-owner");
    const speaker = {
      speakPrepared: vi.fn(async () => ({ completed: true as const })),
      speak: vi.fn(async () => ({ completed: true as const })), cancel: vi.fn(() => true),
      on: vi.fn(() => () => undefined),
    };
    const api = { createVoiceSpeaker: vi.fn(() => speaker) };
    const prepare = vi.fn(async () => ({ audio: makeAudio() }));
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never,
      undefined, async () => makeAudio(), prepare);
    const requestId = "00000000-0000-4000-8000-000000000053";

    expect(cancelVoiceSpeech(window as never, "user", requestId)).toBe(true);
    await speakVoiceResponse(window as never, requestId, "No debe sonar después de Stop");

    expect(prepare).not.toHaveBeenCalled();
    expect(speaker.speakPrepared).not.toHaveBeenCalled();
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL, { requestId, state: "cancelled" });
  });

  it("cancels only the active correlated speech request", async () => {
    const window = createWindow("speech-cancel");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let finishSpeech: ((value: null) => void) | undefined;
    let turnId = "";
    let idFactory = () => "";
    const speaker = {
      speak: vi.fn(() => {
        turnId = idFactory();
        return new Promise<null>((resolve) => { finishSpeech = resolve; });
      }),
      cancel: vi.fn(() => {
        listeners.get("voice.speech.cancelled")?.({ turnId });
        finishSpeech?.(null);
        return true;
      }),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener);
        return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => {
      idFactory = options.idFactory;
      return speaker;
    }) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never);
    const requestId = "00000000-0000-4000-8000-000000000052";
    const operation = speakVoiceResponse(window as never, requestId, "Respuesta.");
    await vi.waitFor(() => expect(speaker.speak).toHaveBeenCalledOnce());

    expect(cancelVoiceSpeech(window as never, "user", "00000000-0000-4000-8000-000000000099")).toBe(false);
    expect(cancelVoiceSpeech(window as never, "user", requestId)).toBe(true);
    expect(speaker.cancel).toHaveBeenCalledWith("user");
    expect(window.webContents.send).toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL, { requestId, state: "preparing" });
    await operation;
  });

  it("uses the cached acknowledgement asset and gives the final response priority without overlap", async () => {
    const window = createWindow("acknowledgement");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const order: string[] = [];
    let idFactory = () => "";
    let playbackState = "idle";
    let currentTurnId = "";
    let finishAcknowledgement: (() => void) | undefined;
    const speaker = {
      getPlaybackState: () => playbackState,
      speakPrepared: vi.fn(() => {
        currentTurnId = idFactory(); playbackState = "playing"; order.push("ack-started");
        listeners.get("voice.speaking")?.({ turnId: currentTurnId });
        return new Promise<null>((resolve) => { finishAcknowledgement = () => { playbackState = "idle";
          listeners.get("voice.speech.cancelled")?.({ turnId: currentTurnId, reason: "superseded" }); resolve(null); }; });
      }),
      speak: vi.fn(async () => {
        currentTurnId = idFactory();
        expect(playbackState).toBe("idle");
        order.push("response-started");
        listeners.get("voice.speech.completed")?.({ turnId: currentTurnId });
        return { completed: true as const };
      }),
      cancel: vi.fn(() => { order.push("ack-stopped"); finishAcknowledgement?.(); return true; }),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener); return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn(() => speaker) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never, undefined, async () => makeAudio());
    const requestId = "00000000-0000-4000-8000-000000000073";
    await expect(invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, trustedEvent(window), { requestId }))
      .resolves.toEqual({ ok: true, requestId, accepted: true });
    await vi.waitFor(() => expect(speaker.speakPrepared).toHaveBeenCalledOnce());
    await speakVoiceResponse(window as never, requestId, "Respuesta principal");
    expect(order).toEqual(["ack-started", "ack-stopped", "response-started"]);
    expect(speaker.speak).toHaveBeenCalledOnce();
  });

  it.each(["quick time-tool result", "quick Spotify action"])(
    "does not signal follow-up completion when a %s acknowledgement ends before final response preparation",
    async () => {
      const window = createWindow("quick-ack-response");
      const listeners = new Map<string, (event: Record<string, unknown>) => void>();
      let idFactory = () => "";
      let turnId = "";
      let playbackState = "idle";
      let finishAcknowledgement: (() => void) | undefined;
      const speaker = {
        getPlaybackState: () => playbackState,
        speakPrepared: vi.fn(() => {
          turnId = idFactory();
          playbackState = "playing";
          return new Promise<null>((resolve) => {
            finishAcknowledgement = () => {
              playbackState = "idle";
              listeners.get("voice.speech.completed")?.({ turnId });
              resolve(null);
            };
          });
        }),
        speak: vi.fn(async () => {
          turnId = idFactory();
          listeners.get("voice.speaking")?.({ turnId });
          listeners.get("voice.playback.started")?.({ turnId });
          listeners.get("voice.speech.completed")?.({ turnId });
          return { completed: true as const };
        }),
        cancel: vi.fn(() => { playbackState = "idle"; finishAcknowledgement?.(); return true; }),
        on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
          listeners.set(type, listener); return () => listeners.delete(type);
        }),
      };
      const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => {
        idFactory = options.idFactory; return speaker;
      }) };
      registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never,
        undefined, async () => makeAudio());
      const requestId = "00000000-0000-4000-8000-000000000074";
      await invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, trustedEvent(window), { requestId });
      await vi.waitFor(() => expect(speaker.speakPrepared).toHaveBeenCalledOnce());

      finishAcknowledgement?.();
      expect(window.webContents.send.mock.calls.map(([, payload]) => payload))
        .not.toContainEqual({ requestId, state: "completed" });

      await speakVoiceResponse(window as never, requestId, "Respuesta final del proveedor");
      expect(window.webContents.send.mock.calls.map(([, payload]) => payload)
        .filter((payload) => payload && typeof payload === "object" && "state" in payload && payload.state === "completed"))
        .toHaveLength(1);
    },
  );

  it("prepares the main response while a cached acknowledgement plays, then stops it before confirmed response playback", async () => {
    const window = createWindow("ack-during-tts");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const order: string[] = [];
    let idFactory = () => "";
    let playing = false;
    let finishAcknowledgement: (() => void) | undefined;
    let resolvePrepared!: (value: { audio: Uint8Array }) => void;
    const preparation = new Promise<{ audio: Uint8Array }>((resolve) => { resolvePrepared = resolve; });
    const speaker = {
      getPlaybackState: () => playing ? "playing" : "idle",
      speakPrepared: vi.fn((audio: Uint8Array) => {
        const turnId = idFactory();
        if (order.length === 0) {
          playing = true; order.push("ack-started");
          listeners.get("voice.speaking")?.({ turnId });
          return new Promise<null>((resolve) => { finishAcknowledgement = () => {
            playing = false; listeners.get("voice.speech.cancelled")?.({ turnId, reason: "superseded" }); resolve(null);
          }; });
        }
        expect(playing).toBe(false);
        expect(audio.byteLength).toBeGreaterThan(0);
        order.push("response-started");
        listeners.get("voice.speaking")?.({ turnId });
        listeners.get("voice.playback.started")?.({ turnId });
        listeners.get("voice.speech.completed")?.({ turnId });
        return Promise.resolve({ completed: true as const });
      }),
      speak: vi.fn(),
      cancel: vi.fn(() => { order.push("ack-stopped"); finishAcknowledgement?.(); return true; }),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener); return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => { idFactory = options.idFactory; return speaker; }) };
    const prepareResponse = vi.fn(async (_text: string, _signal: AbortSignal) => preparation);
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never, undefined,
      async () => makeAudio(), prepareResponse);
    const requestId = "00000000-0000-4000-8000-000000000077";
    await expect(invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, trustedEvent(window), { requestId }))
      .resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(speaker.speakPrepared).toHaveBeenCalledOnce());

    const response = speakVoiceResponse(window as never, requestId, "Respuesta extensa lista para voz");
    await vi.waitFor(() => expect(prepareResponse).toHaveBeenCalledOnce());
    const duplicateResponse = speakVoiceResponse(window as never, requestId, "Respuesta duplicada que no debe sintetizarse");
    await Promise.resolve();
    expect(prepareResponse).toHaveBeenCalledOnce();
    expect(playing).toBe(true);
    expect(order).toEqual(["ack-started"]);
    resolvePrepared({ audio: makeAudio() });
    await Promise.all([response, duplicateResponse]);

    expect(order).toEqual(["ack-started", "ack-stopped", "response-started"]);
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL,
      { requestId, state: "speaking" });
    expect(window.webContents.send.mock.calls.map(([, payload]) => payload))
      .not.toContainEqual({ requestId, state: "error", error: { code: "voice_audio_processing_failed" } });
  });

  it("keeps the request active when the acknowledgement ends before response synthesis, so Stop remains effective", async () => {
    const window = createWindow("ack-ends-during-tts");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let idFactory = () => "";
    let finishAcknowledgement: (() => void) | undefined;
    let playbackState = "idle";
    let resolvePrepared!: (value: { audio: Uint8Array }) => void;
    let responseSignal: AbortSignal | undefined;
    const responseAudio = new Promise<{ audio: Uint8Array }>((resolve) => { resolvePrepared = resolve; });
    const speaker = {
      getPlaybackState: vi.fn(() => playbackState),
      speakPrepared: vi.fn(() => {
        playbackState = "playing";
        const turnId = idFactory();
        return new Promise<null>((resolve) => { finishAcknowledgement = () => {
          playbackState = "idle"; listeners.get("voice.speech.completed")?.({ turnId }); resolve(null);
        }; });
      }),
      speak: vi.fn(), cancel: vi.fn(() => { playbackState = "idle"; finishAcknowledgement?.(); return true; }),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener); return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => { idFactory = options.idFactory; return speaker; }) };
    const prepareResponse = vi.fn((_text: string, signal: AbortSignal) => { responseSignal = signal; return responseAudio; });
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never,
      undefined, async () => makeAudio(), prepareResponse);
    const requestId = "00000000-0000-4000-8000-000000000080";
    await invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, trustedEvent(window), { requestId });
    await vi.waitFor(() => expect(speaker.speakPrepared).toHaveBeenCalledOnce());
    const response = speakVoiceResponse(window as never, requestId, "Respuesta principal");
    await vi.waitFor(() => expect(prepareResponse).toHaveBeenCalledOnce());

    finishAcknowledgement?.();
    expect(window.webContents.send).not.toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL, { requestId, state: "completed" });
    expect(cancelVoiceSpeech(window as never, "user", requestId)).toBe(true);
    expect(responseSignal?.aborted).toBe(true);
    resolvePrepared({ audio: makeAudio() });
    await response;
    expect(speaker.speakPrepared).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL, { requestId, state: "cancelled" });
  });

  it("reports a real response-processing failure after stopping its acknowledgement, without playing audio", async () => {
    const window = createWindow("ack-then-real-error");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let idFactory = () => "";
    let finishAcknowledgement: (() => void) | undefined;
    let playbackState = "idle";
    const speaker = {
      getPlaybackState: vi.fn(() => playbackState),
      speakPrepared: vi.fn(() => {
        playbackState = "playing";
        const turnId = idFactory();
        return new Promise<null>((resolve) => { finishAcknowledgement = () => {
          listeners.get("voice.speech.cancelled")?.({ turnId, reason: "superseded" }); resolve(null);
        }; });
      }),
      speak: vi.fn(), cancel: vi.fn(() => { playbackState = "idle"; finishAcknowledgement?.(); return true; }),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener); return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => { idFactory = options.idFactory; return speaker; }) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never,
      undefined, async () => makeAudio(), async () => ({ audio: null, errorCode: "voice_audio_processing_failed" }));
    const requestId = "00000000-0000-4000-8000-000000000081";
    await invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, trustedEvent(window), { requestId });
    await vi.waitFor(() => expect(speaker.speakPrepared).toHaveBeenCalledOnce());
    await speakVoiceResponse(window as never, requestId, "Respuesta que falla al procesar");

    expect(speaker.speakPrepared).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL,
      { requestId, state: "error", error: { code: "voice_audio_processing_failed" } });
    expect(window.webContents.send).not.toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL,
      { requestId, state: "cancelled" });
  });

  it("aborts response preparation on Stop, discards late audio, and accepts the next response", async () => {
    const window = createWindow("response-stop-during-tts");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const speaker = {
      speakPrepared: vi.fn(async () => ({ completed: true as const })),
      speak: vi.fn(), cancel: vi.fn(() => true),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener); return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => speaker) };
    let resolveFirst!: (value: { audio: Uint8Array | null; errorCode?: string }) => void;
    let firstSignal: AbortSignal | undefined;
    const prepare = vi.fn((_text: string, signal: AbortSignal) => {
      if (prepare.mock.calls.length === 1) {
        firstSignal = signal;
        return new Promise<{ audio: Uint8Array | null; errorCode?: string }>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ audio: makeAudio() });
    });
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never,
      undefined, async () => makeAudio(), prepare);
    const firstId = "00000000-0000-4000-8000-000000000078";
    const firstResponse = speakVoiceResponse(window as never, firstId, "Se cancela");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(cancelVoiceSpeech(window as never, "user", firstId)).toBe(true);
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst({ audio: null, errorCode: "voice_audio_processing_failed" });
    await firstResponse;
    expect(speaker.speakPrepared).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalledWith(VOICE_SPEECH_EVENT_CHANNEL,
      { requestId: firstId, state: "error", error: { code: "voice_audio_processing_failed" } });

    await speakVoiceResponse(window as never, "00000000-0000-4000-8000-000000000079", "Nueva respuesta");
    expect(speaker.speakPrepared).toHaveBeenCalledOnce();
  });

  it("Stop during local acknowledgement loading prevents both late acknowledgement and reply audio", async () => {
    const window = createWindow("ack-stop-loading");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let resolveAudio!: (value: Uint8Array) => void;
    const speaker = {
      speakPrepared: vi.fn(async () => ({ completed: true as const })),
      speak: vi.fn(async () => ({ completed: true as const })),
      cancel: vi.fn(() => true),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener); return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn(() => speaker) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never, undefined,
      () => new Promise((resolve) => { resolveAudio = resolve; }));
    const requestId = "00000000-0000-4000-8000-000000000074";
    const acknowledgement = invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, trustedEvent(window), { requestId });
    await vi.waitFor(() => expect(resolveAudio).toBeTypeOf("function"));
    expect(cancelVoiceSpeech(window as never, "user", requestId)).toBe(true);
    resolveAudio(makeAudio());
    await expect(acknowledgement).resolves.toEqual({ ok: true, requestId, accepted: false });
    await speakVoiceResponse(window as never, requestId, "No debe sonar después de Stop");
    expect(speaker.speakPrepared).not.toHaveBeenCalled();
    expect(speaker.speak).not.toHaveBeenCalled();
  });

  it("Stop interrupts an acknowledgement, suppresses its late reply, and allows a fresh request", async () => {
    const window = createWindow("ack-stop-playing");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    let idFactory = () => "";
    let turnId = "";
    let finishPlayback: (() => void) | undefined;
    let playbackState = "idle";
    const speaker = {
      getPlaybackState: () => playbackState,
      speakPrepared: vi.fn(() => {
        turnId = idFactory(); playbackState = "playing";
        listeners.get("voice.speaking")?.({ turnId });
        return new Promise<null>((resolve) => { finishPlayback = () => { playbackState = "idle";
          listeners.get("voice.speech.cancelled")?.({ turnId, reason: "user" }); resolve(null); }; });
      }),
      speak: vi.fn(async () => {
        turnId = idFactory();
        listeners.get("voice.speech.completed")?.({ turnId });
        return { completed: true as const };
      }),
      cancel: vi.fn(() => { finishPlayback?.(); return true; }),
      on: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener); return () => listeners.delete(type);
      }),
    };
    const api = { createVoiceSpeaker: vi.fn((options: { idFactory: () => string }) => { idFactory = options.idFactory; return speaker; }) };
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, async () => api as never, undefined, async () => makeAudio());
    const requestId = "00000000-0000-4000-8000-000000000075";
    await invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, trustedEvent(window), { requestId });
    await vi.waitFor(() => expect(speaker.speakPrepared).toHaveBeenCalledOnce());
    expect(invoke(VOICE_SPEECH_CANCEL_CHANNEL, trustedEvent(window), { requestId }))
      .toEqual({ ok: true, requestId, cancelled: true });
    await speakVoiceResponse(window as never, requestId, "No debe hablarse tras Stop");
    expect(speaker.speak).not.toHaveBeenCalled();
    await speakVoiceResponse(window as never, "00000000-0000-4000-8000-000000000076", "Nueva solicitud");
    expect(speaker.speak).toHaveBeenCalledOnce();
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
    await expect(handler({ sender: window.webContents, senderFrame: { url: "http://127.0.0.1:5173/" } }, { requestId: "wrong-origin" }))
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

  it("retires and blocks a replaced renderer, then unlocks only after the trusted document commits", async () => {
    const window = createWindow("one"); const voice = register(window);
    registerVoiceWindowNavigation(window as never, RENDERER_URL);
    registerVoiceWindowNavigation(window as never, RENDERER_URL);
    expect(window.webContents.on.mock.calls.filter(([name]) =>
      name === "did-start-navigation" || name === "did-navigate")).toHaveLength(2);

    const started = await startSession(window, "start-before-reload");
    finish(window, started.sessionId!, "finish-before-reload");
    window.emitWebContents("did-start-navigation", {
      url: RENDERER_URL, isMainFrame: true, isSameDocument: false,
    });
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
    expect(voice.controllers[0].unsubscribe).toHaveBeenCalledOnce();
    await expect(invoke(VOICE_PTT_START_CHANNEL, trustedEvent(window), { requestId: "stale-start" }))
      .rejects.toThrow("untrusted_voice_ipc_sender");

    window.emitWebContents("did-navigate", {}, RENDERER_URL + "/unexpected");
    await expect(invoke(VOICE_PTT_START_CHANNEL, trustedEvent(window), { requestId: "still-blocked" }))
      .rejects.toThrow("untrusted_voice_ipc_sender");

    window.emitWebContents("did-navigate", {}, RENDERER_URL + "/");
    const replacement = await startSession(window, "start-after-reload");
    expect(replacement.ok).toBe(true);
    expect(replacement.sessionId).not.toBe(started.sessionId);
  });

  it("does not retire a session for in-page navigation or a subframe navigation", async () => {
    const window = createWindow("one"); const voice = register(window);
    registerVoiceWindowNavigation(window as never, RENDERER_URL);
    const started = await startSession(window);
    window.emitWebContents("did-start-navigation", {
      url: RENDERER_URL + "/#section", isMainFrame: true, isSameDocument: true,
    });
    window.emitWebContents("did-start-navigation", {
      url: "http://127.0.0.1:5174/child", isMainFrame: false, isSameDocument: false,
    });

    expect(voice.controllers[0].end).not.toHaveBeenCalled();
    expect(await startSession(window, "duplicate")).toMatchObject({
      ok: false, error: { code: "request_conflict" },
    });
    expect(started.ok).toBe(true);
  });

  it("aborts STT on reload and suppresses late completion without affecting another window", async () => {
    const firstWindow = createWindow("first");
    const secondWindow = createWindow("second");
    const voice = makeVoiceFactory();
    let currentWindow = firstWindow;
    registerVoiceIpcHandlers(() => currentWindow as never, RENDERER_URL, async () => voice as never);
    registerVoiceWindowNavigation(firstWindow as never, RENDERER_URL);
    registerVoiceWindowNavigation(secondWindow as never, RENDERER_URL);

    const first = await startSession(firstWindow, "start-first");
    finish(firstWindow, first.sessionId!, "finish-first");
    currentWindow = secondWindow;
    const second = await startSession(secondWindow, "start-second");
    finish(secondWindow, second.sessionId!, "finish-second");

    firstWindow.emitWebContents("did-start-navigation", {
      url: RENDERER_URL, isMainFrame: true, isSameDocument: false,
    });
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();
    expect(voice.controllers[0].cancel).toHaveBeenCalledWith("session_ended");
    expect(voice.controllers[1].end).not.toHaveBeenCalled();
    const firstEventCount = firstWindow.webContents.send.mock.calls.length;
    voice.controllers[0].resolvePending({ sessionId: first.sessionId, turnId: "turn-1", text: "late", language: "es" });
    await Promise.resolve(); await Promise.resolve();
    expect(firstWindow.webContents.send).toHaveBeenCalledTimes(firstEventCount);

    secondWindow.emitWebContents("did-start-navigation", {
      url: RENDERER_URL, isMainFrame: true, isSameDocument: false,
    });
    expect(voice.controllers[1].end).toHaveBeenCalledOnce();
  });

  it("blocks a start whose Voice API load resolves after navigation begins", async () => {
    const window = createWindow("one");
    const voice = makeVoiceFactory();
    let resolveVoice!: (value: typeof voice) => void;
    const voiceApi = new Promise<typeof voice>((resolve) => { resolveVoice = resolve; });
    registerVoiceIpcHandlers(() => window as never, RENDERER_URL, () => voiceApi as never);
    registerVoiceWindowNavigation(window as never, RENDERER_URL);

    const pendingStart = invoke(VOICE_PTT_START_CHANNEL, trustedEvent(window), { requestId: "start-racing" });
    window.emitWebContents("did-start-navigation", {
      url: RENDERER_URL, isMainFrame: true, isSameDocument: false,
    });
    resolveVoice(voice);
    await expect(pendingStart).resolves.toMatchObject({
      ok: false, requestId: "start-racing", error: { code: "session_unavailable" },
    });
    expect(voice.createPttVoiceController).not.toHaveBeenCalled();

    window.emitWebContents("did-navigate", {}, RENDERER_URL + "/");
    expect(await startSession(window, "start-after-race")).toMatchObject({ ok: true });
  });

  it("handles cancellation and navigation in either order without retiring twice", async () => {
    const window = createWindow("one"); const voice = register(window);
    registerVoiceWindowNavigation(window as never, RENDERER_URL);
    const first = await startSession(window, "start-cancel-first");
    const cancelResult = invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-first", sessionId: first.sessionId, targetRequestId: "start-cancel-first",
    });
    window.emitWebContents("did-start-navigation", {
      url: RENDERER_URL, isMainFrame: true, isSameDocument: false,
    });
    expect(cancelResult).toMatchObject({ ok: true });
    expect(voice.controllers[0].end).toHaveBeenCalledOnce();

    window.emitWebContents("did-navigate", {}, RENDERER_URL + "/");
    const second = await startSession(window, "start-navigation-first");
    window.emitWebContents("did-start-navigation", {
      url: RENDERER_URL, isMainFrame: true, isSameDocument: false,
    });
    await expect(Promise.resolve().then(() => invoke(VOICE_PTT_CANCEL_CHANNEL, trustedEvent(window), {
      requestId: "cancel-too-late", sessionId: second.sessionId, targetRequestId: "start-navigation-first",
    }))).rejects.toThrow("untrusted_voice_ipc_sender");
    expect(voice.controllers[1].end).toHaveBeenCalledOnce();
  });

  it("grants microphone permission only to the trusted main frame and denies video or other origins", () => {
    const window = createWindow("one");
    const otherWindow = createWindow("two");
    const permissionSession = {
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    };
    registerVoiceMicrophonePermissions(permissionSession as never, () => window as never, RENDERER_URL);
    const check = permissionSession.setPermissionCheckHandler.mock.calls[0][0] as (...args: unknown[]) => boolean;
    const request = permissionSession.setPermissionRequestHandler.mock.calls[0][0] as (...args: unknown[]) => void;
    const requestResult = (webContents: unknown, permission: string, details: unknown) => {
      const callback = vi.fn();
      request(webContents, permission, callback, details);
      return callback.mock.lastCall?.[0];
    };
    expect(check(window.webContents, "media", RENDERER_URL, {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaType: "audio",
    })).toBe(true);
    expect(check(window.webContents, "media", `${RENDERER_URL}/`, {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, securityOrigin: `${RENDERER_URL}/`, mediaType: "audio",
    })).toBe(true);
    expect(check(window.webContents, "media", "http://127.0.0.1:5173", {
      isMainFrame: true, requestingUrl: "http://127.0.0.1:5173/", mediaType: "audio",
    })).toBe(false);
    expect(check(window.webContents, "media", RENDERER_URL, {
      isMainFrame: false, requestingUrl: `${RENDERER_URL}/`, mediaType: "audio",
    })).toBe(false);

    expect(check(window.webContents, "media", RENDERER_URL, {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`,
      securityOrigin: "http://127.0.0.1:5173", mediaType: "audio",
    })).toBe(false);
    for (const requestingOrigin of [
      "http://localhost:5174", "https://127.0.0.1:5174", "http://127.0.0.1:5173",
      "http://example.invalid:5174", "null", "not an origin", "http://user:pass@127.0.0.1:5174",
      "http://127.0.0.1:5174/extra", "http://127.0.0.1:5174/?query", "http://127.0.0.1:5174/#fragment",
      "http://127.0.0.1:5174/?", "http://127.0.0.1:5174/#",
    ]) {
      expect(check(window.webContents, "media", requestingOrigin, {
        isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaType: "audio",
      }), requestingOrigin).toBe(false);
    }

    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaTypes: ["audio"],
    })).toBe(true);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, securityOrigin: RENDERER_URL, mediaTypes: ["audio"],
    })).toBe(true);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, securityOrigin: `${RENDERER_URL}/`, mediaTypes: ["audio"],
    })).toBe(true);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, securityOrigin: "http://127.0.0.1:5173", mediaTypes: ["audio"],
    })).toBe(false);
    for (const securityOrigin of [
      "http://localhost:5174", "https://127.0.0.1:5174", "http://127.0.0.1:5173",
      "http://example.invalid:5174", "null", "not an origin", "http://user:pass@127.0.0.1:5174",
      "http://127.0.0.1:5174/extra", "http://127.0.0.1:5174/?query", "http://127.0.0.1:5174/#fragment",
      "http://127.0.0.1:5174/?", "http://127.0.0.1:5174/#",
    ]) {
      expect(requestResult(window.webContents, "media", {
        isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, securityOrigin, mediaTypes: ["audio"],
      }), securityOrigin).toBe(false);
    }
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: "http://127.0.0.1:5173/", mediaTypes: ["audio"],
    })).toBe(false);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/unexpected`, mediaTypes: ["audio"],
    })).toBe(false);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: "http://[invalid", mediaTypes: ["audio"],
    })).toBe(false);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, mediaTypes: ["audio"],
    })).toBe(false);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: false, requestingUrl: `${RENDERER_URL}/`, mediaTypes: ["audio"],
    })).toBe(false);
    expect(requestResult(otherWindow.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaTypes: ["audio"],
    })).toBe(false);
    expect(requestResult(window.webContents, "camera", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaTypes: ["audio"],
    })).toBe(false);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaTypes: ["video"],
    })).toBe(false);
    expect(requestResult(window.webContents, "media", {
      isMainFrame: true, requestingUrl: `${RENDERER_URL}/`, mediaTypes: ["audio", "video"],
    })).toBe(false);
  });

});
