import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import {
  VOICE_EVENT_CHANNEL,
  VOICE_PTT_CANCEL_CHANNEL,
  VOICE_PTT_FINISH_CHANNEL,
  VOICE_PTT_START_CHANNEL,
  type VoiceEventEnvelope,
  type VoiceIpcErrorCode,
  type VoicePttEvent,
  type VoicePttFinishRequest,
  type VoicePttStartRequest,
} from "../shared/ipc-contract.js";
import {
  isVoiceEventEnvelope,
  isVoicePttCancelRequest,
  isVoicePttFinishRequest,
  isVoicePttStartRequest,
} from "../shared/voice-ipc-validation.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";

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
  cancelled: boolean;
  retired: boolean;
}

type LoadPublicVoiceApi = () => Promise<PublicVoiceApi>;

const activeSessions = new WeakMap<VoiceIpcWindow, ActiveVoiceSession>();
const navigatingWindows = new WeakSet<VoiceIpcWindow>();
const navigationHooks = new WeakSet<VoiceIpcWindow>();
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
): void {
  ipcMain.removeHandler(VOICE_PTT_START_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_FINISH_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_CANCEL_CHANNEL);

  ipcMain.handle(VOICE_PTT_START_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoicePttStartRequest(payload)) throw new Error("invalid_voice_ptt_start_request");
    const request = payload as VoicePttStartRequest;
    if (activeSessions.has(window)) {
      return errorResponse(request.requestId, "request_conflict", "A PTT session is already active.");
    }

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
        cancelled: false, retired: false,
      };
      activeSessions.set(window, state);
      state.unsubscribe = controller.subscribe((event) => {
        if (event && typeof event === "object" && "type" in event) sendVoiceEvent(state!, event as VoicePttEvent);
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
}

export function cleanupVoiceWindow(window: VoiceIpcWindow): void {
  const state = activeSessions.get(window);
  if (state) retireSession(state, state.finishRequestId ?? state.startRequestId);
}

export function removeVoiceIpcHandlers(): void {
  ipcMain.removeHandler(VOICE_PTT_START_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_FINISH_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_CANCEL_CHANNEL);
  cachedVoiceApi = null;
}

function trustedOrigin(actualOrigin: string, expectedRendererUrl: string): boolean {
  try {
    const expected = new URL(expectedRendererUrl);
    if (expected.protocol === "file:") return ["file://", "file:///", "null"].includes(actualOrigin);
    return actualOrigin === expected.origin;
  } catch {
    return false;
  }
}

function isTrustedAudioPermissionRequest(
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
): boolean {
  if (!window || window.isDestroyed() || webContents !== window.webContents || details.isMainFrame !== true
    || !details.requestingUrl || !isTrustedRendererUrl(details.requestingUrl, expectedRendererUrl)
    || !details.securityOrigin || !trustedOrigin(details.securityOrigin, expectedRendererUrl)) return false;
  return details.mediaType === "audio"
    || (Array.isArray(details.mediaTypes) && details.mediaTypes.includes("audio") && !details.mediaTypes.includes("video"));
}

export function registerVoiceMicrophonePermissions(
  permissionSession: Session,
  getMainWindow: () => VoiceIpcWindow | null,
  expectedRendererUrl: string,
): void {
  permissionSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const window = getMainWindow();
    return permission === "media" && trustedOrigin(requestingOrigin, expectedRendererUrl)
      && isTrustedAudioPermissionRequest(webContents, { ...details, securityOrigin: details.securityOrigin ?? requestingOrigin }, window, expectedRendererUrl);
  });
  permissionSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const window = getMainWindow();
    callback(permission === "media"
      && isTrustedAudioPermissionRequest(webContents, details, window, expectedRendererUrl));
  });
}
