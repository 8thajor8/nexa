import { contextBridge, ipcRenderer } from "electron";
import {
  GET_WALLPAPER_CHANNEL,
  isPingResponse,
  isWallpaperResponse,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  type NexaDesktopApi,
} from "./shared/ipc-contract";

const api: NexaDesktopApi = {
  async ping() {
    const response: unknown = await ipcRenderer.invoke(PING_CHANNEL);
    if (!isPingResponse(response)) throw new Error("invalid_ping_response");
    return response;
  },
  async getWallpaper() {
    const response: unknown = await ipcRenderer.invoke(GET_WALLPAPER_CHANNEL);
    if (!isWallpaperResponse(response)) throw new Error("invalid_wallpaper_response");
    return response;
  },
  minimizeWindow() {
    ipcRenderer.send(WINDOW_MINIMIZE_CHANNEL);
  },
  async toggleMaximizeWindow() {
    const response: unknown = await ipcRenderer.invoke(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
    if (typeof response !== "boolean") throw new Error("invalid_window_state_response");
    return response;
  },
  closeWindow() {
    ipcRenderer.send(WINDOW_CLOSE_CHANNEL);
  },
};
contextBridge.exposeInMainWorld("nexaDesktop", api);
