import type { SpotifyDesktopApi } from "../shared/ipc-contract";
import type { MicrophoneDeviceStore } from "./audio/microphone-device-store";
import { createInactivePttVoiceController } from "./voice/ptt-voice-controller-owner";
import type { PttVoiceControllerPort } from "./voice/ptt-voice-controller";

export interface RendererStartupServicesOptions {
  readonly isIsolated: boolean;
  readonly microphoneDevices: Pick<MicrophoneDeviceStore, "start" | "destroy">;
  readonly spotify: Pick<SpotifyDesktopApi, "setLiveStatusVisible">;
  readonly documentTarget: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  readonly windowTarget: Pick<Window, "addEventListener">;
  readonly createVoiceController: () => PttVoiceControllerPort;
  readonly destroyVoiceController: () => Promise<void>;
}

export interface RendererStartupServices {
  readonly voiceController: PttVoiceControllerPort;
  readonly dispose: () => void;
}

/** Starts device, Spotify visibility and Voice subscriptions only in normal Desktop mode. */
export function initializeRendererStartupServices(
  options: RendererStartupServicesOptions,
): RendererStartupServices {
  if (options.isIsolated) {
    return Object.freeze({ voiceController: createInactivePttVoiceController(), dispose: () => undefined });
  }

  const voiceController = options.createVoiceController();
  options.microphoneDevices.start();
  const updateSpotifyVisibility = () => options.spotify.setLiveStatusVisible(
    options.documentTarget.visibilityState === "visible",
  );
  updateSpotifyVisibility();
  options.documentTarget.addEventListener("visibilitychange", updateSpotifyVisibility);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.spotify.setLiveStatusVisible(false);
    options.documentTarget.removeEventListener("visibilitychange", updateSpotifyVisibility);
    options.microphoneDevices.destroy();
    void options.destroyVoiceController().catch(() => undefined);
  };
  options.windowTarget.addEventListener("pagehide", dispose, { once: true });
  return Object.freeze({ voiceController, dispose });
}
