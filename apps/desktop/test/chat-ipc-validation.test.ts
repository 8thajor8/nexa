import { describe, expect, it } from "vitest";
import { isChatCancelRequest, isChatConversationCreateRequest, isChatEventEnvelope, isChatSendMessageRequest, isChatSendResponse } from "../src/shared/chat-ipc-validation.js";

const conversationId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";

describe("chat IPC contracts", () => {
  it("accepts only the optional explicit new-conversation flag", () => {
    expect(isChatConversationCreateRequest(undefined)).toBe(true);
    expect(isChatConversationCreateRequest({})).toBe(true);
    expect(isChatConversationCreateRequest({ newConversation: true })).toBe(true);
    expect(isChatConversationCreateRequest({ newConversation: "yes" })).toBe(false);
    expect(isChatConversationCreateRequest({ newConversation: true, path: "arbitrary" })).toBe(false);
  });

  it("accepts only bounded typed and voice messages with UUID correlation", () => {
    expect(isChatSendMessageRequest({ conversationId, requestId, text: "hola", source: "typed" })).toBe(true);
    expect(isChatSendMessageRequest({ conversationId, requestId, text: "hola", source: "voice" })).toBe(true);
    expect(isChatSendMessageRequest({ conversationId, requestId, text: " ", source: "typed" })).toBe(false);
    expect(isChatSendMessageRequest({ conversationId, requestId, text: "hola", source: "model" })).toBe(false);
    expect(isChatSendMessageRequest({ conversationId, requestId, text: "x".repeat(16_001), source: "typed" })).toBe(false);
    expect(isChatSendMessageRequest({ conversationId, requestId, text: "hola", source: "typed", channel: "anything" })).toBe(false);
  });

  it("validates cancel requests, ACK/errors, and terminal event shapes strictly", () => {
    expect(isChatCancelRequest({ requestId })).toBe(true);
    expect(isChatCancelRequest({ requestId, sessionId: "unrelated" })).toBe(false);
    expect(isChatSendResponse({ ok: true, accepted: true, conversationId, requestId })).toBe(true);
    expect(isChatSendResponse({ ok: false, requestId, error: { code: "runtime_unavailable", message: "offline" } })).toBe(true);
    expect(isChatSendResponse({ ok: true, accepted: true, conversationId, requestId, response: "fake" })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "processing" })).toBe(true);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "completed", response: "actual" })).toBe(true);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "conversation_title_updated", title: "Clima en Madrid" })).toBe(true);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "conversation_title_updated", title: "x".repeat(61) })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "conversation_title_updated", title: "Título", secret: "extra" })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "completed", response: "actual",
      presentation: { kind: "diagnostic", technicalDetail: '{"schema":"nexa-system-diagnostic/v1"}' } })).toBe(true);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "completed", response: "actual",
      presentation: { kind: "diagnostic", technicalDetail: "x", apiKey: "secret" } })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "completed" })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "cancelled", response: "fabricated" })).toBe(false);
  });

  it("validates authorization events with provider-specific state and reason pairs", () => {
    expect(isChatEventEnvelope({ conversationId, requestId, status: "authorization_required", requirement: {
      provider: "spotify", state: "not_connected", reason: "spotify_auth_required", canConnect: true, retrySafe: true,
    } })).toBe(true);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "authorization_required", requirement: {
      provider: "microsoft", state: "insufficient_permissions", reason: "microsoft_access_denied", canConnect: false, retrySafe: false,
    } })).toBe(true);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "authorization_required", requirement: {
      provider: "microsoft", state: "not_connected", reason: "spotify_auth_required", canConnect: true, retrySafe: true,
    } })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "authorization_required", requirement: {
      provider: "spotify", state: "not_connected", reason: "spotify_auth_required", canConnect: true, retrySafe: true, token: "secret",
    } })).toBe(false);
  });

  it("accepts bounded Spotify Now Playing metadata only from trusted provider URLs", () => {
    const card = { name: "Track", artists: ["Artist"], imageUrl: "https://i.scdn.co/image/abc", spotifyUrl: "https://open.spotify.com/track/abc123", playing: true };
    expect(isChatEventEnvelope({ conversationId, requestId, status: "spotify_now_playing", card })).toBe(true);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "spotify_now_playing", card: { ...card, imageUrl: "https://example.com/image.jpg" } })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "spotify_now_playing", card: { ...card, spotifyUrl: "https://open.spotify.com/playlist/abc123" } })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "spotify_now_playing", card: { ...card, artists: [" "] } })).toBe(false);
    expect(isChatEventEnvelope({ conversationId, requestId, status: "spotify_now_playing", card: { ...card, token: "secret" } })).toBe(false);
  });
});
