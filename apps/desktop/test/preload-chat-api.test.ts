import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_RENDERER_ISOLATION_ARGUMENT } from "../src/shared/ipc-contract";

const mocks = vi.hoisted(() => ({
  exposed: undefined as unknown,
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn((_key: string, api: unknown) => { mocks.exposed = api; }) },
  ipcRenderer: { invoke: mocks.invoke, send: mocks.send, on: mocks.on, removeListener: mocks.removeListener },
}));

type ChatApi = {
  isIsolated: boolean;
  chat: {
    createConversation(): Promise<unknown>;
    sendMessage(request: unknown): Promise<unknown>;
    cancelRequest(requestId: string): Promise<unknown>;
    onEvent(listener: (event: unknown) => void): () => void;
  };
  copyTechnicalDetail(text: string): Promise<boolean>;
  authorization: {
    connect(request: unknown): Promise<unknown>;
    cancel(request: unknown): Promise<unknown>;
  };
  [key: string]: unknown;
};
const conversationId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const originalArgv = process.argv;

async function loadPreload(): Promise<ChatApi> {
  mocks.exposed = undefined;
  await import("../src/preload");
  return mocks.exposed as ChatApi;
}

describe("chat preload allowlist", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { process.argv = originalArgv; });

  it("exposes the Main-provided isolated mode synchronously without IPC", async () => {
    process.argv = [...originalArgv, DESKTOP_RENDERER_ISOLATION_ARGUMENT];
    const api = await loadPreload();
    expect(api.isIsolated).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("exposes only narrow chat operations and uses fixed correlated channels", async () => {
    const api = await loadPreload();
    expect(api.isIsolated).toBe(false);
    expect(Object.keys(api.chat).sort()).toEqual(["cancelRequest", "createConversation", "onEvent", "sendMessage"]);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("invoke");

    mocks.invoke.mockResolvedValueOnce({ ok: true, conversationId });
    await expect(api.chat.createConversation()).resolves.toEqual({ ok: true, conversationId });
    expect(mocks.invoke).toHaveBeenLastCalledWith("chat:create-conversation");

    mocks.invoke.mockResolvedValueOnce({ ok: true, accepted: true, conversationId, requestId });
    await expect(api.chat.sendMessage({ conversationId, requestId, text: "hola", source: "typed" }))
      .resolves.toMatchObject({ ok: true, requestId });
    expect(mocks.invoke).toHaveBeenLastCalledWith("chat:send-message", { conversationId, requestId, text: "hola", source: "typed" });

    mocks.invoke.mockResolvedValueOnce({ ok: true, accepted: true, requestId });
    await expect(api.chat.cancelRequest(requestId)).resolves.toEqual({ ok: true, accepted: true, requestId });
    expect(mocks.invoke).toHaveBeenLastCalledWith("chat:cancel-request", { requestId });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("exposes only validated Memory mode operations through fixed IPC channels", async () => {
    const api = await loadPreload();
    const memory = api.memory as { getStatus(): Promise<unknown>; setMode(mode: string): Promise<unknown> };
    const status = { mode: "memory1", memory2Available: true, memory2WriteAvailable: true, switching: false, fallbackReason: null };
    mocks.invoke.mockResolvedValueOnce(status);
    await expect(memory.getStatus()).resolves.toEqual(status);
    expect(mocks.invoke).toHaveBeenLastCalledWith("memory:mode:get");
    mocks.invoke.mockResolvedValueOnce({ ok: true, status: { ...status, mode: "memory2-readonly" } });
    await expect(memory.setMode("memory2-readonly")).resolves.toMatchObject({ ok: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith("memory:mode:set", "memory2-readonly");
    await expect(memory.setMode("memory2")).rejects.toThrow("invalid_memory_mode");
  });

  it("exposes a bounded technical-detail copy operation through its fixed Main channel", async () => {
    const api = await loadPreload();
    await expect(api.copyTechnicalDetail("")).rejects.toThrow("invalid_clipboard_text");
    await expect(api.copyTechnicalDetail("x".repeat(20_001))).rejects.toThrow("invalid_clipboard_text");
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValueOnce(true);
    await expect(api.copyTechnicalDetail("detalle de esta respuesta")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("nexa:clipboard:write-text", "detalle de esta respuesta");
    mocks.invoke.mockResolvedValueOnce(false);
    await expect(api.copyTechnicalDetail("detalle")).rejects.toThrow("clipboard_write_failed");
  });

  it("rejects bad input, mismatched ACKs, filters events, and unsubscribes only its listener", async () => {
    const api = await loadPreload();
    await expect(api.chat.sendMessage({ conversationId, requestId, text: "", source: "typed" })).rejects.toThrow("invalid_chat_send_request");
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValueOnce({ ok: true, accepted: true, conversationId, requestId: "00000000-0000-4000-8000-000000000099" });
    await expect(api.chat.sendMessage({ conversationId, requestId, text: "hola", source: "typed" })).rejects.toThrow("invalid_chat_send_response");

    let callback: ((event: unknown) => void) | undefined;
    mocks.on.mockImplementationOnce((_channel, listener) => { callback = listener as typeof callback; });
    const received = vi.fn();
    const unsubscribe = api.chat.onEvent(received);
    expect(mocks.on).toHaveBeenCalledWith("chat:event", expect.any(Function));
    callback?.({}, { conversationId, requestId, status: "processing" });
    callback?.({}, { conversationId, requestId, status: "completed", response: "ok", extra: true });
    expect(received).toHaveBeenCalledTimes(1);
    unsubscribe(); unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
    expect(mocks.removeListener).toHaveBeenCalledWith("chat:event", expect.any(Function));
  });

  it("exposes only validated authorization actions and rejects mismatched providers", async () => {
    const api = await loadPreload();
    expect(Object.keys(api.authorization).sort()).toEqual(["cancel", "connect"]);
    expect(api.authorization).not.toHaveProperty("token");
    await expect(api.authorization.connect({ provider: "spotify", requestId: "bad" }))
      .rejects.toThrow("invalid_authorization_connect_request");
    expect(mocks.invoke).not.toHaveBeenCalled();

    const spotifyRequest = { provider: "spotify", requestId };
    mocks.invoke.mockResolvedValueOnce({ provider: "microsoft", state: "connected" });
    await expect(api.authorization.connect(spotifyRequest)).rejects.toThrow("invalid_authorization_connect_response");
    expect(mocks.invoke).toHaveBeenLastCalledWith("authorization:connect", spotifyRequest);

    mocks.invoke.mockResolvedValueOnce({ provider: "spotify", state: "connected" });
    await expect(api.authorization.connect(spotifyRequest)).resolves.toEqual({ provider: "spotify", state: "connected" });
  });

  it("validates city input and current weather responses across the Main boundary", async () => {
    const api = await loadPreload();
    const weather = api.weather as { getCurrent(location: string): Promise<unknown> };
    await expect(weather.getCurrent("https://example.com")).rejects.toThrow("invalid_weather_location");
    expect(mocks.invoke).not.toHaveBeenCalled();
    const status = { available: true, location: "Barcelona", temperatureC: 20, condition: "Despejado", updatedAt: 123 };
    mocks.invoke.mockResolvedValueOnce(status);
    await expect(weather.getCurrent("Barcelona")).resolves.toEqual(status);
    expect(mocks.invoke).toHaveBeenLastCalledWith("weather:current", "Barcelona");
    mocks.invoke.mockResolvedValueOnce({ ...status, extra: "not allowed" });
    await expect(weather.getCurrent("Barcelona")).rejects.toThrow("invalid_weather_status_response");
  });

  it("exposes validated live window settings and removes its subscription", async () => {
    const api = await loadPreload();
    const settings = api.windowSettings as { onChanged(listener: (snapshot: unknown) => void): () => void };
    let callback: ((event: unknown, value: unknown) => void) | undefined;
    mocks.on.mockImplementationOnce((_channel, listener) => { callback = listener as typeof callback; });
    const receive = vi.fn();
    const unsubscribe = settings.onChanged(receive);
    expect(mocks.on).toHaveBeenCalledWith("nexa:window-settings:changed", expect.any(Function));
    const snapshot = { displays: [{ id: "1", label: "Pantalla 1 · Principal", resolution: "1920 × 1080", primary: true }],
      preferences: { displayId: "1", startFullscreen: true }, effectiveFullscreen: false, effectiveDisplayId: "1",
      transitioning: true, transitionTargetFullscreen: true, transitionTargetDisplayId: "1" };
    callback?.({}, snapshot);
    callback?.({}, { ...snapshot, effectiveFullscreen: "false" });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledWith(snapshot);
    unsubscribe(); unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith("nexa:window-settings:changed", expect.any(Function));
  });
});
