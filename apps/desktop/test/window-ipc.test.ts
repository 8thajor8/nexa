import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  WINDOW_SETTINGS_GET_CHANNEL,
  WINDOW_SETTINGS_SET_CHANNEL,
  CLIPBOARD_WRITE_TEXT_CHANNEL,
  DESKTOP_RESTART_CHANNEL,
} from "../src/shared/ipc-contract";
import type { IpcSenderContext } from "../src/shared/ipc-security";

const ipcMock = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMock, clipboard: { writeText: ipcMock.writeText } }));

import { registerIpcHandlers } from "../src/main/ipc";

type IpcCallback = (event: IpcSenderContext) => unknown;

describe("frameless window IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts restart only from the trusted main frame with no arguments", () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    const restart = vi.fn(() => ({ ok: true as const, accepted: true as const }));
    registerIpcHandlers(() => ({ webContents }) as never, async () => ({ available: false }), undefined, undefined, restart);
    const handler = ipcMock.handle.mock.calls.find(([channel]) => channel === DESKTOP_RESTART_CHANNEL)?.[1] as
      (event: IpcSenderContext, ...args: unknown[]) => unknown;
    expect(() => handler({ sender: webContents, senderFrame: {} })).toThrow("untrusted_ipc_sender");
    expect(() => handler({ sender: webContents, senderFrame: mainFrame }, "extra")).toThrow("invalid_restart_request");
    expect(restart).not.toHaveBeenCalled();
    expect(handler({ sender: webContents, senderFrame: mainFrame })).toEqual({ ok: true, accepted: true });
    expect(restart).toHaveBeenCalledOnce();
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

  it("restricts display and fullscreen settings to the trusted Renderer and validates updates", async () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    const window = { webContents };
    const snapshot = { displays: [{ id: "2", label: "Pantalla 2", resolution: "1920 × 1080", primary: false }],
      preferences: { displayId: "2", startFullscreen: true }, effectiveFullscreen: true,
      effectiveDisplayId: "2", transitioning: false, transitionTargetFullscreen: null, transitionTargetDisplayId: null };
    const update = vi.fn((preferences) => ({ ...snapshot, preferences, effectiveFullscreen: preferences.startFullscreen }));
    registerIpcHandlers(() => window as never, async () => ({ available: false }), { get: () => snapshot, set: update });
    const invokeHandler = (channel: string) =>
      ipcMock.handle.mock.calls.find(([registeredChannel]) => registeredChannel === channel)?.[1] as (event: IpcSenderContext, value?: unknown) => unknown;
    const trustedEvent = { sender: webContents, senderFrame: mainFrame };
    const untrustedEvent = { sender: webContents, senderFrame: {} };
    expect(await invokeHandler(WINDOW_SETTINGS_GET_CHANNEL)(trustedEvent)).toEqual(snapshot);
    expect(await invokeHandler(WINDOW_SETTINGS_SET_CHANNEL)(trustedEvent, { displayId: "2", startFullscreen: false }))
      .toEqual({ ...snapshot, preferences: { displayId: "2", startFullscreen: false }, effectiveFullscreen: false });
    expect(update).toHaveBeenCalledOnce();
    expect(() => invokeHandler(WINDOW_SETTINGS_GET_CHANNEL)(untrustedEvent)).toThrow("untrusted_ipc_sender");
    expect(() => invokeHandler(WINDOW_SETTINGS_SET_CHANNEL)(trustedEvent, { displayId: "2", startFullscreen: false, extra: true }))
      .toThrow("invalid_window_preferences");
    expect(update).toHaveBeenCalledOnce();
  });

  it("copies only bounded text from the trusted main frame", async () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    const window = { webContents };
    registerIpcHandlers(() => window as never, async () => ({ available: false }));
    const handler = ipcMock.handle.mock.calls.find(([channel]) => channel === CLIPBOARD_WRITE_TEXT_CHANNEL)?.[1] as
      (event: IpcSenderContext, value: unknown) => unknown;
    const trustedEvent = { sender: webContents, senderFrame: mainFrame };
    const untrustedEvent = { sender: webContents, senderFrame: {} };
    const detail = "Informe técnico asociado a este mensaje.";

    expect(handler(trustedEvent, detail)).toBe(true);
    expect(ipcMock.writeText).toHaveBeenCalledOnce();
    expect(ipcMock.writeText).toHaveBeenCalledWith(detail);
    expect(() => handler(trustedEvent, "x".repeat(20_001))).toThrow("invalid_clipboard_text");
    expect(() => handler(untrustedEvent, "no copiar")).toThrow("untrusted_ipc_sender");
    expect(ipcMock.writeText).toHaveBeenCalledOnce();
  });
});
