import { describe, expect, it, vi } from "vitest";
import type { VoiceDesktopApi, VoiceEventEnvelope } from "../src/shared/ipc-contract";
import {
  createPttVoiceControllerOwner,
  getRendererPttVoiceControllerOwner,
} from "../src/renderer/voice/ptt-voice-controller-owner";
import type { PttCapturePort } from "../src/renderer/voice/ptt-voice-controller";

function makeVoice() {
  const listeners = new Set<(event: VoiceEventEnvelope) => void>();
  const voice = {
    ptt: {},
    onEvent(listener: (event: VoiceEventEnvelope) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as VoiceDesktopApi;
  return { voice, listeners };
}

function makeCapture(): PttCapturePort {
  return {
    start: vi.fn(async () => ({ sessionId: "session", requestId: "start" })),
    finish: vi.fn(async () => ({ ok: true, accepted: true, requestId: "finish", sessionId: "session" })),
    cancel: vi.fn(async () => undefined),
    mainCancellationPending: false,
    recoverMainCancellation: vi.fn(async () => undefined),
  };
}

describe("PttVoiceControllerOwner", () => {
  it("returns one stable controller across repeated consumers without starting microphone capture", async () => {
    const { voice, listeners } = makeVoice();
    const capture = makeCapture();
    const createCapture = vi.fn(() => capture);
    const first = getRendererPttVoiceControllerOwner(voice, { createCapture });
    const second = getRendererPttVoiceControllerOwner(voice, { createCapture });

    expect(second).toBe(first);
    expect(second.controller).toBe(first.controller);
    expect(createCapture).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(1);
    expect(capture.start).not.toHaveBeenCalled();
    await first.destroy();
    expect(listeners.size).toBe(0);
    expect(capture.cancel).toHaveBeenCalledOnce();
  });

  it("keeps separate owners and listeners for separate Renderer window contexts", async () => {
    const firstWindow = makeVoice();
    const secondWindow = makeVoice();
    const firstCapture = makeCapture();
    const secondCapture = makeCapture();
    const first = createPttVoiceControllerOwner(firstWindow.voice, { createCapture: () => firstCapture });
    const second = createPttVoiceControllerOwner(secondWindow.voice, { createCapture: () => secondCapture });

    expect(first).not.toBe(second);
    expect(first.controller).not.toBe(second.controller);
    expect(firstWindow.listeners.size).toBe(1);
    expect(secondWindow.listeners.size).toBe(1);
    await first.destroy();
    expect(firstWindow.listeners.size).toBe(0);
    expect(secondWindow.listeners.size).toBe(1);
    await second.destroy();
    expect(secondWindow.listeners.size).toBe(0);
  });

  it("preserves the same recovery-bearing instance across consumer remounts", async () => {
    const { voice } = makeVoice();
    const capture = makeCapture();
    const createCapture = vi.fn(() => capture);
    const owner = createPttVoiceControllerOwner(voice, { createCapture });
    await owner.controller.start();
    capture.mainCancellationPending = true;
    (capture.cancel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("reply lost"), { code: "main_cancel_unconfirmed" }),
    );
    await owner.controller.cancel();
    expect(owner.controller.getSnapshot().status).toBe("recovery-required");

    const remountedConsumerController = owner.controller;
    expect(remountedConsumerController).toBe(owner.controller);
    expect(createCapture).toHaveBeenCalledOnce();
    expect(capture.mainCancellationPending).toBe(true);
    await owner.destroy();
  });
});
