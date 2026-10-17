import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function createOrganicMemoryPreferencesStore(userDataPath: string) {
  const filePath = resolve(userDataPath, "organic-memory-preferences.json");
  function read(): { relationshipLearningEnabled: boolean; thirdPartyLearningEnabled: boolean } {
    try {
      const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_preferences");
      const record = value as Record<string, unknown>;
      if (record.version !== 1 || typeof record.relationshipLearningEnabled !== "boolean"
        || (record.thirdPartyLearningEnabled !== undefined && typeof record.thirdPartyLearningEnabled !== "boolean"))
        throw new Error("invalid_preferences");
      return { relationshipLearningEnabled: record.relationshipLearningEnabled,
        thirdPartyLearningEnabled: record.thirdPartyLearningEnabled ?? true };
    } catch (error) { return { relationshipLearningEnabled: false,
      thirdPartyLearningEnabled: (error as NodeJS.ErrnoException)?.code === "ENOENT" }; }
  }
  function write(next: { relationshipLearningEnabled: boolean; thirdPartyLearningEnabled: boolean }): void {
    mkdirSync(userDataPath, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    let descriptor: number | undefined;
    let ownsTemporaryPath = false;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      ownsTemporaryPath = true;
      writeFileSync(descriptor, `${JSON.stringify({ version: 1, ...next })}\n`, "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, filePath);
      ownsTemporaryPath = false;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (ownsTemporaryPath) try { unlinkSync(temporaryPath); } catch { /* Preserve files not created by this operation. */ }
      throw error;
    }
  }
  return {
    readRelationshipLearningEnabled(): boolean { return read().relationshipLearningEnabled; },
    readThirdPartyLearningEnabled(): boolean { return read().thirdPartyLearningEnabled; },
    writeRelationshipLearningEnabled(enabled: boolean): void {
      if (typeof enabled !== "boolean") throw new TypeError("relationship_learning_preference_invalid");
      write({ ...read(), relationshipLearningEnabled: enabled });
    },
    writeThirdPartyLearningEnabled(enabled: boolean): void {
      if (typeof enabled !== "boolean") throw new TypeError("third_party_learning_preference_invalid");
      write({ ...read(), thirdPartyLearningEnabled: enabled });
    },
  };
}
