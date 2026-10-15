export const PING_CHANNEL = "nexa:ping" as const;
export const GET_WALLPAPER_CHANNEL = "nexa:wallpaper:get" as const;
export const CLIPBOARD_WRITE_TEXT_CHANNEL = "nexa:clipboard:write-text" as const;
export const WINDOW_MINIMIZE_CHANNEL = "nexa:window:minimize" as const;
export const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = "nexa:window:toggle-maximize" as const;
export const WINDOW_CLOSE_CHANNEL = "nexa:window:close" as const;
export const DESKTOP_RESTART_CHANNEL = "nexa:desktop:restart" as const;
export const WINDOW_SETTINGS_GET_CHANNEL = "nexa:window-settings:get" as const;
export const WINDOW_SETTINGS_SET_CHANNEL = "nexa:window-settings:set" as const;
export const WINDOW_SETTINGS_CHANGED_CHANNEL = "nexa:window-settings:changed" as const;

export const VOICE_PTT_START_CHANNEL = "voice:ptt:start" as const;
export const VOICE_PTT_FINISH_CHANNEL = "voice:ptt:finish" as const;
export const VOICE_PTT_CANCEL_CHANNEL = "voice:ptt:cancel" as const;
export const VOICE_EVENT_CHANNEL = "voice:event" as const;
export const VOICE_SPEECH_CANCEL_CHANNEL = "voice:speech:cancel" as const;
export const VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL = "voice:speech:acknowledgement" as const;
export const VOICE_SPEECH_CHAT_PLAY_CHANNEL = "voice:speech:chat-play" as const;
export const VOICE_SPEECH_EVENT_CHANNEL = "voice:speech:event" as const;
export const VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL = "voice:followup:diagnostic" as const;
export const VOICE_CHAT_TIMING_DIAGNOSTIC_CHANNEL = "voice:chat-timing:diagnostic" as const;
export const VOICE_DUCKING_END_CHANNEL = "voice:ducking:end" as const;
export const CHAT_SEND_MESSAGE_CHANNEL = "chat:send-message" as const;
export const CHAT_CANCEL_REQUEST_CHANNEL = "chat:cancel-request" as const;
export const CHAT_CREATE_CONVERSATION_CHANNEL = "chat:create-conversation" as const;
export const CHAT_OPEN_CONVERSATION_CHANNEL = "chat:open-conversation" as const;
export const CHAT_LIST_MESSAGES_CHANNEL = "chat:list-messages" as const;
export const CHAT_LIST_CONVERSATIONS_CHANNEL = "chat:list-conversations" as const;
export const CHAT_RENAME_CONVERSATION_CHANNEL = "chat:rename-conversation" as const;
export const CHAT_EVENT_CHANNEL = "chat:event" as const;
export const MEMORY_MODE_GET_CHANNEL = "memory:mode:get" as const;
export const MEMORY_MODE_SET_CHANNEL = "memory:mode:set" as const;
export const AUTHORIZATION_CONNECT_CHANNEL = "authorization:connect" as const;
export const AUTHORIZATION_CANCEL_CHANNEL = "authorization:cancel" as const;
export const SPOTIFY_OPEN_TRACK_CHANNEL = "spotify:open-track" as const;
export const SPOTIFY_LIVE_STATUS_CHANNEL = "spotify:live-status" as const;
export const SPOTIFY_LIVE_STATUS_EVENT_CHANNEL = "spotify:live-status-event" as const;
export const SPOTIFY_LIVE_VISIBILITY_CHANNEL = "spotify:live-visibility" as const;
export const SPOTIFY_CONTROL_CHANNEL = "spotify:control" as const;
export const WEATHER_CURRENT_CHANNEL = "weather:current" as const;
export const MASTER_VOLUME_GET_CHANNEL = "audio:master-volume:get" as const;
export const MASTER_VOLUME_SET_CHANNEL = "audio:master-volume:set" as const;
export const MASTER_VOLUME_EVENT_CHANNEL = "audio:master-volume:event" as const;
export const DESKTOP_RENDERER_ISOLATION_ARGUMENT = "--nexa-renderer-isolated" as const;
export const DESKTOP_RENDERER_ORGANIC_PILOT_ARGUMENT = "--nexa-renderer-organic-pilot-verified" as const;

export type ChatMessageSource = "typed" | "voice";
export interface ChatSendMessageRequest {
  conversationId: string;
  requestId: string;
  text: string;
  source: ChatMessageSource;
}
export interface ChatSendAck {
  ok: true;
  accepted: true;
  conversationId: string;
  requestId: string;
}
export type ChatIpcErrorCode = "invalid_request" | "busy" | "conversation_not_found"
  | "request_not_found" | "runtime_unavailable" | "cancel_not_accepted" | "operation_failed";
export type ChatConversationResponse =
  | { ok: true; conversationId: string }
  | { ok: false; error: { code: "runtime_unavailable" | "operation_failed"; message: string } };
export interface ChatConversationCreateRequest { newConversation?: boolean; }
export interface ChatMessageCursor { offset: number; beforeSequence: number; }
export interface ChatConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status: "complete" | "interrupted";
}
export interface ChatConversationOpenRequest { conversationId: string; }
export interface ChatConversationMessagesRequest { conversationId: string; cursor?: ChatMessageCursor | null; }
export interface ChatConversationListCursor { updatedAt: string; conversationId: string; }
export interface ChatConversationSummary {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
export interface ChatConversationListRequest { limit?: number; cursor?: ChatConversationListCursor | null; }
export interface ChatConversationRenameRequest { conversationId: string; title: string; }
export type ChatConversationRenameResponse =
  | { ok: true; conversationId: string; title: string }
  | { ok: false; error: { code: "invalid_request" | "conversation_not_found" | "invalid_title" | "operation_failed"; message: string } };
export type ChatConversationListResponse =
  | { ok: true; conversations: ChatConversationSummary[]; nextCursor: ChatConversationListCursor | null }
  | { ok: false; error: { code: "runtime_unavailable" | "operation_failed"; message: string } };
export type ChatConversationMessagesResponse =
  | { ok: true; conversationId: string; messages: ChatConversationMessage[]; nextCursor: ChatMessageCursor | null; incompleteTail: boolean }
  | { ok: false; error: { code: "conversation_not_found" | "runtime_unavailable" | "operation_failed"; message: string } };
export interface ChatIpcFailure {
  ok: false;
  conversationId?: string;
  requestId: string;
  error: { code: ChatIpcErrorCode; message: string };
}
export type ChatSendResponse = ChatSendAck | ChatIpcFailure;
export interface ChatCancelRequest { requestId: string; }
export interface ChatCancelAck { ok: true; accepted: true; requestId: string; }
export type ChatCancelResponse = ChatCancelAck | ChatIpcFailure;
export type AuthorizationProvider = "microsoft" | "spotify";
export type AuthorizationState = "not_connected" | "reauthorization_required" | "insufficient_permissions";
export interface ChatAuthorizationRequirement {
  provider: AuthorizationProvider;
  state: AuthorizationState;
  reason: "email_not_connected" | "microsoft_authorization_required" | "microsoft_access_denied"
    | "spotify_auth_required" | "spotify_reauthorization_required" | "spotify_auth_expired";
  canConnect: boolean;
  retrySafe: boolean;
}
export interface AuthorizationRequiredEvent {
  conversationId: string;
  requestId: string;
  status: "authorization_required";
  requirement: ChatAuthorizationRequirement;
}
export interface SpotifyNowPlayingCard {
  name: string;
  artists: string[];
  imageUrl: string | null;
  spotifyUrl: string | null;
  playing: boolean;
}
export interface SpotifyNowPlayingEvent {
  conversationId: string;
  requestId: string;
  status: "spotify_now_playing";
  card: SpotifyNowPlayingCard;
}
export interface ChatPresentationMetadata {
  kind: "diagnostic" | "tool_catalog";
  technicalDetail: string;
}
export type ChatEventStatus = "processing" | "text_delta" | "text_reset" | "completed" | "cancelled" | "error" | "authorization_required" | "spotify_now_playing" | "conversation_title_updated";
interface ChatEventBase {
  conversationId: string;
  requestId: string;
}
export type ChatEventEnvelope =
  | AuthorizationRequiredEvent
  | SpotifyNowPlayingEvent
  | (ChatEventBase & { status: "conversation_title_updated"; title: string; source?: "automatic" | "manual" })
  | (ChatEventBase & { status: "text_delta"; delta: string })
  | (ChatEventBase & { status: "text_reset" })
  | (ChatEventBase & { status: "processing" })
  | (ChatEventBase & { status: "cancelled" })
  | (ChatEventBase & { status: "completed"; response: string; presentation?: ChatPresentationMetadata })
  | (ChatEventBase & { status: "error"; error: { code: ChatIpcErrorCode; message: string } });
export interface ChatDesktopApi {
  createConversation(request?: ChatConversationCreateRequest): Promise<ChatConversationResponse>;
  openConversation(conversationId: string): Promise<ChatConversationMessagesResponse>;
  listMessages(request: ChatConversationMessagesRequest): Promise<ChatConversationMessagesResponse>;
  listConversations(request?: ChatConversationListRequest): Promise<ChatConversationListResponse>;
  renameConversation(request: ChatConversationRenameRequest): Promise<ChatConversationRenameResponse>;
  sendMessage(request: ChatSendMessageRequest): Promise<ChatSendResponse>;
  cancelRequest(requestId: string): Promise<ChatCancelResponse>;
  onEvent(listener: (event: ChatEventEnvelope) => void): () => void;
}

export type DesktopMemoryMode = "memory1" | "memory2-readonly" | "memory2-confirmed-write";
export interface DesktopMemoryModeStatus {
  mode: DesktopMemoryMode;
  memory2Available: boolean;
  memory2WriteAvailable: boolean;
  switching: boolean;
  fallbackReason: "invalid_preference" | "mode_unavailable" | null;
}
export type DesktopMemoryModeResult =
  | { ok: true; status: DesktopMemoryModeStatus }
  | { ok: false; error: "busy" | "memory2_unavailable" | "memory2_write_unavailable" | "operation_failed" };
export interface DesktopMemoryApi {
  getStatus(): Promise<DesktopMemoryModeStatus>;
  setMode(mode: DesktopMemoryMode): Promise<DesktopMemoryModeResult>;
}

export function isDesktopMemoryMode(value: unknown): value is DesktopMemoryMode {
  return value === "memory1" || value === "memory2-readonly" || value === "memory2-confirmed-write";
}
export function isDesktopMemoryModeStatus(value: unknown): value is DesktopMemoryModeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5 && isDesktopMemoryMode(record.mode)
    && typeof record.memory2Available === "boolean" && typeof record.memory2WriteAvailable === "boolean"
    && typeof record.switching === "boolean"
    && (record.fallbackReason === null || record.fallbackReason === "invalid_preference" || record.fallbackReason === "mode_unavailable");
}
export function isDesktopMemoryModeResult(value: unknown): value is DesktopMemoryModeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return Object.keys(record).length === 2 && isDesktopMemoryModeStatus(record.status);
  return record.ok === false && Object.keys(record).length === 2
    && ["busy", "memory2_unavailable", "memory2_write_unavailable", "operation_failed"].includes(String(record.error));
}

export interface AuthorizationConnectRequest { provider: AuthorizationProvider; requestId: string; }
export type AuthorizationConnectResult =
  | { provider: AuthorizationProvider; state: "connected" }
  | { provider: AuthorizationProvider; state: "cancelled" }
  | { provider: AuthorizationProvider; state: "error"; code: string; message: string };
export interface AuthorizationCancelRequest { provider: AuthorizationProvider; requestId: string; }
export type AuthorizationCancelResult =
  | { provider: AuthorizationProvider; requestId: string; accepted: true }
  | { provider: AuthorizationProvider; requestId: string; accepted: false; code: "not_active" | "unsupported" };
export interface AuthorizationDesktopApi {
  connect(request: AuthorizationConnectRequest): Promise<AuthorizationConnectResult>;
  cancel(request: AuthorizationCancelRequest): Promise<AuthorizationCancelResult>;
}
export type SpotifyPlaybackControl = "play" | "pause" | "previous" | "next";
export type SpotifyLiveStatusState = "loading" | "playing" | "paused" | "no_track" | "not_connected" | "no_device" | "unavailable";
export interface SpotifyLiveStatus {
  state: SpotifyLiveStatusState;
  connected: boolean;
  deviceAvailable: boolean;
  controlsEnabled: boolean;
  track: SpotifyNowPlayingCard | null;
  message: string | null;
  updatedAt: number | null;
}
export type SpotifyControlErrorCode = "not_connected" | "no_device" | "permission_denied"
  | "rate_limited" | "provider_restricted" | "busy" | "operation_failed" | "outcome_uncertain";
export type SpotifyStateVerification = "target_transition_observed" | "target_already_observed" | "previous_track_restarted_observed";
export type SpotifyObservedState = "playing" | "paused" | "track_changed" | "track_restarted";
export type SpotifyControlResponse =
  | { ok: true; action: SpotifyPlaybackControl; outcome: "provider_accepted"; providerAccepted: true;
      reconciliation: "available" | "unavailable" }
  | { ok: true; action: SpotifyPlaybackControl; outcome: "state_confirmed"; stateConfirmed: true;
      verification: SpotifyStateVerification; reconciliation: "available" | "unavailable" }
  | { ok: false; action: SpotifyPlaybackControl; error: { code: SpotifyControlErrorCode; message: string };
      reconciliation?: "changed" | "unchanged" | "unavailable"; observedState?: SpotifyObservedState };
export interface SpotifyDesktopApi {
  openTrack(url: string): Promise<boolean>;
  getLiveStatus(): Promise<SpotifyLiveStatus>;
  setLiveStatusVisible(visible: boolean): void;
  onLiveStatus(listener: (status: SpotifyLiveStatus) => void): () => void;
  control(action: SpotifyPlaybackControl): Promise<SpotifyControlResponse>;
}

export interface WeatherCurrentStatus {
  readonly available: boolean;
  readonly location: string;
  readonly temperatureC: number | null;
  readonly condition: string | null;
  readonly updatedAt: number;
}
export interface WeatherDesktopApi {
  getCurrent(location: string): Promise<WeatherCurrentStatus>;
}

export interface MasterVolumeStatus {
  available: boolean;
  volume: number | null;
  errorCode: "device_unavailable" | "access_denied" | "operation_failed" | null;
}
export interface MasterVolumeDesktopApi {
  get(): Promise<MasterVolumeStatus>;
  set(value: number): Promise<MasterVolumeStatus>;
  onChanged(listener: (status: MasterVolumeStatus) => void): () => void;
}

export type VoicePttEventType =
  | "voice.session.started"
  | "voice.transcribing"
  | "voice.transcript.final"
  | "voice.cancelled"
  | "voice.error"
  | "voice.session.ended";

export interface VoiceSessionEvent {
  type: "voice.session.started" | "voice.session.ended";
  sessionId: string;
  turnId: null;
  timestamp: number;
}
export interface VoiceTranscribingEvent {
  type: "voice.transcribing";
  sessionId: string;
  turnId: string;
  timestamp: number;
}
export interface VoiceTranscriptFinalEvent {
  type: "voice.transcript.final";
  sessionId: string;
  turnId: string;
  timestamp: number;
  text: string;
  language: string | null;
}
export interface VoiceCancelledEvent {
  type: "voice.cancelled";
  sessionId: string;
  turnId: string;
  timestamp: number;
  reason: "user" | "superseded" | "session_ended" | "timeout";
}
export interface VoiceErrorEvent {
  type: "voice.error";
  sessionId: string;
  turnId: string;
  timestamp: number;
  error: { code: "VOICE_PTT_TRANSCRIPTION_FAILED"; message: string };
}
export type VoicePttEvent = VoiceSessionEvent | VoiceTranscribingEvent | VoiceTranscriptFinalEvent
  | VoiceCancelledEvent | VoiceErrorEvent;

export interface VoiceEventEnvelope {
  requestId: string;
  sessionId: string;
  sequence: number;
  turnId?: string;
  event: VoicePttEvent;
}

export interface VoicePttStartRequest { requestId: string; }
export interface VoicePttStartSuccess { ok: true; requestId: string; sessionId: string; }
export interface VoicePttFinishRequest {
  requestId: string;
  sessionId: string;
  audio: Uint8Array;
  format: "wav";
  language?: string;
  pttFinalizationMs?: number;
  audioConversionMs?: number;
}
export interface VoicePttFinishAck { ok: true; accepted: true; requestId: string; sessionId: string; }
export interface VoicePttCancelRequest {
  requestId: string;
  sessionId: string;
  targetRequestId: string;
}
export interface VoicePttCancelSuccess {
  ok: true;
  requestId: string;
  sessionId: string;
  targetRequestId: string;
  cancelled: boolean;
}
export type VoiceIpcErrorCode = "invalid_request" | "session_unavailable" | "session_mismatch"
  | "request_conflict" | "request_not_found" | "operation_failed";
export interface VoiceIpcError { code: VoiceIpcErrorCode; message: string; }
export interface VoiceIpcFailure { ok: false; requestId: string; error: VoiceIpcError; }
export type VoicePttStartResponse = VoicePttStartSuccess | VoiceIpcFailure;
export type VoicePttFinishResponse = VoicePttFinishAck | VoiceIpcFailure;
export type VoicePttCancelResponse = VoicePttCancelSuccess | VoiceIpcFailure;

export interface VoicePttApi {
  start: (request: VoicePttStartRequest) => Promise<VoicePttStartResponse>;
  finish: (request: VoicePttFinishRequest) => Promise<VoicePttFinishResponse>;
  cancel: (request: VoicePttCancelRequest) => Promise<VoicePttCancelResponse>;
}
export type VoiceSpeechState = "preparing" | "speaking" | "completed" | "cancelled" | "error";
export type VoiceSpeechErrorCode = "voice_speech_generation_failed" | "voice_speech_playback_failed"
  | "voice_speech_playback_timeout" | "voice_speech_start_timeout" | "voice_speech_stop_failed"
  | "voice_speech_stop_timeout" | "voice_speech_busy" | "voice_speech_degraded" | "voice_speech_too_long"
  | "voice_audio_storage_unavailable" | "voice_tts_generation_failed" | "voice_tts_generation_timeout" | "voice_tts_response_invalid"
  | "voice_audio_processing_failed" | "voice_audio_storage_failed" | "voice_identity_browser_unavailable";
export interface VoiceSpeechEvent {
  requestId: string;
  state: VoiceSpeechState;
  error?: { code: VoiceSpeechErrorCode };
}
export interface VoiceSpeechCancelRequest { requestId: string; }
export interface VoiceSpeechAcknowledgementRequest { requestId: string; }
export interface VoiceSpeechAcknowledgementResponse { ok: true; requestId: string; accepted: boolean; }
export type VoiceSpeechCancelResponse =
  | { ok: true; requestId: string; cancelled: boolean }
  | { ok: false; requestId: string; error: "request_not_found" | "operation_failed" };
export interface VoiceSpeechApi {
  acknowledge(request: VoiceSpeechAcknowledgementRequest): Promise<VoiceSpeechAcknowledgementResponse>;
  playChatResponse(requestId: string): Promise<boolean>;
  cancel(request: VoiceSpeechCancelRequest): Promise<VoiceSpeechCancelResponse>;
  onEvent(listener: (event: VoiceSpeechEvent) => void): () => void;
}
export type VoiceFollowupDiagnosticOutcome = "window_opened" | "vad_speech_detected" | "vad_misfire"
  | "window_expired_no_speech" | "window_expired_after_speech" | "transcription_submitted"
  | "transcript_empty" | "transcript_unusable" | "transcript_accepted_without_prefix"
  | "transcript_accepted_prefix_removed" | "prefix_rejected" | "prefix_accepted" | "chat_submission_requested"
  | "transcription_error" | "cancelled";
export interface VoiceFollowupDiagnosticRequest {
  requestId: string;
  outcome: VoiceFollowupDiagnosticOutcome;
  durationMs?: number;
}
export type VoiceChatTimingOrigin = "typed" | "voice";
export type VoiceChatTimingPhase = "request_started" | "runtime_processing_started" | "response_final_received"
  | "first_text_delta_received" | "first_text_rendered" | "response_rendered"
  | "ack_timer_started" | "ack_timer_expired" | "ack_timer_cancelled_response"
  | "ack_timer_cancelled_terminal" | "ack_timer_cancelled_superseded" | "stop_requested"
  | "response_arrived_during_ack" | "response_after_ack_timer" | "response_final_available_before_ack"
  | "ack_release_wait" | "runtime_to_final";
export interface VoiceChatTimingDiagnosticRequest {
  requestId: string;
  origin: VoiceChatTimingOrigin;
  phase: VoiceChatTimingPhase;
  durationMs?: number;
}
export interface VoiceDesktopApi {
  ptt: VoicePttApi;
  speech: VoiceSpeechApi;
  endDucking(requestId: string, reason?: "completed" | "followup_expired" | "stop" | "error"): Promise<boolean>;
  recordFollowupDiagnostic(request: VoiceFollowupDiagnosticRequest): Promise<boolean>;
  recordChatTiming(request: VoiceChatTimingDiagnosticRequest): Promise<boolean>;
  onEvent: (listener: (event: VoiceEventEnvelope) => void) => () => void;
}

export interface PingResponse { ok: true; message: "pong"; }
export type WallpaperResponse =
  | { available: true; dataUrl: string }
  | { available: false };
export type DesktopRestartResponse = { ok: true; accepted: true }
  | { ok: false; error: "restart_pending" | "restart_unavailable" | "relaunch_failed" };
export interface NexaDesktopApi {
  readonly isIsolated: boolean;
  readonly isSyntheticOrganicPilot: boolean;
  ping: () => Promise<PingResponse>;
  getWallpaper: () => Promise<WallpaperResponse>;
  copyTechnicalDetail: (text: string) => Promise<boolean>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  restartDesktop: () => Promise<DesktopRestartResponse>;
  windowSettings: WindowSettingsDesktopApi;
  voice: VoiceDesktopApi;
  chat: ChatDesktopApi;
  memory: DesktopMemoryApi;
  authorization: AuthorizationDesktopApi;
  spotify: SpotifyDesktopApi;
  masterVolume: MasterVolumeDesktopApi;
  weather: WeatherDesktopApi;
}

export interface DesktopDisplayInfo {
  id: string;
  label: string;
  resolution: string;
  primary: boolean;
}
export interface WindowPreferences {
  displayId: string;
  startFullscreen: boolean;
}
export interface WindowSettingsSnapshot {
  displays: DesktopDisplayInfo[];
  preferences: WindowPreferences;
  effectiveFullscreen: boolean;
  effectiveDisplayId: string;
  transitioning: boolean;
  transitionTargetFullscreen: boolean | null;
  transitionTargetDisplayId: string | null;
}
export interface WindowSettingsDesktopApi {
  get(): Promise<WindowSettingsSnapshot>;
  set(preferences: WindowPreferences): Promise<WindowSettingsSnapshot>;
  onChanged(listener: (snapshot: WindowSettingsSnapshot) => void): () => void;
}

export function createPingResponse(): PingResponse {
  return { ok: true, message: "pong" };
}

export function isPingResponse(value: unknown): value is PingResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && record.ok === true && record.message === "pong";
}

export function isDesktopRestartResponse(value: unknown): value is DesktopRestartResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return record.ok === true ? keys.length === 2 && record.accepted === true
    : record.ok === false && keys.length === 2
      && typeof record.error === "string"
      && ["restart_pending", "restart_unavailable", "relaunch_failed"].includes(record.error);
}

const MAX_WALLPAPER_DATA_URL_LENGTH = 14 * 1024 * 1024;
const WALLPAPER_DATA_URL_PATTERN = /^data:image\/(?:jpeg|png|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isWallpaperResponse(value: unknown): value is WallpaperResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.available === false) return keys.length === 1;
  return record.available === true &&
    keys.length === 2 &&
    typeof record.dataUrl === "string" &&
    record.dataUrl.length <= MAX_WALLPAPER_DATA_URL_LENGTH &&
    WALLPAPER_DATA_URL_PATTERN.test(record.dataUrl);
}
