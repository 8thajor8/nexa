import type { VoiceDesktopApi } from "../../shared/ipc-contract";
import { PttVoiceController, type PttVoiceControllerDependencies, type PttVoiceControllerPort } from "./ptt-voice-controller";

export interface PttVoiceControllerOwner {
  readonly controller: PttVoiceController;
  destroy(): Promise<void>;
}

/** Inert controller used by isolated Desktop startup; it creates no capture or IPC subscriptions. */
export function createInactivePttVoiceController(): PttVoiceControllerPort {
  const snapshot = Object.freeze({ status: "idle" as const, canStart: false });
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (_listener: () => void) => () => undefined,
    start: async () => undefined,
    finish: async (_language?: string) => undefined,
    cancel: async () => undefined,
    recoverMainCancellation: async (_target?: "preferred" | "start" | "finish") => undefined,
  });
}

/** Owns one controller for one Electron Renderer context, independent of React mounts. */
export function createPttVoiceControllerOwner(
  voice: VoiceDesktopApi,
  dependencies: PttVoiceControllerDependencies = {},
): PttVoiceControllerOwner {
  const controller = new PttVoiceController(voice, dependencies);
  let destruction: Promise<void> | null = null;
  return Object.freeze({
    controller,
    destroy(): Promise<void> {
      destruction ??= controller.destroy();
      return destruction;
    },
  });
}

// Electron gives each BrowserWindow its own Renderer context and module instance.
let rendererOwner: PttVoiceControllerOwner | null = null;

export function getRendererPttVoiceControllerOwner(
  voice: VoiceDesktopApi,
  dependencies: PttVoiceControllerDependencies = {},
): PttVoiceControllerOwner {
  rendererOwner ??= createPttVoiceControllerOwner(voice, dependencies);
  return rendererOwner;
}

export function destroyRendererPttVoiceControllerOwner(): Promise<void> {
  return rendererOwner?.destroy() ?? Promise.resolve();
}
