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
  VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL,
  VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL,
  VOICE_DUCKING_END_CHANNEL,
  type VoiceEventEnvelope,
  type VoiceIpcErrorCode,
  type VoicePttEvent,
  type VoicePttFinishRequest,
  type VoicePttStartRequest,
  type VoiceSpeechEvent,
  type VoiceSpeechAcknowledgementRequest,
  type VoiceSpeechErrorCode,
} from "../shared/ipc-contract.js";
import { prepareSpokenText } from "./spoken-text.js";
import {
  isVoiceEventEnvelope,
  isVoiceId,
  isVoicePttCancelRequest,
  isVoicePttFinishRequest,
  isVoicePttStartRequest,
  isVoiceSpeechCancelRequest,
  isVoiceSpeechAcknowledgementRequest,
  isVoiceFollowupDiagnosticRequest,
  isVoiceSpeechEvent,
} from "../shared/voice-ipc-validation.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AudioDuckingEndReason } from "./audio-session-ducking.js";

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
    prepareAudio(input: Uint8Array): Promise<unknown>;
    play(audioId: string, options?: { playbackId?: string; onStarted?: () => void }): Promise<unknown>;
    stopPlayback(playbackId: string): Promise<unknown>;
    removeTemporary(audioId: string): Promise<boolean>;
  } }): VoiceSpeakerController;
}

export interface VoiceSpeakerController {
  speak(text: string, options?: { style?: string; persist?: boolean }): Promise<{ completed: true } | null>;
  speakPrepared(audio: Uint8Array): Promise<{ completed: true } | null>;
  cancel(reason?: "user" | "superseded" | "session_ended"): boolean;
  on(type: string, listener: (event: Record<string, unknown>) => void): () => void;
  getPlaybackState?(): string;
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
  transcriptFinal: boolean;
  cancelled: boolean;
  retired: boolean;
}

type LoadPublicVoiceApi = () => Promise<PublicVoiceApi>;
export interface VoiceAudioDuckingPort {
  begin(requestId: string): Promise<void>;
  transfer(previousRequestId: string, nextRequestId: string): boolean | void;
  end(requestId: string, reason?: AudioDuckingEndReason): Promise<void>;
  endExcept(requestId: string | null): Promise<void>;
  close(): Promise<void>;
}
type VoiceAcknowledgementId = "clear" | "review" | "moment";
type LoadVoiceAcknowledgement = (id: VoiceAcknowledgementId) => Promise<Uint8Array | null>;
export type PreparedVoiceResponseAudio = { audio: Uint8Array | null; errorCode?: VoiceSpeechErrorCode;
  metrics?: Record<string, unknown> };
export type PrepareVoiceResponseAudio = (text: string, signal: AbortSignal) => Promise<PreparedVoiceResponseAudio>;

const activeSessions = new WeakMap<VoiceIpcWindow, ActiveVoiceSession>();
interface VoiceSpeechOwner {
  window: VoiceIpcWindow;
  speaker: VoiceSpeakerController;
  activeRequestId: string | null;
  activeKind: "acknowledgement" | "response_preparing" | "response" | null;
  nextTurnId: string | null;
  acknowledgementEnd: { requestId: string; promise: Promise<void>; resolve: () => void } | null;
  acknowledgementStarting: boolean;
  stoppedRequestIds: Set<string>;
  handledResponseRequestIds: Set<string>;
  unsubscribe: Array<() => void>;
}
const speechOwners = new Map<VoiceIpcWindow, VoiceSpeechOwner>();
const pendingSpeechOwners = new WeakMap<VoiceIpcWindow, Promise<VoiceSpeechOwner>>();
const pendingResponsePreparations = new WeakMap<VoiceIpcWindow, Map<string, AbortController>>();
const stoppedVoiceRequests = new WeakMap<VoiceIpcWindow, Set<string>>();
const navigatingWindows = new WeakSet<VoiceIpcWindow>();
const navigationHooks = new WeakSet<VoiceIpcWindow>();
const duckingRequestByWindow = new Map<VoiceIpcWindow, string>();
let configuredAudioDucking: VoiceAudioDuckingPort | null = null;
type VoiceDiagnosticEvent = { requestId: string; stage: string; state: string; errorCode?: string; durationMs?: number | null;
  cancellation?: string; metrics?: Record<string, unknown> | null };
let recordVoiceDiagnostic: ((event: VoiceDiagnosticEvent) => void) | null = null;
function recordVoice(event: VoiceDiagnosticEvent): void {
  try { recordVoiceDiagnostic?.(event); } catch { /* Diagnostics never affect Voice. */ }
}

function releaseVoiceDucking(window: VoiceIpcWindow, requestId?: string, reason: AudioDuckingEndReason = "completed"): void {
  const activeRequestId = duckingRequestByWindow.get(window);
  if (!activeRequestId || (requestId !== undefined && requestId !== activeRequestId)) return;
  duckingRequestByWindow.delete(window);
  void configuredAudioDucking?.end(activeRequestId, reason).catch(() => undefined);
}

function transferVoiceDucking(window: VoiceIpcWindow, requestId: string): boolean {
  const previous = duckingRequestByWindow.get(window);
  if (!previous || previous === requestId) return Boolean(previous);
  const transferred = configuredAudioDucking?.transfer(previous, requestId);
  if (transferred === false) void configuredAudioDucking?.begin(requestId).catch(() => undefined);
  duckingRequestByWindow.set(window, requestId);
  return true;
}

export function continueVoiceDuckingForRequest(requestId: string): void {
  for (const window of duckingRequestByWindow.keys()) {
    if (transferVoiceDucking(window, requestId)) return;
  }
}

export function releaseVoiceDuckingForRequest(requestId: string): void {
  for (const [window, activeRequestId] of duckingRequestByWindow) {
    if (activeRequestId === requestId) releaseVoiceDucking(window, requestId, "error");
  }
}

export function releaseVoiceDuckingExcept(requestId: string | null): void {
  for (const [window, activeRequestId] of duckingRequestByWindow) {
    if (activeRequestId !== requestId) releaseVoiceDucking(window, activeRequestId, "superseded");
  }
  void configuredAudioDucking?.endExcept(requestId).catch(() => undefined);
}
const perWindowSequence = new WeakMap<VoiceIpcWindow, number>();
let cachedVoiceApi: Promise<PublicVoiceApi> | null = null;
type SpeechTiming = { startedAt: number; responseDispatchedAt?: number; synthesisStartedAt?: number;
  audioReadyAt?: number; playbackStartedAt?: number; completed?: boolean; completedMetrics?: Record<string, unknown> };
const speechTimingByRequest = new Map<string, SpeechTiming>();

function rememberSpeechTiming(requestId: string, timing: SpeechTiming): void {
  speechTimingByRequest.set(requestId, timing);
  while (speechTimingByRequest.size > 16) speechTimingByRequest.delete(speechTimingByRequest.keys().next().value!);
}

function correlatedSpeechMetrics(timing: SpeechTiming): Record<string, number | null> {
  return {
    responseDispatchToSynthesisMs: timing.responseDispatchedAt === undefined || timing.synthesisStartedAt === undefined ? null
      : Math.max(0, timing.synthesisStartedAt - timing.responseDispatchedAt),
    responseDispatchToAudioReadyMs: timing.responseDispatchedAt === undefined || timing.audioReadyAt === undefined ? null
      : Math.max(0, timing.audioReadyAt - timing.responseDispatchedAt),
    responseDispatchToPlaybackMs: timing.responseDispatchedAt === undefined || timing.playbackStartedAt === undefined ? null
      : Math.max(0, timing.playbackStartedAt - timing.responseDispatchedAt),
    audioReadyToPlaybackMs: timing.audioReadyAt === undefined || timing.playbackStartedAt === undefined ? null
      : Math.max(0, timing.playbackStartedAt - timing.audioReadyAt),
  };
}

/** Marks Main's successful delivery of a final voice response to the Renderer. */
export function markVoiceResponseDispatched(requestId: string): void {
  const timing = speechTimingByRequest.get(requestId);
  if (!timing) return;
  timing.responseDispatchedAt = performance.now();
  if (timing.playbackStartedAt !== undefined) {
    recordVoice({ requestId, stage: "playback", state: timing.completed ? "success" : "processing",
      durationMs: timing.completed ? Math.max(0, timing.playbackStartedAt - timing.responseDispatchedAt) : null,
      metrics: { ...(timing.completedMetrics ?? {}), ...correlatedSpeechMetrics(timing) } });
    if (timing.completed) speechTimingByRequest.delete(requestId);
  }
}

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
    "voice_speech_degraded", "voice_speech_too_long", "voice_audio_storage_unavailable", "voice_tts_generation_failed", "voice_tts_generation_timeout",
    "voice_tts_response_invalid", "voice_audio_processing_failed", "voice_audio_storage_failed", "voice_identity_browser_unavailable"]);
  return (typeof value === "string" && allowed.has(value) ? value : "voice_speech_playback_failed") as VoiceSpeechErrorCode;
}

async function getSpeechOwner(window: VoiceIpcWindow, loadVoiceApi: LoadPublicVoiceApi): Promise<VoiceSpeechOwner> {
  const current = speechOwners.get(window);
  if (current) return current;
  let pending = pendingSpeechOwners.get(window);
  if (!pending) {
    pending = getPublicVoiceApi(loadVoiceApi).then((voice) => {
      let stoppedRequests = stoppedVoiceRequests.get(window);
      if (!stoppedRequests) { stoppedRequests = new Set(); stoppedVoiceRequests.set(window, stoppedRequests); }
      const owner: VoiceSpeechOwner = { window, speaker: undefined as unknown as VoiceSpeakerController,
        activeRequestId: null, activeKind: null, nextTurnId: null, acknowledgementEnd: null,
        acknowledgementStarting: false, stoppedRequestIds: stoppedRequests,
        handledResponseRequestIds: new Set(), unsubscribe: [] };
      owner.speaker = voice.createVoiceSpeaker({ idFactory: () => owner.nextTurnId ?? randomUUID() });
      owner.unsubscribe = [
        owner.speaker.on("voice.speaking", (event) => {
          if (typeof event.turnId !== "string") return;
          const details = event.diagnostics as Record<string, unknown> | undefined;
          const timing = speechTimingByRequest.get(event.turnId);
          const audioReadyAt = performance.now();
          if (timing) timing.audioReadyAt = audioReadyAt;
          recordVoice({ requestId: event.turnId, stage: "playback", state: "processing",
            metrics: { ...(details?.metrics && typeof details.metrics === "object" ? details.metrics as Record<string, unknown> : {}),
              responseDispatchToAudioReadyMs: timing?.responseDispatchedAt === undefined ? null
                : Math.max(0, audioReadyAt - timing.responseDispatchedAt) } });
        }),
        owner.speaker.on("voice.playback.started", (event) => {
          if (typeof event.turnId !== "string") return;
          emitSpeechEvent(window, { requestId: event.turnId, state: "speaking" });
          const timing = speechTimingByRequest.get(event.turnId);
          const playbackStartedAt = performance.now();
          if (!timing) return;
          timing.playbackStartedAt = playbackStartedAt;
          const responseDispatchToPlaybackMs = timing.responseDispatchedAt === undefined ? null
            : Math.max(0, playbackStartedAt - timing.responseDispatchedAt);
          const audioReadyToPlaybackMs = timing.audioReadyAt === undefined ? null
            : Math.max(0, playbackStartedAt - timing.audioReadyAt);
          recordVoice({ requestId: event.turnId, stage: "playback", state: "started",
            durationMs: playbackStartedAt - timing.startedAt,
            metrics: { playbackCommandStartMs: Number((event.diagnostics as Record<string, unknown> | undefined)?.durationMs) || null,
              responseDispatchToPlaybackMs, audioReadyToPlaybackMs } });
        }),
        owner.speaker.on("voice.speech.completed", (event) => {
          if (typeof event.turnId !== "string") return;
          const matchingRequestActive = owner.activeRequestId === event.turnId;
          const acknowledgementStillActive = matchingRequestActive && owner.activeKind === "acknowledgement";
          const responseStillPreparing = matchingRequestActive && owner.activeKind === "response_preparing"
            && pendingResponsePreparations.get(window)?.has(event.turnId) === true;
          const responseStillActive = responseStillPreparing
            || (acknowledgementStillActive && pendingResponsePreparations.get(window)?.has(event.turnId) === true);
          if (owner.acknowledgementEnd?.requestId === event.turnId) {
            owner.acknowledgementEnd.resolve();
            owner.acknowledgementEnd = null;
          }
          if (responseStillActive) owner.activeKind = "response_preparing";
          else if (!acknowledgementStillActive) emitSpeechEvent(window, { requestId: event.turnId, state: "completed" });
          const details = event.diagnostics as Record<string, unknown> | undefined;
          const timing = speechTimingByRequest.get(event.turnId);
          const completedMetrics = details?.metrics && typeof details.metrics === "object"
            ? details.metrics as Record<string, unknown> : {};
          if (timing) {
            timing.completed = true;
            timing.completedMetrics = completedMetrics;
          }
          recordVoice({ requestId: event.turnId, stage: "playback", state: "success",
            durationMs: typeof details?.durationMs === "number" ? details.durationMs : null,
            metrics: timing ? { ...completedMetrics, ...correlatedSpeechMetrics(timing) }
              : details?.metrics && typeof details.metrics === "object" ? completedMetrics : null });
          if (timing?.responseDispatchedAt !== undefined) speechTimingByRequest.delete(event.turnId);
          if (owner.activeRequestId === event.turnId) {
            if (!responseStillActive) { owner.activeRequestId = null; owner.activeKind = null; }
          }
        }),
        owner.speaker.on("voice.speech.cancelled", (event) => {
          if (typeof event.turnId !== "string") return;
          const responseStillActive = owner.activeRequestId === event.turnId
            && owner.activeKind === "response_preparing"
            && pendingResponsePreparations.get(window)?.has(event.turnId) === true;
          if (owner.acknowledgementEnd?.requestId === event.turnId) {
            owner.acknowledgementEnd.resolve();
            owner.acknowledgementEnd = null;
          }
          speechTimingByRequest.delete(event.turnId);
          if (responseStillActive) owner.activeKind = "response_preparing";
          else emitSpeechEvent(window, { requestId: event.turnId, state: "cancelled" });
          recordVoice({ requestId: event.turnId, stage: typeof event.phase === "string" && event.phase === "speaking" ? "playback" : "synthesis",
            state: "cancelled", cancellation: typeof event.reason === "string" ? event.reason : "unknown" });
          if (owner.activeRequestId === event.turnId && !responseStillActive) { owner.activeRequestId = null; owner.activeKind = null; }
        }),
        owner.speaker.on("voice.speech.error", (event) => {
          if (typeof event.turnId !== "string") return;
          const responseStillActive = owner.activeRequestId === event.turnId
            && owner.activeKind === "response_preparing"
            && pendingResponsePreparations.get(window)?.has(event.turnId) === true;
          if (owner.acknowledgementEnd?.requestId === event.turnId) {
            owner.acknowledgementEnd.resolve();
            owner.acknowledgementEnd = null;
          }
          speechTimingByRequest.delete(event.turnId);
          const error = event.error as Record<string, unknown> | undefined;
          if (responseStillActive) owner.activeKind = "response_preparing";
          else emitSpeechEvent(window, { requestId: event.turnId, state: "error",
            error: { code: safeSpeechErrorCode(error?.code) } });
          const details = event.diagnostics as Record<string, unknown> | undefined;
          recordVoice({ requestId: event.turnId, stage: typeof details?.stage === "string" ? details.stage : "audio_preparation",
            state: "error", errorCode: safeSpeechErrorCode(error?.code),
            durationMs: typeof details?.durationMs === "number" ? details.durationMs : null,
            metrics: details?.metrics && typeof details.metrics === "object" ? details.metrics as Record<string, unknown> : null });
          if (owner.activeRequestId === event.turnId && !responseStillActive) { owner.activeRequestId = null; owner.activeKind = null; }
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
  const pending = pendingResponsePreparations.get(window);
  const pendingRequestId = targetRequestId ?? owner?.activeRequestId ?? (pending?.keys().next().value as string | undefined);
  const pendingController = pendingRequestId ? pending?.get(pendingRequestId) : undefined;
  if (reason === "user" && targetRequestId && isVoiceId(targetRequestId)) {
    if (owner && owner.activeRequestId !== targetRequestId && !pendingController) {
      return owner.stoppedRequestIds.has(targetRequestId);
    }
    if (!owner && !pendingController) {
      let stopped = stoppedVoiceRequests.get(window);
      if (!stopped) { stopped = new Set(); stoppedVoiceRequests.set(window, stopped); }
      stopped.add(targetRequestId);
      if (stopped.size > 64) stopped.delete(stopped.values().next().value!);
      return true;
    }
    let stopped = stoppedVoiceRequests.get(window);
    if (!stopped) { stopped = new Set(); stoppedVoiceRequests.set(window, stopped); }
    stopped.add(targetRequestId);
    if (stopped.size > 64) stopped.delete(stopped.values().next().value!);
  }
  if (!owner?.activeRequestId || (targetRequestId !== undefined && owner.activeRequestId !== targetRequestId)) {
    if (!pendingController || !pendingRequestId) return reason === "user" && pendingRequestId !== undefined;
    if (reason === "user") {
      owner?.stoppedRequestIds.add(pendingRequestId);
      if (owner && owner.stoppedRequestIds.size > 64) owner.stoppedRequestIds.delete(owner.stoppedRequestIds.values().next().value!);
    }
    pendingController.abort();
    pending?.delete(pendingRequestId);
    if (owner?.activeRequestId === pendingRequestId && owner.activeKind === "response_preparing") {
      owner.activeRequestId = null; owner.activeKind = null; owner.nextTurnId = null;
      emitSpeechEvent(window, { requestId: pendingRequestId, state: "cancelled" });
    }
    return true;
  }
  const requestId = owner.activeRequestId;
  if (targetRequestId !== undefined && pendingController && pendingRequestId === targetRequestId) {
    if (reason === "user") owner.stoppedRequestIds.add(requestId);
    pendingController.abort();
    pending?.delete(requestId);
  }
  if (reason === "user") {
    owner.stoppedRequestIds.add(requestId);
    if (owner.stoppedRequestIds.size > 64) owner.stoppedRequestIds.delete(owner.stoppedRequestIds.values().next().value!);
  }
  if (owner.activeKind === "acknowledgement" && owner.acknowledgementStarting) {
    owner.acknowledgementStarting = false;
    owner.activeRequestId = null;
    owner.activeKind = null;
    owner.nextTurnId = null;
    const pending = owner.acknowledgementEnd;
    if (pending?.requestId === requestId) {
      owner.acknowledgementEnd = null;
      pending.resolve();
    }
    emitSpeechEvent(window, { requestId, state: "cancelled" });
    return true;
  }
  if (owner.activeKind === "response_preparing") {
    if (owner.speaker.getPlaybackState?.() !== undefined && owner.speaker.getPlaybackState?.() !== "idle") {
      const interrupted = owner.speaker.cancel(reason);
      if (interrupted) return true;
    }
    owner.activeRequestId = null; owner.activeKind = null; owner.nextTurnId = null;
    emitSpeechEvent(window, { requestId, state: "cancelled" });
    return true;
  }
  return owner.speaker.cancel(reason);
}

export async function speakVoiceResponse(window: VoiceIpcWindow | null, requestId: string, text: string): Promise<void> {
  if (!window || window.isDestroyed() || !isVoiceId(requestId) || typeof text !== "string") return;
  const spokenText = prepareSpokenText(text);
  if (!spokenText.trim()) {
    releaseVoiceDucking(window, requestId, "error");
    return;
  }
  if (spokenText.length > 3_000) {
    recordVoice({ requestId, stage: "synthesis", state: "error", errorCode: "voice_speech_too_long" });
    emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_too_long" } });
    releaseVoiceDucking(window, requestId, "error");
    return;
  }
  const loader = configuredVoiceApiLoader;
  if (!loader) {
    recordVoice({ requestId, stage: "synthesis", state: "error", errorCode: "voice_speech_generation_failed" });
    emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_generation_failed" } });
    releaseVoiceDucking(window, requestId, "error");
    return;
  }
  rememberSpeechTiming(requestId, { startedAt: performance.now() });
  let owner: VoiceSpeechOwner;
  const ownerPreparationStartedAt = performance.now();
  try { owner = await getSpeechOwner(window, loader); }
  catch {
    speechTimingByRequest.delete(requestId);
    recordVoice({ requestId, stage: "synthesis", state: "error", errorCode: "voice_speech_generation_failed" });
    emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_generation_failed" } });
    releaseVoiceDucking(window, requestId, "error");
    return;
  }
  recordVoice({ requestId, stage: "synthesis", state: "processing", durationMs: performance.now() - ownerPreparationStartedAt,
    metrics: { speechInitializationMs: performance.now() - ownerPreparationStartedAt } });
  if (owner.stoppedRequestIds.has(requestId)) {
    speechTimingByRequest.delete(requestId);
    emitSpeechEvent(window, { requestId, state: "cancelled" });
    releaseVoiceDucking(window, requestId, "stop");
    return;
  }
  if (owner.handledResponseRequestIds.has(requestId)) return;
  owner.handledResponseRequestIds.add(requestId);
  if (owner.handledResponseRequestIds.size > 256) owner.handledResponseRequestIds.delete(owner.handledResponseRequestIds.values().next().value!);
  const prepareResponseAudio = configuredResponseAudioPreparer;
  if (prepareResponseAudio) {
    let preparations = pendingResponsePreparations.get(window);
    if (!preparations) { preparations = new Map(); pendingResponsePreparations.set(window, preparations); }
    if (preparations.has(requestId)) return;
    const controller = new AbortController();
    preparations.set(requestId, controller);
    if (owner.activeRequestId && owner.activeRequestId !== requestId
      && owner.activeKind !== "acknowledgement") cancelVoiceSpeech(window, "superseded", owner.activeRequestId ?? undefined);
    if (owner.activeKind !== "acknowledgement") {
      owner.activeRequestId = requestId;
      owner.activeKind = "response_preparing";
    } else if (owner.activeRequestId !== requestId) {
      cancelVoiceSpeech(window, "superseded", owner.activeRequestId ?? undefined);
      owner.activeRequestId = requestId;
      owner.activeKind = "response_preparing";
    }
    const speechTiming = speechTimingByRequest.get(requestId);
    if (speechTiming) speechTiming.synthesisStartedAt = performance.now();
    recordVoice({ requestId, stage: "synthesis", state: "started",
      metrics: { responseDispatchToSynthesisMs: speechTiming?.responseDispatchedAt === undefined ? null
        : Math.max(0, performance.now() - speechTiming.responseDispatchedAt) } });
    emitSpeechEvent(window, { requestId, state: "preparing" });
    let prepared: PreparedVoiceResponseAudio;
    try { prepared = await prepareResponseAudio(spokenText, controller.signal); }
    catch { prepared = { audio: null, errorCode: "voice_speech_generation_failed" }; }
    if (owner.stoppedRequestIds.has(requestId) || controller.signal.aborted || window.isDestroyed()) {
      preparations.delete(requestId);
      if (owner.activeRequestId === requestId && owner.activeKind === "response_preparing") {
        owner.activeRequestId = null; owner.activeKind = null;
      }
      return;
    }
    if (!(prepared?.audio instanceof Uint8Array) || prepared.audio.byteLength === 0) {
      const errorCode = prepared?.errorCode ?? "voice_speech_generation_failed";
      if (owner.activeKind === "acknowledgement" && owner.activeRequestId === requestId) {
        const acknowledgementEnd = owner.acknowledgementEnd;
        await stopAcknowledgementForResponse(owner, requestId);
        if (acknowledgementEnd?.requestId === requestId) await acknowledgementEnd.promise;
      }
      preparations.delete(requestId);
      if (owner.activeRequestId === requestId) { owner.activeRequestId = null; owner.activeKind = null; }
      speechTimingByRequest.delete(requestId);
      recordVoice({ requestId, stage: "synthesis", state: "error", errorCode, metrics: prepared?.metrics });
      emitSpeechEvent(window, { requestId, state: "error", error: { code: errorCode } });
      releaseVoiceDucking(window, requestId, "error");
      return;
    }
    if (owner.activeKind === "acknowledgement" && owner.activeRequestId) {
      const acknowledgementRequestId = owner.activeRequestId;
      const acknowledgementEnd = owner.acknowledgementEnd;
      if (acknowledgementRequestId === requestId) await stopAcknowledgementForResponse(owner, requestId);
      else cancelVoiceSpeech(window, "superseded", acknowledgementRequestId);
      if (acknowledgementEnd?.requestId === acknowledgementRequestId) await acknowledgementEnd.promise;
    }
    if (owner.stoppedRequestIds.has(requestId) || controller.signal.aborted || window.isDestroyed()) {
      preparations.delete(requestId);
      return;
    }
    preparations.delete(requestId);
    recordVoice({ requestId, stage: "synthesis", state: "success", metrics: prepared.metrics });
    if (owner.activeRequestId && owner.activeRequestId !== requestId) cancelVoiceSpeech(window, "superseded", owner.activeRequestId);
    owner.activeRequestId = requestId;
    owner.activeKind = "response";
    owner.nextTurnId = requestId;
    let completed = false;
    try { completed = (await owner.speaker.speakPrepared(Buffer.from(prepared.audio)))?.completed === true; }
    catch {
      speechTimingByRequest.delete(requestId);
      if (owner.activeRequestId === requestId) {
        owner.activeRequestId = null; owner.activeKind = null;
        emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_generation_failed" } });
      }
    } finally {
      if (owner.nextTurnId === requestId) owner.nextTurnId = null;
      if (!completed) releaseVoiceDucking(window, requestId, "error");
    }
    return;
  }
  if (owner.activeKind === "acknowledgement" && owner.activeRequestId) {
    const acknowledgementRequestId = owner.activeRequestId;
    const acknowledgementEnd = owner.acknowledgementEnd;
    cancelVoiceSpeech(window, "superseded", acknowledgementRequestId);
    if (acknowledgementEnd?.requestId === acknowledgementRequestId) await acknowledgementEnd.promise;
  }
  if (owner.activeRequestId && owner.activeRequestId !== requestId) owner.speaker.cancel("superseded");
  if (owner.stoppedRequestIds.has(requestId)) return;
  owner.activeRequestId = requestId;
  owner.activeKind = "response";
  owner.nextTurnId = requestId;
  const speechTiming = speechTimingByRequest.get(requestId);
  if (speechTiming) speechTiming.synthesisStartedAt = performance.now();
  recordVoice({ requestId, stage: "synthesis", state: "started",
    metrics: { responseDispatchToSynthesisMs: speechTiming?.responseDispatchedAt === undefined ? null
      : Math.max(0, performance.now() - speechTiming.responseDispatchedAt) } });
  emitSpeechEvent(window, { requestId, state: "preparing" });
  let completed = false;
  try { completed = (await owner.speaker.speak(spokenText, { style: "normal", persist: false }))?.completed === true; }
  catch {
    speechTimingByRequest.delete(requestId);
    if (owner.activeRequestId === requestId) {
      owner.activeRequestId = null;
      emitSpeechEvent(window, { requestId, state: "error", error: { code: "voice_speech_generation_failed" } });
    }
  } finally {
    if (owner.nextTurnId === requestId) owner.nextTurnId = null;
    if (!completed) releaseVoiceDucking(window, requestId, "error");
  }
}

async function stopAcknowledgementForResponse(owner: VoiceSpeechOwner, requestId: string): Promise<void> {
  if (owner.activeRequestId !== requestId || owner.activeKind !== "acknowledgement") return;
  const acknowledgementEnd = owner.acknowledgementEnd?.requestId === requestId ? owner.acknowledgementEnd : null;
  owner.activeRequestId = requestId;
  owner.activeKind = "response_preparing";
  if (owner.acknowledgementStarting) {
    owner.acknowledgementStarting = false;
    owner.nextTurnId = null;
    if (acknowledgementEnd) {
      owner.acknowledgementEnd = null;
      acknowledgementEnd.resolve();
    }
  } else {
    owner.speaker.cancel("superseded");
  }
  if (acknowledgementEnd) await acknowledgementEnd.promise;
}

let configuredVoiceApiLoader: LoadPublicVoiceApi | null = null;
let configuredVoiceAcknowledgementLoader: LoadVoiceAcknowledgement | null = null;
let configuredResponseAudioPreparer: PrepareVoiceResponseAudio | null = null;
let voiceAcknowledgementIndex = 0;

export async function speakVoiceAcknowledgement(window: VoiceIpcWindow | null, requestId: string): Promise<boolean> {
  if (!window || window.isDestroyed() || !isVoiceId(requestId) || !configuredVoiceApiLoader || !configuredVoiceAcknowledgementLoader) return false;
  const owner = await getSpeechOwner(window, configuredVoiceApiLoader).catch(() => null);
  const playbackState = owner?.speaker.getPlaybackState?.();
  const responsePreparingForRequest = owner?.activeKind === "response_preparing" && owner.activeRequestId === requestId;
  if (!owner || window.isDestroyed() || owner.stoppedRequestIds.has(requestId)
    || (owner.activeRequestId && !responsePreparingForRequest) || (playbackState !== undefined && playbackState !== "idle")) return false;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  owner.acknowledgementEnd = { requestId, promise, resolve };
  owner.activeRequestId = requestId;
  owner.activeKind = "acknowledgement";
  owner.acknowledgementStarting = true;
  owner.nextTurnId = requestId;
  emitSpeechEvent(window, { requestId, state: "preparing" });
  const ids: VoiceAcknowledgementId[] = ["clear", "review", "moment"];
  const id = ids[voiceAcknowledgementIndex++ % ids.length];
  const audio = await configuredVoiceAcknowledgementLoader(id).catch(() => null);
  if (owner.activeRequestId !== requestId || owner.activeKind !== "acknowledgement" || !owner.acknowledgementStarting) return false;
  if (!(audio instanceof Uint8Array) || audio.byteLength < 44 || audio.byteLength > 4 * 1024 * 1024
    || audio[0] !== 0x52 || audio[1] !== 0x49 || audio[2] !== 0x46 || audio[3] !== 0x46
    || audio[8] !== 0x57 || audio[9] !== 0x41 || audio[10] !== 0x56 || audio[11] !== 0x45
    || window.isDestroyed() || owner.stoppedRequestIds.has(requestId)) {
    owner.acknowledgementStarting = false;
    if (owner.acknowledgementEnd?.requestId === requestId) {
      owner.acknowledgementEnd = null;
      resolve();
    }
    if (owner.activeRequestId === requestId && owner.activeKind === "acknowledgement") {
      owner.activeRequestId = null;
      owner.activeKind = null;
      owner.nextTurnId = null;
    }
    if (!window.isDestroyed()) emitSpeechEvent(window, { requestId, state: "cancelled" });
    return false;
  }
  owner.acknowledgementStarting = false;
  try {
    void owner.speaker.speakPrepared(Buffer.from(audio)).catch(() => undefined).finally(() => {
      if (owner.acknowledgementEnd?.requestId === requestId) {
        owner.acknowledgementEnd.resolve();
        owner.acknowledgementEnd = null;
      }
      if (owner.activeRequestId === requestId && owner.activeKind === "acknowledgement") {
        owner.activeRequestId = null;
        owner.activeKind = null;
      }
      if (owner.nextTurnId === requestId) owner.nextTurnId = null;
    });
    return true;
  } catch {
    owner.acknowledgementEnd.resolve();
    owner.acknowledgementEnd = null;
    owner.activeRequestId = null;
    owner.activeKind = null;
    if (owner.nextTurnId === requestId) owner.nextTurnId = null;
    return false;
  }
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
  diagnosticRecorder?: (event: VoiceDiagnosticEvent) => void,
  loadAcknowledgement?: LoadVoiceAcknowledgement,
  prepareResponseAudio?: PrepareVoiceResponseAudio,
  audioDucking?: VoiceAudioDuckingPort,
): void {
  configuredVoiceApiLoader = loadVoiceApi;
  configuredVoiceAcknowledgementLoader = loadAcknowledgement ?? null;
  configuredResponseAudioPreparer = prepareResponseAudio ?? null;
  configuredAudioDucking = audioDucking ?? null;
  recordVoiceDiagnostic = diagnosticRecorder ?? null;
  ipcMain.removeHandler(VOICE_PTT_START_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_FINISH_CHANNEL);
  ipcMain.removeHandler(VOICE_PTT_CANCEL_CHANNEL);
  ipcMain.removeHandler(VOICE_SPEECH_CANCEL_CHANNEL);
  ipcMain.removeHandler(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL);
  ipcMain.removeHandler(VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL);
  ipcMain.removeHandler(VOICE_DUCKING_END_CHANNEL);

  ipcMain.handle(VOICE_PTT_START_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoicePttStartRequest(payload)) throw new Error("invalid_voice_ptt_start_request");
    const request = payload as VoicePttStartRequest;
    if (activeSessions.has(window)) {
      return errorResponse(request.requestId, "request_conflict", "A PTT session is already active.");
    }
    if (!transferVoiceDucking(window, request.requestId)) {
      duckingRequestByWindow.set(window, request.requestId);
      void configuredAudioDucking?.endExcept(request.requestId).catch(() => undefined);
      void configuredAudioDucking?.begin(request.requestId).catch(() => undefined);
    }
    cancelVoiceSpeech(window, "superseded");

    let state: ActiveVoiceSession | null = null;
    try {
      const voice = await getPublicVoiceApi(loadVoiceApi);
      if (window.isDestroyed() || navigatingWindows.has(window)
        || getMainWindow() !== window || activeSessions.has(window)) {
        releaseVoiceDucking(window, request.requestId);
        return errorResponse(request.requestId, "session_unavailable", "The window is no longer available.");
      }
      const controller = voice.createPttVoiceController({
        recognizer: voice.createSpeechRecognizer(),
      });
      state = {
        window, controller, unsubscribe: () => undefined, startRequestId: request.requestId,
        sessionId: "", finishRequestId: null, turnRequestIds: new Map(), eventRequestIdOverride: null,
        cancelled: false, retired: false, transcriptionStartedAt: null, transcriptFinal: false,
      };
      activeSessions.set(window, state);
      state.unsubscribe = controller.subscribe((event) => {
        if (event && typeof event === "object" && "type" in event) {
          const voiceEvent = event as VoicePttEvent;
          sendVoiceEvent(state!, voiceEvent);
          if (voiceEvent.type === "voice.session.started") recordVoice({ requestId: state!.startRequestId, stage: "ptt", state: "started" });
          else if (voiceEvent.type === "voice.transcribing") recordVoice({ requestId: state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "processing" });
          else if (voiceEvent.type === "voice.transcript.final") {
            state!.transcriptFinal = true;
            recordVoice({ requestId: state!.turnRequestIds.get(voiceEvent.turnId) ?? state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "success", durationMs: state!.transcriptionStartedAt === null ? null
              : performance.now() - state!.transcriptionStartedAt });
          }
          else if (voiceEvent.type === "voice.error") recordVoice({ requestId: state!.turnRequestIds.get(voiceEvent.turnId) ?? state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "error", errorCode: String(voiceEvent.error?.code ?? "VOICE_PTT_TRANSCRIPTION_FAILED"),
            durationMs: state!.transcriptionStartedAt === null ? null : performance.now() - state!.transcriptionStartedAt });
          else if (voiceEvent.type === "voice.cancelled") recordVoice({ requestId: state!.finishRequestId ?? state!.startRequestId,
            stage: "transcription", state: "cancelled", cancellation: String(voiceEvent.reason ?? "user") });
          if (voiceEvent.type === "voice.error" || (voiceEvent.type === "voice.cancelled" && !state!.transcriptFinal)) {
            releaseVoiceDucking(window, state!.finishRequestId ?? state!.startRequestId);
          }
        }
      });
      const started = controller.start();
      if (!started || typeof started.sessionId !== "string" || !started.sessionId) {
        retireSession(state, request.requestId);
        releaseVoiceDucking(window, request.requestId);
        return errorResponse(request.requestId, "operation_failed", "Voice could not start a session.");
      }
      state.sessionId = started.sessionId;
      return { ok: true as const, requestId: request.requestId, sessionId: started.sessionId };
    } catch {
      if (state) retireSession(state, request.requestId);
      releaseVoiceDucking(window, request.requestId);
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
    configuredAudioDucking?.transfer(state.startRequestId, request.requestId);
    duckingRequestByWindow.set(window, request.requestId);
    if (request.pttFinalizationMs !== undefined) recordVoice({ requestId: request.requestId, stage: "ptt", state: "success",
      durationMs: request.pttFinalizationMs, metrics: { pttFinalizationMs: request.pttFinalizationMs,
        audioConversionMs: request.audioConversionMs ?? null } });
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
      releaseVoiceDucking(window, request.requestId);
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
      if (!state.transcriptFinal) releaseVoiceDucking(window, request.targetRequestId);
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
    if (cancelled) releaseVoiceDucking(window, requestId, "stop");
    return cancelled ? { ok: true as const, requestId, cancelled: true as const }
      : { ok: false as const, requestId, error: "request_not_found" as const };
  });

  ipcMain.handle(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoiceSpeechAcknowledgementRequest(payload)) throw new Error("invalid_voice_speech_acknowledgement_request");
    const request = payload as VoiceSpeechAcknowledgementRequest;
    return { ok: true as const, requestId: request.requestId,
      accepted: await speakVoiceAcknowledgement(window, request.requestId) };
  });
  ipcMain.handle(VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (!isVoiceFollowupDiagnosticRequest(payload)) throw new Error("invalid_voice_followup_diagnostic_request");
    recordVoice({ requestId: payload.requestId, stage: "followup", state: "success", durationMs: payload.durationMs,
      metrics: { followupOutcome: payload.outcome } });
    return true;
  });
  ipcMain.handle(VOICE_DUCKING_END_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getMainWindow();
    if (!isTrustedVoiceSender(event, window, expectedRendererUrl)) throw new Error("untrusted_voice_ipc_sender");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)
      || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, "requestId") || !Object.hasOwn(payload, "reason")) {
      throw new Error("invalid_voice_ducking_end_request");
    }
    const request = payload as { requestId: unknown; reason: unknown };
    if (!isVoiceId(request.requestId) || typeof request.reason !== "string"
      || !["completed", "followup_expired", "stop", "error"].includes(request.reason)) {
      throw new Error("invalid_voice_ducking_end_request");
    }
    if (duckingRequestByWindow.get(window) !== request.requestId) return false;
    releaseVoiceDucking(window, request.requestId, request.reason as AudioDuckingEndReason);
    return true;
  });
}

export function cleanupVoiceWindow(window: VoiceIpcWindow): void {
  releaseVoiceDucking(window);
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
  ipcMain.removeHandler(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL);
  ipcMain.removeHandler(VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL);
  ipcMain.removeHandler(VOICE_DUCKING_END_CHANNEL);
  for (const [window, speech] of speechOwners) {
    cancelVoiceSpeech(window, "session_ended");
    for (const unsubscribe of speech.unsubscribe) { try { unsubscribe(); } catch { /* Listener cleanup is best-effort. */ } }
  }
  speechOwners.clear();
  configuredVoiceApiLoader = null;
  configuredVoiceAcknowledgementLoader = null;
  configuredResponseAudioPreparer = null;
  for (const [window] of duckingRequestByWindow) releaseVoiceDucking(window);
  configuredAudioDucking = null;
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
