import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE_NAME = "home-assistant-lights.json";
const ENTITY_ID_PATTERN = /^light\.[a-z0-9_]+$/u;
const MAX_LIGHTS = 32;
const MAX_NAME_LENGTH = 120;
const MAX_AREA_LENGTH = 80;
const MAX_ALIASES = 16;
const MAX_ALIAS_LENGTH = 80;

export interface AuthorizedHomeAssistantLight {
  entityId: string;
  name?: string;
  area?: string;
  aliases?: string[];
  effectSpeedEntityId?: string;
}

export type HomeAssistantLightsStoreError =
  | "home_assistant_device_store_invalid"
  | "home_assistant_device_store_io_error"
  | "home_assistant_legacy_configuration_invalid"
  | "home_assistant_device_store_write_failed";

export type HomeAssistantLightsStoreRead =
  | { ok: true; version: 1; authorizedLights: AuthorizedHomeAssistantLight[]; source: "store" | "migrated" }
  | { ok: false; error: HomeAssistantLightsStoreError };

type LegacyEnvironment = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLight(value: unknown): AuthorizedHomeAssistantLight | null {
  if (!isRecord(value) || Object.keys(value).some(key => !["entityId", "name", "area", "aliases", "effectSpeedEntityId"].includes(key))) return null;
  if (typeof value.entityId !== "string" || !ENTITY_ID_PATTERN.test(value.entityId)) return null;

  const result: AuthorizedHomeAssistantLight = { entityId: value.entityId };
  for (const key of ["name", "area"] as const) {
    const item = value[key];
    const limit = key === "name" ? MAX_NAME_LENGTH : MAX_AREA_LENGTH;
    if (item === undefined) continue;
    if (typeof item !== "string" || !item.trim() || item.trim().length > limit) return null;
    result[key] = item.trim();
  }

  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases) || value.aliases.length > MAX_ALIASES
      || value.aliases.some(alias => typeof alias !== "string" || !alias.trim() || alias.trim().length > MAX_ALIAS_LENGTH)) return null;
    result.aliases = value.aliases.map(alias => (alias as string).trim());
  }
  if (value.effectSpeedEntityId !== undefined) {
    if (typeof value.effectSpeedEntityId !== "string" || !/^number\.[a-z0-9_]+$/u.test(value.effectSpeedEntityId)) return null;
    result.effectSpeedEntityId = value.effectSpeedEntityId;
  }
  return result;
}

function normalizeLights(value: unknown): AuthorizedHomeAssistantLight[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIGHTS) return null;
  const lights = value.map(normalizeLight);
  if (lights.some(light => light === null)) return null;
  const normalized = lights as AuthorizedHomeAssistantLight[];
  if (new Set(normalized.map(light => light.entityId)).size !== normalized.length) return null;
  const speedIds = normalized.flatMap(light => light.effectSpeedEntityId ? [light.effectSpeedEntityId] : []);
  if (new Set(speedIds).size !== speedIds.length) return null;
  return normalized;
}

function parseStoredValue(value: unknown): AuthorizedHomeAssistantLight[] | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.version !== 1
    || !Object.hasOwn(value, "authorizedLights")) return null;
  return normalizeLights(value.authorizedLights);
}

function parseLegacyEnvironment(environment: LegacyEnvironment): AuthorizedHomeAssistantLight[] | null {
  const rawLights = environment.NEXA_HOME_ASSISTANT_LIGHTS;
  if (rawLights !== undefined && typeof rawLights !== "string") return null;
  const entityIds = typeof rawLights === "string"
    ? rawLights.split(",").map(value => value.trim()).filter(Boolean) : [];
  if (entityIds.length > MAX_LIGHTS || entityIds.some(entityId => !ENTITY_ID_PATTERN.test(entityId))
    || new Set(entityIds).size !== entityIds.length) return null;

  const rawMetadata = environment.NEXA_HOME_ASSISTANT_LIGHT_METADATA;
  if (rawMetadata === undefined || (typeof rawMetadata === "string" && !rawMetadata.trim()))
    return entityIds.map(entityId => ({ entityId }));
  if (typeof rawMetadata !== "string") return null;
  let metadata: unknown;
  try { metadata = JSON.parse(rawMetadata); } catch { return null; }
  if (!Array.isArray(metadata) || metadata.length > entityIds.length) return null;

  const seen = new Set<string>();
  const lights = entityIds.map(entityId => ({ entityId } as AuthorizedHomeAssistantLight));
  for (const item of metadata) {
    if (isRecord(item) && Object.hasOwn(item, "effectSpeedEntityId")) return null;
    const light = normalizeLight(item);
    if (!light || !entityIds.includes(light.entityId) || seen.has(light.entityId)) return null;
    seen.add(light.entityId);
    const index = lights.findIndex(candidate => candidate.entityId === light.entityId);
    lights[index] = light;
  }
  return lights;
}

function writeAtomic(filePath: string, directory: string, lights: AuthorizedHomeAssistantLight[]): void {
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  let ownsTemporaryPath = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    ownsTemporaryPath = true;
    writeFileSync(descriptor, `${JSON.stringify({ version: 1, authorizedLights: lights }, null, 2)}\n`, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    ownsTemporaryPath = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (ownsTemporaryPath) try { unlinkSync(temporaryPath); } catch { /* Never remove a temp file not owned by this write. */ }
  }
}

/** Main-process-only, versioned persistence for explicitly authorized HA lights. */
export function createHomeAssistantLightsStore(userDataPath: string, { environment = process.env }: { environment?: LegacyEnvironment } = {}) {
  const filePath = resolve(userDataPath, FILE_NAME);

  function read(): HomeAssistantLightsStoreRead {
    let storedText: string;
    try { storedText = readFileSync(filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { ok: false, error: "home_assistant_device_store_io_error" };
      const legacyLights = parseLegacyEnvironment(environment);
      if (!legacyLights) return { ok: false, error: "home_assistant_legacy_configuration_invalid" };
      try {
        writeAtomic(filePath, userDataPath, legacyLights);
        return { ok: true, version: 1, authorizedLights: legacyLights, source: "migrated" };
      } catch { return { ok: false, error: "home_assistant_device_store_write_failed" }; }
    }

    let storedValue: unknown;
    try { storedValue = JSON.parse(storedText); } catch { return { ok: false, error: "home_assistant_device_store_invalid" }; }
    const authorizedLights = parseStoredValue(storedValue);
    return authorizedLights
      ? { ok: true, version: 1, authorizedLights, source: "store" }
      : { ok: false, error: "home_assistant_device_store_invalid" };
  }

  function write(authorizedLights: unknown): HomeAssistantLightsStoreRead {
    const current = read();
    if (!current.ok) return current;
    const normalized = normalizeLights(authorizedLights);
    if (!normalized) return { ok: false, error: "home_assistant_device_store_invalid" };
    try {
      writeAtomic(filePath, userDataPath, normalized);
      return { ok: true, version: 1, authorizedLights: normalized, source: "store" };
    } catch { return { ok: false, error: "home_assistant_device_store_write_failed" }; }
  }

  return Object.freeze({ read, write });
}
