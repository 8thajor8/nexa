import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AuthorizationProvider, ChatAuthorizationRequirement, ChatConversationListCursor, ChatConversationSummary,
  ChatEventEnvelope, ChatIpcErrorCode, ChatMessageCursor, DesktopMemoryMode,
  DesktopMemoryModeResult, SpotifyLiveStatus, SpotifyPlaybackControl, SpotifyNowPlayingCard, VoiceSpeechErrorCode,
  VoiceSpeechEvent, VoiceChatTimingOrigin, VoiceChatTimingPhase, WeatherCurrentStatus } from "../shared/ipc-contract";
import { ASSISTANT_STATE_LABELS, createMockAssistantStateProvider } from "../shared/assistant-state";
import { loadDesktopPreferences, saveDesktopPreferences, type DesktopPreferences } from "./desktop-preferences";
import type { PttVoiceControllerPort, PttVoiceSnapshot, PttVoiceStatus } from "./voice/ptt-voice-controller";
import { VoiceFollowupController, type FollowupTranscript, type VoiceFollowupFailure } from "./voice/voice-followup-controller";
import { ConversationPanel, type ConversationChatMessage, type VoiceTranscriptItem } from "./components/ConversationPanel";
import { ConversationsPanel } from "./components/ConversationsPanel";
import { PresencePanel } from "./components/PresencePanel";
import { Sidebar } from "./components/Sidebar";
import { WindowChrome } from "./components/WindowChrome";
import { DashboardModules } from "./components/DashboardModules";
import { CommandHeader } from "./components/CommandHeader";
import { SettingsModal } from "./components/SettingsModal";
import { welcomeGreeting } from "./conversation-welcome";
import type { MicrophoneDeviceStore } from "./audio/microphone-device-store";

interface AppProps { voiceController: PttVoiceControllerPort; microphoneDevices: MicrophoneDeviceStore; }

const MAX_CHAT_HISTORY = 100;
const VOICE_ACKNOWLEDGEMENT_DELAY_MS = 1_500;
const TYPED_VOICE_ACKNOWLEDGEMENT_DELAY_MS = 2_000;
const CHAT_ERROR_MESSAGES: Partial<Record<ChatIpcErrorCode, string>> = {
  busy: "Ya hay una solicitud activa en esta conversación.",
  conversation_not_found: "La conversación ya no está disponible.",
  runtime_unavailable: "Runtime todavía no está conectado. El mensaje no se envió.",
  request_not_found: "La solicitud ya no está activa. No se recibió su resultado final.",
  cancel_not_accepted: "Runtime no aceptó la solicitud de cancelación.",
  operation_failed: "No se pudo completar la solicitud conversacional.",
};

const VOICE_STATUS_LABELS: Record<PttVoiceStatus, string> = {
  idle: "PTT en espera",
  starting: "Solicitando micrófono",
  listening: "Escuchando",
  finishing: "Preparando audio",
  processing: "Transcribiendo",
  cancelling: "Cancelando sesión",
  recovering: "Recuperando sesión",
  "transcript-ready": "Transcripción lista",
  error: "Error de voz",
  "recovery-required": "Recuperación requerida",
};

const VOICE_SPEECH_ERRORS: Record<VoiceSpeechErrorCode, string> = {
  voice_speech_generation_failed: "No se pudo generar la respuesta hablada.",
  voice_audio_storage_unavailable: "No se pudo preparar el almacenamiento de audio.",
  voice_tts_generation_failed: "El proveedor no pudo generar la respuesta hablada.",
  voice_tts_generation_timeout: "La síntesis de voz tardó demasiado. Podés volver a intentarlo.",
  voice_tts_response_invalid: "El proveedor devolvió un audio no válido.",
  voice_audio_processing_failed: "No se pudo procesar el audio para reproducirlo.",
  voice_identity_browser_unavailable: "Falta el motor local requerido para procesar la identidad vocal.",
  voice_audio_storage_failed: "No se pudo guardar el audio generado.",
  voice_speech_playback_failed: "No se pudo reproducir la respuesta hablada.",
  voice_speech_playback_timeout: "La reproducción de voz tardó demasiado y se detuvo.",
  voice_speech_start_timeout: "Windows no confirmó el inicio de la respuesta hablada.",
  voice_speech_stop_failed: "No se pudo confirmar la interrupción del audio.",
  voice_speech_stop_timeout: "La interrupción del audio tardó demasiado.",
  voice_speech_busy: "La salida de voz todavía está ocupada.",
  voice_speech_degraded: "La salida de voz necesita reiniciarse antes de continuar.",
  voice_speech_too_long: "La respuesta es demasiado larga para reproducirla completa.",
};

const VOICE_FOLLOWUP_ERRORS: Record<VoiceFollowupFailure["code"], string> = {
  microphone_permission_denied: "Nexa no pudo acceder al micrófono para continuar escuchando.",
  microphone_unavailable: "No se encontró un micrófono para continuar escuchando.",
  microphone_device_unavailable: "El micrófono seleccionado no está disponible para continuar escuchando.",
  followup_failed: "No se pudo iniciar el seguimiento de voz.",
};

export default function App({ voiceController, microphoneDevices }: AppProps) {
  // Main sets this immutable startup fact before Preload runs; it is not a permission switch.
  const isIsolated = window.nexaDesktop.isIsolated;
  const isSyntheticOrganicPilot = window.nexaDesktop.isSyntheticOrganicPilot;
  const [preferences, setPreferences] = useState<DesktopPreferences>(() => loadDesktopPreferences());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState<"command" | "conversations">("command");
  const stateProvider = useMemo(() => createMockAssistantStateProvider(), []);
  const assistantState = useSyncExternalStore(
    stateProvider.subscribe, stateProvider.getSnapshot, stateProvider.getSnapshot,
  );
  const voiceSnapshot = useSyncExternalStore(
    voiceController.subscribe, voiceController.getSnapshot, voiceController.getSnapshot,
  );
  const [voiceFollowupError, setVoiceFollowupError] = useState<string | null>(null);
  const followupSubmit = useRef<(value: FollowupTranscript) => void>(() => undefined);
  const followup = useMemo(() => new VoiceFollowupController(window.nexaDesktop.voice, {
    getDeviceId: () => microphoneDevices.getSnapshot().selectedDeviceId,
    onAcceptedTranscript: (value) => followupSubmit.current(value),
    onFailure: (failure) => {
      console.warn("[nexa-desktop] voice_followup_error", failure);
      setVoiceFollowupError(VOICE_FOLLOWUP_ERRORS[failure.code]);
    },
  }), [microphoneDevices]);
  const followupStatus = useSyncExternalStore(followup.subscribe, followup.getSnapshot, followup.getSnapshot);
  const followupEligibleRequests = useRef(new Set<string>());
  const [chatMessages, setChatMessages] = useState<ConversationChatMessage[]>([]);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [authorizationRequirements, setAuthorizationRequirements] = useState<Record<string, ChatAuthorizationRequirement>>({});
  const [authorizationAttempts, setAuthorizationAttempts] = useState<Record<string, { state: "connecting" | "connected" | "cancelled" | "error"; message?: string }>>({});
  const [spotifyNowPlayingCards, setSpotifyNowPlayingCards] = useState<Record<string, SpotifyNowPlayingCard>>({});
  const [spotifyLiveStatus, setSpotifyLiveStatus] = useState<SpotifyLiveStatus>({
    state: "loading", connected: false, deviceAvailable: false, controlsEnabled: false, track: null, message: null, updatedAt: null,
  });
  const [spotifyControlBusy, setSpotifyControlBusy] = useState<SpotifyPlaybackControl | null>(null);
  const [spotifyControlError, setSpotifyControlError] = useState<string | null>(null);
  const [chatConversationId, setChatConversationId] = useState<string | null>(null);
  const [activeConversationEmpty, setActiveConversationEmpty] = useState(false);
  const [welcomeMessage] = useState(() => welcomeGreeting(new Date()));
  const [conversationItems, setConversationItems] = useState<ChatConversationSummary[]>([]);
  const [conversationListCursor, setConversationListCursor] = useState<ChatConversationListCursor | null>(null);
  const conversationListCursorRef = useRef(conversationListCursor);
  conversationListCursorRef.current = conversationListCursor;
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [conversationListError, setConversationListError] = useState<string | null>(null);
  const [conversationOpening, setConversationOpening] = useState(false);
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<ChatMessageCursor | null>(null);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const chatConversationIdRef = useRef(chatConversationId);
  chatConversationIdRef.current = chatConversationId;
  const activeChatRequest = useRef<string | null>(null);
  const knownChatRequests = useRef(new Set<string>());
  const terminalChatRequests = useRef(new Set<string>());
  const acknowledgementTimers = useRef(new Map<string, number>());
  const chatTimingByRequest = useRef(new Map<string, { origin: VoiceChatTimingOrigin; startedAt: number;
    runtimeStartedAt?: number; finalAt?: number; acknowledgementAt?: number; acknowledgementTimerStartedAt?: number;
    firstTextDeltaAt?: number; firstTextRendered?: boolean; rendered?: boolean }>());
  const pendingStreamDeltas = useRef(new Map<string, { delta: string; frameId: number }>());
  const voiceChatRequests = useRef(new Set<string>());
  const completedVoiceChatRequests = useRef(new Set<string>());
  const originalRequestTexts = useRef(new Map<string, string>());
  const [voiceTranscriptNotice, setVoiceTranscriptNotice] = useState<string | null>(null);
  const [voiceSpeechStatus, setVoiceSpeechStatus] = useState<{ requestId: string; state: "preparing" | "speaking" | "cancelling" | "error"; message?: string } | null>(null);
  const [cancellationPending, setCancellationPending] = useState(false);
  const activeVoiceSpeechRequest = useRef<string | null>(null);
  const typedVoiceSpeechRequest = useRef<string | null>(null);
  const typedVoiceReplyRequests = useRef(new Set<string>());
  const typedVoiceFinalSpeechRequests = useRef(new Set<string>());
  const voiceRepliesEnabledRef = useRef(preferences.voiceRepliesEnabled);
  voiceRepliesEnabledRef.current = preferences.voiceRepliesEnabled;
  const reportChatTiming = useCallback((requestId: string, origin: VoiceChatTimingOrigin,
    phase: VoiceChatTimingPhase, durationMs?: number) => {
    void window.nexaDesktop.voice.recordChatTiming({ requestId, origin, phase,
      ...(typeof durationMs === "number" ? { durationMs: Math.max(0, durationMs) } : {}) }).catch(() => undefined);
  }, []);
  const discardStreamUpdate = useCallback((requestId: string, removeMessage = true) => {
    const pending = pendingStreamDeltas.current.get(requestId);
    if (pending) window.cancelAnimationFrame(pending.frameId);
    pendingStreamDeltas.current.delete(requestId);
    if (removeMessage) setChatMessages((current) => current.filter((entry) =>
      !(entry.role === "assistant" && entry.requestId === requestId)));
  }, []);
  const cancellingVoiceSpeechRequests = useRef(new Set<string>());
  const cancellationInFlight = useRef(false);
  const seenTranscriptKeys = useRef(new Set<string>());
  const [weatherStatus, setWeatherStatus] = useState<WeatherCurrentStatus>(() => ({
    available: false, location: preferences.weatherLocation, temperatureC: null, condition: null, updatedAt: 0,
  }));
  const [weatherLoading, setWeatherLoading] = useState(true);
  const wallpaperEnabled = preferences.wallpaperEnabled;
  const [wallpaperDataUrl, setWallpaperDataUrl] = useState<string | null>(null);
  const [wallpaperLoading, setWallpaperLoading] = useState(false);
  const [wallpaperMessage, setWallpaperMessage] = useState("Buscando fondo de Windows");
  const initialWallpaperRequestStarted = useRef(false);

  const updatePreferences = useCallback((next: DesktopPreferences) => {
    setPreferences(next);
    saveDesktopPreferences(next);
  }, []);
  const changeVoiceReplies = useCallback((enabled: boolean) => {
    updatePreferences({ ...preferences, voiceRepliesEnabled: enabled });
    voiceRepliesEnabledRef.current = enabled;
    if (!enabled) {
      const requestIds = new Set(typedVoiceReplyRequests.current);
      if (typedVoiceSpeechRequest.current) requestIds.add(typedVoiceSpeechRequest.current);
      for (const requestId of requestIds) {
        const timer = acknowledgementTimers.current.get(requestId);
        if (timer !== undefined) window.clearTimeout(timer);
        acknowledgementTimers.current.delete(requestId);
        typedVoiceReplyRequests.current.delete(requestId);
        typedVoiceFinalSpeechRequests.current.delete(requestId);
        void window.nexaDesktop.voice.speech.cancel({ requestId })
          .catch(() => undefined)
          .finally(() => { void window.nexaDesktop.voice.endDucking(requestId, "stop").catch(() => false); });
      }
      typedVoiceSpeechRequest.current = null;
    }
  }, [preferences, updatePreferences]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const changeMemoryMode = useCallback(async (mode: DesktopMemoryMode): Promise<DesktopMemoryModeResult> => {
    const result = await window.nexaDesktop.memory.setMode(mode);
    if (result.ok || result.error === "operation_failed") {
      for (const timer of acknowledgementTimers.current.values()) window.clearTimeout(timer);
      acknowledgementTimers.current.clear();
      voiceChatRequests.current.clear();
      completedVoiceChatRequests.current.clear();
      setChatMessages([]);
      setChatNotice(null);
      setChatConversationId(null);
      setActiveConversationEmpty(false);
      setOlderMessagesCursor(null);
      activeChatRequest.current = null;
      knownChatRequests.current.clear();
      terminalChatRequests.current.clear();
      originalRequestTexts.current.clear();
      const conversation = await window.nexaDesktop.chat.createConversation();
      if (conversation.ok) { setChatConversationId(conversation.conversationId); setActiveConversationEmpty(true); }
      else setChatNotice(CHAT_ERROR_MESSAGES[conversation.error.code] ?? "No se pudo preparar la conversación.");
    }
    return result;
  }, []);

  const refreshConversationList = useCallback(async (append = false) => {
    if (isIsolated) return;
    setConversationListLoading(true);
    setConversationListError(null);
    try {
      const result = await window.nexaDesktop.chat.listConversations(append && conversationListCursorRef.current
        ? { limit: 50, cursor: conversationListCursorRef.current } : { limit: 50 });
      if (!result.ok) {
        setConversationListError("No se pudo cargar el historial de conversaciones.");
        return;
      }
      setConversationItems((current) => append
        ? [...current, ...result.conversations.filter((item) => !current.some((entry) => entry.conversationId === item.conversationId))]
        : result.conversations);
      setConversationListCursor(result.nextCursor);
    } catch {
      setConversationListError("No se pudo cargar el historial de conversaciones.");
    } finally { setConversationListLoading(false); }
  }, [isIsolated]);

  useEffect(() => { void refreshConversationList(); }, [refreshConversationList]);

  useEffect(() => {
    if (isIsolated && !isSyntheticOrganicPilot) return;
    let mounted = true;
    void window.nexaDesktop.chat.createConversation().then((result) => {
      if (!mounted) return;
      if (result.ok) { setChatConversationId(result.conversationId); setActiveConversationEmpty(true); void refreshConversationList(); }
      else setChatNotice(CHAT_ERROR_MESSAGES[result.error.code] ?? "No se pudo preparar la conversación.");
    }).catch(() => {
      if (mounted) setChatNotice("No se pudo conectar con Runtime. La conversación no está disponible.");
    });
    return () => { mounted = false; };
  }, [isIsolated, isSyntheticOrganicPilot, refreshConversationList]);

  const createNewConversation = useCallback(async () => {
    if (isIsolated || activeChatRequest.current || conversationOpening) return;
    setConversationOpening(true);
    setConversationListError(null);
    try {
      const result = await window.nexaDesktop.chat.createConversation({ newConversation: true });
      if (!result.ok) {
        setConversationListError("No se pudo crear una conversación nueva.");
        return;
      }
      setChatMessages([]);
      setChatNotice(null);
      setChatConversationId(result.conversationId);
      setActiveConversationEmpty(true);
      setOlderMessagesCursor(null);
      await refreshConversationList();
    } catch { setConversationListError("No se pudo crear una conversación nueva."); }
    finally { setConversationOpening(false); }
  }, [conversationOpening, isIsolated, refreshConversationList]);

  const openStoredConversation = useCallback(async (conversationId: string) => {
    if (isIsolated || activeChatRequest.current || conversationOpening || conversationId === chatConversationIdRef.current) return;
    setConversationOpening(true);
    setConversationListError(null);
    try {
      const result = await window.nexaDesktop.chat.openConversation(conversationId);
      if (!result.ok) {
        setConversationListError(result.error.code === "runtime_unavailable"
          ? "La conversación no se puede cambiar mientras Nexa está ocupada."
          : "No se pudo abrir esa conversación.");
        return;
      }
      const messages: ConversationChatMessage[] = result.messages.map((message) => ({
        id: message.id, requestId: message.id, conversationId: result.conversationId,
        role: message.role, text: message.content, source: "history",
        status: message.status === "complete" ? "completed" : "error",
        createdAt: Date.parse(message.createdAt),
        ...(message.status === "interrupted" ? { error: "Mensaje interrumpido." } : {}),
      }));
      setChatMessages(messages);
      setChatNotice(null);
      setChatConversationId(result.conversationId);
      setActiveConversationEmpty(messages.length === 0);
      setOlderMessagesCursor(result.nextCursor);
    } catch { setConversationListError("No se pudo abrir esa conversación."); }
    finally { setConversationOpening(false); }
  }, [conversationOpening, isIsolated]);

  const loadOlderMessages = useCallback(async () => {
    const conversationId = chatConversationIdRef.current;
    const cursor = olderMessagesCursor;
    if (isIsolated || !conversationId || !cursor || olderMessagesLoading || activeChatRequest.current) return;
    setOlderMessagesLoading(true);
    try {
      const result = await window.nexaDesktop.chat.listMessages({ conversationId, cursor });
      if (!result.ok || chatConversationIdRef.current !== conversationId) return;
      const older: ConversationChatMessage[] = result.messages.map((message) => ({
        id: message.id, requestId: message.id, conversationId, role: message.role,
        text: message.content, source: "history", status: message.status === "complete" ? "completed" : "error",
        createdAt: Date.parse(message.createdAt), ...(message.status === "interrupted" ? { error: "Mensaje interrumpido." } : {}),
      }));
      setChatMessages((current) => [...older, ...current]);
      setOlderMessagesCursor(result.nextCursor);
    } catch { setConversationListError("No se pudieron cargar los mensajes anteriores."); }
    finally { setOlderMessagesLoading(false); }
  }, [isIsolated, olderMessagesCursor, olderMessagesLoading]);

  useEffect(() => {
    let mounted = true;
    if (isIsolated) {
      setWeatherLoading(false);
      setWeatherStatus({ available: false, location: preferences.weatherLocation, temperatureC: null, condition: null, updatedAt: Date.now() });
      return () => { mounted = false; };
    }
    const weatherApi = window.nexaDesktop?.weather;
    if (!weatherApi?.getCurrent) {
      setWeatherLoading(false);
      setWeatherStatus({ available: false, location: preferences.weatherLocation, temperatureC: null, condition: null, updatedAt: Date.now() });
      return () => { mounted = false; };
    }
    setWeatherLoading(true);
    setWeatherStatus({ available: false, location: preferences.weatherLocation,
      temperatureC: null, condition: null, updatedAt: Date.now() });
    const refresh = async () => {
      try {
        const result = await weatherApi.getCurrent(preferences.weatherLocation);
        if (mounted) setWeatherStatus(result);
      } catch {
        if (mounted) setWeatherStatus({ available: false, location: preferences.weatherLocation,
          temperatureC: null, condition: null, updatedAt: Date.now() });
      } finally {
        if (mounted) setWeatherLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15 * 60_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [isIsolated, preferences.weatherLocation]);

  const submitChatMessage = useCallback(async (
    text: string,
    source: "typed" | "voice",
    voice?: Pick<VoiceTranscriptItem, "sessionId" | "requestId" | "turnId">,
  ) => {
    if (!chatConversationId) {
      setChatNotice("La conversación todavía se está preparando. Inténtalo de nuevo en un momento.");
      return;
    }
    const requestId = voice?.requestId ?? globalThis.crypto.randomUUID();
    if (source === "typed") {
      followupEligibleRequests.current.clear();
      void followup.stop();
    }
    if (activeChatRequest.current && source === "typed") {
      setChatNotice("Ya hay una solicitud activa en esta conversación.");
      return;
    }
    const message: ConversationChatMessage = {
      id: requestId, requestId, conversationId: chatConversationId, role: "user", text,
      source, status: activeChatRequest.current ? "error" : "sending", createdAt: Date.now(),
      ...(activeChatRequest.current ? { error: "Ya hay una solicitud activa en esta conversación." } : {}),
      ...(voice ? voice : {}),
    };
    setActiveConversationEmpty(false);
    if (activeChatRequest.current) {
      setChatMessages((current) => [...current, message].slice(-MAX_CHAT_HISTORY));
      setChatNotice("La transcripción se conservó, pero no se envió porque hay otra solicitud activa.");
      return;
    }
    for (const previousRequestId of typedVoiceReplyRequests.current) {
      const timer = acknowledgementTimers.current.get(previousRequestId);
      if (timer !== undefined) window.clearTimeout(timer);
      const timing = chatTimingByRequest.current.get(previousRequestId);
      if (timer !== undefined && timing?.acknowledgementTimerStartedAt !== undefined && timing.acknowledgementAt === undefined) {
        reportChatTiming(previousRequestId, timing.origin, "ack_timer_cancelled_superseded",
          performance.now() - timing.acknowledgementTimerStartedAt);
      }
      acknowledgementTimers.current.delete(previousRequestId);
      void window.nexaDesktop.voice.speech.cancel({ requestId: previousRequestId }).catch(() => undefined)
        .finally(() => { void window.nexaDesktop.voice.endDucking(previousRequestId, "stop").catch(() => false); });
    }
    typedVoiceReplyRequests.current.clear();
    typedVoiceFinalSpeechRequests.current.clear();
    typedVoiceSpeechRequest.current = null;
    for (const timer of acknowledgementTimers.current.values()) window.clearTimeout(timer);
    acknowledgementTimers.current.clear();
    voiceChatRequests.current.clear();
    completedVoiceChatRequests.current.clear();
    knownChatRequests.current.add(requestId);
    originalRequestTexts.current.set(requestId, text);
    activeChatRequest.current = requestId;
    const timingOrigin: VoiceChatTimingOrigin = source;
    const timingStartedAt = performance.now();
    chatTimingByRequest.current.set(requestId, { origin: timingOrigin, startedAt: timingStartedAt });
    while (chatTimingByRequest.current.size > 24) chatTimingByRequest.current.delete(chatTimingByRequest.current.keys().next().value!);
    reportChatTiming(requestId, timingOrigin, "request_started");
    setChatMessages((current) => [...current, message].slice(-MAX_CHAT_HISTORY));
    setChatNotice(null);
    if (source === "voice") {
      voiceChatRequests.current.add(requestId);
      followupEligibleRequests.current.add(requestId);
      const timerStartedAt = performance.now();
      const timing = chatTimingByRequest.current.get(requestId);
      if (timing) {
        timing.acknowledgementTimerStartedAt = timerStartedAt;
        reportChatTiming(requestId, timing.origin, "ack_timer_started", VOICE_ACKNOWLEDGEMENT_DELAY_MS);
      }
      const timer = window.setTimeout(() => {
        acknowledgementTimers.current.delete(requestId);
        const timing = chatTimingByRequest.current.get(requestId);
        if (timing) {
          timing.acknowledgementAt = performance.now();
          reportChatTiming(requestId, timing.origin, "ack_timer_expired", timing.acknowledgementAt - timerStartedAt);
        }
        const completed = completedVoiceChatRequests.current.has(requestId);
        if (!voiceChatRequests.current.has(requestId) || (!completed && activeChatRequest.current !== requestId)
          || (terminalChatRequests.current.has(requestId) && !completed)) return;
        void window.nexaDesktop.voice.speech.acknowledge({ requestId }).catch(() => undefined);
      }, VOICE_ACKNOWLEDGEMENT_DELAY_MS);
      acknowledgementTimers.current.set(requestId, timer);
    } else if (voiceRepliesEnabledRef.current) {
      typedVoiceReplyRequests.current.add(requestId);
      const timerStartedAt = performance.now();
      const timing = chatTimingByRequest.current.get(requestId);
      if (timing) timing.acknowledgementTimerStartedAt = timerStartedAt;
      reportChatTiming(requestId, "typed", "ack_timer_started", TYPED_VOICE_ACKNOWLEDGEMENT_DELAY_MS);
      const timer = window.setTimeout(() => {
        acknowledgementTimers.current.delete(requestId);
        const timing = chatTimingByRequest.current.get(requestId);
        if (timing) {
          timing.acknowledgementAt = performance.now();
          reportChatTiming(requestId, timing.origin, "ack_timer_expired", timing.acknowledgementAt - timerStartedAt);
        }
        if (!typedVoiceReplyRequests.current.has(requestId) || !voiceRepliesEnabledRef.current
          || activeChatRequest.current !== requestId || terminalChatRequests.current.has(requestId)) return;
        void window.nexaDesktop.voice.speech.acknowledge({ requestId }).catch(() => undefined);
      }, TYPED_VOICE_ACKNOWLEDGEMENT_DELAY_MS);
      acknowledgementTimers.current.set(requestId, timer);
    }
    try {
      const response = await window.nexaDesktop.chat.sendMessage({
        conversationId: chatConversationId, requestId, text, source,
      });
      if (!response.ok) {
        const timing = chatTimingByRequest.current.get(requestId);
        if (timing) { reportChatTiming(requestId, timing.origin, "ack_timer_cancelled_terminal", performance.now() - timing.startedAt);
          chatTimingByRequest.current.delete(requestId); }
        const timer = acknowledgementTimers.current.get(requestId);
        if (timer !== undefined) window.clearTimeout(timer);
        acknowledgementTimers.current.delete(requestId);
        terminalChatRequests.current.add(requestId);
        voiceChatRequests.current.delete(requestId);
        followupEligibleRequests.current.delete(requestId);
        completedVoiceChatRequests.current.delete(requestId);
        typedVoiceReplyRequests.current.delete(requestId);
        typedVoiceFinalSpeechRequests.current.delete(requestId);
        if (activeChatRequest.current === requestId) activeChatRequest.current = null;
        setChatMessages((current) => current.map((entry) => entry.requestId === requestId
          ? { ...entry, status: "error", error: CHAT_ERROR_MESSAGES[response.error.code] ?? "No se pudo enviar el mensaje." }
          : entry));
        setChatNotice(CHAT_ERROR_MESSAGES[response.error.code] ?? "No se pudo enviar el mensaje.");
      } else {
        setChatMessages((current) => current.map((entry) => entry.requestId === requestId && entry.status === "sending"
          ? { ...entry, status: "processing" } : entry));
      }
    } catch {
      const timing = chatTimingByRequest.current.get(requestId);
      if (timing) { reportChatTiming(requestId, timing.origin, "ack_timer_cancelled_terminal", performance.now() - timing.startedAt);
        chatTimingByRequest.current.delete(requestId); }
      const timer = acknowledgementTimers.current.get(requestId);
      if (timer !== undefined) window.clearTimeout(timer);
      acknowledgementTimers.current.delete(requestId);
      terminalChatRequests.current.add(requestId);
      voiceChatRequests.current.delete(requestId);
      followupEligibleRequests.current.delete(requestId);
      completedVoiceChatRequests.current.delete(requestId);
      typedVoiceReplyRequests.current.delete(requestId);
      typedVoiceFinalSpeechRequests.current.delete(requestId);
      if (activeChatRequest.current === requestId) activeChatRequest.current = null;
      setChatMessages((current) => current.map((entry) => entry.requestId === requestId
        ? { ...entry, status: "error", error: "Se perdió la conexión con el proceso Desktop; el mensaje no se reintentó." }
        : entry));
      setChatNotice("No se confirmó el envío. No se reintentó automáticamente.");
    }
  }, [chatConversationId, followup, reportChatTiming]);
  followupSubmit.current = (value) => {
    void submitChatMessage(value.text, "voice", value);
  };

  const handleChatEvent = useCallback((event: ChatEventEnvelope) => {
    if (event.conversationId !== chatConversationIdRef.current || !knownChatRequests.current.has(event.requestId)
      || terminalChatRequests.current.has(event.requestId)) return;
    if (event.status === "text_delta") {
      const timing = chatTimingByRequest.current.get(event.requestId);
      if (timing && timing.firstTextDeltaAt === undefined) {
        timing.firstTextDeltaAt = performance.now();
        reportChatTiming(event.requestId, timing.origin, "first_text_delta_received",
          timing.firstTextDeltaAt - timing.startedAt);
      }
      const previous = pendingStreamDeltas.current.get(event.requestId);
      if (previous) {
        previous.delta += event.delta;
      } else {
        const pending = { delta: event.delta, frameId: 0 };
        pending.frameId = window.requestAnimationFrame(() => {
          if (pendingStreamDeltas.current.get(event.requestId) !== pending) return;
          pendingStreamDeltas.current.delete(event.requestId);
          if (event.conversationId !== chatConversationIdRef.current || terminalChatRequests.current.has(event.requestId)) return;
          setChatMessages((current) => {
            const existingIndex = current.findIndex((entry) => entry.role === "assistant"
              && entry.requestId === event.requestId);
            if (existingIndex >= 0) return current.map((entry, index) => index === existingIndex
              ? { ...entry, text: entry.text + pending.delta, status: "processing" } : entry);
            const streamedMessage: ConversationChatMessage = { id: `${event.requestId}:stream`, requestId: event.requestId,
              conversationId: event.conversationId, role: "assistant", text: pending.delta,
              source: voiceChatRequests.current.has(event.requestId) ? "voice" : "typed",
              status: "processing", createdAt: Date.now(), streamed: true };
            return [...current, streamedMessage].slice(-MAX_CHAT_HISTORY);
          });
        });
        pendingStreamDeltas.current.set(event.requestId, pending);
      }
      return;
    }
    if (event.status === "text_reset") {
      discardStreamUpdate(event.requestId);
      return;
    }
    if (event.status === "processing") {
      const timing = chatTimingByRequest.current.get(event.requestId);
      if (timing && timing.runtimeStartedAt === undefined) {
        timing.runtimeStartedAt = performance.now();
        reportChatTiming(event.requestId, timing.origin, "runtime_processing_started", timing.runtimeStartedAt - timing.startedAt);
      }
      setChatMessages((current) => current.map((entry) => entry.requestId === event.requestId && entry.status === "sending"
        ? { ...entry, status: "processing" } : entry));
      return;
    }
    if (event.status === "authorization_required") {
      setAuthorizationRequirements((current) => ({ ...current, [event.requestId]: event.requirement }));
      return;
    }
    if (event.status === "spotify_now_playing") {
      setSpotifyNowPlayingCards((current) => ({ ...current, [event.requestId]: event.card }));
      return;
    }
    terminalChatRequests.current.add(event.requestId);
    discardStreamUpdate(event.requestId, event.status !== "completed");
    if (event.status === "completed") {
      const timing = chatTimingByRequest.current.get(event.requestId);
      if (timing && timing.finalAt === undefined) {
        timing.finalAt = performance.now();
        reportChatTiming(event.requestId, timing.origin, "response_final_received", timing.finalAt - timing.startedAt);
        if (timing.runtimeStartedAt !== undefined) reportChatTiming(event.requestId, timing.origin, "runtime_to_final",
          timing.finalAt - timing.runtimeStartedAt);
      }
    }
    const fromVoice = voiceChatRequests.current.has(event.requestId);
    const acknowledgementTimer = acknowledgementTimers.current.get(event.requestId);
    if (event.status === "completed" && voiceChatRequests.current.has(event.requestId)) {
      completedVoiceChatRequests.current.add(event.requestId);
    } else {
      if (acknowledgementTimer !== undefined) window.clearTimeout(acknowledgementTimer);
      acknowledgementTimers.current.delete(event.requestId);
      const timing = chatTimingByRequest.current.get(event.requestId);
      if (timing && event.status !== "completed") {
        reportChatTiming(event.requestId, timing.origin, "ack_timer_cancelled_terminal", performance.now() - timing.startedAt);
        chatTimingByRequest.current.delete(event.requestId);
      }
      voiceChatRequests.current.delete(event.requestId);
      completedVoiceChatRequests.current.delete(event.requestId);
    }
    const typedVoiceReplyEligible = typedVoiceReplyRequests.current.has(event.requestId);
    if (event.status === "completed" && typedVoiceReplyEligible) {
      if (acknowledgementTimer !== undefined) window.clearTimeout(acknowledgementTimer);
      acknowledgementTimers.current.delete(event.requestId);
      const timing = chatTimingByRequest.current.get(event.requestId);
      if (timing) {
        timing.finalAt ??= performance.now();
        if (timing.acknowledgementAt === undefined && timing.acknowledgementTimerStartedAt !== undefined) {
          reportChatTiming(event.requestId, timing.origin, "ack_timer_cancelled_response",
            timing.finalAt - timing.acknowledgementTimerStartedAt);
        }
        if (timing.acknowledgementAt !== undefined) reportChatTiming(event.requestId, timing.origin, "response_after_ack_timer",
          timing.finalAt - timing.acknowledgementAt);
      }
    } else if (event.status !== "completed" && typedVoiceReplyEligible) {
      const timing = chatTimingByRequest.current.get(event.requestId);
      if (timing) { reportChatTiming(event.requestId, timing.origin, "ack_timer_cancelled_terminal", performance.now() - timing.startedAt);
        chatTimingByRequest.current.delete(event.requestId); }
      typedVoiceReplyRequests.current.delete(event.requestId);
      typedVoiceFinalSpeechRequests.current.delete(event.requestId);
      if (typedVoiceSpeechRequest.current === event.requestId) typedVoiceSpeechRequest.current = null;
      if (activeVoiceSpeechRequest.current === event.requestId) {
        void window.nexaDesktop.voice.speech.cancel({ requestId: event.requestId }).catch(() => undefined);
        void window.nexaDesktop.voice.endDucking(event.requestId, "error").catch(() => false);
      }
    }
    if (event.status !== "completed" && activeVoiceSpeechRequest.current === event.requestId && !typedVoiceReplyEligible) {
      void window.nexaDesktop.voice.speech.cancel({ requestId: event.requestId }).catch(() => undefined);
    }
    if (activeChatRequest.current === event.requestId) activeChatRequest.current = null;
    if (event.status === "completed") {
      void refreshConversationList();
      if (!typedVoiceReplyEligible && fromVoice) {
        const timing = chatTimingByRequest.current.get(event.requestId);
        if (timing) {
          timing.finalAt ??= performance.now();
          if (timing.acknowledgementAt !== undefined) reportChatTiming(event.requestId, timing.origin, "response_after_ack_timer",
            timing.finalAt - timing.acknowledgementAt);
        }
      }
      setChatMessages((current) => {
        const provisional = current.find((entry) => entry.role === "assistant" && entry.requestId === event.requestId);
        const responseMessage: ConversationChatMessage = {
          id: provisional?.id ?? `${event.requestId}:response`, requestId: event.requestId,
          conversationId: event.conversationId, role: "assistant", text: event.response,
          source: provisional?.source ?? "typed", status: "completed", createdAt: provisional?.createdAt ?? Date.now(),
          streamed: provisional?.streamed ?? false,
          ...(event.presentation ? { presentation: event.presentation } : {}),
          originalRequestText: originalRequestTexts.current.get(event.requestId),
        };
        return [...current.filter((entry) => !(entry.role === "assistant" && entry.requestId === event.requestId))
          .map((entry) => entry.requestId === event.requestId
            ? { ...entry, status: "completed" as const } : entry), responseMessage].slice(-MAX_CHAT_HISTORY);
      });
      if (!fromVoice && typedVoiceReplyEligible && voiceRepliesEnabledRef.current) {
        typedVoiceFinalSpeechRequests.current.add(event.requestId);
        typedVoiceSpeechRequest.current = event.requestId;
        void window.nexaDesktop.voice.speech.playChatResponse(event.requestId).then((accepted) => {
          if (!accepted) {
            typedVoiceReplyRequests.current.delete(event.requestId);
            typedVoiceFinalSpeechRequests.current.delete(event.requestId);
            if (typedVoiceSpeechRequest.current === event.requestId) typedVoiceSpeechRequest.current = null;
            void window.nexaDesktop.voice.endDucking(event.requestId, "error").catch(() => false);
          }
        }).catch(() => {
          typedVoiceReplyRequests.current.delete(event.requestId);
          typedVoiceFinalSpeechRequests.current.delete(event.requestId);
          if (typedVoiceSpeechRequest.current === event.requestId) typedVoiceSpeechRequest.current = null;
          void window.nexaDesktop.voice.endDucking(event.requestId, "error").catch(() => false);
        });
      }
      else if (!fromVoice) typedVoiceReplyRequests.current.delete(event.requestId);
    } else if (event.status === "cancelled") {
      setChatMessages((current) => current.map((entry) => entry.requestId === event.requestId
        ? { ...entry, status: "cancelled" } : entry));
    } else {
      const message = CHAT_ERROR_MESSAGES[event.error.code] ?? event.error.message;
      setChatMessages((current) => current.map((entry) => entry.requestId === event.requestId
        ? { ...entry, status: "error", error: message } : entry));
      setChatNotice(message);
    }
  }, [discardStreamUpdate, refreshConversationList, reportChatTiming]);

  useLayoutEffect(() => {
    for (const message of chatMessages) {
      if (message.role !== "assistant" || !message.requestId) continue;
      const timing = chatTimingByRequest.current.get(message.requestId);
      if (!timing) continue;
      if (timing.firstTextDeltaAt !== undefined && !timing.firstTextRendered) {
        timing.firstTextRendered = true;
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          reportChatTiming(message.requestId, timing.origin, "first_text_rendered", performance.now() - timing.startedAt);
        }));
      }
      if (timing.finalAt !== undefined && !timing.rendered) {
        timing.rendered = true;
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          reportChatTiming(message.requestId, timing.origin, "response_rendered", performance.now() - timing.finalAt!);
          chatTimingByRequest.current.delete(message.requestId);
        }));
      }
    }
  }, [chatMessages, reportChatTiming]);

  const connectAuthorization = useCallback(async (provider: AuthorizationProvider, requestId: string) => {
    setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "connecting" } }));
    try {
      const result = await window.nexaDesktop.authorization.connect({ provider, requestId });
      if (result.state === "connected") {
        setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "connected" } }));
      } else if (result.state === "cancelled") {
        setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "cancelled", message: "Conexión cancelada." } }));
      } else {
        setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "error", message: result.message } }));
      }
    } catch {
      setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "error", message: "No se pudo iniciar la conexión desde Desktop." } }));
    }
  }, []);

  const cancelAuthorization = useCallback(async (provider: AuthorizationProvider, requestId: string) => {
    try {
      const result = await window.nexaDesktop.authorization.cancel({ provider, requestId });
      if (result.accepted) {
        setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "connecting", message: "Cancelando conexión…" } }));
      } else if (result.code === "unsupported") {
        setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "connecting", message: "Para cancelar Microsoft, cierra la ventana de inicio de sesión." } }));
      }
    } catch {
      setAuthorizationAttempts((current) => ({ ...current, [requestId]: { state: "error", message: "No se pudo cancelar la conexión." } }));
    }
  }, []);

  const openSpotifyTrack = useCallback(async (url: string) => {
    try {
      const opened = await window.nexaDesktop.spotify.openTrack(url);
      if (!opened) setChatNotice("No se pudo abrir el enlace de Spotify.");
    } catch {
      setChatNotice("No se pudo abrir el enlace de Spotify.");
    }
  }, []);

  useEffect(() => window.nexaDesktop.chat.onEvent(handleChatEvent), [handleChatEvent]);

  useEffect(() => {
    const speech = window.nexaDesktop?.voice?.speech;
    if (!speech) return;
    return speech.onEvent((event: VoiceSpeechEvent) => {
      if (event.state === "preparing") {
        if (followupEligibleRequests.current.has(event.requestId)) {
          void followup.stop().then(() => {
            if (followupEligibleRequests.current.has(event.requestId)) followup.prepare();
          });
        }
        activeVoiceSpeechRequest.current = event.requestId;
        setVoiceSpeechStatus({ requestId: event.requestId, state: "preparing" });
        return;
      }
      if (activeVoiceSpeechRequest.current !== event.requestId && !voiceChatRequests.current.has(event.requestId)
        && !typedVoiceReplyRequests.current.has(event.requestId)) return;
      if (event.state === "speaking") {
        const timer = acknowledgementTimers.current.get(event.requestId);
        if (timer !== undefined) window.clearTimeout(timer);
        acknowledgementTimers.current.delete(event.requestId);
        const timing = chatTimingByRequest.current.get(event.requestId);
        if (timer !== undefined && timing?.acknowledgementTimerStartedAt !== undefined && timing.acknowledgementAt === undefined) {
          reportChatTiming(event.requestId, timing.origin, "ack_timer_cancelled_response",
            performance.now() - timing.acknowledgementTimerStartedAt);
        }
        voiceChatRequests.current.delete(event.requestId);
        completedVoiceChatRequests.current.delete(event.requestId);
        setVoiceSpeechStatus({ requestId: event.requestId, state: "speaking" });
      }
      else if (event.state === "error") {
        const isTypedFinal = typedVoiceFinalSpeechRequests.current.has(event.requestId);
        if (!isTypedFinal && typedVoiceReplyRequests.current.has(event.requestId)) {
          void window.nexaDesktop.voice.endDucking(event.requestId, "error").catch(() => false);
        }
        if (isTypedFinal) {
          typedVoiceReplyRequests.current.delete(event.requestId);
          typedVoiceFinalSpeechRequests.current.delete(event.requestId);
        }
        if (typedVoiceSpeechRequest.current === event.requestId && isTypedFinal) typedVoiceSpeechRequest.current = null;
        const wasVoiceFollowupEligible = followupEligibleRequests.current.has(event.requestId);
        followupEligibleRequests.current.delete(event.requestId);
        if (wasVoiceFollowupEligible) void followup.stop();
        const timer = acknowledgementTimers.current.get(event.requestId);
        if (timer !== undefined) window.clearTimeout(timer);
        acknowledgementTimers.current.delete(event.requestId);
        voiceChatRequests.current.delete(event.requestId);
        completedVoiceChatRequests.current.delete(event.requestId);
        activeVoiceSpeechRequest.current = null;
        cancellingVoiceSpeechRequests.current.delete(event.requestId);
        setVoiceSpeechStatus({ requestId: event.requestId, state: "error",
          message: VOICE_SPEECH_ERRORS[event.error?.code ?? "voice_speech_playback_failed"] });
      }
      else {
        const isTypedFinal = typedVoiceFinalSpeechRequests.current.has(event.requestId);
        if (isTypedFinal) {
          typedVoiceReplyRequests.current.delete(event.requestId);
          typedVoiceFinalSpeechRequests.current.delete(event.requestId);
        }
        if (typedVoiceSpeechRequest.current === event.requestId && isTypedFinal) typedVoiceSpeechRequest.current = null;
        const wasVoiceFollowupEligible = followupEligibleRequests.current.has(event.requestId);
        const shouldFollowup = event.state === "completed" && followupEligibleRequests.current.delete(event.requestId)
          && !cancellingVoiceSpeechRequests.current.has(event.requestId);
        followupEligibleRequests.current.delete(event.requestId);
        const timer = acknowledgementTimers.current.get(event.requestId);
        if (timer !== undefined) window.clearTimeout(timer);
        acknowledgementTimers.current.delete(event.requestId);
        voiceChatRequests.current.delete(event.requestId);
        completedVoiceChatRequests.current.delete(event.requestId);
        activeVoiceSpeechRequest.current = null;
        cancellingVoiceSpeechRequests.current.delete(event.requestId);
        setVoiceSpeechStatus(null);
        if (shouldFollowup) {
          setVoiceFollowupError(null);
          void followup.open(event.requestId);
        }
        else {
          if (wasVoiceFollowupEligible) void followup.stop();
          void window.nexaDesktop.voice.endDucking(event.requestId).catch(() => false);
        }
      }
    });
  }, [followup, reportChatTiming]);

  useEffect(() => () => {
    void followup.stop();
    for (const timer of acknowledgementTimers.current.values()) window.clearTimeout(timer);
    acknowledgementTimers.current.clear();
  }, [followup]);

  const cancelVoiceSpeech = useCallback(async () => {
    const requestId = activeVoiceSpeechRequest.current;
    if (!requestId) return;
    const timer = acknowledgementTimers.current.get(requestId);
    if (timer !== undefined) window.clearTimeout(timer);
    acknowledgementTimers.current.delete(requestId);
    const timing = chatTimingByRequest.current.get(requestId);
    if (timer !== undefined && timing?.acknowledgementTimerStartedAt !== undefined && timing.acknowledgementAt === undefined) {
      reportChatTiming(requestId, timing.origin, "ack_timer_cancelled_terminal",
        performance.now() - timing.acknowledgementTimerStartedAt);
    }
    voiceChatRequests.current.delete(requestId);
    completedVoiceChatRequests.current.delete(requestId);
    if (cancellingVoiceSpeechRequests.current.has(requestId)) return;
    cancellingVoiceSpeechRequests.current.add(requestId);
    setVoiceSpeechStatus((current) => current?.requestId === requestId ? { ...current, state: "cancelling" } : current);
    try {
      const result = await window.nexaDesktop.voice.speech.cancel({ requestId });
      if (!result.ok && activeVoiceSpeechRequest.current === requestId) {
        activeVoiceSpeechRequest.current = null;
        cancellingVoiceSpeechRequests.current.delete(requestId);
        setVoiceSpeechStatus({ requestId, state: "error", message: "No se encontró una respuesta hablada activa para detener." });
      }
    } catch {
      if (activeVoiceSpeechRequest.current === requestId) activeVoiceSpeechRequest.current = null;
      cancellingVoiceSpeechRequests.current.delete(requestId);
      setVoiceSpeechStatus({ requestId, state: "error", message: "No se pudo solicitar la interrupción del audio." });
    }
  }, [reportChatTiming]);

  useEffect(() => {
    if (isIsolated) {
      setSpotifyLiveStatus({ state: "unavailable", connected: false, deviceAvailable: false,
        controlsEnabled: false, track: null, message: null, updatedAt: Date.now() });
      return;
    }
    const spotifyApi = window.nexaDesktop?.spotify;
    if (!spotifyApi?.onLiveStatus || !spotifyApi.getLiveStatus) return;
    let mounted = true;
    const unsubscribe = spotifyApi.onLiveStatus((status) => {
      if (!mounted) return;
      setSpotifyLiveStatus(status);
    });
    void spotifyApi.getLiveStatus().then((status) => {
      if (mounted) setSpotifyLiveStatus(status);
    }).catch(() => {
      if (mounted) setSpotifyLiveStatus({ state: "unavailable", connected: false, deviceAvailable: false,
        controlsEnabled: false, track: null, message: "No se pudo actualizar el estado de Spotify.", updatedAt: Date.now() });
    });
    return () => { mounted = false; unsubscribe(); };
  }, [isIsolated]);

  async function controlSpotify(action: SpotifyPlaybackControl) {
    if (spotifyControlBusy) return;
    setSpotifyControlBusy(action);
    setSpotifyControlError(null);
    try {
      const result = await window.nexaDesktop.spotify.control(action);
      if (!result.ok) setSpotifyControlError(result.observedState ? null : result.error.message);
      else {
        // Main already attempts reconciliation. A separate UI read must not turn an
        // accepted Spotify write into a reported action failure.
        void window.nexaDesktop.spotify.getLiveStatus().then(setSpotifyLiveStatus).catch(() => undefined);
      }
    } catch {
      setSpotifyControlError("No se pudo confirmar la acción de Spotify.");
    } finally {
      setSpotifyControlBusy(null);
    }
  }

  const cancelActiveInteraction = useCallback(async () => {
    if (cancellationInFlight.current) return;
    const requestId = activeChatRequest.current;
    const pendingVoiceRequestId = voiceChatRequests.current.values().next().value as string | undefined;
    const typedSpeechRequestId = requestId && typedVoiceReplyRequests.current.has(requestId) ? requestId : null;
    const speechRequestId = activeVoiceSpeechRequest.current ?? pendingVoiceRequestId ?? typedSpeechRequestId;
    const voiceStatus = voiceController.getSnapshot().status;
    const captureActive = ["starting", "listening", "finishing", "processing"].includes(voiceStatus)
      || (voiceStatus === "error" && !voiceController.getSnapshot().canStart && Boolean(voiceController.getSnapshot().sessionId));
    if (!requestId && !speechRequestId && !captureActive && !followup.getSnapshot()) return;
    followupEligibleRequests.current.clear();
    const requestTiming = requestId ? chatTimingByRequest.current.get(requestId) : undefined;
    if (requestId && requestTiming) reportChatTiming(requestId, requestTiming.origin, "stop_requested",
      performance.now() - requestTiming.startedAt);
    if (speechRequestId && typedVoiceReplyRequests.current.has(speechRequestId)) {
      const timer = acknowledgementTimers.current.get(speechRequestId);
      if (timer !== undefined) window.clearTimeout(timer);
      const timing = chatTimingByRequest.current.get(speechRequestId);
      if (timing) reportChatTiming(speechRequestId, timing.origin, "stop_requested", performance.now() - timing.startedAt);
      acknowledgementTimers.current.delete(speechRequestId);
      typedVoiceReplyRequests.current.delete(speechRequestId);
      typedVoiceFinalSpeechRequests.current.delete(speechRequestId);
      if (typedVoiceSpeechRequest.current === speechRequestId) typedVoiceSpeechRequest.current = null;
    }
    cancellationInFlight.current = true;
    setCancellationPending(true);
    try {
      const cancellations: Promise<void>[] = [];
      cancellations.push(followup.stop());
      if (requestId) {
        cancellations.push((async () => {
          try {
          const result = await window.nexaDesktop.chat.cancelRequest(requestId);
          if (!result.ok && result.error.code === "request_not_found") {
            terminalChatRequests.current.add(requestId);
            if (activeChatRequest.current === requestId) activeChatRequest.current = null;
            const message = CHAT_ERROR_MESSAGES.request_not_found ?? "La solicitud ya no está activa.";
            setChatMessages((current) => current.map((entry) => entry.requestId === requestId
              ? { ...entry, status: "error", error: message } : entry));
            setChatNotice(message);
          } else if (!result.ok) {
            setChatNotice(CHAT_ERROR_MESSAGES[result.error.code] ?? "No se pudo solicitar la cancelación.");
          }
        } catch {
          setChatNotice("No se confirmó la cancelación de Runtime. El estado final sigue pendiente.");
        }
        })());
      }
      if (speechRequestId) {
        if (activeVoiceSpeechRequest.current === speechRequestId) {
          cancellations.push(cancelVoiceSpeech());
        } else {
          cancellations.push(window.nexaDesktop.voice.speech.cancel({ requestId: speechRequestId }).then(() => undefined)
            .catch(() => undefined)); /* Main retains this request id if speaker initialization is still pending. */
        }
      }
      if (captureActive) {
        cancellations.push(voiceController.cancel().catch(() => undefined));
      }
      await Promise.all(cancellations);
    } finally {
      cancellationInFlight.current = false;
      setCancellationPending(false);
    }
  }, [cancelVoiceSpeech, voiceController, followup, reportChatTiming]);

  useEffect(() => {
    if (voiceSnapshot.status === "starting" || voiceSnapshot.status === "listening") {
      setVoiceTranscriptNotice(null);
      return;
    }
    if (voiceSnapshot.status !== "transcript-ready" || !voiceSnapshot.sessionId
      || !voiceSnapshot.requestId || !voiceSnapshot.turnId || voiceSnapshot.transcript === undefined) return;
    const key = `${voiceSnapshot.sessionId}:${voiceSnapshot.turnId}`;
    if (seenTranscriptKeys.current.has(key)) return;
    seenTranscriptKeys.current.add(key);
    if (!voiceSnapshot.transcript.trim()) {
      setVoiceTranscriptNotice("No se detectó voz en la grabación. No se añadió ningún mensaje.");
      return;
    }
    setVoiceTranscriptNotice(null);
    void submitChatMessage(voiceSnapshot.transcript, "voice", {
      sessionId: voiceSnapshot.sessionId, requestId: voiceSnapshot.requestId, turnId: voiceSnapshot.turnId,
    });
  }, [voiceSnapshot, submitChatMessage]);

  async function refreshWallpaper() {
    if (!window.nexaDesktop?.getWallpaper) {
      setWallpaperDataUrl(null);
      setWallpaperMessage("Wallpaper no disponible; se usa el fondo Nexa");
      return;
    }
    setWallpaperLoading(true);
    try {
      const result = await window.nexaDesktop.getWallpaper();
      if (result.available) {
        setWallpaperDataUrl(result.dataUrl);
        setWallpaperMessage("Wallpaper local de Windows");
      } else {
        setWallpaperDataUrl(null);
        setWallpaperMessage("Wallpaper no disponible; se usa el fondo Nexa");
      }
    } catch {
      setWallpaperDataUrl(null);
      setWallpaperMessage("Wallpaper no disponible; se usa el fondo Nexa");
    } finally {
      setWallpaperLoading(false);
    }
  }

  useEffect(() => {
    if (initialWallpaperRequestStarted.current) return;
    initialWallpaperRequestStarted.current = true;
    void refreshWallpaper();
  }, []);

  return (
    <div className={`app-shell${wallpaperEnabled && wallpaperDataUrl ? " app-shell--wallpaper" : ""}${activeView === "conversations" ? " app-shell--conversations" : ""}`}>
      {wallpaperEnabled && wallpaperDataUrl && (
        <img className="wallpaper-background" src={wallpaperDataUrl} alt="" aria-hidden="true" />
      )}
      <WindowChrome />
      <Sidebar activeView={activeView} onOpenCommandCenter={() => setActiveView("command")}
        onOpenConversations={() => setActiveView("conversations")}
        onOpenSettings={() => setSettingsOpen(true)} showSettings={!isSyntheticOrganicPilot} showConversations={!isIsolated} />
      <main className="workspace-shell">
        {isSyntheticOrganicPilot && <div className="synthetic-pilot-banner" role="status">PILOTO SINTÉTICO — SIN DATOS PERSONALES</div>}
        <CommandHeader preferences={preferences} weather={weatherStatus} weatherLoading={weatherLoading} />

        <div className={`workspace-grid${activeView === "conversations" ? " workspace-grid--conversations" : ""}`}>
          <ConversationsPanel conversations={conversationItems} activeConversationId={chatConversationId}
            isVisible={activeView === "conversations"}
            busy={conversationOpening || conversationListLoading || activeChatRequest.current !== null} loading={conversationListLoading}
            hasMore={conversationListCursor !== null} error={conversationListError}
            onNew={() => { void createNewConversation(); }}
            onSelect={(conversationId) => { void openStoredConversation(conversationId); }}
            onLoadMore={() => { void refreshConversationList(true); }} />
          <ConversationPanel
            key={chatConversationId ?? "conversation-uninitialized"}
            snapshot={voiceSnapshot}
            transcripts={[]}
            chatMessages={chatMessages}
            authorizationRequirements={authorizationRequirements}
            spotifyNowPlayingCards={spotifyNowPlayingCards}
            authorizationAttempts={authorizationAttempts}
            chatNotice={chatNotice}
            chatBusy={chatConversationId === null || activeChatRequest.current !== null || conversationOpening}
            welcomeMessage={activeConversationEmpty ? welcomeMessage : null}
            showVoiceRepliesToggle={activeView === "conversations"} voiceRepliesEnabled={preferences.voiceRepliesEnabled}
            onVoiceRepliesChange={changeVoiceReplies}
            hasOlderMessages={olderMessagesCursor !== null}
            olderMessagesLoading={olderMessagesLoading}
            onLoadOlderMessages={() => { void loadOlderMessages(); }}
            onSendMessage={(text) => { void submitChatMessage(text, "typed"); }}
            onCancelInteraction={() => { void cancelActiveInteraction(); }}
            onConnectAuthorization={(provider, requestId) => { void connectAuthorization(provider, requestId); }}
            onCancelAuthorization={(provider, requestId) => { void cancelAuthorization(provider, requestId); }}
            onRetryAuthorizedRequest={(text) => { void submitChatMessage(text, "typed"); }}
            onOpenSpotifyTrack={(url) => { void openSpotifyTrack(url); }}
            transcriptNotice={voiceTranscriptNotice}
            voiceSpeechStatus={voiceSpeechStatus}
            followupStatus={followupStatus}
            followupError={voiceFollowupError}
            onStart={() => { setVoiceFollowupError(null); followupEligibleRequests.current.clear(); void followup.stop().then(() => voiceController.start()); }}
            onFinish={() => { void voiceController.finish(); }}
            onRecover={() => { void voiceController.recoverMainCancellation(); }}
            interactionCancelable={followupStatus !== "idle" || activeChatRequest.current !== null || activeVoiceSpeechRequest.current !== null
              || voiceChatRequests.current.size > 0
              || ["starting", "listening", "finishing", "processing"].includes(voiceSnapshot.status)
              || (voiceSnapshot.status === "error" && !voiceSnapshot.canStart && Boolean(voiceSnapshot.sessionId))}
            cancellationPending={cancellationPending}
          />
          <PresencePanel className={activeView === "conversations" ? "presence-panel--offscreen" : ""}
            isHidden={activeView === "conversations"}
            status={voiceSnapshot.status} statusLabel={VOICE_STATUS_LABELS[voiceSnapshot.status]} />
        </div>

      </main>
      <DashboardModules className={activeView === "conversations" ? "dashboard-modules--hidden" : ""} isHidden={activeView === "conversations"}
        assistantState={ASSISTANT_STATE_LABELS[assistantState]} spotifyStatus={spotifyLiveStatus}
        spotifyBusyAction={spotifyControlBusy} spotifyError={spotifyControlError}
        voiceRepliesEnabled={preferences.voiceRepliesEnabled} onVoiceRepliesChange={changeVoiceReplies}
        onSpotifyControl={(action) => { void controlSpotify(action); }} onOpenSpotifyTrack={(url) => { void openSpotifyTrack(url); }} />
      {settingsOpen && <SettingsModal preferences={preferences} onPreferencesChange={updatePreferences}
        microphoneDevices={microphoneDevices}
        microphoneDisabled={["starting", "listening", "finishing", "processing", "cancelling", "recovering"].includes(voiceSnapshot.status)}
        onClose={closeSettings} onMemoryModeChange={changeMemoryMode} />}
    </div>
  );
}
