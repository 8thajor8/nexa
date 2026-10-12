import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DesktopDisplayInfo, WindowPreferences } from "../shared/ipc-contract.js";

export interface ScreenDisplayLike {
  id: number | string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
}
export interface WindowBounds { x: number; y: number; width: number; height: number; }
export interface WindowPlacementAdapter {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  getBounds(): WindowBounds;
  isMaximized?(): boolean;
  unmaximize?(): void;
  setMinimumSize(width: number, height: number): void;
  setBounds(bounds: WindowBounds): void;
  setFullScreen(enabled: boolean): void;
  once(event: "leave-full-screen" | "enter-full-screen", listener: () => void): unknown;
}

type WindowDiagnostic = (details: Record<string, string | number | boolean | null>) => void;
interface NativeWindowState { bounds: WindowBounds; displayId: string; fullscreen: boolean; maximized: boolean; }

function reportWindowDiagnostic(diagnostic: WindowDiagnostic, phase: string, details: Record<string, string | number | boolean | null> = {}) {
  try { diagnostic({ phase, ...details }); } catch { /* Diagnostics must not affect window state. */ }
}

function readNativeWindowState(window: WindowPlacementAdapter, displayIdForBounds: (bounds: WindowBounds) => string): NativeWindowState | null {
  if (window.isDestroyed()) return null;
  try {
    const bounds = window.getBounds();
    return { bounds, displayId: displayIdForBounds(bounds), fullscreen: window.isFullScreen(), maximized: Boolean(window.isMaximized?.()) };
  } catch { return null; }
}

function waitForNativeState(
  window: WindowPlacementAdapter,
  displayIdForBounds: (bounds: WindowBounds) => string,
  matches: (state: NativeWindowState) => boolean,
  timeoutMs: number,
  diagnostic: WindowDiagnostic,
  checkpoint: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSnapshot = "";
    let stableSamples = 0;
    const startedAt = Date.now();
    const finish = (success: boolean, state: NativeWindowState | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reportWindowDiagnostic(diagnostic, success ? "native_state_confirmed" : "native_state_timeout", {
        checkpoint, success, actualDisplayId: state?.displayId ?? null,
        actualFullscreen: state?.fullscreen ?? false, maximized: state?.maximized ?? false,
        finalX: state?.bounds.x ?? null, finalY: state?.bounds.y ?? null,
        finalWidth: state?.bounds.width ?? null, finalHeight: state?.bounds.height ?? null, stableSamples,
      });
      resolve(success);
    };
    const sample = () => {
      const state = readNativeWindowState(window, displayIdForBounds);
      if (!state) { finish(false, null); return; }
      const snapshot = `${state.displayId}|${state.fullscreen}|${state.maximized}|${state.bounds.x}|${state.bounds.y}|${state.bounds.width}|${state.bounds.height}`;
      if (snapshot !== lastSnapshot) {
        stableSamples = 0;
        reportWindowDiagnostic(diagnostic, "native_state_observed", { checkpoint,
          actualDisplayId: state.displayId, actualFullscreen: state.fullscreen, maximized: state.maximized,
          currentX: state.bounds.x, currentY: state.bounds.y, currentWidth: state.bounds.width,
          currentHeight: state.bounds.height, stableSamples });
      } else if (matches(state)) stableSamples += 1;
      lastSnapshot = snapshot;
      if (matches(state) && stableSamples >= 2) { finish(true, state); return; }
      if (Date.now() - startedAt >= timeoutMs) { finish(false, state); return; }
      timer = setTimeout(sample, 50);
    };
    sample();
  });
}

export async function setFullscreenAndWait(
  window: WindowPlacementAdapter,
  enabled: boolean,
  timeoutMs = 2_500,
  diagnostic: WindowDiagnostic = () => undefined,
): Promise<boolean> {
  if (window.isDestroyed()) {
    reportWindowDiagnostic(diagnostic, "native_state_unavailable", { requestedFullscreen: enabled, success: false });
    return false;
  }
  if (window.isFullScreen() !== enabled) {
    window.once(enabled ? "enter-full-screen" : "leave-full-screen", () => {
      reportWindowDiagnostic(diagnostic, "electron_event_received", { eventName: enabled ? "enter-full-screen" : "leave-full-screen",
        requestedFullscreen: enabled, actualFullscreen: !window.isDestroyed() && window.isFullScreen() });
    });
    reportWindowDiagnostic(diagnostic, "command_issued", { command: "setFullScreen", requestedFullscreen: enabled });
    try {
      window.setFullScreen(enabled);
      reportWindowDiagnostic(diagnostic, "command_returned", { command: "setFullScreen", requestedFullscreen: enabled,
        actualFullscreen: !window.isDestroyed() && window.isFullScreen() });
    } catch {
      reportWindowDiagnostic(diagnostic, "command_threw", { command: "setFullScreen", requestedFullscreen: enabled });
      return false;
    }
  }
  return waitForNativeState(window, () => "", (state) => state.fullscreen === enabled, timeoutMs, diagnostic, "fullscreen_state");
}
export interface WindowPlacementResult {
  success: boolean;
  targetDisplayId: string;
  actualDisplayId: string | null;
  bounds: WindowBounds | null;
  fullscreen: boolean;
  boundsMatch: boolean;
  dpiAdjusted: boolean;
  failurePhase?: string | null;
}

export function centeredWindowBounds(display: ScreenDisplayLike): WindowBounds {
  const area = display.workArea;
  const width = Math.min(1280, area.width);
  const height = Math.min(800, area.height);
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
}

export function applyWindowPlacement(
  window: WindowPlacementAdapter,
  bounds: WindowBounds,
  fullscreen: boolean,
  targetDisplayId: string,
  displayIdForBounds: (bounds: WindowBounds) => string,
  diagnostic: (details: Record<string, string | number | boolean | null>) => void = () => undefined,
  targetScaleFactor = 1,
  sourceScaleFactor = 1,
  transitionTimeoutMs = 2_500,
): Promise<WindowPlacementResult> {
  const before = window.isDestroyed() ? null : window.getBounds();
  const initialFullscreen = !window.isDestroyed() && window.isFullScreen();
  const initialMaximized = !window.isDestroyed() && Boolean(window.isMaximized?.());
  const report = (phase: string, details: Record<string, string | number | boolean | null> = {}) =>
    reportWindowDiagnostic(diagnostic, phase, details);
  const state = () => readNativeWindowState(window, displayIdForBounds);
  const initialDisplayId = before ? displayIdForBounds(before) : null;
  const initialState = state();
  report("operation_started", { targetDisplayId, requestedFullscreen: fullscreen, initialDisplayId,
    initialFullscreen, initialMaximized, requestedX: bounds.x, requestedY: bounds.y,
    requestedWidth: bounds.width, requestedHeight: bounds.height, targetScaleFactor, sourceScaleFactor });
  const finish = (failurePhase: string | null = null): WindowPlacementResult => {
    const finalState = state();
    const actualBounds = finalState?.bounds ?? null;
    const actualDisplayId = finalState?.displayId ?? null;
    const actualFullscreen = finalState?.fullscreen ?? false;
    const exactBounds = Boolean(actualBounds && actualBounds.x === bounds.x && actualBounds.y === bounds.y
      && actualBounds.width === bounds.width && actualBounds.height === bounds.height);
    const dpiAdjusted = Boolean(actualBounds && [targetScaleFactor, sourceScaleFactor].some((scale) =>
      Number.isFinite(scale) && scale > 1
      && Math.abs(actualBounds.width - bounds.width * scale) <= 10
      && Math.abs(actualBounds.height - bounds.height * scale) <= 10));
    const success = !failurePhase && actualDisplayId === targetDisplayId && actualFullscreen === fullscreen;
    const result: WindowPlacementResult = { success, targetDisplayId, actualDisplayId, bounds: actualBounds,
      fullscreen: actualFullscreen, boundsMatch: fullscreen || exactBounds, dpiAdjusted, failurePhase };
    report("native_state_confirmed", { checkpoint: failurePhase ?? "placement_complete", targetDisplayId, actualDisplayId,
      beforeX: before?.x ?? null, beforeY: before?.y ?? null, beforeWidth: before?.width ?? null, beforeHeight: before?.height ?? null,
      requestedX: bounds.x, requestedY: bounds.y, requestedWidth: bounds.width, requestedHeight: bounds.height,
      finalX: actualBounds?.x ?? null, finalY: actualBounds?.y ?? null, finalWidth: actualBounds?.width ?? null,
      finalHeight: actualBounds?.height ?? null, requestedFullscreen: fullscreen, actualFullscreen,
      maximized: finalState?.maximized ?? false, targetScaleFactor, sourceScaleFactor,
      boundsMatch: fullscreen || exactBounds, dpiAdjusted, placementSuccess: success });
    return result;
  };
  const fail = (phase: string): WindowPlacementResult => finish(phase);

  if (window.isDestroyed() || !initialState) return Promise.resolve(fail("window_unavailable"));
  try {
    report("command_issued", { command: "setMinimumSize", requestedWidth: Math.min(840, bounds.width),
      requestedHeight: Math.min(600, bounds.height) });
    window.setMinimumSize(Math.min(840, bounds.width), Math.min(600, bounds.height));
    report("command_returned", { command: "setMinimumSize" });
  } catch { return Promise.resolve(fail("minimum_size_failed")); }

  return (async () => {
    let current = state();
    if (!current) return fail("window_unavailable");

    if (current.fullscreen && (current.displayId !== targetDisplayId || !fullscreen)) {
      const leftFullscreen = await setFullscreenAndWait(window, false, transitionTimeoutMs, diagnostic);
      current = state();
      if (!leftFullscreen || !current || current.fullscreen) return fail("fullscreen_exit_unconfirmed");
    }

    if (current.maximized) {
      report("command_issued", { command: "unmaximize" });
      try { window.unmaximize?.(); } catch { return fail("unmaximize_failed"); }
      const unmaximized = await waitForNativeState(window, displayIdForBounds,
        (next) => !next.maximized && !next.fullscreen, transitionTimeoutMs, diagnostic, "unmaximize");
      current = state();
      if (!unmaximized || !current || current.maximized) return fail("unmaximize_unconfirmed");
    }

    if (current.displayId !== targetDisplayId || current.fullscreen !== fullscreen || !fullscreen) {
      if (current.fullscreen) return fail("fullscreen_exit_unconfirmed");
      report("command_issued", { command: "setBounds", requestedX: bounds.x, requestedY: bounds.y,
        requestedWidth: bounds.width, requestedHeight: bounds.height });
      try { window.setBounds(bounds); } catch { return fail("set_bounds_failed"); }
      const moved = await waitForNativeState(window, displayIdForBounds,
        (next) => next.displayId === targetDisplayId && !next.fullscreen && !next.maximized,
        transitionTimeoutMs, diagnostic, "target_display_windowed");
      current = state();
      if (!moved || !current || current.displayId !== targetDisplayId || current.fullscreen || current.maximized) {
        return fail("target_display_unconfirmed");
      }
    }

    if (fullscreen && !current.fullscreen) {
      const enteredFullscreen = await setFullscreenAndWait(window, true, transitionTimeoutMs, diagnostic);
      current = state();
      if (!enteredFullscreen || !current || !current.fullscreen) return fail("fullscreen_entry_unconfirmed");
    }

    const completed = await waitForNativeState(window, displayIdForBounds,
      (next) => next.displayId === targetDisplayId && next.fullscreen === fullscreen,
      transitionTimeoutMs, diagnostic, "placement_final");
    current = state();
    if (!completed || !current || current.displayId !== targetDisplayId || current.fullscreen !== fullscreen) {
      return fail("final_state_unconfirmed");
    }
    return finish();
  })();
}

export function isFullscreenToggleInput(input: { type?: string; code?: string }): boolean {
  return input.type === "keyDown" && input.code === "F11";
}

export function describeDisplays(displays: ScreenDisplayLike[], primaryId: number | string): DesktopDisplayInfo[] {
  return [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y).map((display, index) => ({
    id: String(display.id), label: `Pantalla ${index + 1}${String(display.id) === String(primaryId) ? " · Principal" : ""}`,
    resolution: `${display.bounds.width} × ${display.bounds.height}`,
    primary: String(display.id) === String(primaryId),
  }));
}

export function defaultWindowPreferences(displays: DesktopDisplayInfo[]): WindowPreferences {
  const selected = displays.find((display) => !display.primary) ?? displays.find((display) => display.primary) ?? displays[0];
  return { displayId: selected?.id ?? "", startFullscreen: true };
}

export function normalizeWindowPreferences(value: unknown, displays: DesktopDisplayInfo[]): WindowPreferences {
  const fallback = defaultWindowPreferences(displays);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const displayId = typeof record.displayId === "string" && displays.some((display) => display.id === record.displayId)
    ? record.displayId : fallback.displayId;
  return { displayId, startFullscreen: typeof record.startFullscreen === "boolean" ? record.startFullscreen : true };
}

export function resolveFullscreenForSettingsUpdate(
  current: WindowPreferences,
  requested: WindowPreferences,
): boolean {
  // A monitor-only update must preserve the user's persisted startup choice,
  // even when Electron is temporarily windowed after a failed transition.
  return requested.startFullscreen !== current.startFullscreen ? requested.startFullscreen : current.startFullscreen;
}

export function fullscreenPreferenceAfterTransition(
  currentPreference: boolean,
  requestedFullscreen: boolean,
  origin: "startup" | "settings" | "f11",
  succeeded: boolean,
): boolean {
  if (origin === "settings") return requestedFullscreen;
  if (origin === "f11" && succeeded) return requestedFullscreen;
  return currentPreference;
}

export function preferencesAfterPlacement(
  current: WindowPreferences,
  targetDisplayId: string,
  succeeded: boolean,
): WindowPreferences {
  return succeeded ? { ...current, displayId: targetDisplayId } : current;
}

export function createWindowOperationQueue() {
  let queue: Promise<void> = Promise.resolve();
  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createWindowPreferencesStore(userDataPath: string) {
  const filePath = resolve(userDataPath, "window-preferences.json");
  return {
    read(): unknown {
      try { return JSON.parse(readFileSync(filePath, "utf8")) as unknown; }
      catch { return null; }
    },
    write(preferences: WindowPreferences): void {
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, filePath);
    },
  };
}
