import { describe, expect, it, vi } from "vitest";
import {
  createPingResponse,
  GET_WALLPAPER_CHANNEL,
  isPingResponse,
  isWallpaperResponse,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
} from "../src/shared/ipc-contract";
import { isTrustedIpcSender, runForTrustedIpcSender } from "../src/shared/ipc-security";

describe("desktop IPC contract", () => {
  it("uses the explicit ping channel and validates its response shape", () => {
    expect(PING_CHANNEL).toBe("nexa:ping");
    expect(createPingResponse()).toEqual({ ok: true, message: "pong" });
    expect(isPingResponse({ ok: true, message: "pong" })).toBe(true);
    expect(isPingResponse({ ok: true, message: "pong", extra: true })).toBe(false);
    expect(isPingResponse(null)).toBe(false);
  });
  it("accepts only the main frame of the registered window", () => {
    const mainFrame = {};
    const otherFrame = {};
    const webContents = { mainFrame };
    const windowContext = { webContents };
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, windowContext)).toBe(true);
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: otherFrame }, windowContext)).toBe(false);
    expect(isTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, windowContext)).toBe(false);
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, null)).toBe(false);
  });

  it("validates a narrow wallpaper response and rejects arbitrary URLs", () => {
    expect(GET_WALLPAPER_CHANNEL).toBe("nexa:wallpaper:get");
    expect(isWallpaperResponse({ available: false })).toBe(true);
    expect(isWallpaperResponse({ available: true, dataUrl: "data:image/jpeg;base64,/9j/" })).toBe(true);
    expect(isWallpaperResponse({ available: true, dataUrl: "file:///secret.jpg" })).toBe(false);
    expect(isWallpaperResponse({ available: true, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" })).toBe(false);
    expect(isWallpaperResponse({ available: false, path: "C:\\secret.jpg" })).toBe(false);
  });

  it("exposes only explicit window-control channels", () => {
    expect(WINDOW_MINIMIZE_CHANNEL).toBe("nexa:window:minimize");
    expect(WINDOW_TOGGLE_MAXIMIZE_CHANNEL).toBe("nexa:window:toggle-maximize");
    expect(WINDOW_CLOSE_CHANNEL).toBe("nexa:window:close");
  });

  it("runs the wallpaper operation only for the registered main frame", () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    const windowContext = { webContents };
    const operation = vi.fn(() => ({ available: false } as const));

    expect(runForTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, windowContext, operation))
      .toEqual({ available: false });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(() => runForTrustedIpcSender({ sender: webContents, senderFrame: {} }, windowContext, operation))
      .toThrow("untrusted_ipc_sender");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
