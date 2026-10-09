import { describe, expect, it } from "vitest";
import { createPingResponse, isPingResponse, PING_CHANNEL } from "../src/shared/ipc-contract";
import { isTrustedIpcSender } from "../src/shared/ipc-security";

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
});