export interface ClockPreference {
  readonly id: string;
  readonly label: string;
  readonly timeZone: string;
}

export interface DesktopPreferences {
  readonly primaryTimeZone: string;
  readonly clocks: readonly ClockPreference[];
  readonly weatherLocation: string;
  readonly wallpaperEnabled: boolean;
  readonly voiceRepliesEnabled: boolean;
}

export const DESKTOP_PREFERENCES_KEY = "nexa.desktop.preferences.v1";

export const DEFAULT_CLOCKS: readonly ClockPreference[] = Object.freeze([
  Object.freeze({ id: "Europe/Madrid", label: "Barcelona", timeZone: "Europe/Madrid" }),
  Object.freeze({ id: "America/Argentina/Buenos_Aires", label: "Buenos Aires", timeZone: "America/Argentina/Buenos_Aires" }),
  Object.freeze({ id: "America/Costa_Rica", label: "Costa Rica", timeZone: "America/Costa_Rica" }),
]);

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = Object.freeze({
  primaryTimeZone: "Europe/Madrid",
  clocks: DEFAULT_CLOCKS,
  weatherLocation: "Barcelona",
  wallpaperEnabled: true,
  voiceRepliesEnabled: false,
});

const FALLBACK_TIME_ZONES = [
  "UTC", "Europe/Madrid", "Europe/London", "Europe/Paris", "Europe/Rome", "Europe/Berlin",
  "America/Argentina/Buenos_Aires", "America/Costa_Rica", "America/Mexico_City", "America/New_York",
  "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Asia/Tokyo",
  "Asia/Shanghai", "Asia/Kolkata", "Australia/Sydney",
];

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function availableTimeZones(): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const zones = typeof supportedValuesOf === "function" ? supportedValuesOf.call(Intl, "timeZone") : FALLBACK_TIME_ZONES;
  return [...new Set(["UTC", ...zones, ...DEFAULT_CLOCKS.map((clock) => clock.timeZone)])].filter(isValidTimeZone).sort();
}

export function isSafeWeatherLocation(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100
    && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’()-]*$/u.test(value.trim());
}

export function cityLabelFromTimeZone(timeZone: string): string {
  const tail = timeZone.split("/").at(-1) ?? timeZone;
  return tail.replaceAll("_", " ");
}

function normalizeClocks(value: unknown): ClockPreference[] {
  if (!Array.isArray(value)) return [...DEFAULT_CLOCKS];
  const result: ClockPreference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const clock = item as Record<string, unknown>;
    if (!isValidTimeZone(clock.timeZone) || seen.has(clock.timeZone) || result.length >= 8) continue;
    const label = typeof clock.label === "string" && /^[\p{L}\p{M}\p{N} .,'’()-]{1,50}$/u.test(clock.label.trim())
      ? clock.label.trim() : cityLabelFromTimeZone(clock.timeZone);
    seen.add(clock.timeZone);
    result.push({ id: clock.timeZone, label, timeZone: clock.timeZone });
  }
  if (result.length || (Array.isArray(value) && value.length === 0)) return result;
  return [...DEFAULT_CLOCKS];
}

export function normalizeDesktopPreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_DESKTOP_PREFERENCES;
  const record = value as Record<string, unknown>;
  const clocks = normalizeClocks(record.clocks);
  return {
    primaryTimeZone: isValidTimeZone(record.primaryTimeZone) ? record.primaryTimeZone : "Europe/Madrid",
    clocks,
    weatherLocation: isSafeWeatherLocation(record.weatherLocation) ? record.weatherLocation.trim() : "Barcelona",
    wallpaperEnabled: typeof record.wallpaperEnabled === "boolean" ? record.wallpaperEnabled : true,
    voiceRepliesEnabled: typeof record.voiceRepliesEnabled === "boolean" ? record.voiceRepliesEnabled : false,
  };
}

export function loadDesktopPreferences(storage?: Pick<Storage, "getItem">): DesktopPreferences {
  try {
    const source = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const serialized = source?.getItem(DESKTOP_PREFERENCES_KEY);
    return serialized ? normalizeDesktopPreferences(JSON.parse(serialized)) : DEFAULT_DESKTOP_PREFERENCES;
  } catch {
    return DEFAULT_DESKTOP_PREFERENCES;
  }
}

export function saveDesktopPreferences(preferences: DesktopPreferences, storage?: Pick<Storage, "setItem">): boolean {
  try {
    const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!target) return false;
    target.setItem(DESKTOP_PREFERENCES_KEY, JSON.stringify(normalizeDesktopPreferences(preferences)));
    return true;
  } catch {
    return false;
  }
}

export function formatClockTime(date: Date, timeZone: string, locale = "es-ES"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

export function formatPrimaryDate(date: Date, timeZone: string, locale = "es-ES"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "2-digit", month: "short", year: "numeric" }).format(date);
}
