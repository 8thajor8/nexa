import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDesktopMemoryMode, type DesktopMemoryMode } from "../shared/ipc-contract.js";

export type MemoryModeFallbackReason = "invalid_preference" | "mode_unavailable" | null;

export interface MemoryModePreferenceRead {
  mode: DesktopMemoryMode | null;
  invalid: boolean;
}

export function resolveInitialDesktopMemoryMode(preference: MemoryModePreferenceRead): {
  mode: DesktopMemoryMode; fallbackReason: MemoryModeFallbackReason;
} {
  return { mode: preference.mode ?? "memory2-confirmed-write",
    fallbackReason: preference.invalid ? "invalid_preference" : null };
}

/** Stores only the selected mode in Electron's local userData directory. */
export function createMemoryModePreferencesStore(userDataPath: string) {
  const filePath = resolve(userDataPath, "memory-mode-preferences.json");
  return {
    read(): MemoryModePreferenceRead {
      try {
        const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) return { mode: null, invalid: true };
        const record = value as Record<string, unknown>;
        if (Object.keys(record).length !== 2 || record.version !== 1 || !isDesktopMemoryMode(record.mode)) {
          return { mode: null, invalid: true };
        }
        return { mode: record.mode, invalid: false };
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "ENOENT"
          ? { mode: null, invalid: false } : { mode: null, invalid: true };
      }
    },
    write(mode: DesktopMemoryMode): void {
      if (!isDesktopMemoryMode(mode)) throw new TypeError("memory_mode_preference_invalid");
      mkdirSync(userDataPath, { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      let descriptor: number | undefined;
      let ownsTemporaryPath = false;
      try {
        descriptor = openSync(temporaryPath, "wx", 0o600);
        ownsTemporaryPath = true;
        writeFileSync(descriptor, `${JSON.stringify({ version: 1, mode })}\n`, "utf8");
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporaryPath, filePath);
        ownsTemporaryPath = false;
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (ownsTemporaryPath) try { unlinkSync(temporaryPath); } catch { /* Leave unrelated files untouched. */ }
        throw error;
      }
    },
  };
}
