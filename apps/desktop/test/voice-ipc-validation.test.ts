import { describe, expect, it } from "vitest";
import {
  isVoiceEventEnvelope,
  isVoicePttCancelRequest,
  isVoicePttFinishRequest,
  isVoicePttStartRequest,
  MAX_VOICE_PTT_AUDIO_BYTES,
} from "../src/shared/voice-ipc-validation";

function makeWav(dataBytes = 2): Uint8Array {
  const paddedDataBytes = dataBytes + (dataBytes & 1);
  const bytes = new Uint8Array(44 + paddedDataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => [...value].forEach((char, index) => bytes[offset + index] = char.charCodeAt(0));
  tag(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

describe("Voice IPC validation", () => {
  it("accepts strict start and cancel requests and rejects extra or malformed fields", () => {
    expect(isVoicePttStartRequest({ requestId: "start-1" })).toBe(true);
    expect(isVoicePttStartRequest({ requestId: "start-1", extra: true })).toBe(false);
    expect(isVoicePttStartRequest({ requestId: "\n" })).toBe(false);
    expect(isVoicePttCancelRequest({ requestId: "cancel-1", sessionId: "session-1", targetRequestId: "finish-1" })).toBe(true);
    expect(isVoicePttCancelRequest({ requestId: "cancel-1", sessionId: "session-1" })).toBe(false);
  });

  it("accepts only bounded WAV PCM16 mono 16 kHz audio up to 30 seconds", () => {
    expect(isVoicePttFinishRequest({ requestId: "finish-1", sessionId: "session-1", audio: makeWav(), format: "wav" })).toBe(true);
    expect(isVoicePttFinishRequest({ requestId: "finish-1", sessionId: "session-1", audio: makeWav(960_000), format: "wav" })).toBe(true);
    expect(isVoicePttFinishRequest({ requestId: "finish-1", sessionId: "session-1", audio: makeWav(960_002), format: "wav" })).toBe(false);
    expect(isVoicePttFinishRequest({ requestId: "finish-1", sessionId: "session-1", audio: makeWav(MAX_VOICE_PTT_AUDIO_BYTES), format: "wav" })).toBe(false);
    const wrongProfile = makeWav(); new DataView(wrongProfile.buffer).setUint16(22, 2, true);
    expect(isVoicePttFinishRequest({ requestId: "finish-1", sessionId: "session-1", audio: wrongProfile, format: "wav" })).toBe(false);
    expect(isVoicePttFinishRequest({ requestId: "finish-1", sessionId: "session-1", audio: new Uint8Array([1, 2]), format: "wav" })).toBe(false);
    expect(isVoicePttFinishRequest({ requestId: "finish-1", sessionId: "session-1", audio: makeWav(), format: "WAV" })).toBe(false);
  });

  it("validates event envelopes and preserves the Voice event object and turn identity", () => {
    const event = Object.freeze({ type: "voice.transcript.final", sessionId: "session-1", turnId: "turn-1", timestamp: 123,
      text: "hola", language: "es" });
    const envelope = { requestId: "finish-1", sessionId: "session-1", sequence: 2, turnId: "turn-1", event };
    expect(isVoiceEventEnvelope(envelope)).toBe(true);
    expect(envelope.event).toBe(event);
    expect(isVoiceEventEnvelope({ ...envelope, turnId: undefined })).toBe(false);
    expect(isVoiceEventEnvelope({ ...envelope, sequence: 0 })).toBe(false);
    expect(isVoiceEventEnvelope({ ...envelope, event: { ...event, extra: true } })).toBe(false);
    const started = { type: "voice.session.started", sessionId: "session-1", turnId: null, timestamp: 123 };
    expect(isVoiceEventEnvelope({ requestId: "start-1", sessionId: "session-1", sequence: 1, event: started })).toBe(true);
    expect(isVoiceEventEnvelope({ requestId: "start-1", sessionId: "session-1", sequence: 1, turnId: "invented", event: started })).toBe(false);
  });
});
