import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryModePreferencesStore, resolveInitialDesktopMemoryMode } from "../src/main/memory-mode-preferences.js";

const directories: string[] = [];

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "nexa-memory-mode-preferences-"));
  directories.push(directory);
  return { directory, store: createMemoryModePreferencesStore(directory) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("local Memory mode preference", () => {
  it("starts a fresh Desktop in personal writable Memory2 and preserves an explicit legacy Memory1 choice", () => {
    expect(resolveInitialDesktopMemoryMode({ mode: null, invalid: false }))
      .toEqual({ mode: "memory2-confirmed-write", fallbackReason: null });
    expect(resolveInitialDesktopMemoryMode({ mode: "memory1", invalid: false }))
      .toEqual({ mode: "memory1", fallbackReason: null });
    expect(resolveInitialDesktopMemoryMode({ mode: null, invalid: true }))
      .toEqual({ mode: "memory2-confirmed-write", fallbackReason: "invalid_preference" });
  });

  it("defaults to no selection, persists only the mode, and restores it after recreating the store", async () => {
    const { directory, store } = await makeStore();
    expect(store.read()).toEqual({ mode: null, invalid: false });
    store.write("memory2-confirmed-write");
    expect(createMemoryModePreferencesStore(directory).read()).toEqual({ mode: "memory2-confirmed-write", invalid: false });
    expect(JSON.parse(await readFile(join(directory, "memory-mode-preferences.json"), "utf8")))
      .toEqual({ version: 1, mode: "memory2-confirmed-write" });
    store.write("memory1");
    expect(createMemoryModePreferencesStore(directory).read()).toEqual({ mode: "memory1", invalid: false });
  });

  it("marks malformed or unsupported preferences invalid so startup can use Memory1 safely", async () => {
    const { directory, store } = await makeStore();
    await writeFile(join(directory, "memory-mode-preferences.json"), JSON.stringify({ version: 1, mode: "memory2" }));
    expect(store.read()).toEqual({ mode: null, invalid: true });
    expect(() => store.write("memory2" as never)).toThrow("memory_mode_preference_invalid");
  });
});
