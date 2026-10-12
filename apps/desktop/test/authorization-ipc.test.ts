import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_CANCEL_CHANNEL, AUTHORIZATION_CONNECT_CHANNEL,
} from "../src/shared/ipc-contract.js";
import { AuthorizationIpcService } from "../src/main/authorization-ipc.js";

const handlers = vi.hoisted(() => new Map<string, (...args: never[]) => unknown>());
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, listener: (...args: never[]) => unknown) => handlers.set(channel, listener),
  removeHandler: (channel: string) => handlers.delete(channel),
} }));

const requestId = "00000000-0000-4000-8000-000000000001";
function setup(connectors: ConstructorParameters<typeof AuthorizationIpcService>[1]) {
  const contents = { mainFrame: {} };
  const window = { webContents: contents };
  const service = new AuthorizationIpcService(() => window, connectors);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { service, event, window, contents };
}

describe("Desktop authorization IPC", () => {
  beforeEach(() => handlers.clear());

  it("accepts only the trusted Main frame and returns a minimal connected result", async () => {
    const microsoft = vi.fn(async () => ({ success: true }));
    const h = setup({ microsoft, spotify: vi.fn(async () => ({ success: true })) });
    const connect = h.service.connect.bind(h.service) as (event: never, payload: unknown) => Promise<unknown>;
    await expect(connect({ sender: {}, senderFrame: {} } as never, { provider: "microsoft", requestId }))
      .rejects.toThrow("untrusted_ipc_sender");
    await expect(connect(h.event as never, { provider: "microsoft", requestId }))
      .resolves.toEqual({ provider: "microsoft", state: "connected" });
    expect(microsoft).toHaveBeenCalledOnce();
  });

  it("sanitizes provider failures and never returns raw exception details", async () => {
    const h = setup({
      microsoft: async () => { throw Object.assign(new Error("secret-value"), { code: "microsoft_configuration_missing" }); },
      spotify: async () => undefined,
    });
    const result = await h.service.connect(h.event as never, { provider: "microsoft", requestId });
    expect(result).toEqual({ provider: "microsoft", state: "error", code: "microsoft_configuration_missing",
      message: "Falta configurar Microsoft en el entorno local de Nexa." });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("rejects parallel authorization attempts for one provider without invoking a second connector", async () => {
    let finish!: () => void;
    const microsoft = vi.fn(() => new Promise<{ success: boolean }>((resolve) => { finish = () => resolve({ success: true }); }));
    const h = setup({ microsoft, spotify: async () => undefined });
    const first = h.service.connect(h.event as never, { provider: "microsoft", requestId });
    await Promise.resolve();
    const second = await h.service.connect(h.event as never, { provider: "microsoft", requestId: "00000000-0000-4000-8000-000000000002" });
    expect(second).toMatchObject({ state: "error", code: "authorization_in_progress" });
    expect(microsoft).toHaveBeenCalledOnce();
    finish();
    await expect(first).resolves.toMatchObject({ state: "connected" });
  });

  it("supports cancellation only for the matching active Spotify request", async () => {
    const spotify = vi.fn((_signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      _signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "spotify_authorization_cancelled" })), { once: true });
    }));
    const h = setup({ microsoft: async () => undefined, spotify });
    const first = h.service.connect(h.event as never, { provider: "spotify", requestId });
    await Promise.resolve();
    expect(h.service.cancel(h.event as never, { provider: "spotify", requestId }))
      .toEqual({ provider: "spotify", requestId, accepted: true });
    await expect(first).resolves.toEqual({ provider: "spotify", state: "cancelled" });
    expect(h.service.cancel(h.event as never, { provider: "microsoft", requestId }))
      .toEqual({ provider: "microsoft", requestId, accepted: false, code: "not_active" });
  });

  it("reports Microsoft browser cancellation without exposing MSAL details", async () => {
    const h = setup({
      microsoft: async () => { throw Object.assign(new Error("interaction canceled with sensitive data"), { code: "microsoft_authorization_cancelled" }); },
      spotify: async () => undefined,
    });
    await expect(h.service.connect(h.event as never, { provider: "microsoft", requestId }))
      .resolves.toEqual({ provider: "microsoft", state: "cancelled" });
  });
});
