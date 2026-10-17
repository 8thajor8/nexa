import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHomeAssistantDeviceAdmin, type HomeAssistantDiscoveredLight } from "../src/main/home-assistant-device-admin.js";
import { createHomeAssistantLightsStore } from "../src/main/home-assistant-lights-store.js";

const directories: string[] = [];
async function createFixture(initial: { entityId: string; name?: string; area?: string; aliases?: string[] }[] = [],
  discovered: HomeAssistantDiscoveredLight[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "nexa-ha-admin-"));
  directories.push(directory);
  const store = createHomeAssistantLightsStore(directory, { environment: {} });
  expect(store.read()).toMatchObject({ ok: true });
  if (initial.length) expect(store.write(initial)).toMatchObject({ ok: true });
  const discoveryClient = { discoverLights: async () => discovered };
  return { directory, store, admin: createHomeAssistantDeviceAdmin({ store, discoveryClient }), discoveryClient };
}
const light = (entityId: string, name = entityId): HomeAssistantDiscoveredLight => ({ entityId, name, state: "off",
  available: true, capabilities: { brightness: true, color: false }, alreadyAuthorized: false });

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("Home Assistant device administration", () => {
  it("discovers only candidate lights and does not authorize them", async () => {
    const { admin, store } = await createFixture([], [light("light.office", "Office")]);
    expect(await admin.discoverLights()).toEqual({ ok: true, value: [{ ...light("light.office", "Office"), alreadyAuthorized: false }] });
    expect(store.read()).toMatchObject({ ok: true, authorizedLights: [] });
  });

  it("authorizes only an entity returned by live discovery and persists through restart", async () => {
    const { directory, admin, store, discoveryClient } = await createFixture([], [light("light.office", "Office")]);
    expect(await admin.authorizeLight({ entityId: "light.unknown" })).toEqual({ ok: false, error: "home_assistant_light_not_discovered" });
    expect(store.read()).toMatchObject({ ok: true, authorizedLights: [] });
    expect(await admin.authorizeLight({ entityId: "light.office", name: "Desk", area: "Study", aliases: ["Lamp"] }))
      .toEqual({ ok: true, value: { authorizedLights: [{ entityId: "light.office", name: "Desk", area: "Study", aliases: ["Lamp"] }], changed: true } });
    const repeated = await admin.authorizeLight({ entityId: "light.office" });
    expect(repeated).toMatchObject({ ok: true, value: { changed: false } });
    const reopened = createHomeAssistantLightsStore(directory, { environment: {} });
    expect(reopened.read()).toMatchObject({ ok: true, source: "store", authorizedLights: [{ entityId: "light.office" }] });

    discoveryClient.discoverLights = async () => [];
    expect(await admin.discoverLights()).toEqual({ ok: true, value: [] });
    expect(reopened.read()).toMatchObject({ ok: true, authorizedLights: [{ entityId: "light.office" }] });
  });

  it("updates and clears metadata, rejects malformed values, and removes only authorized lights", async () => {
    const { admin, store } = await createFixture([{ entityId: "light.office", name: "Office" }], [light("light.office")]);
    expect(await admin.updateLightMetadata({ entityId: "light.office", area: "Office", aliases: ["Work lamp"] }))
      .toEqual({ ok: true, value: { authorizedLights: [{ entityId: "light.office", name: "Office", area: "Office", aliases: ["Work lamp"] }] } });
    expect(await admin.updateLightMetadata({ entityId: "light.office", name: null, area: null, aliases: [] }))
      .toEqual({ ok: true, value: { authorizedLights: [{ entityId: "light.office", aliases: [] }] } });
    expect(await admin.updateLightMetadata({ entityId: "light.office", name: "x".repeat(121) }))
      .toEqual({ ok: false, error: "home_assistant_device_store_invalid" });
    expect(await admin.updateLightMetadata({ entityId: "light.missing", name: "Missing" }))
      .toEqual({ ok: false, error: "home_assistant_light_not_authorized" });
    expect(await admin.removeAuthorizedLight({ entityId: "light.office" }))
      .toEqual({ ok: true, value: { authorizedLights: [] } });
    expect(await admin.removeAuthorizedLight({ entityId: "light.office" }))
      .toEqual({ ok: false, error: "home_assistant_light_not_authorized" });
    expect(store.read()).toMatchObject({ ok: true, authorizedLights: [] });
  });

  it("enforces the 32-light limit and serializes concurrent additions without losing updates", async () => {
    const discovered = Array.from({ length: 33 }, (_, index) => light(`light.room_${index}`));
    const { admin } = await createFixture(Array.from({ length: 31 }, (_, index) => ({ entityId: `light.room_${index}` })), discovered);
    const results = await Promise.all([
      admin.authorizeLight({ entityId: "light.room_31" }),
      admin.authorizeLight({ entityId: "light.room_32" }),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
  });

  it("rejects unknown properties and non-light IDs at the administration boundary", async () => {
    const { admin } = await createFixture([], [light("light.office")]);
    expect(await admin.authorizeLight({ entityId: "switch.office" })).toEqual({ ok: false, error: "invalid_request" });
    expect(await admin.authorizeLight({ entityId: "light.office", service: "light.turn_on" }))
      .toEqual({ ok: false, error: "invalid_request" });
  });

  it("requires explicit confirmation to link a verified speed control and supports unlinking", async () => {
    const { store } = await createFixture([{ entityId: "light.office" }], [light("light.office")]);
    let associationValid = true;
    const speedClient = {
      discoverEffectSpeedCandidates: async (lightEntityId: string) => [{ entityId: "number.office_effect_speed",
        name: "Effect speed", available: true, sameDeviceVerified: true as const }],
      associationIsCurrent: async (_light: { entityId: string }, entityId: string) => associationValid && entityId === "number.office_effect_speed",
    };
    const admin = createHomeAssistantDeviceAdmin({ store, discoveryClient: { discoverLights: async () => [light("light.office")] }, speedClient });

    const candidates = await admin.discoverEffectSpeedCandidates({ lightEntityId: "light.office" });
    expect(candidates).toMatchObject({ ok: true, value: { candidates: [{ sameDeviceVerified: true }] } });
    expect(store.read()).toMatchObject({ ok: true, authorizedLights: [{ entityId: "light.office" }] });

    associationValid = false;
    expect(await admin.linkEffectSpeed({ lightEntityId: "light.office", entityId: "number.office_effect_speed" }))
      .toEqual({ ok: false, error: "home_assistant_speed_link_stale" });
    expect(store.read()).toMatchObject({ ok: true, authorizedLights: [{ entityId: "light.office" }] });

    associationValid = true;
    expect(await admin.linkEffectSpeed({ lightEntityId: "light.office", entityId: "number.office_effect_speed" }))
      .toMatchObject({ ok: true, value: { authorizedLights: [{ entityId: "light.office", effectSpeedEntityId: "number.office_effect_speed" }] } });
    expect(await admin.unlinkEffectSpeed({ lightEntityId: "light.office" }))
      .toMatchObject({ ok: true, value: { authorizedLights: [{ entityId: "light.office" }] } });
  });
});
