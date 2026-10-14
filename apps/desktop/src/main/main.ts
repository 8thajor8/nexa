import { app, BrowserWindow, ipcMain, Menu, protocol, screen, session, shell } from "electron";
import { lstat, mkdir, readFile } from "node:fs/promises";
// @ts-expect-error The repository's JavaScript Runtime intentionally has no generated declaration file.
import { createConversationRuntime } from "../../../../src/core/conversation-runtime.js";
// @ts-expect-error The shared Runtime diagnostics intentionally has no generated declaration file.
import { createOperationalDiagnostics } from "../../../../src/core/system-diagnostics.js";
// @ts-expect-error The repository's JavaScript Runtime intentionally has no generated declaration file.
import { microsoftAuth, resolveMicrosoftTokenPath } from "../../../../src/integrations/microsoft/auth.js";
import { loadRootEnvironment } from "./environment.js";
import { desktopStartupPolicy, prepareDesktopIsolation, resolveSyntheticMemory2StorePath,
  resolvePersonalMemory2StorePath, validateIsolatedMemoryStore } from "./isolation.js";
import { createSyntheticOrganicPilotSession } from "./organic-memory-pilot.js";
import { createDesktopOrganicMemoryHost } from "./organic-memory-desktop.js";
// @ts-expect-error The repository's JavaScript Memory 2 initializer intentionally has no generated declaration file.
import { initializeEmptyMemoryStore } from "../../../../src/memory/backend.js";
// @ts-expect-error The repository's JavaScript Memory 2 reader intentionally has no generated declaration file.
import { openExistingMemory2Reader } from "../../../../src/memory/read-existing.js";
// @ts-expect-error The repository's JavaScript Runtime intentionally has no generated declaration file.
import { authorizeSpotify } from "../../../../src/integrations/spotify/auth.js";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerIpcHandlers } from "./ipc.js";
import { createDesktopRestartController, DEV_RESTART_EXIT_CODE } from "./restart.js";
import { registerChatNavigationHandlers } from "./chat-navigation.js";
import { isAllowedNavigation, isTrustedIpcSender } from "../shared/ipc-security.js";
import {
  GET_WALLPAPER_CHANNEL,
  DESKTOP_RESTART_CHANNEL,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  WINDOW_SETTINGS_GET_CHANNEL,
  WINDOW_SETTINGS_SET_CHANNEL,
  WINDOW_SETTINGS_CHANGED_CHANNEL,
  SPOTIFY_OPEN_TRACK_CHANNEL,
  MEMORY_MODE_GET_CHANNEL,
  MEMORY_MODE_SET_CHANNEL,
  DESKTOP_RENDERER_ISOLATION_ARGUMENT,
  DESKTOP_RENDERER_ORGANIC_PILOT_ARGUMENT,
} from "../shared/ipc-contract.js";
import { canonicalSpotifyTrackUrl } from "../shared/spotify-link-validation.js";
import {
  FRAMELESS_WINDOW_OPTIONS,
  createSecureWebPreferences,
  loadRendererEntryPoint,
  selectRendererEntryPoint,
} from "./security.js";
import { getWindowsWallpaper } from "./wallpaper.js";
import { desktopTraceDisposition } from "./diagnostic-policy.js";
import { applyWindowPlacement, centeredWindowBounds, createWindowOperationQueue, createWindowPreferencesStore, describeDisplays,
  fullscreenPreferenceAfterTransition, isFullscreenToggleInput, setFullscreenAndWait,
  normalizeWindowPreferences, preferencesAfterPlacement, resolveFullscreenForSettingsUpdate, type ScreenDisplayLike } from "./window-settings.js";
import type { WindowPreferences } from "../shared/ipc-contract.js";
import { registerWeatherIpcHandler, removeWeatherIpcHandler } from "./weather-ipc.js";
import { registerAuthorizationIpcHandlers, removeAuthorizationIpcHandlers } from "./authorization-ipc.js";
import { registerSpotifyLiveStatusHandlers, removeSpotifyLiveStatusHandlers, SpotifyLiveStatusService } from "./spotify-live-status.js";
import { beginChatRuntimeSwitch, cleanupChatWindow, endChatRuntimeSwitch, refreshChatRuntimeAfterSwitch,
  registerChatIpcHandlers, removeChatIpcHandlers, type ConversationRuntimeApi } from "./chat-ipc.js";
import { isApprovedSyntheticStore, isReadableMemory2Store, registerMemoryModeIpcHandlers } from "./memory-mode-ipc.js";
import { createMemoryModePreferencesStore, resolveInitialDesktopMemoryMode, type MemoryModeFallbackReason } from "./memory-mode-preferences.js";
import {
  cleanupVoiceWindow,
  cancelVoiceSpeech,
  speakVoiceResponse,
  rememberTypedChatResponse,
  discardTypedChatVoiceResponse,
  markVoiceResponseDispatched,
  releaseVoiceDuckingExcept,
  continueVoiceDuckingForRequest,
  releaseVoiceDuckingForRequest,
  registerVoiceWindowNavigation,
  registerVoiceIpcHandlers,
  registerVoiceMicrophonePermissions,
  removeVoiceIpcHandlers,
  type PublicVoiceApi,
  type PreparedVoiceResponseAudio,
} from "./voice-ipc.js";
import { createAudioSessionDucking } from "./audio-session-ducking.js";

interface DesktopSpeechService {
  generate(input: { text: string; style?: string; persist?: boolean; signal?: AbortSignal; includeAudio?: boolean }): Promise<unknown>;
  prepareAudio(input: Uint8Array): Promise<unknown>;
  play(audioId: string, options?: { playbackId?: string; onStarted?: () => void }): Promise<unknown>;
  stopPlayback(playbackId: string): Promise<unknown>;
  getPlaybackStatus(playbackId: string): unknown;
  removeTemporary(audioId: string): Promise<boolean>;
  getLastMetrics?(): Record<string, unknown> | null;
  close(): Promise<unknown>;
}

let desktopSpeechServicePromise: Promise<DesktopSpeechService> | null = null;
let desktopSpeechServiceInstance: DesktopSpeechService | null = null;
let closingDesktopSpeechService = false;
let desktopSpeechServiceClosed = false;
const desktopOperationalDiagnostics = createOperationalDiagnostics();
let desktopVoiceConfiguration = { model: "unknown", voice: "unknown", identityProfile: "unknown", identityProcessing: null as boolean | null };
async function getDesktopSpeechService(): Promise<DesktopSpeechService> {
  if (!desktopSpeechServicePromise) {
    desktopSpeechServicePromise = (async () => {
      const speechUrl = pathToFileURL(resolve(repositoryRoot, "src", "speech", "service.js")).href;
      const storeUrl = pathToFileURL(resolve(repositoryRoot, "src", "speech", "audio-store.js")).href;
      const configUrl = pathToFileURL(resolve(repositoryRoot, "src", "speech", "config.js")).href;
      const [speechModule, storeModule, configModule] = await Promise.all([
        import(speechUrl) as Promise<{ createSpeechService(options?: object): DesktopSpeechService }>,
        import(storeUrl) as Promise<{ createAudioStore(config: object): unknown }>,
        import(configUrl) as Promise<{ speechConfig: Record<string, unknown> }>,
      ]);
      desktopVoiceConfiguration = { model: String(configModule.speechConfig.model), voice: String(configModule.speechConfig.voice),
        identityProfile: "nova-portena", identityProcessing: configModule.speechConfig.voiceIdentityEnabled === true };
      const audioRoot = resolve(app.getPath("userData"), "voice-audio");
      const store = storeModule.createAudioStore({ ...configModule.speechConfig,
        temporaryDirectory: resolve(audioRoot, "temporary"), persistentDirectory: resolve(audioRoot, "saved") });
        desktopSpeechServiceInstance = speechModule.createSpeechService({ store });
        return desktopSpeechServiceInstance;
    })().catch((error) => { desktopSpeechServicePromise = null; throw error; });
  }
  return desktopSpeechServicePromise;
}

const desktopSpeechService: DesktopSpeechService = {
  generate: async (input) => (await getDesktopSpeechService()).generate(input),
  prepareAudio: async (input) => (await getDesktopSpeechService()).prepareAudio(input),
  play: async (audioId, options) => (await getDesktopSpeechService()).play(audioId, options),
  stopPlayback: async (playbackId) => (await getDesktopSpeechService()).stopPlayback(playbackId),
  getPlaybackStatus: (playbackId) => desktopSpeechServiceInstance?.getPlaybackStatus(playbackId)
    ?? { playbackId, status: "unknown", released: false },
  removeTemporary: async (audioId) => (await getDesktopSpeechService()).removeTemporary(audioId),
  getLastMetrics: () => desktopSpeechServiceInstance?.getLastMetrics?.() ?? null,
  close: async () => (await getDesktopSpeechService()).close(),
};

async function closeDesktopSpeechService(): Promise<void> {
  if (desktopSpeechServiceClosed || closingDesktopSpeechService) return;
  closingDesktopSpeechService = true;
  try { if (desktopSpeechServiceInstance) await desktopSpeechServiceInstance.close(); }
  catch { console.error("[nexa-desktop] voice service cleanup failed"); }
  finally { desktopSpeechServiceClosed = true; closingDesktopSpeechService = false; }
}

async function loadDesktopVoiceApi(): Promise<PublicVoiceApi> {
  const api = await import(publicVoiceApiUrl) as PublicVoiceApi;
  return { ...api, createVoiceSpeaker: (options) => api.createVoiceSpeaker({ ...options, speechService: desktopSpeechService }) };
}

async function prepareDesktopVoiceResponseAudio(text: string, signal: AbortSignal): Promise<PreparedVoiceResponseAudio> {
  let result: { success?: boolean; audioId?: string; audio?: Uint8Array; error?: { code?: string } };
  try {
    result = await desktopSpeechService.generate({ text, style: "normal", persist: false, signal, includeAudio: true }) as typeof result;
  } catch {
    return { audio: null, errorCode: "voice_speech_generation_failed" };
  }
  const lastMetrics = desktopSpeechService.getLastMetrics?.() ?? null;
  const metrics = lastMetrics ? { synthesisMs: lastMetrics.synthesisMs, ttsSdkResponseMs: lastMetrics.ttsSdkResponseMs,
    ttsBodyReadMs: lastMetrics.ttsBodyReadMs, identityProcessingMs: lastMetrics.identityProcessingMs } : undefined;
  if (!result.success) {
    const errorCode = result.error?.code === "voice_identity_browser_unavailable" ? "voice_identity_browser_unavailable"
      : result.error?.code === "audio_processing_failed" ? "voice_audio_processing_failed"
        : result.error?.code === "audio_storage_unavailable" ? "voice_audio_storage_unavailable"
          : result.error?.code === "invalid_provider_audio" ? "voice_tts_response_invalid"
            : result.error?.code === "speech_generation_timeout" ? "voice_tts_generation_timeout"
              : result.error?.code === "speech_generation_failed" ? "voice_tts_generation_failed"
              : "voice_speech_generation_failed";
    return { audio: null, errorCode, metrics };
  }
  const audio = result.audio instanceof Uint8Array ? Buffer.from(result.audio) : null;
  if (result.audioId) await desktopSpeechService.removeTemporary(result.audioId).catch(() => false);
  return audio ? { audio, metrics } : { audio: null, errorCode: "voice_tts_response_invalid", metrics };
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vadAssetNames = new Set([
  "silero_vad_v6.onnx", "vad.worklet.bundle.min.js",
  "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
]);
protocol.registerSchemesAsPrivileged([{ scheme: "nexa-vad", privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

function registerVadAssets(): void {
  protocol.handle("nexa-vad", async (request) => {
    const url = new URL(request.url);
    const name = url.hostname === "assets" && !url.search && !url.hash ? url.pathname.slice(1) : "";
    if (!vadAssetNames.has(name)) return new Response(null, { status: 404 });
    const source = name === "silero_vad_v6.onnx" || name === "vad.worklet.bundle.min.js"
      ? resolve(appRoot, "node_modules", "@ricky0123", "vad-web", "dist", name)
      : resolve(appRoot, "node_modules", "onnxruntime-web", "dist", name);
    const path = app.isPackaged ? resolve(appRoot, "dist", "vad", name) : source;
    try {
      const bytes = await readFile(path);
      const contentType = name.endsWith(".js") || name.endsWith(".mjs") ? "text/javascript"
        : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return new Response(bytes, { headers: { "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } });
    } catch { return new Response(null, { status: 404 }); }
  });
}
const repositoryRoot = resolve(appRoot, "..", "..");
async function readPreparedVoiceAcknowledgement(id: "clear" | "review" | "moment"): Promise<Uint8Array | null> {
  const filePath = resolve(repositoryRoot, "apps", "desktop", "resources", "voice-acknowledgements", `${id}.wav`);
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 44 || info.size > 4 * 1024 * 1024) return null;
    const audio = await readFile(filePath);
    if (audio.byteLength !== info.size || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE"
      || audio.readUInt32LE(4) + 8 !== audio.byteLength || audio.readUInt16LE(20) !== 1
      || audio.readUInt16LE(22) !== 2 || audio.readUInt16LE(34) !== 16) return null;
    return audio;
  } catch { return null; }
}
const desktopModuleVersion = "LOG-CLEANUP-01";
const desktopIsolation = prepareDesktopIsolation({ app, repositoryRoot });
const startupPolicy = desktopStartupPolicy(Boolean(desktopIsolation), desktopIsolation?.organicPilot ?? false);
if (startupPolicy.loadRootEnvironment) loadRootEnvironment(repositoryRoot);
const syntheticMemoryStoreCandidate = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "Nexa", "Temporary", "memory-desktop-01", "nexa-memory2-synthetic-desktop-v5.json")
  : undefined;
const desktopDiagnosticsEnabled = process.env.NEXA_DIAGNOSTICS === "true";
const audioDuckingDiagnosticsEnabled = process.env.NEXA_AUDIO_DUCKING_DIAGNOSTICS === "true";
let audioDuckingShutdownStarted = false;
let audioDuckingClosed = false;
const desktopAudioDucking = createAudioSessionDucking({ diagnostics: (event, details) => {
  const traceEvent = `audio_ducking_${event}`;
  if (!audioDuckingDiagnosticsEnabled) {
    writeSafeTrace("voice_audio", traceEvent, { ...details });
    return;
  }
  const safeDetails = Object.fromEntries(Object.entries(details).filter(([key, value]) =>
    ["stage", "code", "component", "endpointRole", "errorStage", "sessionCount", "enumeratedSessions", "activeSessions", "excludedOwnedSessions", "excludedSystemSessions",
      "attemptedSessions", "changedSessions", "spotifySessionsFound", "spotifySessionsAttempted", "spotifySessionsChanged",
      "spotifyPreflightSkipped", "spotifyFailureStage", "spotifyFailureHResult",
      "endReason",
      "failedSessions", "failureStage", "failureHResult", "errorName", "errorCode"].includes(key)
    && (value === null || ["string", "number", "boolean"].includes(typeof value))));
  const line = `[nexa-desktop] ${JSON.stringify({ area: "voice_audio", event: traceEvent,
    timestamp: new Date().toISOString(), ...safeDetails })}`;
  if (event === "failed") console.error(line);
  else console.info(line);
} });
if (startupPolicy.registerAuthorization) microsoftAuth.configureCachePath(resolveMicrosoftTokenPath(repositoryRoot));
const rendererFile = resolve(appRoot, "dist", "index.html");
const rendererEntryPoint = selectRendererEntryPoint(
  app.isPackaged,
  process.env.VITE_DEV_SERVER_URL,
  rendererFile,
);
const rendererEntryPointUrl = rendererEntryPoint.kind === "url"
  ? rendererEntryPoint.url
  : pathToFileURL(rendererEntryPoint.filePath).href;
const desktopRestart = createDesktopRestartController(app, app.isPackaged,
  rendererEntryPoint.kind === "url" && process.env.NEXA_DEV_RESTART_EXIT_CODE === String(DEV_RESTART_EXIT_CODE));
const publicVoiceApiUrl = pathToFileURL(resolve(appRoot, "dist-electron", "voice", "index.js")).href;
let mainWindow: BrowserWindow | null = null;
let conversationRuntime: ConversationRuntimeApi | null = null;
let organicPilotSession: Awaited<ReturnType<typeof createSyntheticOrganicPilotSession>> | null = null;
let spotifyLiveStatusService: SpotifyLiveStatusService | null = null;
let closingRuntime = false;
let runtimeClosed = false;
const windowPreferencesStore = createWindowPreferencesStore(app.getPath("userData"));
const memoryModePreferencesStore = createMemoryModePreferencesStore(app.getPath("userData"));

function windowDisplays() {
  return describeDisplays(screen.getAllDisplays() as ScreenDisplayLike[], screen.getPrimaryDisplay().id);
}

function createDesktopConversationRuntime(memoryMode: "memory1" | "memory2-readonly" | "memory2-confirmed-write", storePath?: string): ConversationRuntimeApi {
  const organicHost = memoryMode === "memory2-confirmed-write" && storePath
    ? createDesktopOrganicMemoryHost({ storePath }) : null;
  const agentOptions = !startupPolicy.allowRuntimeTools
    ? { getTools: () => [], ask: async () => { throw new Error("desktop_isolation_provider_disabled"); }, logger: writeAgentTrace }
    : { logger: writeAgentTrace };
  const runtime = createConversationRuntime({
    memoryMode,
    ...(storePath ? { storePath } : {}),
    operationalDiagnostics: desktopOperationalDiagnostics,
    agentOptions: { ...agentOptions,
      operationalMemoryStoreIdentity: memoryMode === "memory2-confirmed-write" ? "personal_memory2"
        : basename(storePath ?? "") === "nexa-memory2-synthetic-desktop-v5.json" ? "synthetic_memory_desktop_01"
          : memoryMode === "memory1" ? "not_applicable" : "unknown",
      ...(memoryMode === "memory2-confirmed-write" ? { allowConfirmedMemoryWrites: true,
        enableOrganicMemoryLearning: true, organicMemoryAuthorizationFactory: organicHost?.authorizationFactory,
        organicEvidenceCapabilityFactory: organicHost?.evidenceCapabilityFactory } : {}) },
    diagnostic: (event: Record<string, unknown>) => {
      const { event: name, ...details } = event;
      writeSafeTrace("runtime", String(name), details);
    },
  }) as ConversationRuntimeApi;
  if (!organicHost) return runtime;
  return Object.freeze({ ...runtime, close: async () => { organicHost.revoke(); await runtime.close(); } }) as ConversationRuntimeApi;
}

function resolveApprovedMemory2StorePath(): string | null {
  return resolveSyntheticMemory2StorePath(syntheticMemoryStoreCandidate, repositoryRoot);
}

function resolveApprovedMemory2WriteStorePath(): string | null {
  return resolvePersonalMemory2StorePath(repositoryRoot);
}

async function prepareApprovedMemory2WriteStore(storePath: string): Promise<void> {
  const approvedPath = resolveApprovedMemory2WriteStorePath();
  if (!approvedPath || resolve(approvedPath) !== resolve(storePath)) throw new Error("memory2_write_store_path_rejected");
  await mkdir(dirname(approvedPath), { recursive: true });
  if (resolveApprovedMemory2WriteStorePath() !== approvedPath) throw new Error("memory2_write_store_path_rejected");
  await initializeEmptyMemoryStore({ storePath: approvedPath });
}

let windowPreferences: WindowPreferences = { displayId: "", startFullscreen: true };
let windowPlacementDepth = 0;
let windowPlacementTarget: { displayId: string; fullscreen: boolean } | null = null;
let windowOperationSequence = 0;
let activeWindowOperationId: string | null = null;
const enqueueWindowOperation = createWindowOperationQueue();

function createWindowOperationId(): string {
  windowOperationSequence += 1;
  return `window-op-${windowOperationSequence}`;
}

function traceWindowOperation(operationId: string | null, event: string, details: Record<string, unknown> = {}) {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  let actualDisplayId: string | null = null;
  let actualFullscreen: boolean | null = null;
  let actualMaximized: boolean | null = null;
  if (window) {
    try {
      bounds = window.getBounds();
      actualDisplayId = String(screen.getDisplayMatching(bounds).id);
      actualFullscreen = window.isFullScreen();
      actualMaximized = window.isMaximized();
    } catch { /* Keep unreadable native state explicitly unknown. */ }
  }
  writeSafeTrace("window", event, { ...details, operationId: operationId ?? "unattributed",
    phase: details.phase ?? "native_state_observed", actualDisplayId, actualFullscreen, actualMaximized,
    currentX: bounds?.x ?? null, currentY: bounds?.y ?? null,
    currentWidth: bounds?.width ?? null, currentHeight: bounds?.height ?? null,
    persistedDisplayId: windowPreferences.displayId, persistedFullscreen: windowPreferences.startFullscreen,
    transitioning: windowPlacementDepth > 0, transitionTargetDisplayId: windowPlacementTarget?.displayId ?? null,
    transitionTargetFullscreen: windowPlacementTarget?.fullscreen ?? null });
}

function getWindowSettings() {
  const displays = windowDisplays();
  const visiblePreferences = normalizeWindowPreferences(windowPreferences, displays);
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const effectiveFullscreen = window ? window.isFullScreen() : visiblePreferences.startFullscreen;
  const effectiveDisplayId = window
    ? String(screen.getDisplayMatching(window.getBounds()).id)
    : visiblePreferences.displayId;
  return { displays, preferences: visiblePreferences, effectiveFullscreen, effectiveDisplayId,
    transitioning: windowPlacementDepth > 0,
    transitionTargetFullscreen: windowPlacementTarget?.fullscreen ?? null,
    transitionTargetDisplayId: windowPlacementTarget?.displayId ?? null };
}

function publishWindowSettings() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try { mainWindow.webContents.send(WINDOW_SETTINGS_CHANGED_CHANNEL, getWindowSettings()); }
  catch { /* Renderer synchronization must not interrupt native window transitions. */ }
}

function handleFullscreenChanged(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  traceWindowOperation(activeWindowOperationId, "fullscreen_event_received", {
    phase: "electron_event_received", eventName: window.isFullScreen() ? "enter-full-screen" : "leave-full-screen",
  });
  publishWindowSettings();
}

function persistWindowPreferences(operationId: string, reason: string) {
  windowPreferencesStore.write(windowPreferences);
  traceWindowOperation(operationId, "window_preferences_persisted", { phase: "preference_write_confirmed", reason,
    persistedDisplayId: windowPreferences.displayId, persistedFullscreen: windowPreferences.startFullscreen });
  publishWindowSettings();
}

function transitionFullscreen(window: BrowserWindow, mode: boolean | "toggle", origin: "startup" | "f11", correlatedOperationId?: string) {
  return enqueueWindowOperation(async () => {
    if (window.isDestroyed()) return false;
    const operationId = correlatedOperationId ?? createWindowOperationId();
    activeWindowOperationId = operationId;
    const requestedFullscreen = mode === "toggle" ? !window.isFullScreen() : mode;
    const targetDisplayId = String(screen.getDisplayMatching(window.getBounds()).id);
    windowPlacementTarget = { displayId: targetDisplayId, fullscreen: requestedFullscreen };
    windowPlacementDepth++;
    publishWindowSettings();
    traceWindowOperation(operationId, "fullscreen_transition_requested", { phase: "request_recorded", origin, targetDisplayId,
      requestedFullscreen, requestedDisplayId: targetDisplayId, initialDisplayId: targetDisplayId,
      initialFullscreen: window.isFullScreen() });
    let success = false;
    try {
      success = await setFullscreenAndWait(window, requestedFullscreen, 2_500, (details) =>
        traceWindowOperation(operationId, "fullscreen_transition_phase", details));
      return success;
    } finally {
      windowPlacementDepth--;
      if (windowPlacementDepth === 0) windowPlacementTarget = null;
      const nextPreference = fullscreenPreferenceAfterTransition(windowPreferences.startFullscreen,
        requestedFullscreen, origin, success);
      if (nextPreference !== windowPreferences.startFullscreen) {
        windowPreferences = { ...windowPreferences, startFullscreen: nextPreference };
        persistWindowPreferences(operationId, "f11_confirmed");
      } else publishWindowSettings();
      traceWindowOperation(operationId, "fullscreen_transition_result", { phase: "native_state_confirmed", origin, targetDisplayId,
        requestedFullscreen, requestedDisplayId: targetDisplayId, success });
      activeWindowOperationId = null;
    }
  });
}

async function placeWindowNow(window: BrowserWindow, fullscreen: boolean, displayId: string, correlatedOperationId?: string) {
  const operationId = correlatedOperationId ?? createWindowOperationId();
  activeWindowOperationId = operationId;
  const displays = screen.getAllDisplays() as ScreenDisplayLike[];
  const selected = displays.find((display) => String(display.id) === displayId)
    ?? displays.find((display) => String(display.id) === String(screen.getPrimaryDisplay().id));
  if (!selected) {
    activeWindowOperationId = null;
    return { success: false, targetDisplayId: displayId, actualDisplayId: null, bounds: null,
      fullscreen: window.isDestroyed() ? false : window.isFullScreen(), boundsMatch: false, dpiAdjusted: false };
  }
  const bounds = centeredWindowBounds(selected);
  const current = window.isDestroyed() ? null : screen.getDisplayMatching(window.getBounds()) as ScreenDisplayLike;
  windowPlacementTarget = { displayId: String(selected.id), fullscreen };
  windowPlacementDepth++;
  publishWindowSettings();
  const sourceBounds = window.isDestroyed() ? null : window.getBounds();
  traceWindowOperation(operationId, "placement_started", { phase: "request_recorded", targetDisplayId: String(selected.id),
    requestedDisplayId: String(selected.id), initialDisplayId: current ? String(current.id) : null,
    requestedFullscreen: fullscreen, initialFullscreen: window.isDestroyed() ? false : window.isFullScreen(),
    initialMaximized: window.isDestroyed() ? false : window.isMaximized(),
    initialX: sourceBounds?.x ?? null, initialY: sourceBounds?.y ?? null,
    initialWidth: sourceBounds?.width ?? null, initialHeight: sourceBounds?.height ?? null,
    targetX: bounds.x, targetY: bounds.y, targetWidth: bounds.width, targetHeight: bounds.height,
    targetWorkAreaX: selected.workArea.x, targetWorkAreaY: selected.workArea.y,
    targetWorkAreaWidth: selected.workArea.width, targetWorkAreaHeight: selected.workArea.height,
    targetDisplayBoundsX: selected.bounds.x, targetDisplayBoundsY: selected.bounds.y,
    targetDisplayBoundsWidth: selected.bounds.width, targetDisplayBoundsHeight: selected.bounds.height,
    targetScaleFactor: selected.scaleFactor ?? 1, sourceScaleFactor: current?.scaleFactor ?? 1 });
  try {
    const placement = await applyWindowPlacement(window, bounds, fullscreen, String(selected.id),
      (windowBounds) => String(screen.getDisplayMatching(windowBounds).id),
      (details) => traceWindowOperation(operationId, "placement_phase", details), selected.scaleFactor ?? 1, current?.scaleFactor ?? 1);
    return placement;
  } finally {
    windowPlacementDepth--;
    if (windowPlacementDepth === 0) windowPlacementTarget = null;
    publishWindowSettings();
    activeWindowOperationId = null;
  }
}

async function updateWindowPreferences(preferences: WindowPreferences) {
  return enqueueWindowOperation(async () => {
    const operationId = createWindowOperationId();
    traceWindowOperation(operationId, "settings_update_received", { phase: "request_received",
      requestedDisplayId: preferences.displayId, requestedFullscreen: preferences.startFullscreen });
    const displays = windowDisplays();
    const normalized = normalizeWindowPreferences(preferences, displays);
    if (normalized.displayId !== preferences.displayId) throw new Error("display_unavailable");
    const desiredFullscreen = resolveFullscreenForSettingsUpdate(windowPreferences, normalized);
    const fullscreenPreferenceChanged = desiredFullscreen !== windowPreferences.startFullscreen;
    if (fullscreenPreferenceChanged) {
      windowPreferences = { ...windowPreferences, startFullscreen: fullscreenPreferenceAfterTransition(
        windowPreferences.startFullscreen, desiredFullscreen, "settings", false) };
      persistWindowPreferences(operationId, "settings_intent");
    }
    if (mainWindow) {
      const placement = await placeWindowNow(mainWindow, desiredFullscreen, normalized.displayId, operationId);
      if (!placement.success) throw new Error("window_placement_failed");
      windowPreferences = preferencesAfterPlacement(windowPreferences, normalized.displayId, placement.success);
      persistWindowPreferences(operationId, "placement_confirmed");
    } else {
      windowPreferences = preferencesAfterPlacement(windowPreferences, normalized.displayId, true);
      windowPreferencesStore.write(windowPreferences);
    }
    const result = getWindowSettings();
    traceWindowOperation(operationId, "settings_update_completed", { phase: "native_state_confirmed",
      requestedDisplayId: normalized.displayId, requestedFullscreen: desiredFullscreen,
      success: result.effectiveDisplayId === normalized.displayId && result.effectiveFullscreen === desiredFullscreen });
    return result;
  });
}

function writeSafeTrace(area: string, event: string, details: Record<string, unknown>): void {
  const safeFields = ["conversationId", "requestId", "source", "status", "origin", "durationMs", "errorName", "errorCode", "moduleVersion",
    "iteration", "finalOnly", "type", "toolCallCount", "tool", "success", "code", "permission", "allowed",
    "reason", "target", "initiator", "appQuery", "resolution", "isInPlace", "mainFrame", "prevented",
    "httpStatus", "outcome", "stage", "reconciliation", "bodyKind", "bodyLength", "contentType",
    "verification", "providerResponse", "providerStatus", "stateConfirmed", "providerAccepted",
    "beforePlaying", "afterPlaying", "trackChanged", "requestedTargetMatched", "previousTrackRestartObserved",
    "requestHost", "requestPath", "responseHost", "responsePath", "redirected", "responseType", "method", "initializationMessage",
    "targetDisplayId", "actualDisplayId", "beforeX", "beforeY", "beforeWidth", "beforeHeight", "requestedX",
    "requestedY", "requestedWidth", "requestedHeight", "finalX", "finalY", "finalWidth", "finalHeight",
    "requestedFullscreen", "actualFullscreen", "initialFullscreen", "actualMaximized", "initialMaximized", "maximized",
    "persistedFullscreen", "transitioning", "success", "targetScaleFactor", "sourceScaleFactor", "boundsMatch", "dpiAdjusted", "placementSuccess",
    "operationId", "phase", "eventName", "command", "initialDisplayId", "requestedDisplayId", "persistedDisplayId",
    "transitionTargetDisplayId", "transitionTargetFullscreen", "currentX", "currentY", "currentWidth", "currentHeight",
    "initialX", "initialY", "initialWidth", "initialHeight", "targetX", "targetY", "targetWidth", "targetHeight",
    "targetWorkAreaX", "targetWorkAreaY", "targetWorkAreaWidth", "targetWorkAreaHeight", "targetDisplayBoundsX",
    "targetDisplayBoundsY", "targetDisplayBoundsWidth", "targetDisplayBoundsHeight", "stableSamples", "checkpoint", "failurePhase"];
  const safeDetails = Object.fromEntries(safeFields.filter((key) => {
    const value = details[key];
    return value === null || ["string", "number", "boolean"].includes(typeof value);
  }).map((key) => [key, details[key]]));
  const disposition = desktopTraceDisposition(desktopDiagnosticsEnabled, area, event, safeDetails);
  if (disposition === "silent") return;
  const line = `[nexa-desktop] ${JSON.stringify({ area, event, timestamp: new Date().toISOString(), ...safeDetails })}`;
  if (disposition === "error") console.error(line);
  else if (disposition === "warning") console.warn(line);
  else console.info(line);
}

function writeAgentTrace(event: string, details: Record<string, unknown>): void {
  writeSafeTrace("agent", event, details);
}

function classifyNavigationTarget(targetUrl: string): string {
  try {
    const target = new URL(targetUrl);
    const renderer = new URL(rendererEntryPointUrl);
    if (target.protocol !== renderer.protocol) return "other_scheme";
    if (target.protocol === "file:") return target.pathname === renderer.pathname ? "renderer_file" : "other_file";
    return target.origin === renderer.origin ? "renderer_origin" : "other_origin";
  } catch {
    return "invalid";
  }
}

function createMainWindow(): BrowserWindow {
  const startupOperationId = createWindowOperationId();
  const snapshot = getWindowSettings();
  windowPreferences = snapshot.preferences;
  windowPreferencesStore.write(windowPreferences);
  const display = (screen.getAllDisplays() as ScreenDisplayLike[])
    .find((item) => String(item.id) === windowPreferences.displayId)
    ?? (screen.getPrimaryDisplay() as ScreenDisplayLike);
  const bounds = centeredWindowBounds(display);
  const window = new BrowserWindow({
    ...bounds, minWidth: Math.min(840, bounds.width), minHeight: Math.min(600, bounds.height),
    title: "Nexa Desktop", show: false, ...FRAMELESS_WINDOW_OPTIONS,
    webPreferences: createSecureWebPreferences(
      resolve(appRoot, "dist-electron", "preload.cjs"),
      [...(desktopIsolation ? [DESKTOP_RENDERER_ISOLATION_ARGUMENT] : []),
        ...(organicPilotSession?.host.active ? [DESKTOP_RENDERER_ORGANIC_PILOT_ARGUMENT] : [])],
    ),
  });
  window.once("ready-to-show", () => {
    traceWindowOperation(startupOperationId, "ready_to_show", { phase: "electron_event_received",
      requestedDisplayId: windowPreferences.displayId, requestedFullscreen: windowPreferences.startFullscreen });
    window.show();
    traceWindowOperation(startupOperationId, "window_show_called", { phase: "command_returned" });
    void transitionFullscreen(window, windowPreferences.startFullscreen, "startup", startupOperationId).catch(() => {
      writeSafeTrace("window", "fullscreen_transition_error", { origin: "startup", errorCode: "transition_failed" });
    });
    spotifyLiveStatusService?.setWindowVisible(true);
    console.info("[nexa-desktop] Nexa Desktop listo");
  });
  window.on("show", () => {
    traceWindowOperation(activeWindowOperationId, "window_show_event", { phase: "electron_event_received", eventName: "show" });
    spotifyLiveStatusService?.setWindowVisible(true);
  });
  window.on("restore", () => spotifyLiveStatusService?.setWindowVisible(true));
  window.on("hide", () => spotifyLiveStatusService?.setWindowVisible(false));
  window.on("minimize", () => spotifyLiveStatusService?.setWindowVisible(false));
  window.on("enter-full-screen", () => handleFullscreenChanged(window));
  window.on("leave-full-screen", () => handleFullscreenChanged(window));
  window.on("maximize", () => traceWindowOperation(activeWindowOperationId, "native_window_event", {
    phase: "electron_event_received", eventName: "maximize",
  }));
  window.on("unmaximize", () => traceWindowOperation(activeWindowOperationId, "native_window_event", {
    phase: "electron_event_received", eventName: "unmaximize",
  }));
  window.on("move", () => traceWindowOperation(activeWindowOperationId, "native_window_event", {
    phase: "electron_event_received", eventName: "move",
  }));
  window.on("resize", () => traceWindowOperation(activeWindowOperationId, "native_window_event", {
    phase: "electron_event_received", eventName: "resize",
  }));
  window.on("closed", () => {
    cleanupChatWindow(window, "window_closed");
    cleanupVoiceWindow(window);
    spotifyLiveStatusService?.setWindowVisible(false);
    spotifyLiveStatusService?.setRendererVisible(false);
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  registerVoiceWindowNavigation(window as never, rendererEntryPointUrl);
  window.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    writeSafeTrace("chat_ipc", "renderer_navigation_started", {
      target: classifyNavigationTarget(url), isInPlace, mainFrame: isMainFrame,
    });
  });
  registerChatNavigationHandlers(
    window.webContents,
    rendererEntryPointUrl,
    classifyNavigationTarget,
    () => cleanupChatWindow(window, "navigation"),
    (event, details) => writeSafeTrace("chat_ipc", event, details),
  );
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("before-input-event", (event, input) => {
    if (isFullscreenToggleInput(input)) {
      event.preventDefault();
      void transitionFullscreen(window, "toggle", "f11").catch(() => {
        writeSafeTrace("window", "fullscreen_transition_error", { origin: "f11", errorCode: "transition_failed" });
      });
    }
  });
  writeSafeTrace("desktop", "renderer_entrypoint_load_requested", {
    source: "main_window_startup", target: classifyNavigationTarget(rendererEntryPointUrl),
  });
  void loadRendererEntryPoint(rendererEntryPoint, {
    loadURL: (url) => window.loadURL(url),
    loadFile: (filePath) => window.loadFile(filePath),
  });
  mainWindow = window;
  traceWindowOperation(startupOperationId, "browser_window_created", { phase: "browser_window_created",
    requestedDisplayId: String(display.id), requestedFullscreen: windowPreferences.startFullscreen,
    initialDisplayId: String(screen.getDisplayMatching(window.getBounds()).id), initialFullscreen: window.isFullScreen(),
    initialMaximized: window.isMaximized() });
  return window;
}

function installWebContentsGuards(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, targetUrl) => {
      if (!isAllowedNavigation(targetUrl, rendererEntryPointUrl)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

  app.whenReady().then(async () => {
  registerVadAssets();
  if (desktopIsolation?.organicPilot) {
    try {
      organicPilotSession = await createSyntheticOrganicPilotSession({ storePath: desktopIsolation.memoryStorePath,
        repositoryRoot, localAppData: process.env.LOCALAPPDATA,
        agentOptions: { logger: writeAgentTrace },
      });
      conversationRuntime = organicPilotSession.runtime as ConversationRuntimeApi;
    } catch {
      console.error("[nexa-desktop] synthetic organic pilot validation failed; no memory fallback was used");
      app.quit();
      return;
    }
  } else if (desktopIsolation) {
    try {
      await validateIsolatedMemoryStore(desktopIsolation.memoryStorePath, openExistingMemory2Reader);
    } catch {
      console.error("[nexa-desktop] isolated Memory 2 store validation failed");
      app.quit();
      return;
    }
  }
  if (desktopIsolation) {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
  }
  writeSafeTrace("desktop", "module_loaded", { moduleVersion: desktopModuleVersion });
  Menu.setApplicationMenu(null);
  installWebContentsGuards();
  registerIpcHandlers(
    () => mainWindow,
    () => startupPolicy.readSystemWallpaper ? getWindowsWallpaper(app.getPath("appData")) : Promise.resolve({ available: false }),
    { get: getWindowSettings, set: updateWindowPreferences },
    undefined,
    () => desktopRestart.request(),
  );
  if (startupPolicy.registerExternalServices) {
    registerWeatherIpcHandler(() => mainWindow);
    ipcMain.handle(SPOTIFY_OPEN_TRACK_CHANNEL, async (event, value: unknown) => {
      if (!mainWindow || !isTrustedIpcSender(event as never, mainWindow as never)) throw new Error("untrusted_ipc_sender");
      const url = canonicalSpotifyTrackUrl(value);
      if (!url) return false;
      try { await shell.openExternal(url); return true; }
      catch { return false; }
    });
    spotifyLiveStatusService = registerSpotifyLiveStatusHandlers(() => mainWindow, undefined, undefined,
      (event, details) => writeSafeTrace("spotify", event, details));
    spotifyLiveStatusService.start();
    if (startupPolicy.registerVoice) {
      registerVoiceIpcHandlers(
        () => mainWindow,
        rendererEntryPointUrl,
        loadDesktopVoiceApi,
        (event) => {
          const metrics = event.metrics ?? {};
          const duration = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
          const stageKey = event.stage === "transcription" ? "transcriptionMs" : event.stage === "runtime" ? "runtimeMs"
            : event.stage === "playback" ? "playbackMs" : null;
          const synthesisMs = duration(metrics.synthesisMs);
          const ttsSdkResponseMs = duration(metrics.ttsSdkResponseMs);
          const ttsBodyReadMs = duration(metrics.ttsBodyReadMs);
          const identityProcessingMs = duration(metrics.identityProcessingMs);
          const identityServerStartupMs = duration(metrics.identityServerStartupMs);
          const identityBrowserStartupMs = duration(metrics.identityBrowserStartupMs);
          const identityRendererPreparationMs = duration(metrics.identityRendererPreparationMs);
          const identityDspSetupMs = duration(metrics.identityDspSetupMs);
          const identityDspProcessingMs = duration(metrics.identityDspProcessingMs);
          const identityAudioCaptureWaitMs = duration(metrics.identityAudioCaptureWaitMs);
          const identityPostProcessingMs = duration(metrics.identityPostProcessingMs);
          const audioReadyMs = duration(metrics.audioReadyMs);
          const audioPreparationMs = [duration(metrics.storageInitializationMs), duration(metrics.audioSaveMs)]
            .filter((value): value is number => value !== null).reduce((sum, value) => sum + value, 0);
          desktopOperationalDiagnostics.recordVoiceOperation({ requestId: event.requestId, stage: event.stage, state: event.state,
            errorCode: event.errorCode, durationMs: event.durationMs, cancellation: event.cancellation,
            followupOutcome: typeof metrics.followupOutcome === "string" ? metrics.followupOutcome : null,
            ...desktopVoiceConfiguration,
            durations: { ...(stageKey ? { [stageKey]: event.durationMs } : {}), synthesisMs, ttsSdkResponseMs, ttsBodyReadMs, identityProcessingMs,
              identityServerStartupMs, identityBrowserStartupMs, identityRendererPreparationMs, identityDspSetupMs,
              identityDspProcessingMs, identityAudioCaptureWaitMs, identityPostProcessingMs, audioReadyMs,
              audioPreparationMs: audioPreparationMs || null,
              pttFinalizationMs: duration(metrics.pttFinalizationMs), audioConversionMs: duration(metrics.audioConversionMs),
              speechInitializationMs: duration(metrics.speechInitializationMs),
              playbackCommandStartMs: duration(metrics.playbackCommandStartMs),
              responseDispatchToPlaybackMs: duration(metrics.responseDispatchToPlaybackMs),
              responseDispatchToSynthesisMs: duration(metrics.responseDispatchToSynthesisMs),
              responseDispatchToAudioReadyMs: duration(metrics.responseDispatchToAudioReadyMs),
              audioReadyToPlaybackMs: duration(metrics.audioReadyToPlaybackMs),
              playbackMs: event.stage === "playback" ? event.durationMs : null },
          });
        },
        (id) => readPreparedVoiceAcknowledgement(id),
        (text, signal) => prepareDesktopVoiceResponseAudio(text, signal),
        desktopAudioDucking,
      );
    }
  }
  const savedMemoryMode = desktopIsolation?.organicPilot
    ? { mode: "memory1" as const, invalid: false }
    : memoryModePreferencesStore.read();
  const initialMemorySelection = desktopIsolation
    ? { mode: savedMemoryMode.mode ?? "memory1" as const,
      fallbackReason: savedMemoryMode.invalid ? "invalid_preference" as const : null }
    : resolveInitialDesktopMemoryMode(savedMemoryMode);
  let initialMemoryMode = initialMemorySelection.mode;
  let memoryModeFallbackReason: MemoryModeFallbackReason = initialMemorySelection.fallbackReason;
  let initialMemoryStorePath: string | undefined;
  if (initialMemoryMode === "memory2-readonly") {
    const storePath = resolveApprovedMemory2StorePath();
    if (await isApprovedSyntheticStore(storePath, openExistingMemory2Reader)) initialMemoryStorePath = storePath ?? undefined;
    else {
      memoryModeFallbackReason = "mode_unavailable";
      console.error("[nexa-desktop] selected Memory 2 read-only store is unavailable; startup stopped");
      app.quit();
      return;
    }
  } else if (initialMemoryMode === "memory2-confirmed-write") {
    const storePath = resolveApprovedMemory2WriteStorePath();
    try {
      if (!storePath) throw new Error("memory2_write_store_unavailable");
      await prepareApprovedMemory2WriteStore(storePath);
      if (!(await isReadableMemory2Store(storePath, openExistingMemory2Reader))) throw new Error("memory2_write_store_unreadable");
      initialMemoryStorePath = storePath;
    } catch {
      memoryModeFallbackReason = "mode_unavailable";
      console.error("[nexa-desktop] selected Memory 2 personal store is unavailable; startup stopped");
      app.quit();
      return;
    }
  }
  if (savedMemoryMode.invalid) {
    try { memoryModePreferencesStore.write(initialMemoryMode); } catch { /* The selected Memory 2 mode remains active for this session. */ }
  }
  if (!desktopIsolation?.organicPilot) {
    conversationRuntime = createDesktopConversationRuntime(initialMemoryMode, initialMemoryStorePath);
  }
  if (startupPolicy.registerChat) {
    registerChatIpcHandlers(() => mainWindow, () => conversationRuntime, ipcMain, (event, details) => {
      writeSafeTrace("chat_ipc", event, details);
    }, {
      onNewInteraction: (requestId, source) => {
        if (mainWindow) discardTypedChatVoiceResponse(mainWindow as never);
        cancelVoiceSpeech(mainWindow as never, "superseded");
        if (source === "voice") continueVoiceDuckingForRequest(requestId);
        else releaseVoiceDuckingExcept(requestId);
      },
      onVoiceRequestTerminal: (requestId) => { releaseVoiceDuckingForRequest(requestId); },
      onVoiceResponse: (window, requestId, response) => { void speakVoiceResponse(window as never, requestId, response); },
      onTypedResponse: (window, requestId, response) => { rememberTypedChatResponse(window as never, requestId, response); },
      onVoiceResponseDispatched: (requestId) => markVoiceResponseDispatched(requestId),
      onVoiceRuntimeCompleted: (_window, requestId, durationMs) => {
        desktopOperationalDiagnostics.recordVoiceOperation({ requestId, stage: "runtime", state: "success", durationMs,
          ...desktopVoiceConfiguration, durations: { runtimeMs: durationMs } });
      },
    });
    if (startupPolicy.registerMemoryMode) registerMemoryModeIpcHandlers({
      getWindow: () => mainWindow,
      getRuntime: () => conversationRuntime,
      setRuntime: (runtime) => { conversationRuntime = runtime as ConversationRuntimeApi | null; },
      createRuntime: (mode, storePath) => createDesktopConversationRuntime(mode, storePath),
      resolveStorePath: resolveApprovedMemory2StorePath,
      resolveWriteStorePath: resolveApprovedMemory2WriteStorePath,
      prepareWriteStore: prepareApprovedMemory2WriteStore,
      openReader: openExistingMemory2Reader as never,
      beginRuntimeSwitch: beginChatRuntimeSwitch,
      refreshRuntimeAfterSwitch: refreshChatRuntimeAfterSwitch,
      endRuntimeSwitch: endChatRuntimeSwitch,
      initialMode: initialMemoryMode,
      initialFallbackReason: memoryModeFallbackReason,
      preferencesStore: memoryModePreferencesStore,
    });
  }
  if (startupPolicy.registerAuthorization) {
    registerAuthorizationIpcHandlers(() => mainWindow, {
      microsoft: async () => microsoftAuth.connect(),
      spotify: async (signal) => {
        const result = await authorizeSpotify({
          signal,
          output: () => undefined,
          browserOpener: async (rawUrl: string) => {
            const url = new URL(rawUrl);
            if (url.protocol !== "https:" || url.hostname !== "accounts.spotify.com" || url.pathname !== "/authorize") {
              throw new Error("spotify_authorization_url_rejected");
            }
            await shell.openExternal(url.toString());
          },
        });
        if (result?.success !== false) void spotifyLiveStatusService?.refresh();
        return result;
      },
    });
  }
  if (startupPolicy.registerVoice) {
    registerVoiceMicrophonePermissions(
      session.defaultSession,
      () => mainWindow,
      rendererEntryPointUrl,
    );
  }
  windowPreferences = normalizeWindowPreferences(windowPreferencesStore.read(), windowDisplays());
  writeSafeTrace("window", "startup_preferences_loaded", { phase: "persisted_state_loaded",
    persistedDisplayId: windowPreferences.displayId, persistedFullscreen: windowPreferences.startFullscreen });
  createMainWindow();
  const reconcileDisplays = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void enqueueWindowOperation(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return undefined;
      const normalized = normalizeWindowPreferences(windowPreferences, windowDisplays());
      const targetDisplayId = normalized.displayId;
      const operationId = createWindowOperationId();
      const placement = await placeWindowNow(mainWindow, mainWindow.isFullScreen(), targetDisplayId, operationId);
      if (placement.success && windowPreferences.displayId !== targetDisplayId) {
        windowPreferences = preferencesAfterPlacement(windowPreferences, targetDisplayId, true);
        persistWindowPreferences(operationId, "display_reconciliation_confirmed");
      }
      return placement;
    });
  };
  screen.on("display-added", reconcileDisplays);
  screen.on("display-removed", reconcileDisplays);
  screen.on("display-metrics-changed", reconcileDisplays);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => desktopRestart.onWillQuit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) createMainWindow();
});
app.on("before-quit", (event) => {
  if (!audioDuckingClosed) {
    event.preventDefault();
    if (audioDuckingShutdownStarted) return;
    audioDuckingShutdownStarted = true;
    void desktopAudioDucking.close().finally(() => {
      audioDuckingClosed = true;
      audioDuckingShutdownStarted = false;
      app.quit();
    });
    return;
  }
  if (conversationRuntime && !runtimeClosed) {
    event.preventDefault();
    if (closingRuntime) return;
    closingRuntime = true;
    if (mainWindow) cleanupChatWindow(mainWindow, "app_quit");
    removeChatIpcHandlers();
    ipcMain.removeHandler(MEMORY_MODE_GET_CHANNEL);
    ipcMain.removeHandler(MEMORY_MODE_SET_CHANNEL);
    removeAuthorizationIpcHandlers();
    const closeRuntime = organicPilotSession ? organicPilotSession.close() : conversationRuntime.close();
    void closeRuntime.catch(() => {
      console.error("[nexa-desktop] conversation runtime close failed");
    }).finally(() => {
      runtimeClosed = true;
      app.quit();
    });
    return;
  }
  if (mainWindow) cleanupChatWindow(mainWindow, "app_quit");
  removeChatIpcHandlers();
  ipcMain.removeHandler(MEMORY_MODE_GET_CHANNEL);
  ipcMain.removeHandler(MEMORY_MODE_SET_CHANNEL);
  removeAuthorizationIpcHandlers();
  removeSpotifyLiveStatusHandlers();
  removeVoiceIpcHandlers();
  if (!desktopSpeechServiceClosed) {
    event.preventDefault();
    if (closingDesktopSpeechService) return;
    void closeDesktopSpeechService().finally(() => app.quit());
    return;
  }
  removeWeatherIpcHandler();
  ipcMain.removeHandler(PING_CHANNEL);
  ipcMain.removeHandler(SPOTIFY_OPEN_TRACK_CHANNEL);
  ipcMain.removeHandler(GET_WALLPAPER_CHANNEL);
  ipcMain.removeHandler(DESKTOP_RESTART_CHANNEL);
  ipcMain.removeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
  ipcMain.removeHandler(WINDOW_SETTINGS_GET_CHANNEL);
  ipcMain.removeHandler(WINDOW_SETTINGS_SET_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_MINIMIZE_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_CLOSE_CHANNEL);
});
