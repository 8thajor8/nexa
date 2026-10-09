import { contextBridge, ipcRenderer } from "electron";
import {
  GET_WALLPAPER_CHANNEL,
  isPingResponse,
  isWallpaperResponse,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  VOICE_EVENT_CHANNEL,
  VOICE_PTT_CANCEL_CHANNEL,
  VOICE_PTT_FINISH_CHANNEL,
  VOICE_PTT_START_CHANNEL,
  type NexaDesktopApi,
} from "./shared/ipc-contract";
import {
  isVoiceEventEnvelope,
  isVoicePttCancelRequest,
  isVoicePttCancelResponse,
  isVoicePttFinishRequest,
  isVoicePttFinishResponse,
  isVoicePttStartRequest,
  isVoicePttStartResponse,
} from "./shared/voice-ipc-validation";

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
  voice: {
    ptt: {
      async start(request) {
        if (!isVoicePttStartRequest(request)) throw new Error("invalid_voice_ptt_start_request");
        const response: unknown = await ipcRenderer.invoke(VOICE_PTT_START_CHANNEL, request);
        if (!isVoicePttStartResponse(response) || response.requestId !== request.requestId) {
          throw new Error("invalid_voice_ptt_start_response");
        }
        return response;
      },
      async finish(request) {
        if (!isVoicePttFinishRequest(request)) throw new Error("invalid_voice_ptt_finish_request");
        const response: unknown = await ipcRenderer.invoke(VOICE_PTT_FINISH_CHANNEL, request);
        if (!isVoicePttFinishResponse(response) || response.requestId !== request.requestId
          || (response.ok && response.sessionId !== request.sessionId)) {
          throw new Error("invalid_voice_ptt_finish_response");
        }
        return response;
      },
      async cancel(request) {
        if (!isVoicePttCancelRequest(request)) throw new Error("invalid_voice_ptt_cancel_request");
        const response: unknown = await ipcRenderer.invoke(VOICE_PTT_CANCEL_CHANNEL, request);
        if (!isVoicePttCancelResponse(response) || response.requestId !== request.requestId
          || (response.ok && (response.sessionId !== request.sessionId
            || response.targetRequestId !== request.targetRequestId))) {
          throw new Error("invalid_voice_ptt_cancel_response");
        }
        return response;
      },
    },
    onEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("voice_event_listener_required");
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isVoiceEventEnvelope(payload)) listener(payload);
      };
      ipcRenderer.on(VOICE_EVENT_CHANNEL, wrappedListener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(VOICE_EVENT_CHANNEL, wrappedListener);
      };
    },
  },
};
contextBridge.exposeInMainWorld("nexaDesktop", api);
