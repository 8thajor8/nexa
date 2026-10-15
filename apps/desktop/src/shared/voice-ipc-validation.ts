import type {
  VoiceEventEnvelope,
  VoicePttCancelRequest,
  VoicePttCancelResponse,
  VoicePttEvent,
  VoicePttFinishAck,
  VoicePttFinishRequest,
  VoicePttFinishResponse,
  VoicePttStartRequest,
  VoicePttStartResponse,
  VoiceSpeechCancelRequest,
  VoiceSpeechCancelResponse,
  VoiceSpeechAcknowledgementRequest,
  VoiceSpeechAcknowledgementResponse,
  VoiceChatTimingDiagnosticRequest,
  VoiceSpeechEvent,
  VoiceFollowupDiagnosticRequest,
} from "./ipc-contract.js";

export const MAX_VOICE_PTT_AUDIO_BYTES = 1_048_576;
export const MAX_VOICE_PTT_DURATION_SECONDS = 30;
const MAX_ID_LENGTH = 128;
const MAX_LANGUAGE_LENGTH = 64;
const SAMPLE_RATE = 16_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function isVoiceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isVoicePttStartRequest(value: unknown): value is VoicePttStartRequest {
  return isPlainRecord(value) && hasExactKeys(value, ["requestId"]) && isVoiceId(value.requestId);
}

function isPttWav(audio: unknown): audio is Uint8Array {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 44 || audio.byteLength > MAX_VOICE_PTT_AUDIO_BYTES) return false;
  const bytes = audio;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readTag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (readTag(0) !== "RIFF" || readTag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.byteLength) return false;

  let offset = 12;
  let formatSeen = false;
  let dataSeen = false;
  let dataLength = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) return false;
    const chunkId = readTag(offset);
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    const paddedEnd = chunkEnd + (chunkLength & 1);
    if (chunkEnd > bytes.byteLength || paddedEnd > bytes.byteLength) return false;

    if (chunkId === "fmt ") {
      if (formatSeen || (chunkLength !== 16 && chunkLength !== 18)) return false;
      formatSeen = true;
      if (view.getUint16(chunkStart, true) !== 1 || view.getUint16(chunkStart + 2, true) !== 1
        || view.getUint32(chunkStart + 4, true) !== SAMPLE_RATE
        || view.getUint32(chunkStart + 8, true) !== SAMPLE_RATE * 2
        || view.getUint16(chunkStart + 12, true) !== 2
        || view.getUint16(chunkStart + 14, true) !== 16
        || (chunkLength === 18 && view.getUint16(chunkStart + 16, true) !== 0)) return false;
    } else if (chunkId === "data") {
      if (dataSeen) return false;
      dataSeen = true;
      dataLength = chunkLength;
    }
    offset = paddedEnd;
  }

  return offset === bytes.byteLength && formatSeen && dataSeen && dataLength > 0
    && dataLength % 2 === 0 && dataLength / (SAMPLE_RATE * 2) <= MAX_VOICE_PTT_DURATION_SECONDS;
}

export function isVoicePttFinishRequest(value: unknown): value is VoicePttFinishRequest {
  if (!isPlainRecord(value)) return false;
  const keys = ["requestId", "sessionId", "audio", "format",
    ...(Object.hasOwn(value, "language") ? ["language"] : []),
    ...(Object.hasOwn(value, "pttFinalizationMs") ? ["pttFinalizationMs"] : []),
    ...(Object.hasOwn(value, "audioConversionMs") ? ["audioConversionMs"] : [])];
  const validDuration = (key: string) => !Object.hasOwn(value, key)
    || (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= 60_000);
  return hasExactKeys(value, keys) && isVoiceId(value.requestId) && isVoiceId(value.sessionId)
    && value.format === "wav" && isPttWav(value.audio)
    && validDuration("pttFinalizationMs") && validDuration("audioConversionMs")
    && (!Object.hasOwn(value, "language") || (typeof value.language === "string"
      && value.language.length > 0 && value.language.length <= MAX_LANGUAGE_LENGTH
      && !/[\u0000-\u001f\u007f]/.test(value.language)));
}

export function isVoicePttCancelRequest(value: unknown): value is VoicePttCancelRequest {
  return isPlainRecord(value) && hasExactKeys(value, ["requestId", "sessionId", "targetRequestId"])
    && isVoiceId(value.requestId) && isVoiceId(value.sessionId) && isVoiceId(value.targetRequestId);
}

export function isVoiceSpeechCancelRequest(value: unknown): value is VoiceSpeechCancelRequest {
  return isPlainRecord(value) && hasExactKeys(value, ["requestId"]) && isVoiceId(value.requestId);
}

export function isVoiceSpeechAcknowledgementRequest(value: unknown): value is VoiceSpeechAcknowledgementRequest {
  return isPlainRecord(value) && hasExactKeys(value, ["requestId"]) && isVoiceId(value.requestId);
}

export function isVoiceFollowupDiagnosticRequest(value: unknown): value is VoiceFollowupDiagnosticRequest {
  if (!isPlainRecord(value)) return false;
  const keys = ["requestId", "outcome", ...(Object.hasOwn(value, "durationMs") ? ["durationMs"] : [])];
  const outcomes = ["window_opened", "vad_speech_detected", "vad_misfire", "window_expired_no_speech",
    "window_expired_after_speech", "transcription_submitted", "transcript_empty", "transcript_unusable",
    "transcript_accepted_without_prefix", "transcript_accepted_prefix_removed", "prefix_rejected",
    "prefix_accepted", "chat_submission_requested", "transcription_error", "cancelled"];
  return hasExactKeys(value, keys) && isVoiceId(value.requestId) && outcomes.includes(String(value.outcome))
    && (!Object.hasOwn(value, "durationMs") || (Number.isFinite(value.durationMs)
      && typeof value.durationMs === "number" && value.durationMs >= 0 && value.durationMs <= 60_000));
}

export function isVoiceChatTimingDiagnosticRequest(value: unknown): value is VoiceChatTimingDiagnosticRequest {
  if (!isPlainRecord(value)) return false;
  const keys = ["requestId", "origin", "phase", ...(Object.hasOwn(value, "durationMs") ? ["durationMs"] : [])];
  const origins = ["typed", "voice"];
  const phases = ["request_started", "runtime_processing_started", "first_text_delta_received", "first_text_rendered",
    "response_final_received", "response_rendered",
    "ack_timer_started", "ack_timer_expired", "ack_timer_cancelled_response", "ack_timer_cancelled_terminal",
    "ack_timer_cancelled_superseded", "stop_requested", "response_arrived_during_ack", "response_after_ack_timer",
    "response_final_available_before_ack", "ack_release_wait", "runtime_to_final"];
  return hasExactKeys(value, keys) && isVoiceId(value.requestId) && origins.includes(String(value.origin))
    && phases.includes(String(value.phase))
    && (!Object.hasOwn(value, "durationMs") || (typeof value.durationMs === "number"
      && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 600_000));
}

export function isVoiceSpeechAcknowledgementResponse(value: unknown): value is VoiceSpeechAcknowledgementResponse {
  return isPlainRecord(value) && hasExactKeys(value, ["ok", "requestId", "accepted"])
    && value.ok === true && isVoiceId(value.requestId) && typeof value.accepted === "boolean";
}

export function isVoiceSpeechEvent(value: unknown): value is VoiceSpeechEvent {
  if (!isPlainRecord(value) || !isVoiceId(value.requestId)) return false;
  if (value.state === "preparing" || value.state === "speaking" || value.state === "completed" || value.state === "cancelled") {
    return hasExactKeys(value, ["requestId", "state"]);
  }
  return value.state === "error" && hasExactKeys(value, ["requestId", "state", "error"])
    && isPlainRecord(value.error) && hasExactKeys(value.error, ["code"])
    && ["voice_speech_generation_failed", "voice_speech_playback_failed", "voice_speech_playback_timeout",
      "voice_speech_start_timeout", "voice_speech_stop_failed", "voice_speech_stop_timeout", "voice_speech_busy",
      "voice_speech_degraded", "voice_speech_too_long", "voice_audio_storage_unavailable", "voice_tts_generation_failed", "voice_tts_generation_timeout",
      "voice_tts_response_invalid", "voice_audio_processing_failed", "voice_audio_storage_failed",
      "voice_identity_browser_unavailable"].includes(String(value.error.code));
}

export function isVoiceSpeechCancelResponse(value: unknown): value is VoiceSpeechCancelResponse {
  if (!isPlainRecord(value) || !isVoiceId(value.requestId)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok", "requestId", "cancelled"]) && typeof value.cancelled === "boolean";
  return value.ok === false && hasExactKeys(value, ["ok", "requestId", "error"])
    && (value.error === "request_not_found" || value.error === "operation_failed");
}

function isVoicePttEvent(value: unknown): value is VoicePttEvent {
  if (!isPlainRecord(value) || typeof value.type !== "string" || !isVoiceId(value.sessionId)
    || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
  const lifecycle = value.type === "voice.session.started" || value.type === "voice.session.ended";
  if (lifecycle) return hasExactKeys(value, ["type", "sessionId", "turnId", "timestamp"]) && value.turnId === null;
  if (typeof value.turnId !== "string" || !isVoiceId(value.turnId)) return false;
  switch (value.type) {
    case "voice.transcribing":
      return hasExactKeys(value, ["type", "sessionId", "turnId", "timestamp"]);
    case "voice.transcript.final":
      return hasExactKeys(value, ["type", "sessionId", "turnId", "timestamp", "text", "language"])
        && typeof value.text === "string" && (value.language === null || typeof value.language === "string");
    case "voice.cancelled":
      return hasExactKeys(value, ["type", "sessionId", "turnId", "timestamp", "reason"])
        && ["user", "superseded", "session_ended", "timeout"].includes(String(value.reason));
    case "voice.error":
      if (!hasExactKeys(value, ["type", "sessionId", "turnId", "timestamp", "error"]) || !isPlainRecord(value.error)) return false;
      return hasExactKeys(value.error, ["code", "message"])
        && value.error.code === "VOICE_PTT_TRANSCRIPTION_FAILED" && typeof value.error.message === "string";
    default:
      return false;
  }
}

export function isVoiceEventEnvelope(value: unknown): value is VoiceEventEnvelope {
  if (!isPlainRecord(value)) return false;
  const hasTurnId = Object.hasOwn(value, "turnId");
  const keys = hasTurnId
    ? ["requestId", "sessionId", "sequence", "turnId", "event"]
    : ["requestId", "sessionId", "sequence", "event"];
  if (!hasExactKeys(value, keys) || !isVoiceId(value.requestId) || !isVoiceId(value.sessionId)
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || !isVoicePttEvent(value.event)) return false;
  return value.event.sessionId === value.sessionId
    && (value.event.turnId === null
      ? !hasTurnId
      : hasTurnId && value.turnId === value.event.turnId);
}

export function isVoicePttStartResponse(value: unknown): value is VoicePttStartResponse {
  if (!isPlainRecord(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok", "requestId", "sessionId"])
    && isVoiceId(value.requestId) && isVoiceId(value.sessionId);
  return isVoicePttFailure(value);
}

export function isVoicePttFinishAck(value: unknown): value is VoicePttFinishAck {
  return isPlainRecord(value) && hasExactKeys(value, ["ok", "accepted", "requestId", "sessionId"])
    && value.ok === true && value.accepted === true && isVoiceId(value.requestId) && isVoiceId(value.sessionId);
}

export function isVoicePttFinishResponse(value: unknown): value is VoicePttFinishResponse {
  return isVoicePttFinishAck(value) || isVoicePttFailure(value);
}

export function isVoicePttCancelResponse(value: unknown): value is VoicePttCancelResponse {
  if (!isPlainRecord(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok", "requestId", "sessionId", "targetRequestId", "cancelled"])
    && isVoiceId(value.requestId) && isVoiceId(value.sessionId) && isVoiceId(value.targetRequestId)
    && typeof value.cancelled === "boolean";
  return isVoicePttFailure(value);
}

function isVoicePttFailure(value: unknown): value is { ok: false; requestId: string; error: { code: string; message: string } } {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["ok", "requestId", "error"]) || value.ok !== false
    || !isVoiceId(value.requestId) || !isPlainRecord(value.error)
    || !hasExactKeys(value.error, ["code", "message"])) return false;
  return ["invalid_request", "session_unavailable", "session_mismatch", "request_conflict", "request_not_found", "operation_failed"]
    .includes(String(value.error.code)) && typeof value.error.message === "string";
}
