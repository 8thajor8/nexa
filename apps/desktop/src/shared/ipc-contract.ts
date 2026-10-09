export const PING_CHANNEL = "nexa:ping" as const;
export const GET_WALLPAPER_CHANNEL = "nexa:wallpaper:get" as const;
export const WINDOW_MINIMIZE_CHANNEL = "nexa:window:minimize" as const;
export const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = "nexa:window:toggle-maximize" as const;
export const WINDOW_CLOSE_CHANNEL = "nexa:window:close" as const;

export const VOICE_PTT_START_CHANNEL = "voice:ptt:start" as const;
export const VOICE_PTT_FINISH_CHANNEL = "voice:ptt:finish" as const;
export const VOICE_PTT_CANCEL_CHANNEL = "voice:ptt:cancel" as const;
export const VOICE_EVENT_CHANNEL = "voice:event" as const;

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
export interface VoiceDesktopApi {
  ptt: VoicePttApi;
  onEvent: (listener: (event: VoiceEventEnvelope) => void) => () => void;
}

export interface PingResponse { ok: true; message: "pong"; }
export type WallpaperResponse =
  | { available: true; dataUrl: string }
  | { available: false };
export interface NexaDesktopApi {
  ping: () => Promise<PingResponse>;
  getWallpaper: () => Promise<WallpaperResponse>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  voice: VoiceDesktopApi;
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
