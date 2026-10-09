import { contextBridge, ipcRenderer } from "electron";
import { isPingResponse, PING_CHANNEL, type NexaDesktopApi } from "./shared/ipc-contract";

const api: NexaDesktopApi = {
  async ping() {
    const response: unknown = await ipcRenderer.invoke(PING_CHANNEL);
    if (!isPingResponse(response)) throw new Error("invalid_ping_response");
    return response;
  },
};
contextBridge.exposeInMainWorld("nexaDesktop", api);