import { describe, expect, it, vi } from "vitest";
import { registerHomeAssistantControlIpcHandlers, removeHomeAssistantControlIpcHandlers } from "../src/main/home-assistant-control-ipc.js";
import { HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL, HOME_ASSISTANT_LIGHT_EFFECT_CHANNEL, HOME_ASSISTANT_LIGHTS_STATE_CHANNEL,
  HOME_ASSISTANT_SPEED_CONTROL_CHANNEL } from "../src/shared/ipc-contract.js";

type Handler = (...args: unknown[]) => unknown;
const state = { entityId: "light.office", name: "Office", friendlyName: "Office bulb", area: "Study", aliases: ["Desk"],
  state: "on", available: true, brightness: 128, rgbColor: [20, 40, 60], rgbwColor: null,
  colorTemperatureKelvin: null, effect: null, effectList: ["Ocean"], supportsBrightness: true, supportsColor: true };
function setup() {
  const handlers = new Map<string, Handler>();
  const calls: unknown[] = [];
  const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => { handlers.delete(channel); } };
  const frame = {};
  const sender = { mainFrame: frame };
  const window = { webContents: sender };
  const client = {
    listAuthorizedLights: async () => [state],
    controlLight: async (input: unknown) => { calls.push(input); return { success: true, outcome: "confirmed", state }; },
    applyLightEffect: async (input: unknown) => { calls.push(input); return { success: true, outcome: "confirmed", state: { ...state, effect: "Ocean" } }; },
  };
  registerHomeAssistantControlIpcHandlers(() => window as never, client as never, ipc as never);
  return { handlers, calls, frame, sender, window, ipc, client };
}
const trusted = (sender: object, frame: object) => ({ sender, senderFrame: frame });

describe("Home Assistant UI control IPC", () => {
  it("lists Main-projected state for authorized lights without connection configuration", async () => {
    const { handlers, sender, frame } = setup();
    expect(await handlers.get(HOME_ASSISTANT_LIGHTS_STATE_CHANNEL)!(trusted(sender, frame))).toEqual({
      ok: true, value: { lights: [{ entityId: "light.office", name: "Office", area: "Study", aliases: ["Desk"], state: "on",
        available: true, brightnessPct: 50, rgbColor: [20, 40, 60], rgbwColor: null, colorTemperatureKelvin: null,
        effect: null, effectList: ["Ocean"], capabilities: { brightness: true, color: true } }] },
    });
  });

  it("keeps authorized light state available when optional speed-state loading fails", async () => {
    const { handlers, sender, frame, window, ipc, client } = setup();
    registerHomeAssistantControlIpcHandlers(() => window as never, client as never, ipc as never, {
      getAuthorizedEffectSpeeds: async () => { throw Object.assign(new Error("synthetic websocket failure"),
        { code: "home_assistant_unavailable" }); },
      setEffectSpeed: vi.fn(),
    });

    await expect(handlers.get(HOME_ASSISTANT_LIGHTS_STATE_CHANNEL)!(trusted(sender, frame))).resolves.toEqual({
      ok: true, value: { lights: [{ entityId: "light.office", name: "Office", area: "Study", aliases: ["Desk"], state: "on",
        available: true, brightnessPct: 50, rgbColor: [20, 40, 60], rgbwColor: null, colorTemperatureKelvin: null,
        effect: null, effectList: ["Ocean"], capabilities: { brightness: true, color: true } }] },
    });
  });

  it("routes one entity and returns the existing client's confirmation", async () => {
    const { handlers, sender, frame, calls } = setup();
    const input = { entityId: "light.office", action: "turn_on", brightnessPct: 50, rgbColor: [20, 40, 60] };
    await expect(handlers.get(HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL)!(trusted(sender, frame), input)).resolves.toMatchObject({
      ok: true, value: { outcome: "confirmed", light: { entityId: "light.office", state: "on" } },
    });
    expect(calls).toEqual([input]);
  });

  it("routes only a validated effect name to the Main client and returns confirmed state", async () => {
    const { handlers, sender, frame, calls } = setup();
    const effect = handlers.get(HOME_ASSISTANT_LIGHT_EFFECT_CHANNEL)!;
    await expect(effect(trusted(sender, frame), { entityId: "light.office", effect: "Ocean" })).resolves.toMatchObject({
      ok: true, value: { outcome: "confirmed", light: { entityId: "light.office", effect: "Ocean" } },
    });
    await expect(effect(trusted(sender, frame), { entityId: "light.office", effect: "turn_off", service: "light.turn_off" }))
      .rejects.toThrow("invalid_home_assistant_request");
    expect(calls).toEqual([{ entityId: "light.office", effect: "Ocean" }]);
  });

  it("fails closed for untrusted senders and malformed, arbitrary, or multi-entity requests", async () => {
    const { handlers, sender, frame, calls } = setup();
    const control = handlers.get(HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL)!;
    await expect(control(trusted({}, frame), { entityId: "light.office", action: "turn_off" })).rejects.toThrow("untrusted_ipc_sender");
    await expect(control(trusted(sender, frame), { entityId: "light.office", action: "turn_off", service: "light.turn_on" }))
      .rejects.toThrow("invalid_home_assistant_request");
    await expect(control(trusted(sender, frame), { entityId: "light.unauthorized", action: "turn_on", brightnessPct: 101 }))
      .rejects.toThrow("invalid_home_assistant_request");
    await expect(control(trusted(sender, frame), [{ entityId: "light.office", action: "turn_off" }]))
      .rejects.toThrow("invalid_home_assistant_request");
    expect(calls).toEqual([]);
  });

  it("maps failures to safe categories and removes handlers on shutdown", async () => {
    const { handlers, sender, frame, window, ipc } = setup();
    const client = {
      listAuthorizedLights: async () => { throw Object.assign(new Error("secret token text"), { code: "home_assistant_unavailable" }); },
      controlLight: async () => { throw Object.assign(new Error("secret"), { code: "home_assistant_light_not_authorized" }); },
    };
    registerHomeAssistantControlIpcHandlers(() => window as never, client as never, ipc as never);
    expect(await handlers.get(HOME_ASSISTANT_LIGHTS_STATE_CHANNEL)!(trusted(sender, frame))).toEqual({
      ok: false, error: "home_assistant_unavailable",
    });
    await expect(handlers.get(HOME_ASSISTANT_LIGHT_CONTROL_CHANNEL)!(trusted(sender, frame),
      { entityId: "light.office", action: "turn_on" })).resolves.toEqual({
      ok: false, error: "home_assistant_light_not_authorized",
    });
    removeHomeAssistantControlIpcHandlers(ipc as never);
    expect(handlers.size).toBe(0);
  });

  it("routes only a light ID and finite value to the main-only speed client", async () => {
    const { handlers, sender, frame, window, ipc, client } = setup();
    const setEffectSpeed = vi.fn().mockResolvedValue({ outcome: "confirmed", state: null });
    registerHomeAssistantControlIpcHandlers(() => window as never, client as never, ipc as never, {
      getAuthorizedEffectSpeeds: async () => [], setEffectSpeed,
    });
    const handler = handlers.get(HOME_ASSISTANT_SPEED_CONTROL_CHANNEL)!;
    await expect(handler(trusted(sender, frame), { lightEntityId: "light.office", value: 45 })).resolves.toEqual({
      ok: true, value: { outcome: "confirmed", state: null },
    });
    expect(setEffectSpeed).toHaveBeenCalledWith({ lightEntityId: "light.office", value: 45 });
    await expect(handler(trusted(sender, frame), { lightEntityId: "light.office", value: "45" }))
      .rejects.toThrow("invalid_home_assistant_request");
    await expect(handler(trusted(sender, frame), { lightEntityId: "light.office", entityId: "number.arbitrary", value: 45 }))
      .rejects.toThrow("invalid_home_assistant_request");
    await expect(handler(trusted({}, frame), { lightEntityId: "light.office", value: 45 }))
      .rejects.toThrow("untrusted_ipc_sender");
    expect(setEffectSpeed).toHaveBeenCalledOnce();
  });
});
