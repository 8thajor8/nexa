import type { DesktopDisplayInfo, WindowPreferences, WindowSettingsSnapshot } from "./ipc-contract.js";

export function isWindowPreferences(value: unknown): value is WindowPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && typeof record.displayId === "string"
    && record.displayId.length > 0 && record.displayId.length <= 80
    && typeof record.startFullscreen === "boolean";
}

export function isWindowSettingsSnapshot(value: unknown): value is WindowSettingsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 7 || !Array.isArray(record.displays) || !isWindowPreferences(record.preferences)
    || typeof record.effectiveFullscreen !== "boolean" || typeof record.effectiveDisplayId !== "string"
    || record.effectiveDisplayId.length === 0 || record.effectiveDisplayId.length > 80
    || typeof record.transitioning !== "boolean"
    || (record.transitionTargetFullscreen !== null && typeof record.transitionTargetFullscreen !== "boolean")
    || (record.transitionTargetDisplayId !== null && (typeof record.transitionTargetDisplayId !== "string"
      || record.transitionTargetDisplayId.length === 0 || record.transitionTargetDisplayId.length > 80))) return false;
  return record.displays.length > 0 && record.displays.length <= 32 && record.displays.every((display) => {
    if (!display || typeof display !== "object" || Array.isArray(display)) return false;
    const item = display as Record<string, unknown>;
    return Object.keys(item).length === 4 && typeof item.id === "string" && item.id.length > 0
      && item.id.length <= 80 && typeof item.label === "string" && item.label.length <= 80
      && typeof item.resolution === "string" && /^\d{1,5} × \d{1,5}$/.test(item.resolution)
      && typeof item.primary === "boolean";
  });
}

export function isDesktopDisplayInfo(value: unknown): value is DesktopDisplayInfo {
  return isWindowSettingsSnapshot({ displays: [value], preferences: { displayId: "valid", startFullscreen: true } });
}
