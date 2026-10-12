import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: ipc }));

import { getCurrentWeatherStatus, registerWeatherIpcHandler } from "../src/main/weather-ipc";
import { WEATHER_CURRENT_CHANNEL } from "../src/shared/ipc-contract";

describe("Desktop current weather IPC", () => {
  beforeEach(() => { ipc.handle.mockClear(); ipc.removeHandler.mockClear(); });

  it("reuses the Runtime weather tool with its external-read permission and returns only current data", async () => {
    const execute = vi.fn(async () => ({ success: true, location: { name: "Barcelona" },
      current: { temperatureC: 18.4, condition: "Parcialmente nublado" }, forecast: [{ personal: "not forwarded" }] }));
    await expect(getCurrentWeatherStatus("Barcelona", execute, () => 123)).resolves.toEqual({ available: true,
      location: "Barcelona", temperatureC: 18.4, condition: "Parcialmente nublado", updatedAt: 123 });
    expect(execute).toHaveBeenCalledWith("get_weather", { location: "Barcelona" },
      { permissionPolicy: expect.objectContaining({ external_read: true }) });
  });

  it("reduces provider errors and incomplete results to an unavailable state", async () => {
    await expect(getCurrentWeatherStatus("Madrid", async () => { throw new Error("private provider detail"); }, () => 456))
      .resolves.toEqual({ available: false, location: "Madrid", temperatureC: null, condition: null, updatedAt: 456 });
    await expect(getCurrentWeatherStatus("Madrid", async () => ({ success: true, current: { temperatureC: 20 } }), () => 457))
      .resolves.toMatchObject({ available: false, location: "Madrid" });
  });

  it("registers a trusted, validated handler and refuses unsafe city input", async () => {
    const sender = { mainFrame: undefined as unknown, send: vi.fn() }; const frame = {};
    sender.mainFrame = frame;
    const window = { isDestroyed: () => false, webContents: sender };
    const execute = vi.fn(async () => ({ success: true, location: { name: "Barcelona" }, current: { temperatureC: 21, condition: "Despejado" } }));
    registerWeatherIpcHandler(() => window as never, ipc as never, execute, () => 100);
    expect(ipc.removeHandler).toHaveBeenCalledWith(WEATHER_CURRENT_CHANNEL);
    const handler = ipc.handle.mock.calls[0][1] as (event: unknown, payload: unknown) => Promise<unknown>;
    await expect(handler({ sender, senderFrame: frame }, "https://example.com")).rejects.toThrow("invalid_weather_location");
    expect(execute).not.toHaveBeenCalled();
  });
});
