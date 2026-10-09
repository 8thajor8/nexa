import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  createPingResponse,
  GET_WALLPAPER_CHANNEL,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  type WallpaperResponse,
} from "../shared/ipc-contract.js";
import { isTrustedIpcSender, runForTrustedIpcSender } from "../shared/ipc-security.js";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  getWallpaper: () => Promise<WallpaperResponse>,
): void {
  ipcMain.removeHandler(PING_CHANNEL);
  ipcMain.removeHandler(GET_WALLPAPER_CHANNEL);
  ipcMain.removeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_MINIMIZE_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_CLOSE_CHANNEL);
  ipcMain.handle(PING_CHANNEL, (event: IpcMainInvokeEvent) => {
    return runForTrustedIpcSender(event, getMainWindow(), createPingResponse);
  });
  ipcMain.handle(GET_WALLPAPER_CHANNEL, async (event: IpcMainInvokeEvent) => {
    return runForTrustedIpcSender(event, getMainWindow(), getWallpaper);
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
  ipcMain.on(WINDOW_CLOSE_CHANNEL, (event: IpcMainEvent) => {
    const window = getMainWindow();
    if (!window || !isTrustedIpcSender(event, window)) return;
    window.close();
  });
}
