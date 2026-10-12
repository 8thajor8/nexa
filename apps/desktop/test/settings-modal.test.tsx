// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_DESKTOP_PREFERENCES } from "../src/renderer/desktop-preferences";
import { MicrophoneDeviceStore } from "../src/renderer/audio/microphone-device-store";
import { SettingsModal } from "../src/renderer/components/SettingsModal";
import type { DesktopMemoryMode, DesktopMemoryModeResult } from "../src/shared/ipc-contract";

afterEach(cleanup);

function makeStore() {
  return new MicrophoneDeviceStore({
    mediaDevices: { enumerateDevices: async () => [], addEventListener: () => undefined, removeEventListener: () => undefined },
    storage: { getItem: () => null, setItem: () => undefined },
  });
}

function renderSettings(onClose = vi.fn(), onPreferencesChange = vi.fn()) {
  const snapshot = { displays: [
    { id: "primary", label: "Pantalla 1 · Principal", resolution: "1920 × 1080", primary: true },
    { id: "secondary", label: "Pantalla 2", resolution: "2560 × 1440", primary: false },
  ], preferences: { displayId: "secondary", startFullscreen: true }, effectiveFullscreen: true,
    effectiveDisplayId: "secondary", transitioning: false, transitionTargetFullscreen: null, transitionTargetDisplayId: null };
  let changedListener: ((settings: typeof snapshot) => void) | undefined;
  const windowApi = { get: vi.fn(async () => snapshot), set: vi.fn(async (preferences) => ({ ...snapshot, preferences,
    effectiveFullscreen: preferences.startFullscreen, effectiveDisplayId: preferences.displayId })),
    onChanged: vi.fn((listener) => { changedListener = listener; return vi.fn(); }) };
  const memoryApi = { getStatus: vi.fn(async () => ({ mode: "memory1" as const, memory2Available: true, memory2WriteAvailable: true, switching: false, fallbackReason: null })),
    setMode: vi.fn(async (mode: DesktopMemoryMode): Promise<DesktopMemoryModeResult> => ({ ok: true,
      status: { mode, memory2Available: true, memory2WriteAvailable: true, switching: false, fallbackReason: null } })) };
  Object.defineProperty(window, "nexaDesktop", { configurable: true, value: { windowSettings: windowApi, memory: memoryApi } });
  return { onClose, onPreferencesChange, windowApi, memoryApi, emitSettings: (settings: typeof snapshot) => changedListener?.(settings), ...render(createElement(SettingsModal, {
    preferences: DEFAULT_DESKTOP_PREFERENCES, onPreferencesChange, microphoneDevices: makeStore(), microphoneDisabled: false, onClose,
    onMemoryModeChange: memoryApi.setMode,
  })) };
}

describe("Settings modal", () => {
  it("renders audio, appearance, time, and weather preferences", () => {
    renderSettings();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByLabelText("Configuración de micrófono")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Wallpaper de Windows/ })).toBeTruthy();
    expect(screen.getByLabelText("Zona horaria principal")).toBeTruthy();
    expect(screen.getByLabelText("Relojes internacionales")).toBeTruthy();
    expect(screen.getByLabelText("Ciudad")).toBeTruthy();
  });

  it("shows the active memory mode and switches through Main without persisting a preference", async () => {
    const { onPreferencesChange } = renderSettings();
    const selector = await screen.findByRole("combobox", { name: "Backend de memoria" });
    expect((selector as HTMLSelectElement).value).toBe("memory1");
    fireEvent.change(selector, { target: { value: "memory2-readonly" } });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe("memory2-readonly"));
    expect(screen.getByText(/el almacén sintético no se modifica/i)).toBeTruthy();
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it("offers personal writable Memory2 and describes its bounded organic learning", async () => {
    const { memoryApi } = renderSettings();
    const selector = await screen.findByRole("combobox", { name: "Backend de memoria" });
    expect(screen.getByRole("option", { name: /escritura y aprendizaje de preferencias/i })).toBeTruthy();
    fireEvent.change(selector, { target: { value: "memory2-confirmed-write" } });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe("memory2-confirmed-write"));
    expect(memoryApi.setMode).toHaveBeenCalledWith("memory2-confirmed-write");
    expect(screen.getByText(/las preferencias cotidianas claras pueden aprenderse automáticamente/i)).toBeTruthy();
  });

  it("loads monitor details and persists monitor and fullscreen preferences through Main", async () => {
    const { windowApi } = renderSettings();
    await screen.findByRole("option", { name: "Pantalla 2 · 2560 × 1440" });
    const display = screen.getByLabelText("Pantalla");
    expect((display as HTMLSelectElement).value).toBe("secondary");
    fireEvent.change(display, { target: { value: "primary" } });
    await waitFor(() => expect(windowApi.set).toHaveBeenCalledWith({ displayId: "primary", startFullscreen: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Iniciar en pantalla completa" }));
    await waitFor(() => expect(windowApi.set).toHaveBeenLastCalledWith({ displayId: "primary", startFullscreen: false }));
  });

  it("keeps the saved fullscreen choice distinct from the native effective mode", async () => {
    const { emitSettings, windowApi, unmount } = renderSettings();
    const checkbox = await screen.findByRole("checkbox", { name: "Iniciar en pantalla completa" });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    emitSettings({ ...await windowApi.get(), effectiveFullscreen: false,
      preferences: { displayId: "secondary", startFullscreen: true } });
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText("Modo actual confirmado: ventana.")).toBeTruthy();
    emitSettings({ ...await windowApi.get(), effectiveFullscreen: false,
      preferences: { displayId: "secondary", startFullscreen: false } });
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(false));
    unmount();
  });

  it("keeps the content area scrollable", () => {
    renderSettings();
    const content = document.querySelector(".settings-dialog__content");
    expect(content).toBeTruthy();
    const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");
    expect(css).toMatch(/\.settings-dialog__content\s*\{[^}]*overflow-y:\s*auto/s);
  });

  it("persists changes through its owner and supports clock configuration", () => {
    const { onPreferencesChange } = renderSettings();
    fireEvent.click(screen.getByRole("checkbox", { name: /Wallpaper de Windows/ }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith({ ...DEFAULT_DESKTOP_PREFERENCES, wallpaperEnabled: false });

    fireEvent.change(screen.getByLabelText("Zona horaria principal"), { target: { value: "UTC" } });
    expect(onPreferencesChange).toHaveBeenLastCalledWith({ ...DEFAULT_DESKTOP_PREFERENCES, primaryTimeZone: "UTC" });

    fireEvent.change(screen.getByLabelText("Agregar reloj"), { target: { value: "Europe/Paris" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith({ ...DEFAULT_DESKTOP_PREFERENCES,
      clocks: [...DEFAULT_DESKTOP_PREFERENCES.clocks, { id: "Europe/Paris", label: "Paris", timeZone: "Europe/Paris" }] });
  });

  it("closes on Escape and outside click", () => {
    const first = renderSettings();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(first.onClose).toHaveBeenCalledOnce();
    first.unmount();

    const second = renderSettings();
    const backdrop = document.querySelector(".settings-backdrop");
    if (!backdrop) throw new Error("settings_backdrop_missing");
    fireEvent.mouseDown(backdrop);
    expect(second.onClose).toHaveBeenCalledOnce();
  });

  it("keeps Tab navigation inside the modal when focus reaches an edge or leaves it", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const view = renderSettings();
    const close = screen.getByRole("button", { name: "Cerrar Settings" });
    const done = screen.getByRole("button", { name: "Listo" });
    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(done);
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    view.unmount();
    outside.remove();
  });
});
