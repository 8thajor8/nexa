import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_PREFERENCES, DESKTOP_PREFERENCES_KEY, availableTimeZones, formatClockTime,
  formatPrimaryDate, isSafeWeatherLocation, isValidTimeZone, loadDesktopPreferences,
  normalizeDesktopPreferences, saveDesktopPreferences,
} from "../src/renderer/desktop-preferences";

describe("Desktop preferences and international time", () => {
  it("starts with the Barcelona, Buenos Aires, and Costa Rica clocks", () => {
    expect(DEFAULT_DESKTOP_PREFERENCES).toMatchObject({ primaryTimeZone: "Europe/Madrid", weatherLocation: "Barcelona" });
    expect(DEFAULT_DESKTOP_PREFERENCES.clocks.map((clock) => [clock.label, clock.timeZone])).toEqual([
      ["Barcelona", "Europe/Madrid"], ["Buenos Aires", "America/Argentina/Buenos_Aires"], ["Costa Rica", "America/Costa_Rica"],
    ]);
  });

  it("uses valid IANA zones and applies daylight-saving transitions", () => {
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("Not/A-Time-Zone")).toBe(false);
    expect(availableTimeZones()).toContain("Europe/Madrid");
    expect(formatClockTime(new Date("2026-03-29T00:30:00.000Z"), "Europe/Madrid")).toBe("01:30");
    expect(formatClockTime(new Date("2026-03-29T01:30:00.000Z"), "Europe/Madrid")).toBe("03:30");
    expect(formatPrimaryDate(new Date("2026-10-10T23:30:00.000Z"), "Europe/Madrid")).toContain("11");
  });

  it("persists only validated preferences and permits an empty clock list", () => {
    let stored: string | null = null;
    const storage = { getItem: (key: string) => key === DESKTOP_PREFERENCES_KEY ? stored : null,
      setItem: (key: string, value: string) => { if (key === DESKTOP_PREFERENCES_KEY) stored = value; } };
    const next = normalizeDesktopPreferences({ primaryTimeZone: "UTC", clocks: [], weatherLocation: "San José", wallpaperEnabled: false });
    expect(saveDesktopPreferences(next, storage)).toBe(true);
    expect(loadDesktopPreferences(storage)).toEqual(next);
    const invalid = normalizeDesktopPreferences({ primaryTimeZone: "bad", clocks: [{ id: "x", label: "<script>", timeZone: "bad" }], weatherLocation: "https://bad", wallpaperEnabled: true });
    expect(invalid.primaryTimeZone).toBe("Europe/Madrid");
    expect(invalid.weatherLocation).toBe("Barcelona");
    expect(invalid.clocks.length).toBeGreaterThan(0);
  });

  it("defaults voice replies off and persists the switch without changing other preferences", () => {
    let stored: string | null = null;
    const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } };
    expect(loadDesktopPreferences(storage).voiceRepliesEnabled).toBe(false);
    const enabled = { ...loadDesktopPreferences(storage), voiceRepliesEnabled: true };
    expect(saveDesktopPreferences(enabled, storage)).toBe(true);
    expect(loadDesktopPreferences(storage)).toEqual(enabled);
    expect(normalizeDesktopPreferences({ voiceRepliesEnabled: "true" }).voiceRepliesEnabled).toBe(false);
  });

  it("accepts ordinary city names but rejects URLs and command-shaped input", () => {
    expect(isSafeWeatherLocation("San José, Costa Rica")).toBe(true);
    expect(isSafeWeatherLocation("New York")).toBe(true);
    expect(isSafeWeatherLocation("https://example.com")).toBe(false);
    expect(isSafeWeatherLocation("city; command" )).toBe(false);
  });
});
