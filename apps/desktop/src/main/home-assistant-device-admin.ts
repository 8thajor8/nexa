import type { HomeAssistantAdminError } from "../shared/ipc-contract.js";
import type { AuthorizedHomeAssistantLight, HomeAssistantLightsStoreRead } from "./home-assistant-lights-store.js";

// @ts-expect-error The shared Home Assistant client is JavaScript and intentionally has no declaration file.
import { createHomeAssistantDiscoveryClient } from "../../../../src/integrations/home-assistant/client.js";

const ENTITY_ID_PATTERN = /^light\.[a-z0-9_]+$/u;
const SAFE_HOME_ASSISTANT_ERRORS = new Set<HomeAssistantAdminError>([
  "home_assistant_not_configured", "home_assistant_configuration_invalid", "home_assistant_timeout",
  "home_assistant_unavailable", "home_assistant_unauthorized", "home_assistant_forbidden",
  "home_assistant_speed_link_stale", "home_assistant_speed_not_linked", "home_assistant_speed_unavailable",
  "home_assistant_speed_value_invalid",
  "home_assistant_request_rejected", "home_assistant_request_failed", "home_assistant_response_invalid",
]);

export interface HomeAssistantDiscoveredLight {
  entityId: string;
  name: string;
  state: "on" | "off" | "unavailable" | "unknown";
  available: boolean;
  capabilities: { brightness: boolean; color: boolean };
  alreadyAuthorized: boolean;
}

export type HomeAssistantAdminResult<T> = { ok: true; value: T } | { ok: false; error: HomeAssistantAdminError };

interface DeviceStore {
  read(): HomeAssistantLightsStoreRead;
  write(lights: unknown): HomeAssistantLightsStoreRead;
}
interface DiscoveryClient { discoverLights(): Promise<readonly Omit<HomeAssistantDiscoveredLight, "alreadyAuthorized">[]>; }
interface EffectSpeedClient {
  discoverEffectSpeedCandidates(lightEntityId: string): Promise<readonly { entityId: string; name: string; available: boolean; sameDeviceVerified: true }[]>;
  associationIsCurrent(light: AuthorizedHomeAssistantLight, numberId: string): Promise<boolean>;
}

function failure<T = never>(error: HomeAssistantAdminError): HomeAssistantAdminResult<T> { return { ok: false, error }; }
function storedLights(store: DeviceStore): HomeAssistantAdminResult<AuthorizedHomeAssistantLight[]> {
  const result = store.read();
  return result.ok ? { ok: true, value: result.authorizedLights } : failure(result.error);
}
function errorCode(error: unknown): HomeAssistantAdminError {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_HOME_ASSISTANT_ERRORS.has(code as HomeAssistantAdminError)
    ? code as HomeAssistantAdminError : "home_assistant_request_failed";
}
function exactKeys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)));
}
function metadataFields(value: Record<string, unknown>): Omit<AuthorizedHomeAssistantLight, "entityId"> | null {
  const result: Omit<AuthorizedHomeAssistantLight, "entityId"> = {};
  for (const key of ["name", "area"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (item === null) continue;
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases) || value.aliases.some(alias => typeof alias !== "string")) return null;
    result.aliases = value.aliases as string[];
  }
  return result;
}
function normalizeDiscovered(value: unknown, authorizedIds: Set<string>): HomeAssistantDiscoveredLight[] | null {
  if (!Array.isArray(value)) return null;
  const result: HomeAssistantDiscoveredLight[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const light = item as Record<string, unknown>;
    if (typeof light.entityId !== "string" || !ENTITY_ID_PATTERN.test(light.entityId) || seen.has(light.entityId)
      || typeof light.name !== "string" || !light.name.trim() || light.name.trim().length > 120
      || !["on", "off", "unavailable", "unknown"].includes(String(light.state))
      || typeof light.available !== "boolean" || !light.capabilities || typeof light.capabilities !== "object"
      || typeof (light.capabilities as Record<string, unknown>).brightness !== "boolean"
      || typeof (light.capabilities as Record<string, unknown>).color !== "boolean") continue;
    seen.add(light.entityId);
    result.push({ entityId: light.entityId, name: light.name, state: light.state as HomeAssistantDiscoveredLight["state"],
      available: light.available, capabilities: {
        brightness: (light.capabilities as Record<string, boolean>).brightness,
        color: (light.capabilities as Record<string, boolean>).color,
      }, alreadyAuthorized: authorizedIds.has(light.entityId) });
  }
  return result;
}

/** Administrative operations are intentionally separate from Agent tools. */
export function createHomeAssistantDeviceAdmin({ store, discoveryClient = createHomeAssistantDiscoveryClient(), speedClient }:
  { store: DeviceStore; discoveryClient?: DiscoveryClient; speedClient?: EffectSpeedClient }) {
  let mutationQueue: Promise<void> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function discoverLights(): Promise<HomeAssistantAdminResult<HomeAssistantDiscoveredLight[]>> {
    const current = storedLights(store);
    if (!current.ok) return current;
    try {
      const discovered = normalizeDiscovered(await discoveryClient.discoverLights(), new Set(current.value.map(light => light.entityId)));
      return discovered ? { ok: true, value: discovered } : failure("home_assistant_response_invalid");
    } catch (error) { return failure(errorCode(error)); }
  }

  function listAuthorizedLights(): HomeAssistantAdminResult<AuthorizedHomeAssistantLight[]> {
    return storedLights(store);
  }

  function authorizeLight(input: unknown): Promise<HomeAssistantAdminResult<{ authorizedLights: AuthorizedHomeAssistantLight[]; changed: boolean }>> {
    return serialize(async () => {
      if (!exactKeys(input, ["entityId", "name", "area", "aliases"]) || typeof input.entityId !== "string"
        || !ENTITY_ID_PATTERN.test(input.entityId)) return failure("invalid_request");
      const metadata = metadataFields(input);
      if (!metadata) return failure("invalid_request");
      const current = storedLights(store);
      if (!current.ok) return current;
      if (current.value.some(light => light.entityId === input.entityId))
        return { ok: true, value: { authorizedLights: current.value, changed: false } };
      let discovered: unknown;
      try { discovered = await discoveryClient.discoverLights(); }
      catch (error) { return failure(errorCode(error)); }
      const candidates = normalizeDiscovered(discovered, new Set(current.value.map(light => light.entityId)));
      if (!candidates) return failure("home_assistant_response_invalid");
      if (!candidates.some(light => light.entityId === input.entityId)) return failure("home_assistant_light_not_discovered");
      const persisted = store.write([...current.value, { entityId: input.entityId, ...metadata }]);
      return persisted.ok
        ? { ok: true, value: { authorizedLights: persisted.authorizedLights, changed: true } }
        : failure(persisted.error);
    });
  }

  function updateLightMetadata(input: unknown): Promise<HomeAssistantAdminResult<{ authorizedLights: AuthorizedHomeAssistantLight[] }>> {
    return serialize(async () => {
      if (!exactKeys(input, ["entityId", "name", "area", "aliases"]) || typeof input.entityId !== "string"
        || !ENTITY_ID_PATTERN.test(input.entityId)) return failure("invalid_request");
      const metadata = metadataFields(input);
      if (!metadata) return failure("invalid_request");
      const current = storedLights(store);
      if (!current.ok) return current;
      if (!current.value.some(light => light.entityId === input.entityId)) return failure("home_assistant_light_not_authorized");
      const lights = current.value.map(light => {
        if (light.entityId !== input.entityId) return light;
        const updated: AuthorizedHomeAssistantLight = { ...light };
        for (const key of ["name", "area"] as const) {
          if (input[key] === null) delete updated[key];
          else if (metadata[key] !== undefined) updated[key] = metadata[key];
        }
        if (metadata.aliases !== undefined) updated.aliases = metadata.aliases;
        return updated;
      });
      const persisted = store.write(lights);
      return persisted.ok ? { ok: true, value: { authorizedLights: persisted.authorizedLights } } : failure(persisted.error);
    });
  }

  function removeAuthorizedLight(input: unknown): Promise<HomeAssistantAdminResult<{ authorizedLights: AuthorizedHomeAssistantLight[] }>> {
    return serialize(async () => {
      if (!exactKeys(input, ["entityId"]) || typeof input.entityId !== "string" || !ENTITY_ID_PATTERN.test(input.entityId))
        return failure("invalid_request");
      const current = storedLights(store);
      if (!current.ok) return current;
      if (!current.value.some(light => light.entityId === input.entityId)) return failure("home_assistant_light_not_authorized");
      const persisted = store.write(current.value.filter(light => light.entityId !== input.entityId));
      return persisted.ok ? { ok: true, value: { authorizedLights: persisted.authorizedLights } } : failure(persisted.error);
    });
  }

  async function discoverEffectSpeedCandidates(input: unknown): Promise<HomeAssistantAdminResult<{ lightEntityId: string; candidates: { entityId: string; name: string; available: boolean; sameDeviceVerified: true }[] }>> {
    if (!exactKeys(input, ["lightEntityId"]) || typeof input.lightEntityId !== "string" || !ENTITY_ID_PATTERN.test(input.lightEntityId))
      return failure("invalid_request");
    const current = storedLights(store);
    if (!current.ok) return current;
    if (!current.value.some(light => light.entityId === input.lightEntityId)) return failure("home_assistant_light_not_authorized");
    if (!speedClient) return failure("home_assistant_request_failed");
    try {
      const candidates = await speedClient.discoverEffectSpeedCandidates(input.lightEntityId);
      return { ok: true, value: { lightEntityId: input.lightEntityId, candidates: [...candidates] } };
    } catch (error) { return failure(errorCode(error)); }
  }

  function linkEffectSpeed(input: unknown): Promise<HomeAssistantAdminResult<{ authorizedLights: AuthorizedHomeAssistantLight[] }>> {
    return serialize(async () => {
      if (!exactKeys(input, ["lightEntityId", "entityId"]) || typeof input.lightEntityId !== "string"
        || !ENTITY_ID_PATTERN.test(input.lightEntityId) || typeof input.entityId !== "string"
        || !/^number\.[a-z0-9_]+$/u.test(input.entityId)) return failure("invalid_request");
      if (!speedClient) return failure("home_assistant_request_failed");
      const current = storedLights(store);
      if (!current.ok) return current;
      const light = current.value.find(item => item.entityId === input.lightEntityId);
      if (!light) return failure("home_assistant_light_not_authorized");
      let valid = false;
      try { valid = await speedClient.associationIsCurrent(light, input.entityId); }
      catch (error) { return failure(errorCode(error)); }
      if (!valid) return failure("home_assistant_speed_link_stale");
      const persisted = store.write(current.value.map(item => item.entityId === light.entityId
        ? { ...item, effectSpeedEntityId: input.entityId } : item));
      return persisted.ok ? { ok: true, value: { authorizedLights: persisted.authorizedLights } } : failure(persisted.error);
    });
  }

  function unlinkEffectSpeed(input: unknown): Promise<HomeAssistantAdminResult<{ authorizedLights: AuthorizedHomeAssistantLight[] }>> {
    return serialize(async () => {
      if (!exactKeys(input, ["lightEntityId"]) || typeof input.lightEntityId !== "string"
        || !ENTITY_ID_PATTERN.test(input.lightEntityId)) return failure("invalid_request");
      const current = storedLights(store);
      if (!current.ok) return current;
      const light = current.value.find(item => item.entityId === input.lightEntityId);
      if (!light) return failure("home_assistant_light_not_authorized");
      const next = current.value.map(item => {
        if (item.entityId !== light.entityId) return item;
        const { effectSpeedEntityId: _discarded, ...withoutSpeed } = item;
        return withoutSpeed;
      });
      const persisted = store.write(next);
      return persisted.ok ? { ok: true, value: { authorizedLights: persisted.authorizedLights } } : failure(persisted.error);
    });
  }

  return Object.freeze({ listAuthorizedLights, discoverLights, authorizeLight, updateLightMetadata, removeAuthorizedLight,
    discoverEffectSpeedCandidates, linkEffectSpeed, unlinkEffectSpeed });
}
