import type {
  ChatCancelRequest, ChatCancelResponse, ChatConversationResponse, ChatEventEnvelope, ChatIpcErrorCode,
  ChatSendMessageRequest, ChatSendResponse,
} from "./ipc-contract.js";
import { isSpotifyTrackUrl } from "./spotify-link-validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 16_000;
const ERROR_CODES: readonly ChatIpcErrorCode[] = ["invalid_request", "busy", "conversation_not_found",
  "request_not_found", "runtime_unavailable", "cancel_not_accepted", "operation_failed"];
const EVENT_STATUSES = ["processing", "completed", "cancelled", "error", "authorization_required"] as const;
const EXTERNAL_EVENT_STATUSES = [...EVENT_STATUSES, "spotify_now_playing"] as const;
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(record: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
function isIdentifier(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function isError(value: unknown): value is { code: ChatIpcErrorCode; message: string } {
  return isRecord(value) && exactKeys(value, ["code", "message"])
    && ERROR_CODES.includes(value.code as ChatIpcErrorCode)
    && typeof value.message === "string" && value.message.length <= 300;
}
function isSafeProviderUrl(value: unknown, hostname: string): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === hostname && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function isChatSendMessageRequest(value: unknown): value is ChatSendMessageRequest {
  return isRecord(value) && exactKeys(value, ["conversationId", "requestId", "text", "source"])
    && isIdentifier(value.conversationId) && isIdentifier(value.requestId)
    && typeof value.text === "string" && value.text.trim().length > 0
    && value.text.length <= MAX_TEXT_LENGTH && (value.source === "typed" || value.source === "voice");
}
export function isChatCancelRequest(value: unknown): value is ChatCancelRequest {
  return isRecord(value) && exactKeys(value, ["requestId"]) && isIdentifier(value.requestId);
}
export function isChatConversationResponse(value: unknown): value is ChatConversationResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) return exactKeys(value, ["ok", "conversationId"]) && isIdentifier(value.conversationId);
  return value.ok === false && exactKeys(value, ["ok", "error"]) && isRecord(value.error)
    && exactKeys(value.error, ["code", "message"])
    && (value.error.code === "runtime_unavailable" || value.error.code === "operation_failed")
    && typeof value.error.message === "string" && value.error.message.length <= 300;
}
export function isChatSendResponse(value: unknown): value is ChatSendResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) return exactKeys(value, ["ok", "accepted", "conversationId", "requestId"])
    && value.accepted === true && isIdentifier(value.conversationId) && isIdentifier(value.requestId);
  if (value.ok !== false || !isIdentifier(value.requestId) || !isError(value.error)) return false;
  return exactKeys(value, value.conversationId === undefined ? ["ok", "requestId", "error"]
    : ["ok", "conversationId", "requestId", "error"])
    && (value.conversationId === undefined || isIdentifier(value.conversationId));
}
export function isChatCancelResponse(value: unknown): value is ChatCancelResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) return exactKeys(value, ["ok", "accepted", "requestId"])
    && value.accepted === true && isIdentifier(value.requestId);
  return value.ok === false && exactKeys(value, ["ok", "requestId", "error"])
    && isIdentifier(value.requestId) && isError(value.error);
}
export function isChatEventEnvelope(value: unknown): value is ChatEventEnvelope {
  if (!isRecord(value) || !isIdentifier(value.conversationId) || !isIdentifier(value.requestId)
    || !EXTERNAL_EVENT_STATUSES.includes(value.status as ChatEventEnvelope["status"])) return false;
  if (value.status === "spotify_now_playing") {
    if (!exactKeys(value, ["conversationId", "requestId", "status", "card"]) || !isRecord(value.card)) return false;
    const card = value.card;
    return exactKeys(card, ["name", "artists", "imageUrl", "spotifyUrl", "playing"])
      && typeof card.name === "string" && card.name.trim().length > 0 && card.name.length <= 300
      && Array.isArray(card.artists) && card.artists.length <= 10
      && card.artists.every((artist) => typeof artist === "string" && artist.trim().length > 0 && artist.length <= 200)
      && (card.imageUrl === null || isSafeProviderUrl(card.imageUrl, "i.scdn.co"))
      && (card.spotifyUrl === null || isSpotifyTrackUrl(card.spotifyUrl))
      && typeof card.playing === "boolean";
  }
  if (value.status === "authorization_required") {
    if (!exactKeys(value, ["conversationId", "requestId", "status", "requirement"]) || !isRecord(value.requirement)) return false;
    const requirement = value.requirement;
    if (!exactKeys(requirement, ["provider", "state", "reason", "canConnect", "retrySafe"])
      || typeof requirement.canConnect !== "boolean" || typeof requirement.retrySafe !== "boolean") return false;
    const microsoftReasons = ["email_not_connected", "microsoft_authorization_required", "microsoft_access_denied"];
    const spotifyReasons = ["spotify_auth_required", "spotify_reauthorization_required", "spotify_auth_expired"];
    const validPair = requirement.provider === "microsoft"
      ? microsoftReasons.includes(String(requirement.reason)) : requirement.provider === "spotify"
        && spotifyReasons.includes(String(requirement.reason));
    if (!validPair) return false;
    const insufficient = requirement.reason === "microsoft_access_denied";
    const expectedState = insufficient ? "insufficient_permissions"
      : requirement.reason === "email_not_connected" || requirement.reason === "spotify_auth_required" ? "not_connected"
        : "reauthorization_required";
    return requirement.state === expectedState && requirement.canConnect === !insufficient
      && (requirement.canConnect || !requirement.retrySafe);
  }
  if (value.status === "completed") {
    const baseKeys = ["conversationId", "requestId", "status", "response"];
    if (!exactKeys(value, value.presentation === undefined ? baseKeys : [...baseKeys, "presentation"])
      || typeof value.response !== "string" || value.response.length > MAX_TEXT_LENGTH) return false;
    if (value.presentation === undefined) return true;
    return isRecord(value.presentation) && exactKeys(value.presentation, ["kind", "technicalDetail"])
      && (value.presentation.kind === "diagnostic" || value.presentation.kind === "tool_catalog")
      && typeof value.presentation.technicalDetail === "string"
      && value.presentation.technicalDetail.length > 0 && value.presentation.technicalDetail.length <= 20_000;
  }
  if (value.status === "error") return exactKeys(value, ["conversationId", "requestId", "status", "error"])
    && isError(value.error);
  return exactKeys(value, ["conversationId", "requestId", "status"]);
}

export const CHAT_MESSAGE_MAX_LENGTH = MAX_TEXT_LENGTH;
