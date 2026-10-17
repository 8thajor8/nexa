import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL, HOME_ASSISTANT_LIGHT_EFFECT_CHANNEL, HOME_ASSISTANT_LIGHTS_STATE_CHANNEL,
  HOME_ASSISTANT_SPEED_CONTROL_CHANNEL, type HomeAssistantAdminError, type HomeAssistantUiLight,
  type HomeAssistantEffectSpeedState } from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import { isHomeAssistantLightControlInput, isHomeAssistantLightEffectInput, isHomeAssistantEffectSpeedInput } from "../shared/home-assistant-ui-validation.js";

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
interface IpcMainLike { handle(channel: string, listener: IpcHandler): void; removeHandler(channel: string): void; }
interface Client {
  listAuthorizedLights(): Promise<readonly Record<string, unknown>[]>;
  controlLight(input: { entityId: string; action: "turn_on" | "turn_off"; brightnessPct?: number | null;
    rgbColor?: [number, number, number] | null }): Promise<{ success: boolean; outcome: string; state?: Record<string, unknown> | null }>;
  applyLightEffect(input: { entityId: string; effect: string }): Promise<{ success: boolean; outcome: string;
    state?: Record<string, unknown> | null }>;
}
const SAFE_ERRORS = new Set<HomeAssistantAdminError>([
  "home_assistant_not_configured", "home_assistant_configuration_invalid", "home_assistant_timeout",
  "home_assistant_unavailable", "home_assistant_unauthorized", "home_assistant_forbidden",
  "home_assistant_effect_not_supported",
  "home_assistant_speed_not_linked", "home_assistant_speed_link_stale", "home_assistant_speed_unavailable",
  "home_assistant_speed_value_invalid",
  "home_assistant_request_rejected", "home_assistant_request_failed", "home_assistant_response_invalid",
  "home_assistant_light_not_authorized", "home_assistant_device_store_invalid",
  "home_assistant_device_store_io_error", "home_assistant_legacy_configuration_invalid",
]);
function mapError(error: unknown): HomeAssistantAdminError {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_ERRORS.has(code as HomeAssistantAdminError)
    ? code as HomeAssistantAdminError : "home_assistant_request_failed";
}
function toUiLight(value: Record<string, unknown>, speed?: HomeAssistantEffectSpeedState): HomeAssistantUiLight {
  const rgb = value.rgbColor;
  return {
    entityId: value.entityId as string, name: typeof value.name === "string" ? value.name : value.entityId as string,
    area: typeof value.area === "string" ? value.area : null,
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((entry): entry is string => typeof entry === "string") : [],
    state: value.state as HomeAssistantUiLight["state"], available: value.available === true,
    brightnessPct: Number.isInteger(value.brightness) ? Math.round(Number(value.brightness) * 100 / 255) : null,
    rgbColor: Array.isArray(rgb) && rgb.length === 3 ? rgb as [number, number, number] : null,
    rgbwColor: Array.isArray(value.rgbwColor) && value.rgbwColor.length === 4
      ? value.rgbwColor as [number, number, number, number] : null,
    colorTemperatureKelvin: Number.isInteger(value.colorTemperatureKelvin) ? value.colorTemperatureKelvin as number : null,
    effect: typeof value.effect === "string" ? value.effect : null,
    effectList: Array.isArray(value.effectList) ? value.effectList.filter((entry): entry is string => typeof entry === "string") : [],
    capabilities: { brightness: value.supportsBrightness === true, color: value.supportsColor === true },
    ...(speed ? { effectSpeed: speed } : {}),
  };
}
interface EffectSpeedClient {
  getAuthorizedEffectSpeeds(): Promise<readonly HomeAssistantEffectSpeedState[]>;
  setEffectSpeed(input: { lightEntityId: string; value: number }): Promise<{ outcome: "confirmed" | "accepted_not_confirmed"; state: HomeAssistantEffectSpeedState | null }>;
}
export function registerHomeAssistantControlIpcHandlers(getWindow: () => BrowserWindow | null, client: Client,
  ipc: IpcMainLike = ipcMain, speedClient?: EffectSpeedClient): void {
  ipc.removeHandler(HOME_ASSISTANT_LIGHTS_STATE_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHT_EFFECT_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_SPEED_CONTROL_CHANNEL);
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    return Boolean(window && isTrustedIpcSender(event as never, window as never));
  };
  ipc.handle(HOME_ASSISTANT_LIGHTS_STATE_CHANNEL, async (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 0) throw new Error("invalid_home_assistant_request");
    try {
      const lights = await client.listAuthorizedLights();
      let speeds: readonly HomeAssistantEffectSpeedState[] = [];
      if (speedClient) {
        try { speeds = await speedClient.getAuthorizedEffectSpeeds(); }
        catch { /* Optional speed discovery must not hide authorized light state. */ }
      }
      const byLight = new Map(speeds.map(speed => [speed.lightEntityId, speed]));
      return { ok: true, value: { lights: lights.map(light => toUiLight(light, byLight.get(String(light.entityId)))) } };
    } catch (error) { return { ok: false, error: mapError(error) }; }
  });
  ipc.handle(HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL, async (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantLightControlInput(args[0]))
      throw new Error("invalid_home_assistant_request");
    const input = args[0];
    try {
      const result = await client.controlLight({ entityId: input.entityId, action: input.action,
        brightnessPct: input.brightnessPct ?? null, rgbColor: input.rgbColor ?? null });
      const light = result.state ? toUiLight(result.state) : null;
      return { ok: true, value: { outcome: result.outcome === "confirmed" ? "confirmed"
        : result.outcome === "device_unavailable" ? "device_unavailable" : "accepted_not_confirmed", light } };
    } catch (error) { return { ok: false, error: mapError(error) }; }
  });
  ipc.handle(HOME_ASSISTANT_LIGHT_EFFECT_CHANNEL, async (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantLightEffectInput(args[0]))
      throw new Error("invalid_home_assistant_request");
    try {
      const result = await client.applyLightEffect(args[0]);
      const light = result.state ? toUiLight(result.state) : null;
      return { ok: true, value: { outcome: result.outcome === "confirmed" ? "confirmed"
        : result.outcome === "device_unavailable" ? "device_unavailable" : "accepted_not_confirmed", light } };
    } catch (error) { return { ok: false, error: mapError(error) }; }
  });
  ipc.handle(HOME_ASSISTANT_SPEED_CONTROL_CHANNEL, async (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantEffectSpeedInput(args[0])) throw new Error("invalid_home_assistant_request");
    if (!speedClient) return { ok: false, error: "home_assistant_request_failed" };
    try {
      const result = await speedClient.setEffectSpeed(args[0]);
      return { ok: true, value: { outcome: result.outcome, state: result.state } };
    } catch (error) { return { ok: false, error: mapError(error) }; }
  });
}
export function removeHomeAssistantControlIpcHandlers(ipc: IpcMainLike = ipcMain): void {
  ipc.removeHandler(HOME_ASSISTANT_LIGHTS_STATE_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHT_EFFECT_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_SPEED_CONTROL_CHANNEL);
}
