import type {
  SpotifyControlResponse, SpotifyLiveStatus, SpotifyPlaybackControl,
} from "./ipc-contract.js";
import { isChatEventEnvelope } from "./chat-ipc-validation.js";

const controls = new Set<SpotifyPlaybackControl>(["play", "pause", "previous", "next"]);
const states = new Set(["loading", "playing", "paused", "no_track", "not_connected", "no_device", "unavailable"]);
const controlErrors = new Set(["not_connected", "no_device", "permission_denied", "rate_limited", "provider_restricted", "busy", "operation_failed", "outcome_uncertain"]);
const stateVerifications = new Set(["target_transition_observed", "target_already_observed", "previous_track_restarted_observed"]);
const observedStates = new Set(["playing", "paused", "track_changed", "track_restarted"]);

function observedStateMatchesAction(action: SpotifyPlaybackControl, state: unknown): boolean {
  return (action === "play" && state === "playing") || (action === "pause" && state === "paused")
    || ((action === "next" || action === "previous") && state === "track_changed")
    || (action === "previous" && state === "track_restarted");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSpotifyPlaybackControl(value: unknown): value is SpotifyPlaybackControl {
  return typeof value === "string" && controls.has(value as SpotifyPlaybackControl);
}

export function isSpotifyLiveStatus(value: unknown): value is SpotifyLiveStatus {
  if (!record(value) || !states.has(String(value.state)) || typeof value.connected !== "boolean"
    || typeof value.deviceAvailable !== "boolean" || typeof value.controlsEnabled !== "boolean"
    || !(value.track === null || isChatEventEnvelope({ conversationId: "00000000-0000-4000-8000-000000000001",
      requestId: "00000000-0000-4000-8000-000000000002", status: "spotify_now_playing", card: value.track }))
    || !(value.message === null || (typeof value.message === "string" && value.message.length <= 240))
    || !(value.updatedAt === null || (Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0))) return false;
  if (value.controlsEnabled && (!value.connected || !value.deviceAvailable)) return false;
  if ((value.state === "playing" || value.state === "paused") && value.track === null) return false;
  if (["playing", "paused", "no_track"].includes(String(value.state))
    && (!value.connected || !value.deviceAvailable || !value.controlsEnabled)) return false;
  if (value.state === "not_connected" && (value.connected || value.deviceAvailable || value.controlsEnabled || value.track !== null)) return false;
  if (value.state === "no_device" && (!value.connected || value.deviceAvailable || value.controlsEnabled || value.track !== null)) return false;
  return true;
}

export function isSpotifyControlResponse(value: unknown, action?: unknown): value is SpotifyControlResponse {
  if (!record(value) || !isSpotifyPlaybackControl(value.action) || (action !== undefined && value.action !== action)) return false;
  if (value.ok === true) {
    if (!["available", "unavailable"].includes(String(value.reconciliation))) return false;
    if (value.outcome === "provider_accepted") return value.providerAccepted === true && Object.keys(value).length === 5;
    return value.outcome === "state_confirmed" && value.stateConfirmed === true
      && stateVerifications.has(String(value.verification)) && Object.keys(value).length === 6;
  }
  if (value.ok !== false || !record(value.error) || !controlErrors.has(String(value.error.code))
    || typeof value.error.message !== "string" || value.error.message.length > 240) return false;
  if (Object.keys(value.error).length !== 2) return false;
  if (value.reconciliation !== undefined && !["changed", "unchanged", "unavailable"].includes(String(value.reconciliation))) return false;
  if (value.observedState !== undefined && (value.error.code !== "outcome_uncertain" || !observedStates.has(String(value.observedState))
    || !observedStateMatchesAction(value.action, value.observedState))) return false;
  return Object.keys(value).length === 3 + Number(value.reconciliation !== undefined) + Number(value.observedState !== undefined);
}
