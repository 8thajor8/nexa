import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
// @ts-expect-error The shared JavaScript Runtime intentionally has no generated declaration file.
import { executeTool } from "../../../../src/tools/index.js";
// @ts-expect-error The shared JavaScript Runtime intentionally has no generated declaration file.
import { defaultPermissionPolicy } from "../../../../src/tools/permissions.js";
import { WEATHER_CURRENT_CHANNEL, type WeatherCurrentStatus } from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import { isWeatherLocation, isWeatherCurrentStatus } from "../shared/weather-ipc-validation.js";

type WeatherToolResult = {
  success?: boolean;
  location?: { name?: unknown };
  current?: { temperatureC?: unknown; condition?: unknown };
};
type ToolExecutor = (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => Promise<WeatherToolResult>;
type WindowLike = BrowserWindow & { webContents: BrowserWindow["webContents"] };
interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, payload?: unknown) => unknown): void;
  removeHandler(channel: string): void;
}

export async function getCurrentWeatherStatus(
  location: string,
  execute: ToolExecutor = executeTool as ToolExecutor,
  now: () => number = Date.now,
): Promise<WeatherCurrentStatus> {
  const requestedLocation = location.trim();
  try {
    const result = await execute("get_weather", { location: requestedLocation }, { permissionPolicy: defaultPermissionPolicy });
    const name = typeof result.location?.name === "string" && result.location.name.trim()
      ? result.location.name.trim().slice(0, 100) : requestedLocation;
    const temperature = result.current?.temperatureC;
    const condition = result.current?.condition;
    if (result.success === true && typeof temperature === "number" && Number.isFinite(temperature)
      && temperature >= -100 && temperature <= 100 && typeof condition === "string" && condition.trim().length > 0) {
      const status = { available: true, location: name, temperatureC: temperature, condition: condition.trim().slice(0, 80), updatedAt: now() };
      if (isWeatherCurrentStatus(status)) return status;
    }
  } catch { /* Provider errors are deliberately reduced to a non-sensitive availability state. */ }
  return { available: false, location: requestedLocation.slice(0, 100), temperatureC: null, condition: null, updatedAt: now() };
}

function trusted(event: IpcMainInvokeEvent, window: WindowLike | null): boolean {
  return Boolean(window && isTrustedIpcSender(event as never, window as never));
}

export function registerWeatherIpcHandler(
  getWindow: () => BrowserWindow | null,
  ipc: IpcMainLike = ipcMain,
  execute?: ToolExecutor,
  now: () => number = Date.now,
): void {
  ipc.removeHandler(WEATHER_CURRENT_CHANNEL);
  ipc.handle(WEATHER_CURRENT_CHANNEL, async (event, payload) => {
    const window = getWindow() as WindowLike | null;
    if (!trusted(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isWeatherLocation(payload)) throw new Error("invalid_weather_location");
    return getCurrentWeatherStatus(payload.trim(), execute, now);
  });
}

export function removeWeatherIpcHandler(ipc: IpcMainLike = ipcMain): void {
  ipc.removeHandler(WEATHER_CURRENT_CHANNEL);
}
