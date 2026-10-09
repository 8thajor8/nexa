import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
} from "../src/shared/ipc-contract";
import type { IpcSenderContext } from "../src/shared/ipc-security";

const ipcMock = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMock }));

import { registerIpcHandlers } from "../src/main/ipc";

type IpcCallback = (event: IpcSenderContext) => unknown;

describe("frameless window IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates the main frame and operates minimize, maximize/restore, and close", async () => {
    let maximized = false;
    const mainFrame = {};
    const webContents = { mainFrame };
    const window = {
      webContents,
      minimize: vi.fn(),
      isMaximized: vi.fn(() => maximized),
      maximize: vi.fn(() => { maximized = true; }),
      unmaximize: vi.fn(() => { maximized = false; }),
      close: vi.fn(),
    };
    const getWallpaper = vi.fn(async () => ({ available: false } as const));
    registerIpcHandlers(() => window as never, getWallpaper);

    const trustedEvent = { sender: webContents, senderFrame: mainFrame };
    const untrustedEvent = { sender: webContents, senderFrame: {} };
    const invokeHandler = (channel: string) =>
      ipcMock.handle.mock.calls.find(([registeredChannel]) => registeredChannel === channel)?.[1] as IpcCallback;
    const sendHandler = (channel: string) =>
      ipcMock.on.mock.calls.find(([registeredChannel]) => registeredChannel === channel)?.[1] as IpcCallback;

    expect(await invokeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL)(trustedEvent)).toBe(true);
    expect(window.maximize).toHaveBeenCalledTimes(1);
    expect(await invokeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL)(trustedEvent)).toBe(false);
    expect(window.unmaximize).toHaveBeenCalledTimes(1);

    sendHandler(WINDOW_MINIMIZE_CHANNEL)(trustedEvent);
    sendHandler(WINDOW_CLOSE_CHANNEL)(trustedEvent);
    expect(window.minimize).toHaveBeenCalledTimes(1);
    expect(window.close).toHaveBeenCalledTimes(1);

    sendHandler(WINDOW_MINIMIZE_CHANNEL)(untrustedEvent);
    sendHandler(WINDOW_CLOSE_CHANNEL)(untrustedEvent);
    expect(() => invokeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL)(untrustedEvent))
      .toThrow("untrusted_ipc_sender");
    expect(window.minimize).toHaveBeenCalledTimes(1);
    expect(window.close).toHaveBeenCalledTimes(1);
    expect(window.maximize).toHaveBeenCalledTimes(1);
    expect(window.unmaximize).toHaveBeenCalledTimes(1);
  });
});
