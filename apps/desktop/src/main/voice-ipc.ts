import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import {
  VOICE_EVENT_CHANNEL,
  VOICE_SPEECH_CANCEL_CHANNEL,
  VOICE_SPEECH_EVENT_CHANNEL,
  VOICE_PTT_CANCEL_CHANNEL,
  VOICE_PTT_FINISH_CHANNEL,
  VOICE_PTT_START_CHANNEL,
  type VoiceEventEnvelope,
  type VoiceIpcErrorCode,
  type VoicePttEvent,
  type VoicePttFinishRequest,
  type VoicePttStartRequest,
  type VoiceSpeechEvent,
  type VoiceSpeechErrorCode,
} from "../shared/ipc-contract.js";
import {
  isVoiceEventEnvelope,
  isVoiceId,
  isVoicePttCancelRequest,
  isVoicePttFinishRequest,
  isVoicePttStartRequest,
  isVoiceSpeechCancelRequest,
  isVoiceSpeechEvent,
} from "../shared/voice-ipc-validation.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export interface VoiceRecognizer {
  transcribe(input: { audio: Buffer; format: string; language?: string; signal: AbortSignal }): Promise<{
    text: string;
    language: string | null;
  }>;
}

export interface VoicePttController {
  start(): { sessionId: string };
  transcribe(input: { audio: Uint8Array; format: "wav"; language?: string }): Promise<{
    sessionId: string;
    turnId: string;
    text: string;
    language: string | null;
  } | null>;
  cancel(reason?: "user" | "superseded" | "session_ended" | "timeout"): boolean;
  end(): void;
  subscribe(listener: (event: object) => void): () => void;
}

export interface PublicVoiceApi {
  createSpeechRecognizer(): VoiceRecognizer;
  createPttVoiceController(options: { recognizer: VoiceRecognizer }): VoicePttController;
  createVoiceSpeaker(options?: { idFactory?: () => string; speechService?: {
    generate(input: { text: string; style?: string; persist?: boolean }): Promise<unknown>;
    play(audioId: string, options?: { playbackId?: string }): Promise<unknown>;
    stopPlayback(playbackId: string): Promise<unknown>;
    removeTemporary(audioId: string): Promise<boolean>;
  } }): VoiceSpeakerController;
}

export interface VoiceSpeakerController {
  speak(text: string, options?: { style?: string; persist?: boolean }): Promise<{ completed: true } | null>;
  cancel(reason?: "user" | "superseded" | "session_ended"): boolean;
  on(type: string, listener: (event: Record<string, unknown>) => void): () => void;
}

interface VoiceIpcWindow extends BrowserWindow {
  isDestroyed(): boolean;
}

interface ActiveVoiceSession {
  window: VoiceIpcWindow;
  controller: VoicePttController;
  unsubscribe: () => void;
  startRequestId: string;
  sessionId: string;
  finishRequestId: string | null;
  turnRequestIds: Map<string, string>;
  eventRequestIdOverride: string | null;
  transcriptionStartedAt: number | null;
  cancelled: boolean;
  retired: boolean;
}

type LoadPublicVoiceApi = () => Promise<PublicVoiceApi>;

const activeSessions = new WeakMap<VoiceIpcWindow, ActiveVoiceSession>();
interface VoiceSpeechOwner {
  window: VoiceIpcWindow;
  speaker: VoiceSpeakerController;
  activeRequestId: string | null;
  nextTurnId: string | null;
  unsubscribe: Array<() => void>;
}
const speechOwners = new Map<VoiceIpcWindow, VoiceSpeechOwner>();
const pendingSpeechOwners = new WeakMap<VoiceIpcWindow, Promise<VoiceSpeechOwner>>();
const navigatingWindows = new WeakSet<VoiceIpcWindow>();
const navigationHooks = new WeakSet<VoiceIpcWindow>();
type VoiceDiagnosticEvent = { requestId: string; stage: string; state: string; errorCode?: string; durationMs?: number | null;
  cancellation?: string; metrics?: Record<string, unknown> | null };
let recordVoiceDiagnostic: ((event: VoiceDiagnosticEvent) => void) | null = null;
function recordVoice(event: VoiceDiagnosticEvent): void {
  try { recordVoiceDiagnostic?.(event); } catch { /* Diagnostics never affect Voice. */ }
}
const perWindowSequence = new WeakMap<VoiceIpcWindow, number>();
let cachedVoiceApi: Promise<PublicVoiceApi> | null = null;

function errorResponse(requestId: string, code: VoiceIpcErrorCode, message: string) {
  return { ok: false as const, requestId, error: { code, message } };
}

function isTrustedRendererUrl(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return actual.protocol === expected.protocol && actual.host === expected.host
      && actual.pathname === expected.pathname && actual.search === "" && actual.hash === ""
      && actual.username === "" && actual.password === "";
  } catch {
    return false;
  }
}

function isTrustedVoiceSender(
  event: IpcMainInvokeEvent,
  window: VoiceIpcWindow | null,
  expectedRendererUrl: string,
): window is VoiceIpcWindow {
  return Boolean(window && !window.isDestroyed() && !navigatingWindows.has(window)
    && isTrustedIpcSender(event, window)
    && event.senderFrame && isTrustedRendererUrl(event.senderFrame.url, expectedRendererUrl));
}

function nextSequence(window: VoiceIpcWindow): number {
  const sequence = (perWindowSequence.get(window) ?? 0) + 1;
  perWindowSequence.set(window, sequence);
  return sequence;
}

function sendVoiceEvent(state: ActiveVoiceSession, sourceEvent: VoicePttEvent): void {
  if (state.retired || state.window.isDestroyed()) return;
  if (state.cancelled && sourceEvent.type !== "voice.cancelled" && sourceEvent.type !== "voice.session.ended") return;

  let requestId: string | undefined;
  if (sourceEvent.type === "voice.session.started") requestId = state.startRequestId;
  else if (sourceEvent.type === "voice.session.ended" || sourceEvent.type === "voice.cancelled") {
    requestId = state.eventRequestIdOverride
      ?? (sourceEvent.turnId ? state.turnRequestIds.get(sourceEvent.turnId) : undefined)
      ?? state.finishRequestId ?? state.startRequestId;
  } else {
    if (sourceEvent.type === "voice.transcribing") {
      if (!state.finishRequestId) return;
      state.turnRequestIds.set(sourceEvent.turnId, state.finishRequestId);
    }
    requestId = sourceEvent.turnId ? state.turnRequestIds.get(sourceEvent.turnId) : undefined;
  }
  if (!requestId) return;

  const envelope: VoiceEventEnvelope = {
    requestId,
    sessionId: sourceEvent.sessionId,
    sequence: nextSequence(state.window),
    ...(sourceEvent.turnId === null ? {} : { turnId: sourceEvent.turnId }),
    event: sourceEvent,
  };
  if (isVoiceEventEnvelope(envelope)) {
    try { state.window.webContents.send(VOICE_EVENT_CHANNEL, envelope); }
    catch { /* A destroyed or closing renderer must not interrupt Voice cleanup. */ }
  }
}

function retireSession(state: ActiveVoiceSession, requestId: string | null): void {
  if (state.retired) return;
  state.eventRequestIdOverride = requestId;
  try { state.controller.end(); }
  catch { /* Cleanup is best-effort; no session should survive its window. */ }
  finally {
    state.retired = true;
    try { state.unsubscribe(); }
    catch { /* A faulty listener cleanup must not retain the window session. */ }
    finally {
      if (activeSessions.get(state.window) === state) activeSessions.delete(state.window);
    }
  }
}

function getPublicVoiceApi(loadVoiceApi: LoadPublicVoiceApi): Promise<PublicVoiceApi> {
  if (!cachedVoiceApi) cachedVoiceApi = loadVoiceApi().catch((error) => {
    cachedVoiceApi = null;
    throw error;
  });
  return cachedVoiceApi;
}

function emitSpeechEvent(window: VoiceIpcWindow, event: VoiceSpeechEvent): void {
  if (window.isDestroyed() || !isVoiceSpeechEvent(event)) return;
  try { window.webContents.send(VOICE_SPEECH_EVENT_CHANNEL, event); }
  catch { /* Closing windows do not interrupt speech cleanup. */ }
}

function safeSpeechErrorCode(value: unknown): VoiceSpeechErrorCode {
  const allowed = new Set(["voice_speech_generation_failed", "voice_speech_playback_failed", "voice_speech_playback_timeout",
    "voice_speech_start_timeout", "voice_speech_stop_failed", "voice_speech_stop_timeout", "voice_speech_busy",
    "voice_speech_degraded", "voice_speech_too_long", "voice_audio_storage_unavailable", "voice_tts_generation_failed",
    "voice_tts_response_invalid", "voice_audio_processing_failed", "voice_audio_storage_failed", "voice_identity_browser_unavailable"]);
  return (typeof value === "string" && allowed.has(value) ? value : "voice_speech_playback_failed") as VoiceSpeechErrorCode;
}

async function getSpeechOwner(window: VoiceIpcWindow, loadVoiceApi: LoadPublicVoiceApi): Promise<VoiceSpeechOwner> {
  const current = speechOwners.get(window);
  if (current) return current;
  let pending = pendingSpeechOwners.get(window);
  if (!pending) {
    pending = getPublicVoiceApi(loadVoiceApi).then((voice) => {
      const owner: VoiceSpeechOwner = { window, speaker: undefined as unknown as VoiceSpeakerController,
        activeRequestId: null, nextTurnId: null, unsubscribe: [] };
      owner.speaker = voice.createVoiceSpeaker({ idFactory: () => owner.nextTurnId ?? randomUUID() });
      owner.unsubscribe = [
        owner.speaker.on("voice.speaking", (event) => {
          if (typeof event.turnId !== "string") return;
          emitSpeechEvent(window, { requestId: event.turnId, state: "speaking" });
          const details = event.diagnostics as Record<string, unknown> | undefined;
          recordVoice({ requestId: event.turnId, stage: "playback", state: "started",
            metrics: details?.metrics && typeof details.metrics === "object" ? details.metrics as Record<string, unknown> : null });
        }),
        owner.speaker.on("voice.speech.completed", (event) => {
          if (typeof event.turnId !== "string") return;
          emitSpeechEvent(window, { requestId: event.turnId, state: "completed" });
          const details = event.diagnostics as Record<string, unknown> | undefined;
          recordVoice({ requestId: event.turnId, stage: "playback", state: "success",
            durationMs: typeof details?.durationMs === "number" ? details.durationMs : null,
            metrics: details?.metrics && typeof details.metrics === "object" ? details.metrics as Record<string, unknown> : null });
          if (owner.activeRequestId === event.turnId) owner.activeRequestId = null;
        }),
        owner.speaker.on("voice.speech.cancelled", (event) => {
          if (typeof event.turnId !== "string") return;
          emitSpeechEvent(window, { requestId: event.turnId, state: "cancelled" });
          recordVoice({ requestId: event.turnId, stage: typeof event.phase === "string" && event.phase === "speaking" ? "playback" : "synthesis",
            state: "cancelled", cancellation: typeof event.reason === "string" ? event.reason : "unknown" });
          if (owner.activeRequestId === event.turnId) owner.activeRequestId = null;
        }),
        owner.speaker.on("voice.speech.error", (event) => {
          if (typeof event.turnId !== "string") return;
          const error = event.error as Record<string, unknown> | undefined;
          emitSpeechEvent(window, { requestId: event.turnId, state: "error",
            error: { code: safeSpeechErrorCode(error?.code) } });
          const details = event.diagnostics as Record<string, unknown> | undefined;
          recordVoice({ requestId: event.turnId, stage: typeof details?.stage === "string" ? details.stage : "audio_preparation",
            state: "error", errorCode: safeSpeechErrorCode(error?.code),
            durationMs: typeof details?.durationMs === "number" ? details.durationMs : null,
            metrics: details?.metrics && typeof details.metrics === "object" ? details.metrics as Record<string, unknown> : null });
          if (owner.activeRequestId === event.turnId) owner.activeRequestId = null;
        }),
      ];
      speechOwners.set(window, owner);
      return owner;
    }).catch((error) => {
      pendingSpeechOwners.delete(window);
      throw error;
    });
    pendingSpeechOwners.set(window, pending);
  }
  const owner = await pending;
  pendingSpeechOwners.delete(window);
  return owner;
}

export function cancelVoiceSpeech(window: VoiceIpcWindow | null, reason: "user" | "superseded" | "session_ended" = "superseded",
  targetRequestId?: string): boolean {
  if (!window || window.isDestroyed()) return false;
  const owner = speechOwners.get(window);
  if (!owner?.activeRequestId || (targetRequestId !== undefined && owner.activeRequestId !== targetRequestId)) return false;
  return owner.speaker.cancel(reason);
}

export async function speakVoiceResponse(window: VoiceIpcWindow | null, requestId: string, text: string): Promise<void> {
  if (!window || window.isDestroyed() || !isVoiceId(requestId) || typeof text !== "string" || !text.trim()) return;
  if (text.length > 3_000) {
    recordVoice({ requestId, stage: "synthesis", state: "error", errorCode: "voice_speech_too_long" });
    emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_too_long" } });
    return;
  }
  const loader = configuredVoiceApiLoader;
  if (!loader) {
    recordVoice({ requestId, stage: "synthesis", state: "error", errorCode: "voice_speech_generation_failed" });
    emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_generation_failed" } });
    return;
  }
  let owner: VoiceSpeechOwner;
  try { owner = await getSpeechOwner(window, loader); }
  catch {
    recordVoice({ requestId, stage: "synthesis", state: "error", errorCode: "voice_speech_generation_failed" });
    emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_generation_failed" } });
    return;
  }
  if (owner.activeRequestId && owner.activeRequestId !== requestId) owner.speaker.cancel("superseded");
  owner.activeRequestId = requestId;
  owner.nextTurnId = requestId;
  recordVoice({ requestId, stage: "synthesis", state: "started" });
  emitSpeechEvent(window, { requestId, state: "preparing" });
  try { await owner.speaker.speak(text, { style: "normal", persist: false }); }
  catch {
    if (owner.activeRequestId === requestId) {
      owner.activeRequestId = null;
      emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_generation_failed" } });
    }
  } finally {
    if (owner.nextTurnId === requestId) owner.nextTurnId = null;
  }
}

let configuredVoiceApiLoader: LoadPublicVoiceApi | null = null;


/** Installs one per-window barrier around top-level document replacement. */
export function registerVoiceWindowNavigation(
  window: VoiceIpcWindow,
  expectedRendererUrl: string,
): void {
  if (navigationHooks.has(window)) return;
  navigationHooks.add(window);

  window.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument || window.isDestroyed()) return;
    navigatingWindows.add(window);
    cleanupVoiceWindow(window);
  });

  window.webContents.on("did-navigate", (_event, url) => {
    if (window.isDestroyed() || !isTrustedRendererUrl(url, expectedRendererUrl)) return;
    navigatingWindows.delete(window);
  });
}

export function registerVoiceIpcHandlers(
  getMainWindow: () => VoiceIpcWindow | null,
  expectedRendererUrl: string,
  loadVoiceApi: LoadPublicVoiceApi,
  diagnosticRecorder?: (event: VoiceDiagnosticEvent) => void,
): void {
  configuredVoiceApiLoader = loadVoiceApi;
  recordVoiceDiagnostic = diagnosticRecorder ?? null;
  ipcMain.removeHandler(VOICE_PTT_START_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_FINISH_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_CANCEL_CHANNEL);
  ipcMain.removeHandler(VOICE_SPEECH_CANCEL_CHANNEL);

  ipcMain.handle(VOICE_PTT_START_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoicePttStartRequest(payload)) throw new Error("invalid_voice_ptt_start_request");
    const request = payload as VoicePttStartRequest;
    if (activeSessions.has(window)) {
      return errorResponse(request.requestId, "request_conflict", "A PTT session is already active.");
    }
    cancelVoiceSpeech(window, "superseded");

    let state: ActiveVoiceSession | null = null;
    try {
      const voice = await getPublicVoiceApi(loadVoiceApi);
      if (window.isDestroyed() || navigatingWindows.has(window)
        || getMainWindow() !== window || activeSessions.has(window)) {
        return errorResponse(request.requestId, "session_unavailable", "The window is no longer available.");
      }
      const controller = voice.createPttVoiceController({
        recognizer: voice.createSpeechRecognizer(),
      });
      state = {
        window, controller, unsubscribe: () => undefined, startRequestId: request.requestId,
        sessionId: "", finishRequestId: null, turnRequestIds: new Map(), eventRequestIdOverride: null,
        cancelled: false, retired: false, transcriptionStartedAt: null,
      };
      activeSessions.set(window, state);
      state.unsubscribe = controller.subscribe((event) => {
        if (event && typeof event === "object" && "type" in event) {
          const voiceEvent = event as VoicePttEvent;
          sendVoiceEvent(state!, voiceEvent);
          if (voiceEvent.type === "voice.session.started") recordVoice({ requestId: state!.startRequestId, stage: "ptt", state: "started" });
          else if (voiceEvent.type === "voice.transcribing") recordVoice({ requestId: state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "processing" });
          else if (voiceEvent.type === "voice.transcript.final") recordVoice({ requestId: state!.turnRequestIds.get(voiceEvent.turnId) ?? state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "success", durationMs: state!.transcriptionStartedAt === null ? null
              : performance.now() - state!.transcriptionStartedAt });
          else if (voiceEvent.type === "voice.error") recordVoice({ requestId: state!.turnRequestIds.get(voiceEvent.turnId) ?? state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "error", errorCode: String(voiceEvent.error?.code ?? "VOICE_PTT_TRANSCRIPTION_FAILED"),
            durationMs: state!.transcriptionStartedAt === null ? null : performance.now() - state!.transcriptionStartedAt });
          else if (voiceEvent.type === "voice.cancelled") recordVoice({ requestId: state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "cancelled", cancellation: String(voiceEvent.reason ?? "user") });
        }
      });
      const started = controller.start();
      if (!started || typeof started.sessionId !== "string" || !started.sessionId) {
        retireSession(state, request.requestId);
        return errorResponse(request.requestId, "operation_failed", "Voice could not start a session.");
      }
      state.sessionId = started.sessionId;
      return { ok: true as const, requestId: request.requestId, sessionId: started.sessionId };
    } catch {
      if (state) retireSession(state, request.requestId);
      return errorResponse(request.requestId, "operation_failed", "Voice could not start a session.");
    }
  });

  ipcMain.handle(VOICE_PTT_FINISH_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoicePttFinishRequest(payload)) throw new Error("invalid_voice_ptt_finish_request");
    const request = payload as VoicePttFinishRequest;
    const state = activeSessions.get(window);
    if (!state || state.retired || state.cancelled || state.sessionId !== request.sessionId) {
      return errorResponse(request.requestId, "session_unavailable", "The PTT session is not active.");
    }
    if (state.finishRequestId) return errorResponse(request.requestId, "request_conflict", "A PTT transcription is already pending.");

    state.finishRequestId = request.requestId;
    state.transcriptionStartedAt = performance.now();
    try {
      const transcription = state.controller.transcribe({
        audio: request.audio, format: request.format,
        ...(request.language === undefined ? {} : { language: request.language }),
      });
      void Promise.resolve(transcription).then(
        () => {
          if (activeSessions.get(window) === state && !state.cancelled) retireSession(state, request.requestId);
        },
        () => {
          if (activeSessions.get(window) === state && !state.cancelled) retireSession(state, request.requestId);
        },
      );
      return { ok: true as const, accepted: true as const, requestId: request.requestId, sessionId: request.sessionId };
    } catch {
      state.finishRequestId = null;
      return errorResponse(request.requestId, "operation_failed", "Voice could not accept the audio.");
    }
  });

  ipcMain.handle(VOICE_PTT_CANCEL_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoicePttCancelRequest(payload)) throw new Error("invalid_voice_ptt_cancel_request");
    const request = payload;
    const state = activeSessions.get(window);
    if (!state || state.retired || state.sessionId !== request.sessionId) {
      return errorResponse(request.requestId, "session_unavailable", "The PTT session is not active.");
    }
    const pendingTranscription = state.finishRequestId !== null;
    const expectedTargetRequestId = state.finishRequestId ?? state.startRequestId;
    if (request.targetRequestId !== expectedTargetRequestId) {
      return errorResponse(request.requestId, "request_not_found", "The target PTT operation is not active.");
    }

    // Invalidate synchronously before Voice callbacks or any future async work can deliver stale events.
    state.cancelled = true;
    state.eventRequestIdOverride = request.requestId;
    let cancelled = false;
    let cancelFailed = false;
    try { cancelled = state.controller.cancel("user"); }
    catch { cancelFailed = true; }
    finally {
      retireSession(state, request.requestId);
    }
    if (cancelFailed) {
      return errorResponse(request.requestId, "operation_failed", "Voice could not cancel the transcription.");
    }
    return {
      ok: true as const, requestId: request.requestId, sessionId: request.sessionId,
      targetRequestId: request.targetRequestId, cancelled: pendingTranscription ? cancelled : true,
    };
  });

  ipcMain.handle(VOICE_SPEECH_CANCEL_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoiceSpeechCancelRequest(payload)) throw new Error("invalid_voice_speech_cancel_request");
    const requestId = payload.requestId;
    const cancelled = cancelVoiceSpeech(window, "user", requestId);
    return cancelled ? { ok: true as const, requestId, cancelled: true as const }
      : { ok: false as const, requestId, error: "request_not_found" as const };
  });
}

export function cleanupVoiceWindow(window: VoiceIpcWindow): void {
  cancelVoiceSpeech(window, "session_ended");
  const state = activeSessions.get(window);
  if (state) retireSession(state, state.finishRequestId ?? state.startRequestId);
  const speech = speechOwners.get(window);
  if (speech) {
    for (const unsubscribe of speech.unsubscribe) { try { unsubscribe(); } catch { /* Listener cleanup is best-effort. */ } }
    speechOwners.delete(window);
  }
}

export function removeVoiceIpcHandlers(): void {
  ipcMain.removeHandler(VOICE_PTT_START_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_FINISH_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_CANCEL_CHANNEL);
  ipcMain.removeHandler(VOICE_SPEECH_CANCEL_CHANNEL);
  for (const [window, speech] of speechOwners) {
    cancelVoiceSpeech(window, "session_ended");
    for (const unsubscribe of speech.unsubscribe) { try { unsubscribe(); } catch { /* Listener cleanup is best-effort. */ } }
  }
  speechOwners.clear();
  configuredVoiceApiLoader = null;
  cachedVoiceApi = null;
}

function trustedOrigin(actualOrigin: string, expectedRendererUrl: string): boolean {
  try {
    const expected = new URL(expectedRendererUrl);
    if (expected.protocol === "file:") return ["file://", "file:///", "null"].includes(actualOrigin);
    if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || expected.port !== "5174") return false;
    if (actualOrigin !== actualOrigin.trim()) return false;

    const actual = new URL(actualOrigin);
    const authority = actualOrigin.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
    const queryPart = actualOrigin.split("#", 1)[0];
    return actual.origin === expected.origin &&
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port &&
      authority === `${expected.hostname}:${expected.port}` &&
      actual.username === "" &&
      actual.password === "" &&
      actual.pathname === "/" &&
      actual.search === "" &&
      actual.hash === "" &&
      !queryPart.includes("?") &&
      !actualOrigin.includes("#");
  } catch {
    return false;
  }
}

type AudioPermissionDecision = { allowed: true; reason: "allowed" }
  | { allowed: false; reason: string };

function classifyPermissionUrl(value: unknown, expectedRendererUrl: string): "missing" | "invalid" | "trusted" | "mismatch" {
  if (value === undefined) return "missing";
  if (typeof value !== "string" || value.length === 0) return "invalid";
  try {
    new URL(value);
    return isTrustedRendererUrl(value, expectedRendererUrl) ? "trusted" : "mismatch";
  } catch {
    return "invalid";
  }
}

function classifyPermissionOrigin(value: unknown, expectedRendererUrl: string): "missing" | "invalid" | "trusted" | "mismatch" {
  if (value === undefined) return "missing";
  if (typeof value !== "string" || value.length === 0) return "invalid";
  if (trustedOrigin(value, expectedRendererUrl)) return "trusted";
  try {
    new URL(value);
    return "mismatch";
  } catch {
    return "invalid";
  }
}

function classifyRequestedMedia(details: {
  mediaType?: string;
  mediaTypes?: readonly string[];
}): "audio" | "video" | "audio_video" | "unknown" | "missing" {
  if (details.mediaType === "audio") return "audio";
  if (details.mediaType === "video") return "video";
  if (details.mediaType === "unknown") return "unknown";
  if (!Array.isArray(details.mediaTypes)) return "missing";
  const hasAudio = details.mediaTypes.includes("audio");
  const hasVideo = details.mediaTypes.includes("video");
  if (hasAudio && hasVideo) return "audio_video";
  if (hasAudio) return "audio";
  if (hasVideo) return "video";
  return "unknown";
}

function evaluateAudioPermissionRequest(
  webContents: WebContents | null,
  details: {
    isMainFrame?: boolean;
    requestingUrl?: string;
    securityOrigin?: string;
    mediaType?: string;
    mediaTypes?: readonly string[];
  },
  window: VoiceIpcWindow | null,
  expectedRendererUrl: string,
  fallbackOrigin?: string,
): AudioPermissionDecision {
  if (!window) return { allowed: false, reason: "window_missing" };
  if (window.isDestroyed()) return { allowed: false, reason: "window_destroyed" };
  if (webContents !== window.webContents) return { allowed: false, reason: "web_contents_mismatch" };
  if (details.isMainFrame !== true) return { allowed: false, reason: "not_main_frame" };
  const requestingUrlStatus = classifyPermissionUrl(details.requestingUrl, expectedRendererUrl);
  if (requestingUrlStatus !== "trusted") {
    return { allowed: false, reason: `requesting_url_${requestingUrlStatus}` };
  }

  // Electron may omit securityOrigin from MediaAccessPermissionRequest. Only
  // derive it after the complete requesting URL has matched the trusted renderer.
  let securityOrigin = details.securityOrigin;
  if (securityOrigin === undefined) {
    if (fallbackOrigin !== undefined) securityOrigin = fallbackOrigin;
    else securityOrigin = new URL(details.requestingUrl!).origin;
  }
  const securityOriginStatus = classifyPermissionOrigin(securityOrigin, expectedRendererUrl);
  if (securityOriginStatus !== "trusted") {
    return { allowed: false, reason: `security_origin_${securityOriginStatus}` };
  }
  if (fallbackOrigin !== undefined) {
    const requestingOriginStatus = classifyPermissionOrigin(fallbackOrigin, expectedRendererUrl);
    if (requestingOriginStatus !== "trusted") {
      return { allowed: false, reason: `requesting_origin_${requestingOriginStatus}` };
    }
    if (new URL(expectedRendererUrl).protocol !== "file:" &&
      new URL(fallbackOrigin).origin !== new URL(securityOrigin).origin) {
      return { allowed: false, reason: "origin_conflict" };
    }
  }

  const requestedMedia = classifyRequestedMedia(details);
  if (requestedMedia !== "audio") return { allowed: false, reason: `media_${requestedMedia}` };
  return { allowed: true, reason: "allowed" };
}

export function registerVoiceMicrophonePermissions(
  permissionSession: Session,
  getMainWindow: () => VoiceIpcWindow | null,
  expectedRendererUrl: string,
): void {
  permissionSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const window = getMainWindow();
    let decision: AudioPermissionDecision;
    if (permission !== "media") decision = { allowed: false, reason: "permission_not_media" };
    else if (classifyPermissionOrigin(requestingOrigin, expectedRendererUrl) !== "trusted") {
      decision = { allowed: false, reason: `requesting_origin_${classifyPermissionOrigin(requestingOrigin, expectedRendererUrl)}` };
    } else {
      decision = evaluateAudioPermissionRequest(webContents, details, window, expectedRendererUrl, requestingOrigin);
    }
    return decision.allowed;
  });
  permissionSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const window = getMainWindow();
    const decision = permission === "media"
      ? evaluateAudioPermissionRequest(webContents, details, window, expectedRendererUrl)
      : { allowed: false as const, reason: "permission_not_media" };
    callback(decision.allowed);
  });
}
