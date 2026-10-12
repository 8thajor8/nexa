import type { WeatherCurrentStatus } from "./ipc-contract.js";

export function isWeatherLocation(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100
    && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’()-]*$/u.test(value.trim());
}

export function isWeatherCurrentStatus(value: unknown): value is WeatherCurrentStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result);
  return keys.length === 5 && typeof result.available === "boolean"
    && typeof result.location === "string" && result.location.length > 0 && result.location.length <= 100
    && (result.temperatureC === null || (typeof result.temperatureC === "number" && Number.isFinite(result.temperatureC) && result.temperatureC >= -100 && result.temperatureC <= 100))
    && (result.condition === null || (typeof result.condition === "string" && result.condition.length > 0 && result.condition.length <= 80))
    && typeof result.updatedAt === "number" && Number.isFinite(result.updatedAt) && result.updatedAt >= 0
    && (result.available ? result.temperatureC !== null && result.condition !== null : result.temperatureC === null && result.condition === null);
}
