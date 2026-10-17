import type {
  AuthorizedHomeAssistantLight, DiscoveredHomeAssistantLight, HomeAssistantAdminResult,
} from "./ipc-contract.js";

const ENTITY_ID_PATTERN = /^light\.[a-z0-9_]+$/u;
const NUMBER_ID_PATTERN = /^number\.[a-z0-9_]+$/u;
const ADMIN_ERROR_CODES = new Set([
  "invalid_request", "home_assistant_light_not_discovered", "home_assistant_light_not_authorized",
  "home_assistant_device_store_invalid", "home_assistant_device_store_io_error",
  "home_assistant_legacy_configuration_invalid", "home_assistant_device_store_write_failed",
  "home_assistant_not_configured", "home_assistant_configuration_invalid", "home_assistant_timeout",
  "home_assistant_unavailable", "home_assistant_unauthorized", "home_assistant_forbidden",
  "home_assistant_request_rejected", "home_assistant_request_failed", "home_assistant_response_invalid",
  "home_assistant_speed_not_linked", "home_assistant_speed_link_stale", "home_assistant_speed_unavailable",
  "home_assistant_speed_value_invalid",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function validOptionalText(value: unknown, maxLength: number, nullable = false): boolean {
  return nullable && value === null || typeof value === "string" && Boolean(value.trim()) && value.trim().length <= maxLength;
}
function validAliases(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 16
    && value.every(alias => typeof alias === "string" && Boolean(alias.trim()) && alias.trim().length <= 80);
}
function validRequestMetadata(record: Record<string, unknown>, nullable: boolean): boolean {
  return (record.name === undefined || validOptionalText(record.name, 120, nullable))
    && (record.area === undefined || validOptionalText(record.area, 80, nullable))
    && (record.aliases === undefined || validAliases(record.aliases));
}

export function isHomeAssistantAuthorizeRequest(value: unknown): value is {
  entityId: string; name?: string; area?: string; aliases?: string[];
} {
  return isRecord(value) && hasOnlyKeys(value, ["entityId", "name", "area", "aliases"])
    && typeof value.entityId === "string" && ENTITY_ID_PATTERN.test(value.entityId)
    && validRequestMetadata(value, false);
}
export function isHomeAssistantMetadataUpdateRequest(value: unknown): value is {
  entityId: string; name?: string | null; area?: string | null; aliases?: string[];
} {
  return isRecord(value) && hasOnlyKeys(value, ["entityId", "name", "area", "aliases"])
    && typeof value.entityId === "string" && ENTITY_ID_PATTERN.test(value.entityId)
    && validRequestMetadata(value, true);
}
export function isHomeAssistantRemoveRequest(value: unknown): value is { entityId: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.entityId === "string"
    && ENTITY_ID_PATTERN.test(value.entityId);
}
export function isHomeAssistantSpeedCandidatesRequest(value: unknown): value is { lightEntityId: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.lightEntityId === "string"
    && ENTITY_ID_PATTERN.test(value.lightEntityId);
}
export function isHomeAssistantSpeedLinkRequest(value: unknown): value is { lightEntityId: string; entityId: string } {
  return isRecord(value) && Object.keys(value).length === 2 && typeof value.lightEntityId === "string"
    && ENTITY_ID_PATTERN.test(value.lightEntityId) && typeof value.entityId === "string" && NUMBER_ID_PATTERN.test(value.entityId);
}
export function isHomeAssistantSpeedUnlinkRequest(value: unknown): value is { lightEntityId: string } {
  return isHomeAssistantSpeedCandidatesRequest(value);
}

function isAuthorizedLight(value: unknown): value is AuthorizedHomeAssistantLight {
  if (!isRecord(value) || !hasOnlyKeys(value, ["entityId", "name", "area", "aliases", "effectSpeedEntityId"])
    || typeof value.entityId !== "string" || !ENTITY_ID_PATTERN.test(value.entityId)) return false;
  return validRequestMetadata(value, false) && (value.effectSpeedEntityId === undefined
    || typeof value.effectSpeedEntityId === "string" && NUMBER_ID_PATTERN.test(value.effectSpeedEntityId));
}
function isDiscoveredLight(value: unknown): value is DiscoveredHomeAssistantLight {
  if (!isRecord(value) || !hasOnlyKeys(value, ["entityId", "name", "state", "available", "capabilities", "alreadyAuthorized"])
    || typeof value.entityId !== "string" || !ENTITY_ID_PATTERN.test(value.entityId)
    || typeof value.name !== "string" || value.name.length > 120
    || !["on", "off", "unavailable", "unknown"].includes(String(value.state))
    || typeof value.available !== "boolean" || typeof value.alreadyAuthorized !== "boolean"
    || !isRecord(value.capabilities) || !hasOnlyKeys(value.capabilities, ["brightness", "color"])) return false;
  return typeof value.capabilities.brightness === "boolean" && typeof value.capabilities.color === "boolean";
}
function isAdminResult<T>(value: unknown, isPayload: (payload: unknown) => payload is T): value is HomeAssistantAdminResult<T> {
  if (!isRecord(value)) return false;
  if (value.ok === false) return Object.keys(value).length === 2 && typeof value.error === "string" && ADMIN_ERROR_CODES.has(value.error);
  return value.ok === true && Object.keys(value).length === 2 && isPayload(value.value);
}
function isAuthorizedLightsPayload(value: unknown): value is { authorizedLights: AuthorizedHomeAssistantLight[] } {
  return isRecord(value) && Object.keys(value).length === 1 && isAuthorizedLightsArray(value.authorizedLights);
}
function isAuthorizedLightsArray(value: unknown): value is AuthorizedHomeAssistantLight[] {
  return Array.isArray(value)
    && value.length <= 32 && value.every(isAuthorizedLight)
    && new Set(value.map(light => light.entityId)).size === value.length;
}
function isDiscoveryPayload(value: unknown): value is { lights: DiscoveredHomeAssistantLight[] } {
  return isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.lights)
    && value.lights.length <= 4096 && value.lights.every(isDiscoveredLight)
    && new Set(value.lights.map(light => light.entityId)).size === value.lights.length;
}
function isSpeedCandidate(value: unknown): value is import("./ipc-contract.js").HomeAssistantEffectSpeedCandidate {
  return isRecord(value) && Object.keys(value).length === 4 && typeof value.entityId === "string"
    && NUMBER_ID_PATTERN.test(value.entityId) && typeof value.name === "string" && value.name.length > 0
    && value.name.length <= 120 && typeof value.available === "boolean" && value.sameDeviceVerified === true;
}
function isSpeedCandidatesPayload(value: unknown): value is {
  lightEntityId: string; candidates: import("./ipc-contract.js").HomeAssistantEffectSpeedCandidate[];
} {
  return isRecord(value) && Object.keys(value).length === 2
    && typeof value.lightEntityId === "string" && ENTITY_ID_PATTERN.test(value.lightEntityId)
    && Array.isArray(value.candidates) && value.candidates.length <= 16 && value.candidates.every(isSpeedCandidate)
    && new Set(value.candidates.map(item => item.entityId)).size === value.candidates.length;
}
export function isHomeAssistantSpeedCandidatesResult(value: unknown): value is HomeAssistantAdminResult<{
  lightEntityId: string; candidates: import("./ipc-contract.js").HomeAssistantEffectSpeedCandidate[];
}> {
  return isAdminResult(value, isSpeedCandidatesPayload);
}

export function isHomeAssistantAuthorizedLightsResult(value: unknown): value is HomeAssistantAdminResult<{ authorizedLights: AuthorizedHomeAssistantLight[] }> {
  return isAdminResult(value, isAuthorizedLightsPayload);
}
export function isHomeAssistantDiscoveryResult(value: unknown): value is HomeAssistantAdminResult<{ lights: DiscoveredHomeAssistantLight[] }> {
  return isAdminResult(value, isDiscoveryPayload);
}
export function isHomeAssistantAuthorizationResult(value: unknown): value is HomeAssistantAdminResult<{
  authorizedLights: AuthorizedHomeAssistantLight[]; changed: boolean;
}> {
  if (!isRecord(value)) return false;
  if (value.ok === false) return Object.keys(value).length === 2 && typeof value.error === "string" && ADMIN_ERROR_CODES.has(value.error);
  if (value.ok !== true || Object.keys(value).length !== 2 || !isRecord(value.value)) return false;
  const payload = value.value;
  return Object.keys(payload).length === 2 && isAuthorizedLightsArray(payload.authorizedLights)
    && typeof payload.changed === "boolean";
}
