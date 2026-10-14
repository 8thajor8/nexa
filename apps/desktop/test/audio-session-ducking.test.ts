import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_DUCKING_FACTOR,
  calculateDuckedVolume,
  createAudioSessionDucking,
  shouldRestoreAudioSession,
  type AudioDuckingAdapter,
  type AudioSessionSnapshot,
} from "../src/main/audio-session-ducking";

const snapshot = (sessionId: string, originalVolume: number): AudioSessionSnapshot => ({
  deviceId: "synthetic-render-device",
  sessionId,
  processId: 4242,
  originalVolume,
  duckedVolume: originalVolume * AUDIO_DUCKING_FACTOR,
});

function adapter(sessions = [snapshot("spotify", 0.7), snapshot("browser", 0.4)]) {
  return {
    sessions,
    duck: vi.fn<AudioDuckingAdapter["duck"]>(async () => ({ sessions, failedSessions: 0 })),
    restore: vi.fn<AudioDuckingAdapter["restore"]>(async () => ({ restored: sessions.length, skipped: 0, failedSessions: 0 })),
  } satisfies AudioDuckingAdapter & { sessions: AudioSessionSnapshot[] };
}

describe("Main Windows audio session ducking", () => {
  it("reduces each session relative to its own level and preserves zero and mute decisions", () => {
    expect(calculateDuckedVolume(0.7)).toBeCloseTo(0.14);
    expect(calculateDuckedVolume(0.4)).toBeCloseTo(0.08);
    expect(calculateDuckedVolume(0)).toBe(0);
    expect(() => calculateDuckedVolume(1.1)).toThrow("invalid_audio_ducking_volume");
  });

  it("restores only when the session still has the volume applied by Nexa", () => {
    expect(shouldRestoreAudioSession(0.14, 0.14)).toBe(true);
    expect(shouldRestoreAudioSession(0.145, 0.14)).toBe(true);
    expect(shouldRestoreAudioSession(0.3, 0.14)).toBe(false);
  });

  it("keeps ducking continuous across the PTT-to-transcript request handoff and restores once", async () => {
    const windowsAudio = adapter();
    const controller = createAudioSessionDucking({ platform: "win32", rootProcessId: 99, adapter: windowsAudio });

    await controller.begin("ptt-start");
    controller.transfer("ptt-start", "voice-chat");
    await controller.end("ptt-start");
    expect(windowsAudio.duck).toHaveBeenCalledOnce();
    expect(windowsAudio.restore).not.toHaveBeenCalled();

    await controller.end("voice-chat");
    await controller.end("voice-chat");
    expect(windowsAudio.restore).toHaveBeenCalledOnce();
    expect(windowsAudio.restore).toHaveBeenCalledWith(windowsAudio.sessions);
  });

  it("keeps a new interaction from being restored by an older request", async () => {
    const windowsAudio = adapter();
    const controller = createAudioSessionDucking({ platform: "win32", adapter: windowsAudio });

    await controller.begin("old");
    await controller.begin("new");
    await controller.end("old");
    expect(windowsAudio.restore).not.toHaveBeenCalled();
    await controller.end("new");
    expect(windowsAudio.restore).toHaveBeenCalledOnce();
  });

  it("restores on Desktop shutdown and remains safe if closing is repeated", async () => {
    const windowsAudio = adapter();
    const controller = createAudioSessionDucking({ platform: "win32", adapter: windowsAudio });

    await controller.begin("active");
    await Promise.all([controller.close(), controller.close()]);
    expect(windowsAudio.restore).toHaveBeenCalledOnce();
    await controller.begin("too-late");
    expect(windowsAudio.duck).toHaveBeenCalledOnce();
  });

  it("does not let a platform or Core Audio failure block Voice", async () => {
    const failedAdapter = adapter();
    failedAdapter.duck.mockRejectedValueOnce(new Error("synthetic bridge failure"));
    const diagnostic = vi.fn();
    const controller = createAudioSessionDucking({ platform: "win32", adapter: failedAdapter, diagnostics: diagnostic });

    await expect(controller.begin("voice-request")).resolves.toBeUndefined();
    await controller.end("voice-request");
    expect(diagnostic).toHaveBeenCalledWith("failed", expect.objectContaining({ stage: "duck", code: "duck_failed" }));
    expect(failedAdapter.restore).not.toHaveBeenCalled();

    const nonWindowsAdapter = adapter();
    const nonWindows = createAudioSessionDucking({ platform: "darwin", adapter: nonWindowsAdapter });
    await nonWindows.begin("voice-request");
    expect(nonWindowsAdapter.duck).not.toHaveBeenCalled();
  });
});
