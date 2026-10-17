import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHomeAssistantLightsStore } from "../src/main/home-assistant-lights-store.js";

const directories: string[] = [];
async function makeStore(environment: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nexa-ha-lights-"));
  directories.push(directory);
  return { directory, store: createHomeAssistantLightsStore(directory, { environment }) };
}
const storePath = (directory: string) => join(directory, "home-assistant-lights.json");

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("Home Assistant authorized lights store", () => {
  it("creates a versioned empty store when no legacy allowlist exists", async () => {
    const { directory, store } = await makeStore();
    expect(store.read()).toEqual({ ok: true, version: 1, authorizedLights: [], source: "migrated" });
    expect(JSON.parse(await readFile(storePath(directory), "utf8")))
      .toEqual({ version: 1, authorizedLights: [] });
  });

  it("migrates one and multiple legacy allowlisted lights and preserves valid metadata", async () => {
    const environment = {
      NEXA_HOME_ASSISTANT_LIGHTS: "light.office, light.kitchen",
      NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([
        { entityId: "light.office", name: "Luz de escritorio", area: "Escritorio", aliases: ["lámpara de trabajo"] },
      ]),
      NEXA_HOME_ASSISTANT_URL: "http://ha.example:8123",
      NEXA_HOME_ASSISTANT_TOKEN: "synthetic-secret-token",
    };
    const { directory, store } = await makeStore(environment);
    const result = store.read();
    expect(result).toEqual({ ok: true, version: 1, source: "migrated", authorizedLights: [
      { entityId: "light.office", name: "Luz de escritorio", area: "Escritorio", aliases: ["lámpara de trabajo"] },
      { entityId: "light.kitchen" },
    ] });
    const contents = await readFile(storePath(directory), "utf8");
    expect(contents).not.toContain("synthetic-secret-token");
    expect(contents).not.toContain("ha.example");

    const single = await makeStore({ NEXA_HOME_ASSISTANT_LIGHTS: "light.office" });
    expect(single.store.read()).toMatchObject({ ok: true, authorizedLights: [{ entityId: "light.office" }] });
  });

  it("persists an explicitly linked effect-speed entity and preserves compatibility with unlinked lights", async () => {
    const { directory, store } = await makeStore();
    const result = store.write([
      { entityId: "light.office", name: "Office", effectSpeedEntityId: "number.office_effect_speed" },
      { entityId: "light.kitchen", area: "Kitchen" },
    ]);
    expect(result).toMatchObject({ ok: true, authorizedLights: [
      { entityId: "light.office", effectSpeedEntityId: "number.office_effect_speed" },
      { entityId: "light.kitchen" },
    ] });
    expect(JSON.parse(await readFile(storePath(directory), "utf8"))).toEqual({ version: 1, authorizedLights: [
      { entityId: "light.office", name: "Office", effectSpeedEntityId: "number.office_effect_speed" },
      { entityId: "light.kitchen", area: "Kitchen" },
    ] });
    const reopened = createHomeAssistantLightsStore(directory, { environment: {} }).read();
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.authorizedLights[0].effectSpeedEntityId).toBe("number.office_effect_speed");
  });

  it("rejects invalid or duplicate speed associations and does not import one from legacy metadata", async () => {
    const { directory, store } = await makeStore();
    for (const lights of [
      [{ entityId: "light.office", effectSpeedEntityId: "switch.office" }],
      [{ entityId: "light.office", effectSpeedEntityId: "number.office" },
        { entityId: "light.kitchen", effectSpeedEntityId: "number.office" }],
    ]) expect(store.write(lights)).toEqual({ ok: false, error: "home_assistant_device_store_invalid" });
    const legacy = await makeStore({ NEXA_HOME_ASSISTANT_LIGHTS: "light.office",
      NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([{ entityId: "light.office", effectSpeedEntityId: "number.office" }]) });
    expect(legacy.store.read()).toEqual({ ok: false, error: "home_assistant_legacy_configuration_invalid" });
    await expect(readFile(storePath(legacy.directory), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not re-import environment changes after the persistent store exists", async () => {
    const { directory, store } = await makeStore({ NEXA_HOME_ASSISTANT_LIGHTS: "light.office" });
    expect(store.read()).toMatchObject({ source: "migrated", authorizedLights: [{ entityId: "light.office" }] });
    const written = store.write([{ entityId: "light.kitchen" }]);
    expect(written).toMatchObject({ ok: true, authorizedLights: [{ entityId: "light.kitchen" }] });
    expect(createHomeAssistantLightsStore(directory, { environment: { NEXA_HOME_ASSISTANT_LIGHTS: "light.office" } }).read())
      .toMatchObject({ source: "store", authorizedLights: [{ entityId: "light.kitchen" }] });
  });

  it("fails closed for an invalid store without replacing it or re-importing legacy settings", async () => {
    const { directory, store } = await makeStore({ NEXA_HOME_ASSISTANT_LIGHTS: "light.office" });
    const original = "{not valid json";
    await writeFile(storePath(directory), original);
    expect(store.read()).toEqual({ ok: false, error: "home_assistant_device_store_invalid" });
    expect(store.write([{ entityId: "light.kitchen" }])).toEqual({ ok: false, error: "home_assistant_device_store_invalid" });
    expect(await readFile(storePath(directory), "utf8")).toBe(original);
  });

  it("rejects invalid, duplicate, oversized, or malformed legacy allowlists without creating a store", async () => {
    const invalidConfigurations: Record<string, unknown>[] = [
      { NEXA_HOME_ASSISTANT_LIGHTS: "switch.office" },
      { NEXA_HOME_ASSISTANT_LIGHTS: "light.office,light.office" },
      { NEXA_HOME_ASSISTANT_LIGHTS: Array.from({ length: 33 }, (_, index) => `light.room_${index}`).join(",") },
      { NEXA_HOME_ASSISTANT_LIGHTS: "light.office", NEXA_HOME_ASSISTANT_LIGHT_METADATA: "{" },
      { NEXA_HOME_ASSISTANT_LIGHTS: "light.office", NEXA_HOME_ASSISTANT_LIGHT_METADATA:
        JSON.stringify([{ entityId: "light.kitchen", name: "Fuera de allowlist" }]) },
    ];
    for (const environment of invalidConfigurations) {
      const { directory, store } = await makeStore(environment);
      expect(store.read()).toEqual({ ok: false, error: "home_assistant_legacy_configuration_invalid" });
      await expect(readFile(storePath(directory), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("validates IDs, uniqueness, metadata lengths and the 32-light bound on writes", async () => {
    const { store } = await makeStore();
    const invalidWrites = [
      [{ entityId: "switch.office" }],
      [{ entityId: "light.office" }, { entityId: "light.office" }],
      [{ entityId: "light.office", name: "x".repeat(121) }],
      [{ entityId: "light.office", area: "x".repeat(81) }],
      [{ entityId: "light.office", aliases: ["x".repeat(81)] }],
      [{ entityId: "light.office", aliases: Array.from({ length: 17 }, (_, index) => `alias ${index}`) }],
      Array.from({ length: 33 }, (_, index) => ({ entityId: `light.room_${index}` })),
    ];
    for (const invalid of invalidWrites) {
      expect(store.write(invalid)).toEqual({ ok: false, error: "home_assistant_device_store_invalid" });
    }
    const allowed = store.write(Array.from({ length: 32 }, (_, index) => ({ entityId: `light.room_${index}` })));
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.authorizedLights).toHaveLength(32);
  });

  it("persists atomically across instances and uses restricted file mode where supported", async () => {
    const { directory, store } = await makeStore();
    expect(store.read()).toMatchObject({ ok: true });
    expect(store.write([{ entityId: "light.office", name: "Office" }])).toMatchObject({ ok: true });
    const reopened = createHomeAssistantLightsStore(directory);
    expect(reopened.read()).toMatchObject({ ok: true, source: "store", authorizedLights: [{ entityId: "light.office", name: "Office" }] });
    expect((await readdir(directory)).sort()).toEqual(["home-assistant-lights.json"]);
    const fileMode = (await stat(storePath(directory))).mode & 0o777;
    if (process.platform !== "win32") expect(fileMode).toBe(0o600);
  });
});
