import { contextBridge, ipcRenderer } from "electron";
import {
  GET_WALLPAPER_CHANNEL,
  DESKTOP_RESTART_CHANNEL,
  CLIPBOARD_WRITE_TEXT_CHANNEL,
  AUTHORIZATION_CANCEL_CHANNEL,
  AUTHORIZATION_CONNECT_CHANNEL,
  SPOTIFY_OPEN_TRACK_CHANNEL,
  SPOTIFY_CONTROL_CHANNEL,
  SPOTIFY_LIVE_STATUS_CHANNEL,
  SPOTIFY_LIVE_STATUS_EVENT_CHANNEL,
  SPOTIFY_LIVE_VISIBILITY_CHANNEL,
  CHAT_CANCEL_REQUEST_CHANNEL,
  CHAT_CREATE_CONVERSATION_CHANNEL,
  CHAT_EVENT_CHANNEL,
  CHAT_SEND_MESSAGE_CHANNEL,
  MEMORY_MODE_GET_CHANNEL,
  MEMORY_MODE_SET_CHANNEL,
  isDesktopMemoryMode,
  isDesktopMemoryModeResult,
  isDesktopMemoryModeStatus,
  isPingResponse,
  isDesktopRestartResponse,
  isWallpaperResponse,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  WINDOW_SETTINGS_GET_CHANNEL,
  WINDOW_SETTINGS_SET_CHANNEL,
  WINDOW_SETTINGS_CHANGED_CHANNEL,
  VOICE_EVENT_CHANNEL,
  VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL,
  VOICE_DUCKING_END_CHANNEL,
  VOICE_SPEECH_CANCEL_CHANNEL,
  VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL,
  VOICE_SPEECH_CHAT_PLAY_CHANNEL,
  VOICE_SPEECH_EVENT_CHANNEL,
  VOICE_PTT_CANCEL_CHANNEL,
  VOICE_PTT_FINISH_CHANNEL,
  VOICE_PTT_START_CHANNEL,
  WEATHER_CURRENT_CHANNEL,
  DESKTOP_RENDERER_ISOLATION_ARGUMENT,
  DESKTOP_RENDERER_ORGANIC_PILOT_ARGUMENT,
  type NexaDesktopApi,
} from "./shared/ipc-contract";
import { isSpotifyControlResponse, isSpotifyLiveStatus, isSpotifyPlaybackControl } from "./shared/spotify-live-ipc-validation";
import {
  isAuthorizationCancelRequest, isAuthorizationCancelResult, isAuthorizationConnectRequest, isAuthorizationConnectResult,
} from "./shared/authorization-ipc-validation";
import { canonicalSpotifyTrackUrl } from "./shared/spotify-link-validation";
import { isWeatherCurrentStatus, isWeatherLocation } from "./shared/weather-ipc-validation";
import { isWindowPreferences, isWindowSettingsSnapshot } from "./shared/window-settings-validation";
import {
  isVoiceEventEnvelope,
  isVoiceId,
  isVoicePttCancelRequest,
  isVoicePttCancelResponse,
  isVoicePttFinishRequest,
  isVoicePttFinishResponse,
  isVoicePttStartRequest,
  isVoicePttStartResponse,
  isVoiceSpeechCancelRequest,
  isVoiceSpeechCancelResponse,
  isVoiceSpeechAcknowledgementRequest,
  isVoiceFollowupDiagnosticRequest,
  isVoiceSpeechAcknowledgementResponse,
  isVoiceSpeechEvent,
} from "./shared/voice-ipc-validation";
import {
  isChatCancelRequest, isChatCancelResponse, isChatConversationResponse, isChatEventEnvelope,
  isChatSendMessageRequest, isChatSendResponse,
} from "./shared/chat-ipc-validation";

const api: NexaDesktopApi = {
  isIsolated: process.argv.includes(DESKTOP_RENDERER_ISOLATION_ARGUMENT),
  isSyntheticOrganicPilot: process.argv.includes(DESKTOP_RENDERER_ORGANIC_PILOT_ARGUMENT),
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
  async copyTechnicalDetail(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 20_000) {
      throw new Error("invalid_clipboard_text");
    }
    const response: unknown = await ipcRenderer.invoke(CLIPBOARD_WRITE_TEXT_CHANNEL, text);
    if (response !== true) throw new Error("clipboard_write_failed");
    return true;
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
  async restartDesktop() {
    const response: unknown = await ipcRenderer.invoke(DESKTOP_RESTART_CHANNEL);
    if (!isDesktopRestartResponse(response)) throw new Error("invalid_restart_response");
    return response;
  },
  windowSettings: {
    async get() {
      const response: unknown = await ipcRenderer.invoke(WINDOW_SETTINGS_GET_CHANNEL);
      if (!isWindowSettingsSnapshot(response)) throw new Error("invalid_window_settings_response");
      return response;
    },
    async set(preferences) {
      if (!isWindowPreferences(preferences)) throw new Error("invalid_window_preferences");
      const response: unknown = await ipcRenderer.invoke(WINDOW_SETTINGS_SET_CHANNEL, preferences);
      if (!isWindowSettingsSnapshot(response)) throw new Error("invalid_window_settings_response");
      return response;
    },
    onChanged(listener) {
      if (typeof listener !== "function") throw new TypeError("window_settings_listener_required");
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isWindowSettingsSnapshot(payload)) listener(payload);
      };
      ipcRenderer.on(WINDOW_SETTINGS_CHANGED_CHANNEL, wrappedListener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(WINDOW_SETTINGS_CHANGED_CHANNEL, wrappedListener);
      };
    },
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
    async recordFollowupDiagnostic(request) {
      if (!isVoiceFollowupDiagnosticRequest(request)) throw new Error("invalid_voice_followup_diagnostic_request");
      return await ipcRenderer.invoke(VOICE_FOLLOWUP_DIAGNOSTIC_CHANNEL, request) === true;
    },
    async endDucking(requestId, reason = "completed") {
      if (!isVoiceId(requestId)) {
        throw new Error("invalid_voice_ducking_request_id");
      }
      if (!["completed", "followup_expired", "stop", "error"].includes(reason)) throw new Error("invalid_voice_ducking_end_reason");
      const response: unknown = await ipcRenderer.invoke(VOICE_DUCKING_END_CHANNEL, { requestId, reason });
      if (typeof response !== "boolean") throw new Error("invalid_voice_ducking_end_response");
      return response;
    },
    speech: {
      async playChatResponse(requestId) {
        if (!isVoiceId(requestId)) throw new Error("invalid_voice_chat_play_request_id");
        const response: unknown = await ipcRenderer.invoke(VOICE_SPEECH_CHAT_PLAY_CHANNEL, { requestId });
        if (typeof response !== "boolean") throw new Error("invalid_voice_chat_play_response");
        return response;
      },
      async acknowledge(request) {
        if (!isVoiceSpeechAcknowledgementRequest(request)) throw new Error("invalid_voice_speech_acknowledgement_request");
        const response: unknown = await ipcRenderer.invoke(VOICE_SPEECH_ACKNOWLEDGEMENT_CHANNEL, request);
        if (!isVoiceSpeechAcknowledgementResponse(response) || response.requestId !== request.requestId) {
          throw new Error("invalid_voice_speech_acknowledgement_response");
        }
        return response;
      },
      async cancel(request) {
        if (!isVoiceSpeechCancelRequest(request)) throw new Error("invalid_voice_speech_cancel_request");
        const response: unknown = await ipcRenderer.invoke(VOICE_SPEECH_CANCEL_CHANNEL, request);
        if (!isVoiceSpeechCancelResponse(response) || response.requestId !== request.requestId) {
          throw new Error("invalid_voice_speech_cancel_response");
        }
        return response;
      },
      onEvent(listener) {
        if (typeof listener !== "function") throw new TypeError("voice_speech_event_listener_required");
        const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
          if (isVoiceSpeechEvent(payload)) listener(payload);
        };
        ipcRenderer.on(VOICE_SPEECH_EVENT_CHANNEL, wrappedListener);
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          ipcRenderer.removeListener(VOICE_SPEECH_EVENT_CHANNEL, wrappedListener);
        };
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
  chat: {
    async createConversation() {
      const response: unknown = await ipcRenderer.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
      if (!isChatConversationResponse(response)) throw new Error("invalid_chat_conversation_response");
      return response;
    },
    async sendMessage(request) {
      if (!isChatSendMessageRequest(request)) throw new Error("invalid_chat_send_request");
      const response: unknown = await ipcRenderer.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);
      if (!isChatSendResponse(response) || response.requestId !== request.requestId
        || (response.ok && response.conversationId !== request.conversationId)
        || (!response.ok && response.conversationId !== undefined && response.conversationId !== request.conversationId)) {
        throw new Error("invalid_chat_send_response");
      }
      return response;
    },
    async cancelRequest(requestId) {
      const request = { requestId };
      if (!isChatCancelRequest(request)) throw new Error("invalid_chat_cancel_request");
      const response: unknown = await ipcRenderer.invoke(CHAT_CANCEL_REQUEST_CHANNEL, request);
      if (!isChatCancelResponse(response) || response.requestId !== requestId) throw new Error("invalid_chat_cancel_response");
      return response;
    },
    onEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("chat_event_listener_required");
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isChatEventEnvelope(payload)) listener(payload);
      };
      ipcRenderer.on(CHAT_EVENT_CHANNEL, wrappedListener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, wrappedListener);
      };
    },
  },
  memory: {
    async getStatus() {
      const response: unknown = await ipcRenderer.invoke(MEMORY_MODE_GET_CHANNEL);
      if (!isDesktopMemoryModeStatus(response)) throw new Error("invalid_memory_mode_status");
      return response;
    },
    async setMode(mode) {
      if (!isDesktopMemoryMode(mode)) throw new Error("invalid_memory_mode");
      const response: unknown = await ipcRenderer.invoke(MEMORY_MODE_SET_CHANNEL, mode);
      if (!isDesktopMemoryModeResult(response)) throw new Error("invalid_memory_mode_response");
      return response;
    },
  },
  authorization: {
    async connect(request) {
      if (!isAuthorizationConnectRequest(request)) throw new Error("invalid_authorization_connect_request");
      const response: unknown = await ipcRenderer.invoke(AUTHORIZATION_CONNECT_CHANNEL, request);
      if (!isAuthorizationConnectResult(response) || response.provider !== request.provider) {
        throw new Error("invalid_authorization_connect_response");
      }
      return response;
    },
    async cancel(request) {
      if (!isAuthorizationCancelRequest(request)) throw new Error("invalid_authorization_cancel_request");
      const response: unknown = await ipcRenderer.invoke(AUTHORIZATION_CANCEL_CHANNEL, request);
      if (!isAuthorizationCancelResult(response) || response.provider !== request.provider
        || response.requestId !== request.requestId) throw new Error("invalid_authorization_cancel_response");
      return response;
    },
  },
  spotify: {
    async openTrack(url) {
      const canonicalUrl = canonicalSpotifyTrackUrl(url);
      if (!canonicalUrl) throw new Error("invalid_spotify_track_url");
      const response: unknown = await ipcRenderer.invoke(SPOTIFY_OPEN_TRACK_CHANNEL, canonicalUrl);
      if (typeof response !== "boolean") throw new Error("invalid_spotify_open_response");
      return response;
    },
    async getLiveStatus() {
      const response: unknown = await ipcRenderer.invoke(SPOTIFY_LIVE_STATUS_CHANNEL);
      if (!isSpotifyLiveStatus(response)) throw new Error("invalid_spotify_live_status_response");
      return response;
    },
    setLiveStatusVisible(visible) {
      if (typeof visible !== "boolean") return;
      ipcRenderer.send(SPOTIFY_LIVE_VISIBILITY_CHANNEL, visible);
    },
    onLiveStatus(listener) {
      if (typeof listener !== "function") throw new TypeError("spotify_status_listener_required");
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isSpotifyLiveStatus(payload)) listener(payload);
      };
      ipcRenderer.on(SPOTIFY_LIVE_STATUS_EVENT_CHANNEL, wrappedListener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(SPOTIFY_LIVE_STATUS_EVENT_CHANNEL, wrappedListener);
      };
    },
    async control(action) {
      if (!isSpotifyPlaybackControl(action)) throw new Error("invalid_spotify_control_request");
      const response: unknown = await ipcRenderer.invoke(SPOTIFY_CONTROL_CHANNEL, action);
      if (!isSpotifyControlResponse(response, action)) throw new Error("invalid_spotify_control_response");
      return response;
    },
  },
  weather: {
    async getCurrent(location) {
      if (!isWeatherLocation(location)) throw new Error("invalid_weather_location");
      const response: unknown = await ipcRenderer.invoke(WEATHER_CURRENT_CHANNEL, location.trim());
      if (!isWeatherCurrentStatus(response)) throw new Error("invalid_weather_status_response");
      return response;
    },
  },
};
contextBridge.exposeInMainWorld("nexaDesktop", api);
