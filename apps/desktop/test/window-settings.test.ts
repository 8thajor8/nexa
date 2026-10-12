import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWindowPlacement, centeredWindowBounds, createWindowPreferencesStore, defaultWindowPreferences, describeDisplays,
  createWindowOperationQueue, fullscreenPreferenceAfterTransition, isFullscreenToggleInput, normalizeWindowPreferences,
  preferencesAfterPlacement, resolveFullscreenForSettingsUpdate, setFullscreenAndWait,
  type WindowBounds, type WindowPlacementAdapter } from "../src/main/window-settings";
import { isWindowPreferences, isWindowSettingsSnapshot } from "../src/shared/window-settings-validation";

const displays = describeDisplays([
  { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
], 1);

describe("window display preferences", () => {
  it("lists display identity and resolution and defaults to a secondary display", () => {
    expect(displays).toEqual([
      { id: "1", label: "Pantalla 1 · Principal", resolution: "1920 × 1080", primary: true },
      { id: "2", label: "Pantalla 2", resolution: "1920 × 1080", primary: false },
    ]);
    expect(defaultWindowPreferences(displays)).toEqual({ displayId: "2", startFullscreen: true });
    expect(defaultWindowPreferences(displays.slice(0, 1))).toEqual({ displayId: "1", startFullscreen: true });
  });

  it("falls back safely when the selected monitor disappears", () => {
    expect(normalizeWindowPreferences({ displayId: "2", startFullscreen: false }, displays.slice(0, 1)))
      .toEqual({ displayId: "1", startFullscreen: false });
  });

  it("centers on the selected display work area and limits dimensions to small screens", () => {
    expect(centeredWindowBounds({ id: 9, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1920, y: 40, width: 1000, height: 700 } }))
      .toEqual({ x: 1920, y: 40, width: 1000, height: 700 });
  });

  it("moves a windowed window to the selected display immediately", () => {
    const calls: unknown[][] = [];
    let currentBounds: WindowBounds = { x: 100, y: 100, width: 800, height: 600 };
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      getBounds: () => currentBounds,
      setMinimumSize: (...args: number[]) => calls.push(["minimum", ...args]),
      setBounds: (bounds: WindowBounds) => { calls.push(["bounds", bounds]); currentBounds = bounds; },
      setFullScreen: (enabled: boolean) => calls.push(["fullscreen", enabled]),
      once: (_event: "leave-full-screen", _listener: () => void) => calls.push(["once"]),
    };
    const bounds = { x: 1920, y: 40, width: 1280, height: 800 };
    const result = applyWindowPlacement(window, bounds, false, "2", (value) => value.x >= 1920 ? "2" : "1");
    return expect(result).resolves.toMatchObject({ success: true, targetDisplayId: "2", actualDisplayId: "2", bounds, fullscreen: false, boundsMatch: true, dpiAdjusted: false }).then(() => {
    expect(calls).toEqual([["minimum", 840, 600], ["bounds", bounds]]);
    });
  });

  it("moves a fullscreen window after leaving fullscreen, then restores it on the selected display", async () => {
    const calls: unknown[][] = [];
    let leaveFullscreen: (() => void) | undefined;
    let enterFullscreen: (() => void) | undefined;
    let fullscreen = true;
    let currentBounds: WindowBounds = { x: 300, y: 100, width: 1200, height: 800 };
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false,
      isFullScreen: () => fullscreen,
      getBounds: () => currentBounds,
      setMinimumSize: (...args: number[]) => calls.push(["minimum", ...args]),
      setBounds: (bounds: WindowBounds) => { calls.push(["bounds", bounds]); currentBounds = bounds; },
      setFullScreen: (enabled: boolean) => {
        calls.push(["fullscreen", enabled]);
        fullscreen = enabled;
        if (!enabled) leaveFullscreen?.();
        else enterFullscreen?.();
      },
      once: (event: "leave-full-screen" | "enter-full-screen", listener: () => void) => {
        if (event === "leave-full-screen") leaveFullscreen = listener;
        else enterFullscreen = listener;
      },
    };
    const bounds = { x: 1920, y: 40, width: 1280, height: 800 };
    const result = await applyWindowPlacement(window, bounds, true, "2", (value) => value.x >= 1920 ? "2" : "1");
    expect(result).toMatchObject({ success: true, targetDisplayId: "2", actualDisplayId: "2", bounds, fullscreen: true, boundsMatch: true, dpiAdjusted: false });
    expect(calls).toEqual([["minimum", 840, 600], ["fullscreen", false], ["bounds", bounds], ["fullscreen", true]]);
  });

  it("supports fullscreen to windowed placement without persisting a preference change", async () => {
    let fullscreen = true;
    let bounds: WindowBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    let leave: (() => void) | undefined;
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => fullscreen, getBounds: () => bounds,
      setMinimumSize: () => undefined, setBounds: (next) => { bounds = next; },
      setFullScreen: (value) => { fullscreen = value; if (!value) leave?.(); },
      once: (event, listener) => { if (event === "leave-full-screen") leave = listener; },
    };
    const result = await applyWindowPlacement(window, { x: 320, y: 40, width: 1280, height: 800 }, false, "1", () => "1");
    expect(result).toMatchObject({ success: true, fullscreen: false, boundsMatch: true });
  });

  it("supports windowed to fullscreen placement after the target display transition", async () => {
    let fullscreen = false;
    let bounds: WindowBounds = { x: 100, y: 100, width: 800, height: 600 };
    let enter: (() => void) | undefined;
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => fullscreen, getBounds: () => bounds,
      setMinimumSize: () => undefined, setBounds: (next) => { bounds = next; },
      setFullScreen: (value) => { fullscreen = value; if (value) enter?.(); },
      once: (event, listener) => { if (event === "enter-full-screen") enter = listener; },
    };
    const result = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, true, "2",
      (value) => value.x >= 1920 ? "2" : "1");
    expect(result).toMatchObject({ success: true, actualDisplayId: "2", fullscreen: true });
  });

  it("supports repeated display changes in windowed mode and reports the final display each time", async () => {
    let bounds: WindowBounds = { x: 320, y: 100, width: 1280, height: 800 };
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => false, getBounds: () => bounds,
      setMinimumSize: () => undefined, setBounds: (next) => { bounds = next; }, setFullScreen: () => undefined,
      once: () => undefined,
    };
    const getDisplayId = (value: WindowBounds) => value.x >= 1920 ? "2" : "1";
    const second = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, false, "2", getDisplayId);
    const first = await applyWindowPlacement(window, { x: 320, y: 40, width: 1280, height: 800 }, false, "1", getDisplayId);
    expect(second.success).toBe(true);
    expect(second.actualDisplayId).toBe("2");
    expect(first.success).toBe(true);
    expect(first.actualDisplayId).toBe("1");
  });

  it("unmaximizes before applying requested window bounds and preserves fullscreen preference state", async () => {
    const calls: unknown[][] = [];
    let maximized = true;
    let bounds: WindowBounds = { x: 1920, y: 0, width: 1920, height: 1080 };
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => false, getBounds: () => bounds,
      isMaximized: () => maximized,
      unmaximize: () => { calls.push(["unmaximize"]); maximized = false; },
      setMinimumSize: () => undefined,
      setBounds: (next) => { calls.push(["bounds", next]); bounds = next; },
      setFullScreen: () => { calls.push(["fullscreen"]); }, once: () => undefined,
    };
    const requested = { x: 320, y: 40, width: 1280, height: 800 };
    const result = await applyWindowPlacement(window, requested, false, "1", () => "1");
    expect(calls[0]).toEqual(["unmaximize"]);
    expect(calls[1]).toEqual(["bounds", requested]);
    expect(result).toMatchObject({ success: true, bounds: requested, fullscreen: false, boundsMatch: true });
  });

  it("reports DPI-scaled dimensions separately from successful display placement", async () => {
    let current: WindowBounds = { x: 2000, y: 40, width: 1606, height: 1004 };
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => false, getBounds: () => current,
      setMinimumSize: () => undefined,
      setBounds: () => { /* Simulate native DPI normalization after setBounds. */ },
      setFullScreen: () => undefined, once: () => undefined,
    };
    const result = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, false, "2",
      () => "2", () => undefined, 1.25);
    expect(result.success).toBe(true);
    expect(result.boundsMatch).toBe(false);
    expect(result.dpiAdjusted).toBe(true);
    expect(result.bounds).toEqual({ x: 2000, y: 40, width: 1606, height: 1004 });
  });

  it("reports failure when Electron's final bounds remain on another display", async () => {
    const actualBounds = { x: 320, y: 40, width: 1280, height: 800 };
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => false, getBounds: () => actualBounds,
      setMinimumSize: () => undefined, setBounds: () => undefined, setFullScreen: () => undefined,
      once: () => undefined,
    };
    const result = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, false, "2",
      (value) => value.x >= 1920 ? "2" : "1");
    expect(result.success).toBe(false);
    expect(result.actualDisplayId).toBe("1");
  });

  it("records the native mismatch when the first fullscreen move changes mode but not display, then a retry moves windowed", async () => {
    let fullscreen = true;
    let bounds: WindowBounds = { x: 320, y: 40, width: 1280, height: 800 };
    let leave: (() => void) | undefined;
    let ignoreFirstTargetAndFullscreen = true;
    const firstTrace: Record<string, string | number | boolean | null>[] = [];
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false,
      isFullScreen: () => fullscreen,
      getBounds: () => bounds,
      setMinimumSize: () => undefined,
      setBounds: (next) => {
        if (ignoreFirstTargetAndFullscreen) { ignoreFirstTargetAndFullscreen = false; return; }
        bounds = next;
      },
      setFullScreen: (next) => {
        if (!next) {
          fullscreen = false;
          leave?.();
          return;
        }
        fullscreen = true;
      },
      once: (event, listener) => { if (event === "leave-full-screen") leave = listener; },
    };
    const displayId = (value: WindowBounds) => value.x >= 1920 ? "B" : "A";

    const first = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, true, "B", displayId,
      (details) => firstTrace.push(details), 1, 1, 150);
    expect(first).toMatchObject({ success: false, actualDisplayId: "A", fullscreen: false });
    expect(firstTrace.map((item) => item.phase)).toContain("command_issued");
    expect(firstTrace.map((item) => item.phase)).toContain("command_returned");
    expect(firstTrace.map((item) => item.phase)).toContain("electron_event_received");
    expect(firstTrace.at(-1)).toMatchObject({ phase: "native_state_confirmed", targetDisplayId: "B",
      actualDisplayId: "A", requestedFullscreen: true, actualFullscreen: false, placementSuccess: false });

    const secondTrace: Record<string, string | number | boolean | null>[] = [];
    const second = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, false, "B", displayId,
      (details) => secondTrace.push(details));
    expect(second).toMatchObject({ success: true, actualDisplayId: "B", fullscreen: false });
    expect(secondTrace.at(-1)).toMatchObject({ phase: "native_state_confirmed", targetDisplayId: "B",
      actualDisplayId: "B", requestedFullscreen: false, actualFullscreen: false, placementSuccess: true });
  });

  it("allows F11 to toggle fullscreen without creating a kiosk mode", () => {
    expect(isFullscreenToggleInput({ type: "keyDown", code: "F11" })).toBe(true);
    expect(isFullscreenToggleInput({ type: "keyUp", code: "F11" })).toBe(false);
    expect(isFullscreenToggleInput({ type: "keyDown", code: "Escape" })).toBe(false);
  });

  it("preserves the user's fullscreen preference on monitor-only changes and honors explicit changes", () => {
    const saved = { displayId: "1", startFullscreen: true };
    expect(resolveFullscreenForSettingsUpdate(saved, { displayId: "2", startFullscreen: true })).toBe(true);
    expect(resolveFullscreenForSettingsUpdate(saved, { displayId: "2", startFullscreen: false })).toBe(false);
    expect(resolveFullscreenForSettingsUpdate(saved, { displayId: "1", startFullscreen: false })).toBe(false);
    expect(fullscreenPreferenceAfterTransition(true, false, "startup", false)).toBe(true);
    expect(fullscreenPreferenceAfterTransition(false, true, "startup", false)).toBe(false);
    expect(fullscreenPreferenceAfterTransition(true, false, "f11", false)).toBe(true);
    expect(fullscreenPreferenceAfterTransition(true, false, "f11", true)).toBe(false);
    expect(fullscreenPreferenceAfterTransition(true, false, "settings", false)).toBe(false);
    expect(preferencesAfterPlacement(saved, "2", false)).toEqual(saved);
    expect(preferencesAfterPlacement(saved, "2", true)).toEqual({ displayId: "2", startFullscreen: true });
  });

  it("persists preferences outside Renderer storage and recovers them", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexa-window-settings-"));
    try {
      const store = createWindowPreferencesStore(directory);
      store.write({ displayId: "2", startFullscreen: true });
      expect(createWindowPreferencesStore(directory).read()).toEqual({ displayId: "2", startFullscreen: true });
      store.write({ displayId: "1", startFullscreen: false });
      expect(createWindowPreferencesStore(directory).read()).toEqual({ displayId: "1", startFullscreen: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates the narrow preferences and display snapshot contract", () => {
    expect(isWindowPreferences({ displayId: "2", startFullscreen: true })).toBe(true);
    expect(isWindowPreferences({ displayId: "2", startFullscreen: true, extra: "ignored?" })).toBe(false);
    expect(isWindowSettingsSnapshot({ displays, preferences: { displayId: "2", startFullscreen: true },
      effectiveFullscreen: true, effectiveDisplayId: "2", transitioning: false,
      transitionTargetFullscreen: null, transitionTargetDisplayId: null })).toBe(true);
    expect(isWindowSettingsSnapshot({ displays: [{ ...displays[0], path: "secret" }], preferences: { displayId: "1", startFullscreen: true },
      effectiveFullscreen: true, effectiveDisplayId: "1", transitioning: false,
      transitionTargetFullscreen: null, transitionTargetDisplayId: null })).toBe(false);
  });

  it("keeps the persisted choice through restart, F11, and A→B→A monitor moves", async () => {
    let fullscreen = true;
    let bounds: WindowBounds = { x: 300, y: 100, width: 1200, height: 800 };
    const listeners = new Map<string, () => void>();
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => fullscreen, getBounds: () => bounds,
      setMinimumSize: () => undefined, setBounds: (next) => { setTimeout(() => { bounds = next; }, 20); },
      setFullScreen: (next) => { setTimeout(() => {
        fullscreen = next;
        listeners.get(next ? "enter-full-screen" : "leave-full-screen")?.();
      }, 20); },
      once: (event, listener) => { listeners.set(event, listener); },
    };
    const displayId = (value: WindowBounds) => value.x >= 1920 ? "B" : "A";
    let preference = { displayId: "A", startFullscreen: true };
    expect(fullscreen).toBe(true);

    // F11 changes the persisted choice only after native state confirms success.
    fullscreen = false;
    preference = { ...preference, startFullscreen: fullscreenPreferenceAfterTransition(preference.startFullscreen, false, "f11", true) };
    expect(preference.startFullscreen).toBe(false);

    const onB = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, false, "B", displayId);
    preference = { ...preference, displayId: onB.success ? "B" : displayId(bounds), startFullscreen: fullscreen };
    expect(onB).toMatchObject({ success: true, actualDisplayId: "B", fullscreen: false });
    expect(preference).toEqual({ displayId: "B", startFullscreen: false });

    // Re-enable fullscreen with an asynchronous native transition, then move B→A.
    preference = { ...preference, startFullscreen: fullscreenPreferenceAfterTransition(preference.startFullscreen, true, "settings", false) };
    const onBFullscreen = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, true, "B", displayId);
    expect(onBFullscreen).toMatchObject({ success: true, actualDisplayId: "B", fullscreen: true });
    const onA = await applyWindowPlacement(window, { x: 320, y: 40, width: 1280, height: 800 }, true, "A", displayId);
    preference = { ...preference, displayId: onA.success ? "A" : displayId(bounds), startFullscreen: onA.fullscreen };
    expect(onA).toMatchObject({ success: true, actualDisplayId: "A", fullscreen: true });
    expect(preference).toEqual({ displayId: "A", startFullscreen: true });

    const backOnB = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, true, "B", displayId);
    expect(backOnB).toMatchObject({ success: true, actualDisplayId: "B", fullscreen: true });
    const backOnA = await applyWindowPlacement(window, { x: 320, y: 40, width: 1280, height: 800 }, true, "A", displayId);
    expect(backOnA).toMatchObject({ success: true, actualDisplayId: "A", fullscreen: true });
  });

  it("does not issue setBounds until Electron confirms the asynchronous exit from fullscreen", async () => {
    let fullscreen = true;
    let bounds: WindowBounds = { x: 320, y: 40, width: 1280, height: 800 };
    const listeners = new Map<string, () => void>();
    const calls: string[] = [];
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => fullscreen, getBounds: () => bounds,
      setMinimumSize: () => undefined,
      setBounds: (next) => { calls.push(`setBounds:fullscreen=${fullscreen}`); bounds = next; },
      setFullScreen: (next) => {
        calls.push(`setFullScreen:${next}`);
        setTimeout(() => {
          fullscreen = next;
          calls.push(`nativeFullscreen:${next}`);
          listeners.get(next ? "enter-full-screen" : "leave-full-screen")?.();
        }, 40);
      },
      once: (event, listener) => { listeners.set(event, listener); },
    };
    const result = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, true, "B",
      (value) => value.x >= 1920 ? "B" : "A", () => undefined, 1, 1, 500);
    expect(result).toMatchObject({ success: true, actualDisplayId: "B", fullscreen: true });
    expect(calls.indexOf("nativeFullscreen:false")).toBeLessThan(calls.indexOf("setBounds:fullscreen=false"));
    expect(calls.indexOf("nativeFullscreen:true")).toBeGreaterThan(calls.indexOf("setBounds:fullscreen=false"));
  });

  it("stops before fullscreen restoration when Windows returns the window to the source monitor", async () => {
    let fullscreen = true;
    let bounds: WindowBounds = { x: 320, y: 40, width: 1280, height: 800 };
    const listeners = new Map<string, () => void>();
    const fullscreenRequests: boolean[] = [];
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => fullscreen, getBounds: () => bounds,
      setMinimumSize: () => undefined,
      setBounds: (next) => {
        bounds = next;
        setTimeout(() => { bounds = { x: 320, y: 40, width: 1280, height: 800 }; }, 20);
      },
      setFullScreen: (next) => {
        fullscreenRequests.push(next);
        if (!next) setTimeout(() => {
          fullscreen = false;
          listeners.get("leave-full-screen")?.();
        }, 10);
      },
      once: (event, listener) => { listeners.set(event, listener); },
    };
    const result = await applyWindowPlacement(window, { x: 1920, y: 40, width: 1280, height: 800 }, true, "B",
      (value) => value.x >= 1920 ? "B" : "A", () => undefined, 1, 1, 160);
    expect(result).toMatchObject({ success: false, actualDisplayId: "A", fullscreen: false, failurePhase: "target_display_unconfirmed" });
    expect(fullscreenRequests).toEqual([false]);
  });

  it("serializes rapid operations and continues after a failed operation", async () => {
    const enqueue = createWindowOperationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = enqueue(async () => { order.push("first:start"); await firstGate; order.push("first:end"); return 1; });
    const second = enqueue(async () => { order.push("second"); throw new Error("simulated placement failure"); });
    const third = enqueue(async () => { order.push("third"); return 3; });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("simulated placement failure");
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("awaits the native F11 fullscreen transition before resolving its effective mode", async () => {
    let fullscreen = false;
    const listeners = new Map<string, () => void>();
    const window: WindowPlacementAdapter = {
      isDestroyed: () => false, isFullScreen: () => fullscreen,
      getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
      setMinimumSize: () => undefined, setBounds: () => undefined,
      setFullScreen: (next) => { fullscreen = next; listeners.get(next ? "enter-full-screen" : "leave-full-screen")?.(); },
      once: (event, listener) => { listeners.set(event, listener); },
    };
    await expect(setFullscreenAndWait(window, true)).resolves.toBe(true);
    expect(fullscreen).toBe(true);
    await expect(setFullscreenAndWait(window, false)).resolves.toBe(true);
    expect(fullscreen).toBe(false);
  });
});
