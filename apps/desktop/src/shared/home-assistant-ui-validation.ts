import type {
  HomeAssistantLightControlInput, HomeAssistantLightControlResult, HomeAssistantLightEffectInput,
  HomeAssistantLightEffectResult, HomeAssistantLightStatesResult,
  HomeAssistantUiLight,
} from "./ipc-contract.js";
const ENTITY_ID_PATTERN = /^light\.[a-z0-9_]+$/u;
const ERRORS = new Set([
  "invalid_request", "home_assistant_light_not_discovered", "home_assistant_light_not_authorized",
  "home_assistant_device_store_invalid", "home_assistant_device_store_io_error",
  "home_assistant_legacy_configuration_invalid", "home_assistant_device_store_write_failed",
  "home_assistant_not_configured", "home_assistant_configuration_invalid", "home_assistant_timeout",
  "home_assistant_unavailable", "home_assistant_unauthorized", "home_assistant_forbidden", "home_assistant_effect_not_supported",
  "home_assistant_speed_not_linked", "home_assistant_speed_link_stale", "home_assistant_speed_unavailable", "home_assistant_speed_value_invalid",
  "home_assistant_request_rejected", "home_assistant_request_failed", "home_assistant_response_invalid",
]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const NUMBER_ID_PATTERN = /^number\.[a-z0-9_]+$/u;
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
export function isHomeAssistantLightControlInput(value: unknown): value is HomeAssistantLightControlInput {
  if (!record(value) || !exactKeys(value, ["entityId", "action", "brightnessPct", "rgbColor"])
    || typeof value.entityId !== "string" || !ENTITY_ID_PATTERN.test(value.entityId)
    || !["turn_on", "turn_off"].includes(String(value.action))) return false;
  if (value.brightnessPct !== undefined && value.brightnessPct !== null
    && (!Number.isInteger(value.brightnessPct) || Number(value.brightnessPct) < 0 || Number(value.brightnessPct) > 100)) return false;
  if (value.rgbColor !== undefined && value.rgbColor !== null
    && (!Array.isArray(value.rgbColor) || value.rgbColor.length !== 3
      || value.rgbColor.some(channel => !Number.isInteger(channel) || Number(channel) < 0 || Number(channel) > 255))) return false;
  if (value.action === "turn_off" && (value.brightnessPct != null || value.rgbColor != null)) return false;
  return true;
}
export function isHomeAssistantLightEffectInput(value: unknown): value is HomeAssistantLightEffectInput {
  return record(value) && exactKeys(value, ["entityId", "effect"])
    && typeof value.entityId === "string" && ENTITY_ID_PATTERN.test(value.entityId)
    && typeof value.effect === "string" && value.effect.trim().length > 0 && value.effect.trim().length <= 80;
}
export function isHomeAssistantEffectSpeedInput(value: unknown): value is { lightEntityId: string; value: number } {
  return record(value) && exactKeys(value, ["lightEntityId", "value"])
    && typeof value.lightEntityId === "string" && ENTITY_ID_PATTERN.test(value.lightEntityId)
    && typeof value.value === "number" && Number.isFinite(value.value);
}
function isEffectSpeedState(value: unknown): value is import("./ipc-contract.js").HomeAssistantEffectSpeedState {
  if (!record(value) || !exactKeys(value, ["lightEntityId", "linked", "available", "stale", "value", "min", "max", "step", "entityName", "error"])
    || typeof value.lightEntityId !== "string" || !ENTITY_ID_PATTERN.test(value.lightEntityId)
    || typeof value.linked !== "boolean" || typeof value.available !== "boolean" || typeof value.stale !== "boolean"
    || !(value.value === null || typeof value.value === "number" && Number.isFinite(value.value))
    || !(value.min === null || typeof value.min === "number" && Number.isFinite(value.min))
    || !(value.max === null || typeof value.max === "number" && Number.isFinite(value.max))
    || !(value.step === null || typeof value.step === "number" && Number.isFinite(value.step) && value.step > 0)
    || !(value.entityName === null || typeof value.entityName === "string" && value.entityName.length <= 120)
    || !(value.error === null || typeof value.error === "string" && ERRORS.has(value.error))) return false;
  return !value.available || value.linked && !value.stale && value.error === null && typeof value.value === "number"
    && typeof value.min === "number" && typeof value.max === "number";
}
export function isHomeAssistantEffectSpeedResult(value: unknown): value is import("./ipc-contract.js").HomeAssistantEffectSpeedResult {
  if (isError(value)) return true;
  if (!record(value) || value.ok !== true || Object.keys(value).length !== 2 || !record(value.value)
    || Object.keys(value.value).length !== 2 || !["confirmed", "accepted_not_confirmed"].includes(String(value.value.outcome))) return false;
  return value.value.state === null || isEffectSpeedState(value.value.state);
}
function isLight(value: unknown): value is HomeAssistantUiLight {
  if (!record(value) || !exactKeys(value, ["entityId", "name", "area", "aliases", "state", "available", "brightnessPct", "rgbColor", "rgbwColor", "colorTemperatureKelvin", "effect", "effectList", "capabilities", "effectSpeed"])
    || typeof value.entityId !== "string" || !ENTITY_ID_PATTERN.test(value.entityId)
    || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 120
    || !(value.area === null || typeof value.area === "string" && value.area.length <= 80)
    || !Array.isArray(value.aliases) || value.aliases.length > 16
    || !value.aliases.every(alias => typeof alias === "string" && alias.length <= 80)
    || !["on", "off", "unavailable", "unknown"].includes(String(value.state))
    || typeof value.available !== "boolean"
    || !(value.brightnessPct === null || Number.isInteger(value.brightnessPct) && Number(value.brightnessPct) >= 0 && Number(value.brightnessPct) <= 100)
    || !(value.rgbColor === null || Array.isArray(value.rgbColor) && value.rgbColor.length === 3
      && value.rgbColor.every(channel => Number.isInteger(channel) && Number(channel) >= 0 && Number(channel) <= 255))
    || !(value.rgbwColor === null || Array.isArray(value.rgbwColor) && value.rgbwColor.length === 4
      && value.rgbwColor.every(channel => Number.isInteger(channel) && Number(channel) >= 0 && Number(channel) <= 255))
    || !(value.colorTemperatureKelvin === null || Number.isInteger(value.colorTemperatureKelvin)
      && Number(value.colorTemperatureKelvin) >= 1000 && Number(value.colorTemperatureKelvin) <= 40_000)
    || !(value.effect === null || typeof value.effect === "string" && value.effect.length > 0 && value.effect.length <= 80)
    || !Array.isArray(value.effectList) || value.effectList.length > 32
    || !value.effectList.every(effect => typeof effect === "string" && effect.trim().length > 0 && effect.length <= 80)
    || !record(value.capabilities) || !exactKeys(value.capabilities, ["brightness", "color"])) return false;
  return typeof value.capabilities.brightness === "boolean" && typeof value.capabilities.color === "boolean"
    && (value.effectSpeed === undefined || isEffectSpeedState(value.effectSpeed));
}
function isError(value: unknown): boolean {
  return record(value) && value.ok === false && Object.keys(value).length === 2
    && typeof value.error === "string" && ERRORS.has(value.error);
}
export function isHomeAssistantLightStatesResult(value: unknown): value is HomeAssistantLightStatesResult {
  if (isError(value)) return true;
  if (!record(value) || value.ok !== true || Object.keys(value).length !== 2 || !record(value.value)
    || Object.keys(value.value).length !== 1 || !Array.isArray(value.value.lights) || value.value.lights.length > 32
    || !value.value.lights.every(isLight)) return false;
  return new Set(value.value.lights.map(light => light.entityId)).size === value.value.lights.length;
}
export function isHomeAssistantLightControlResult(value: unknown): value is HomeAssistantLightControlResult {
  if (isError(value)) return true;
  if (!record(value) || value.ok !== true || Object.keys(value).length !== 2 || !record(value.value)
    || Object.keys(value.value).length !== 2
    || !["confirmed", "accepted_not_confirmed", "device_unavailable"].includes(String(value.value.outcome))) return false;
  return value.value.light === null || isLight(value.value.light);
}
export function isHomeAssistantLightEffectResult(value: unknown): value is HomeAssistantLightEffectResult {
  return isHomeAssistantLightControlResult(value);
}
