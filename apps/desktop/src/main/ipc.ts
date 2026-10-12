import { clipboard, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  CLIPBOARD_WRITE_TEXT_CHANNEL,
  createPingResponse,
  GET_WALLPAPER_CHANNEL,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  WINDOW_SETTINGS_GET_CHANNEL,
  WINDOW_SETTINGS_SET_CHANNEL,
  type WindowPreferences,
  type WindowSettingsSnapshot,
  type WallpaperResponse,
} from "../shared/ipc-contract.js";
import { isTrustedIpcSender, runForTrustedIpcSender } from "../shared/ipc-security.js";
import { isWindowPreferences } from "../shared/window-settings-validation.js";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  getWallpaper: () => Promise<WallpaperResponse>,
  windowSettings?: { get: () => WindowSettingsSnapshot; set: (preferences: WindowPreferences) => WindowSettingsSnapshot | Promise<WindowSettingsSnapshot> },
  writeClipboardText: (text: string) => void = (text) => clipboard.writeText(text),
): void {
  ipcMain.removeHandler(PING_CHANNEL);
  ipcMain.removeHandler(GET_WALLPAPER_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.removeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
  ipcMain.removeHandler(WINDOW_SETTINGS_GET_CHANNEL);
  ipcMain.removeHandler(WINDOW_SETTINGS_SET_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_MINIMIZE_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_CLOSE_CHANNEL);
  ipcMain.handle(PING_CHANNEL, (event: IpcMainInvokeEvent) => {
    return runForTrustedIpcSender(event, getMainWindow(), createPingResponse);
  });
  ipcMain.handle(GET_WALLPAPER_CHANNEL, async (event: IpcMainInvokeEvent) => {
    return runForTrustedIpcSender(event, getMainWindow(), getWallpaper);
  });
  ipcMain.handle(CLIPBOARD_WRITE_TEXT_CHANNEL, (event: IpcMainInvokeEvent, value: unknown) => {
    const window = getMainWindow();
    if (!window) throw new Error("window_unavailable");
    return runForTrustedIpcSender(event, window, () => {
      if (typeof value !== "string" || value.length === 0 || value.length > 20_000) {
        throw new Error("invalid_clipboard_text");
      }
      writeClipboardText(value);
      return true;
    });
  });
  ipcMain.on(WINDOW_MINIMIZE_CHANNEL, (event: IpcMainEvent) => {
    const window = getMainWindow();
    if (!window || !isTrustedIpcSender(event, window)) return;
    window.minimize();
  });
  ipcMain.handle(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, (event: IpcMainInvokeEvent) => {
    const window = getMainWindow();
    if (!window) throw new Error("window_unavailable");
    return runForTrustedIpcSender(event, window, () => {
      const maximized = !window.isMaximized();
      if (maximized) window.maximize();
      else window.unmaximize();
      return maximized;
    });
  });
  ipcMain.handle(WINDOW_SETTINGS_GET_CHANNEL, (event: IpcMainInvokeEvent) => {
    const window = getMainWindow();
    if (!window) throw new Error("window_unavailable");
    return runForTrustedIpcSender(event, window, () => windowSettings?.get() ?? {
      displays: [], preferences: { displayId: "fallback", startFullscreen: true },
      effectiveFullscreen: true, effectiveDisplayId: "fallback", transitioning: false,
      transitionTargetFullscreen: null, transitionTargetDisplayId: null,
    });
  });
  ipcMain.handle(WINDOW_SETTINGS_SET_CHANNEL, (event: IpcMainInvokeEvent, value: unknown) => {
    const window = getMainWindow();
    if (!window) throw new Error("window_unavailable");
    return runForTrustedIpcSender(event, window, () => {
      if (!windowSettings || !isWindowPreferences(value)) throw new Error("invalid_window_preferences");
      return windowSettings.set(value);
    });
  });
  ipcMain.on(WINDOW_CLOSE_CHANNEL, (event: IpcMainEvent) => {
    const window = getMainWindow();
    if (!window || !isTrustedIpcSender(event, window)) return;
    window.close();
  });
}
