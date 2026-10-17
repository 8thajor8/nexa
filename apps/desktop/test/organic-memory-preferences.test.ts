import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOrganicMemoryPreferencesStore } from "../src/main/organic-memory-preferences.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("organic relationship preference", () => {
  it("defaults off and persists activation and revocation across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexa-organic-memory-pref-"));
    directories.push(directory);
    const store = createOrganicMemoryPreferencesStore(directory);
    expect(store.readRelationshipLearningEnabled()).toBe(false);
    expect(store.readThirdPartyLearningEnabled()).toBe(true);
    store.writeRelationshipLearningEnabled(true);
    expect(createOrganicMemoryPreferencesStore(directory).readRelationshipLearningEnabled()).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "organic-memory-preferences.json"), "utf8")))
      .toEqual({ version: 1, relationshipLearningEnabled: true, thirdPartyLearningEnabled: true });
    store.writeRelationshipLearningEnabled(false);
    expect(createOrganicMemoryPreferencesStore(directory).readRelationshipLearningEnabled()).toBe(false);
    store.writeThirdPartyLearningEnabled(false);
    const reopened = createOrganicMemoryPreferencesStore(directory);
    expect(reopened.readThirdPartyLearningEnabled()).toBe(false);
    expect(reopened.readRelationshipLearningEnabled()).toBe(false);
    store.writeRelationshipLearningEnabled(true);
    expect(reopened.readThirdPartyLearningEnabled()).toBe(false);
  });

  it("fails closed for malformed values and rejects non-boolean writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexa-organic-memory-pref-"));
    directories.push(directory);
    const store = createOrganicMemoryPreferencesStore(directory);
    expect(store.readRelationshipLearningEnabled()).toBe(false);
    expect(() => store.writeRelationshipLearningEnabled("enabled" as never)).toThrow("relationship_learning_preference_invalid");
    expect(() => store.writeThirdPartyLearningEnabled("enabled" as never)).toThrow("third_party_learning_preference_invalid");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, "organic-memory-preferences.json"), "{invalid");
    expect(store.readThirdPartyLearningEnabled()).toBe(false);
  });

  it("reads legacy relationship preferences with independent default-on third-party consent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexa-organic-memory-pref-"));
    directories.push(directory);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, "organic-memory-preferences.json"),
      JSON.stringify({ version: 1, relationshipLearningEnabled: true }));
    const store = createOrganicMemoryPreferencesStore(directory);
    expect(store.readRelationshipLearningEnabled()).toBe(true);
    expect(store.readThirdPartyLearningEnabled()).toBe(true);
  });
});
