import { describe, expect, it, vi } from "vitest";
import { initializeRendererStartupServices } from "../src/renderer/startup-services";
import type { MicrophoneDeviceStore } from "../src/renderer/audio/microphone-device-store";
import type { SpotifyDesktopApi } from "../src/shared/ipc-contract";

function setup(isIsolated: boolean) {
  let pagehide: (() => void) | undefined;
  let visibilitychange: (() => void) | undefined;
  const enumerateDevices = vi.fn(async () => []);
  const microphoneDevices = {
    start: vi.fn(() => { void enumerateDevices(); }),
    destroy: vi.fn(),
  } as unknown as MicrophoneDeviceStore;
  const spotify = { setLiveStatusVisible: vi.fn() } as unknown as SpotifyDesktopApi;
  const documentTarget = {
    visibilityState: "visible",
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      visibilitychange = listener as () => void;
    }),
    removeEventListener: vi.fn(),
  } as unknown as Document;
  const windowTarget = {
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      pagehide = listener as () => void;
    }),
  } as unknown as Window;
  const createVoiceController = vi.fn(() => ({
    getSnapshot: () => ({ status: "idle" as const, canStart: true }),
    subscribe: () => () => undefined,
    start: async () => undefined,
    finish: async () => undefined,
    cancel: async () => undefined,
    recoverMainCancellation: async () => undefined,
  }));
  const destroyVoiceController = vi.fn(async () => undefined);
  const startup = initializeRendererStartupServices({ isIsolated, microphoneDevices, spotify, documentTarget,
    windowTarget, createVoiceController, destroyVoiceController });
  return { startup, enumerateDevices, microphoneDevices, spotify, documentTarget, windowTarget,
    createVoiceController, destroyVoiceController, get pagehide() { return pagehide; },
    get visibilitychange() { return visibilitychange; } };
}

describe("Renderer startup services", () => {
  it("does not start microphone, Voice subscriptions, or Spotify visibility IPC in isolated mode", async () => {
    const state = setup(true);
    await state.startup.voiceController.start();
    await state.startup.voiceController.cancel();

    expect(state.enumerateDevices).not.toHaveBeenCalled();
    expect(state.microphoneDevices.start).not.toHaveBeenCalled();
    expect(state.createVoiceController).not.toHaveBeenCalled();
    expect(state.spotify.setLiveStatusVisible).not.toHaveBeenCalled();
    expect(state.documentTarget.addEventListener).not.toHaveBeenCalled();
    expect(state.windowTarget.addEventListener).not.toHaveBeenCalled();
  });

  it("preserves normal device enumeration and Spotify visibility behavior", () => {
    const state = setup(false);
    expect(state.microphoneDevices.start).toHaveBeenCalledOnce();
    expect(state.enumerateDevices).toHaveBeenCalledOnce();
    expect(state.createVoiceController).toHaveBeenCalledOnce();
    expect(state.spotify.setLiveStatusVisible).toHaveBeenCalledTimes(1);
    expect(state.spotify.setLiveStatusVisible).toHaveBeenCalledWith(true);
    expect(state.documentTarget.addEventListener).toHaveBeenCalledOnce();
    expect(state.windowTarget.addEventListener).toHaveBeenCalledOnce();
    state.visibilitychange?.();
    expect(state.spotify.setLiveStatusVisible).toHaveBeenCalledTimes(2);
    state.pagehide?.();
    expect(state.spotify.setLiveStatusVisible).toHaveBeenLastCalledWith(false);
    expect(state.documentTarget.removeEventListener).toHaveBeenCalledOnce();
    expect(state.microphoneDevices.destroy).toHaveBeenCalledOnce();
    expect(state.destroyVoiceController).toHaveBeenCalledOnce();
  });
});
