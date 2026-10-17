import { describe, expect, it } from "vitest";
import { registerHomeAssistantIpcHandlers, removeHomeAssistantIpcHandlers } from "../src/main/home-assistant-ipc.js";
import {
  HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL, HOME_ASSISTANT_LIGHT_METADATA_UPDATE_CHANNEL,
  HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL, HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL, HOME_ASSISTANT_LIGHTS_LIST_CHANNEL,
  HOME_ASSISTANT_SPEED_CANDIDATES_CHANNEL, HOME_ASSISTANT_SPEED_LINK_CHANNEL, HOME_ASSISTANT_SPEED_UNLINK_CHANNEL,
} from "../src/shared/ipc-contract.js";

type Handler = (...args: unknown[]) => unknown;
function setup() {
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const ipc = { handle: (channel: string, listener: Handler) => handlers.set(channel, listener),
    removeHandler: (channel: string) => { handlers.delete(channel); removed.push(channel); } };
  const mainFrame = {};
  const webContents = { mainFrame };
  const window = { webContents };
  const calls: unknown[][] = [];
  const admin = {
    listAuthorizedLights: () => ({ ok: true as const, value: [{ entityId: "light.office" }] }),
    discoverLights: async () => ({ ok: true as const, value: [{ entityId: "light.office" }] }),
    authorizeLight: async (input: unknown) => { calls.push(["authorize", input]); return { ok: true, value: { authorizedLights: [], changed: true } }; },
    updateLightMetadata: async (input: unknown) => { calls.push(["update", input]); return { ok: true, value: { authorizedLights: [] } }; },
    removeAuthorizedLight: async (input: unknown) => { calls.push(["remove", input]); return { ok: true, value: { authorizedLights: [] } }; },
    discoverEffectSpeedCandidates: async (input: unknown) => { calls.push(["speed-candidates", input]); return { ok: true, value: { lightEntityId: "light.office", candidates: [] } }; },
    linkEffectSpeed: async (input: unknown) => { calls.push(["speed-link", input]); return { ok: true, value: { authorizedLights: [] } }; },
    unlinkEffectSpeed: async (input: unknown) => { calls.push(["speed-unlink", input]); return { ok: true, value: { authorizedLights: [] } }; },
  };
  registerHomeAssistantIpcHandlers(() => window as never, admin, ipc as never);
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  const untrustedEvent = { sender: {}, senderFrame: mainFrame };
  return { handlers, removed, window, calls, trustedEvent, untrustedEvent, ipc };
}

describe("Home Assistant administration IPC", () => {
  it("registers named administration operations and returns typed operation results", async () => {
    const { handlers, trustedEvent } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL, HOME_ASSISTANT_LIGHT_METADATA_UPDATE_CHANNEL,
      HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL, HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL, HOME_ASSISTANT_LIGHTS_LIST_CHANNEL,
      HOME_ASSISTANT_SPEED_CANDIDATES_CHANNEL, HOME_ASSISTANT_SPEED_LINK_CHANNEL, HOME_ASSISTANT_SPEED_UNLINK_CHANNEL,
    ].sort());
    expect(await handlers.get(HOME_ASSISTANT_LIGHTS_LIST_CHANNEL)!(trustedEvent)).toEqual({
      ok: true, value: { authorizedLights: [{ entityId: "light.office" }] },
    });
    expect(await handlers.get(HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL)!(trustedEvent)).toEqual({
      ok: true, value: { lights: [{ entityId: "light.office" }] },
    });
    expect(await handlers.get(HOME_ASSISTANT_SPEED_CANDIDATES_CHANNEL)!(trustedEvent, { lightEntityId: "light.office" }))
      .toEqual({ ok: true, value: { lightEntityId: "light.office", candidates: [] } });
  });

  it("rejects untrusted senders and malformed/admin-injected arguments before service calls", async () => {
    const { handlers, trustedEvent, untrustedEvent, calls } = setup();
    expect(() => handlers.get(HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL)!(untrustedEvent, { entityId: "light.office" }))
      .toThrow("untrusted_ipc_sender");
    expect(() => handlers.get(HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL)!(trustedEvent,
      { entityId: "light.office", service: "light.turn_on" })).toThrow("invalid_home_assistant_request");
    await expect(handlers.get(HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL)!(trustedEvent, "unexpected"))
      .rejects.toThrow("invalid_home_assistant_request");
    expect(calls).toEqual([]);
  });

  it("validates and routes explicit authorization, metadata update and removal calls", async () => {
    const { handlers, trustedEvent, calls } = setup();
    await handlers.get(HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL)!(trustedEvent, { entityId: "light.office", name: "Office" });
    await handlers.get(HOME_ASSISTANT_LIGHT_METADATA_UPDATE_CHANNEL)!(trustedEvent, { entityId: "light.office", aliases: [] });
    await handlers.get(HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL)!(trustedEvent, { entityId: "light.office" });
    expect(calls.map(([operation]) => operation)).toEqual(["authorize", "update", "remove"]);
    expect(() => handlers.get(HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL)!(trustedEvent,
      { entityId: "light.office", extra: true })).toThrow("invalid_home_assistant_request");
  });

  it("removes all channel handlers during shutdown", () => {
    const { handlers, ipc } = setup();
    removeHomeAssistantIpcHandlers(ipc as never);
    expect(handlers.size).toBe(0);
  });
});
