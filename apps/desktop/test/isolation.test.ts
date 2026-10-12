import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_ISOLATED_ARGUMENT,
  DESKTOP_ORGANIC_PILOT_ARGUMENT,
  desktopStartupPolicy,
  isDesktopIsolationRequested,
  isOrganicMemoryPilotRequested,
  prepareDesktopIsolation,
  resolveSyntheticMemory2StorePath,
  resolveSyntheticMemory2WriteStorePath,
  resolvePersonalMemory2StorePath,
  validateIsolatedMemoryStore,
} from "../src/main/isolation.js";

const roots: string[] = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "nexa-isolation-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const store = join(root, "nexa-memory2-synthetic-fixture.json");
  writeFileSync(store, "synthetic fixture only");
  return { root, repo, store };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop isolation mode", () => {
  it("activates only with the explicit command-line argument, never an environment value", () => {
    expect(isDesktopIsolationRequested(["electron", "."])).toBe(false);
    expect(isDesktopIsolationRequested(["electron", ".", DESKTOP_ISOLATED_ARGUMENT])).toBe(true);
    const fixture = createFixture();
    const app = { setPath: () => { throw new Error("must not configure normal mode"); }, getPath: () => "" };
    expect(prepareDesktopIsolation({ argv: ["electron", "."], env: { NEXA_DESKTOP_ISOLATED: "1" }, app, repositoryRoot: fixture.repo,
      temporaryDirectory: fixture.root })).toBeNull();
  });

  it("requires explicit read-only Memory2 and applies a fresh profile before reading it back", () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const configuredPaths: Partial<Record<"userData" | "sessionData", string>> = {};
    const app = {
      setPath: (name: "userData" | "sessionData", value: string) => { calls.push(`set:${name}`); configuredPaths[name] = value; },
      getPath: (name: "userData" | "sessionData") => { calls.push(`get:${name}`); return configuredPaths[name] ?? ""; },
    };
    const result = prepareDesktopIsolation({
      argv: ["electron", ".", DESKTOP_ISOLATED_ARGUMENT],
      env: { NEXA_MEMORY_BACKEND: "memory2-readonly", NEXA_MEMORY2_STORE_PATH: fixture.store },
      app,
      repositoryRoot: fixture.repo,
      temporaryDirectory: fixture.root,
    });
    expect(result?.memoryStorePath).toBe(fixture.store);
    expect(result?.profilePath.startsWith(fixture.root)).toBe(true);
    expect(result?.organicPilot).toBe(false);
    expect(calls).toEqual(["set:userData", "set:sessionData", "get:userData", "get:sessionData"]);
  });

  it("accepts only an existing synthetic file in the approved LocalAppData location", () => {
    const fixture = createFixture();
    const alternateTemp = join(fixture.root, "system-temp");
    mkdirSync(alternateTemp);
    const approved = join(fixture.root, "Nexa", "Temporary", "memory-desktop-01");
    mkdirSync(approved, { recursive: true });
    const approvedStore = join(approved, "nexa-memory2-synthetic-desktop-v5.json");
    writeFileSync(approvedStore, "synthetic fixture only");
    expect(resolveSyntheticMemory2StorePath(approvedStore, fixture.repo, alternateTemp, fixture.root)).toBe(approvedStore);
    expect(resolveSyntheticMemory2StorePath(fixture.store, fixture.repo, alternateTemp, fixture.root)).toBeNull();
    expect(resolveSyntheticMemory2StorePath(join(fixture.repo, "nexa-memory2-synthetic-inside-repo.json"),
      fixture.repo, alternateTemp, fixture.root)).toBeNull();
  });

  it("resolves only the dedicated synthetic write store beneath LocalAppData", () => {
    const fixture = createFixture();
    const localAppData = join(fixture.root, "LocalAppData");
    mkdirSync(localAppData);
    const expected = join(localAppData, "Nexa", "Temporary", "memory-write-01", "nexa-memory2-synthetic-write-v5.json");
    expect(resolveSyntheticMemory2WriteStorePath(localAppData, fixture.repo)).toBe(expected);
    expect(resolveSyntheticMemory2WriteStorePath(undefined, fixture.repo)).toBeNull();

    const parent = join(localAppData, "Nexa", "Temporary", "memory-write-01");
    mkdirSync(parent, { recursive: true });
    writeFileSync(expected, "synthetic store placeholder");
    expect(resolveSyntheticMemory2WriteStorePath(localAppData, fixture.repo)).toBe(expected);
    const unsafeRepo = join(localAppData, "Nexa");
    expect(resolveSyntheticMemory2WriteStorePath(localAppData, unsafeRepo)).toBeNull();
  });

  it("resolves the persistent personal Memory2 store only under the repository data directory", () => {
    const fixture = createFixture();
    const expected = join(fixture.repo, "data", "memory-v2.json");
    expect(resolvePersonalMemory2StorePath(fixture.repo)).toBe(expected);
    mkdirSync(join(fixture.repo, "data"));
    writeFileSync(expected, "existing store placeholder");
    expect(resolvePersonalMemory2StorePath(fixture.repo)).toBe(expected);
    rmSync(expected);
    rmSync(join(fixture.repo, "data"), { recursive: true, force: true });
  });

  it("fails closed for missing, writable or invalid Memory2 configuration", () => {
    const fixture = createFixture();
    const app = { setPath: () => undefined, getPath: () => "" };
    const argv = ["electron", ".", DESKTOP_ISOLATED_ARGUMENT];
    expect(() => prepareDesktopIsolation({ argv, env: {}, app, repositoryRoot: fixture.repo, temporaryDirectory: fixture.root }))
      .toThrow("desktop_isolation_requires_memory2_readonly");
    expect(() => prepareDesktopIsolation({ argv, env: { NEXA_MEMORY_BACKEND: "memory1", NEXA_MEMORY2_STORE_PATH: fixture.store }, app,
      repositoryRoot: fixture.repo, temporaryDirectory: fixture.root })).toThrow("desktop_isolation_requires_memory2_readonly");
    expect(() => prepareDesktopIsolation({ argv: [...argv, DESKTOP_ORGANIC_PILOT_ARGUMENT], env: {}, app,
      repositoryRoot: fixture.repo, temporaryDirectory: fixture.root })).toThrow("desktop_isolation_requires_memory2_readonly");
    expect(() => prepareDesktopIsolation({ argv, env: { NEXA_MEMORY_BACKEND: "memory2-readonly" }, app,
      repositoryRoot: fixture.repo, temporaryDirectory: fixture.root })).toThrow("desktop_isolation_requires_absolute_synthetic_memory_store");
    expect(() => prepareDesktopIsolation({ argv, env: { NEXA_MEMORY_BACKEND: "memory2-readonly", NEXA_MEMORY2_STORE_PATH: fixture.repo }, app,
      repositoryRoot: fixture.repo, temporaryDirectory: fixture.root })).toThrow("desktop_isolation_memory_store_must_be_regular_file");
    expect(() => prepareDesktopIsolation({ argv, env: { NEXA_MEMORY_BACKEND: "memory2-readonly",
      NEXA_MEMORY2_STORE_PATH: join(fixture.root, "ordinary-memory.json") }, app,
      repositoryRoot: fixture.repo, temporaryDirectory: fixture.root })).toThrow("desktop_isolation_memory_store_invalid");
  });

  it("blocks source-tree stores and stores whose names do not identify a synthetic fixture", () => {
    const fixture = createFixture();
    const personalShapedPath = join(fixture.repo, "nexa-memory2-synthetic-local.json");
    writeFileSync(personalShapedPath, "synthetic fixture only");
    const wronglyNamedPath = join(fixture.root, "memory-v2.json");
    writeFileSync(wronglyNamedPath, "synthetic fixture only");
    const app = { setPath: () => undefined, getPath: () => "" };
    const argv = ["electron", ".", DESKTOP_ISOLATED_ARGUMENT];
    for (const storePath of [personalShapedPath, wronglyNamedPath]) {
      expect(() => prepareDesktopIsolation({ argv,
        env: { NEXA_MEMORY_BACKEND: "memory2-readonly", NEXA_MEMORY2_STORE_PATH: storePath }, app,
        repositoryRoot: fixture.repo, temporaryDirectory: fixture.root,
      })).toThrow("desktop_isolation_memory_store_must_be_synthetic_temp_file");
    }
  });

  it("closes the read-only preflight reader and sanitizes invalid-store failures", async () => {
    let closes = 0;
    await validateIsolatedMemoryStore("synthetic-path", async ({ storePath }) => {
      expect(storePath).toBe("synthetic-path");
      return { close: async () => { closes += 1; } };
    });
    expect(closes).toBe(1);
    await expect(validateIsolatedMemoryStore("synthetic-path", async () => { throw new Error("sensitive detail"); }))
      .rejects.toThrow("desktop_isolation_memory_store_invalid");
  });

  it("disables environment loading, services, chat, authorization, Voice, tools and wallpaper in isolated mode", () => {
    expect(desktopStartupPolicy(false)).toEqual({ loadRootEnvironment: true, registerExternalServices: true,
      registerChat: true, registerMemoryMode: true, registerAuthorization: true, registerVoice: true, allowRuntimeTools: true, readSystemWallpaper: true });
    expect(desktopStartupPolicy(true)).toEqual({ loadRootEnvironment: false, registerExternalServices: false,
      registerChat: false, registerMemoryMode: false, registerAuthorization: false, registerVoice: false, allowRuntimeTools: false, readSystemWallpaper: false });
    expect(desktopStartupPolicy(true, true)).toEqual({ loadRootEnvironment: false, registerExternalServices: false,
      registerChat: true, registerMemoryMode: false, registerAuthorization: false, registerVoice: false, allowRuntimeTools: false, readSystemWallpaper: false });
  });

  it("rejects the pilot argument without isolation and recognizes only the explicit pilot flag", () => {
    const fixture = createFixture();
    const app = { setPath: () => undefined, getPath: () => "" };
    expect(isOrganicMemoryPilotRequested(["electron", ".", DESKTOP_ORGANIC_PILOT_ARGUMENT])).toBe(true);
    expect(isOrganicMemoryPilotRequested(["electron", "."])).toBe(false);
    expect(() => prepareDesktopIsolation({ argv: ["electron", ".", DESKTOP_ORGANIC_PILOT_ARGUMENT], env: {}, app,
      repositoryRoot: fixture.repo, temporaryDirectory: fixture.root })).toThrow("desktop_organic_pilot_requires_isolated_mode");
  });

  it("accepts pilot startup only with both flags and an existing approved synthetic store", () => {
    const fixture = createFixture();
    const localAppData = join(fixture.root, "LocalAppData");
    const temporaryDirectory = join(localAppData, "Temp");
    const storeDirectory = join(localAppData, "Nexa", "Temporary", "memory-desktop-01");
    mkdirSync(temporaryDirectory, { recursive: true });
    mkdirSync(storeDirectory, { recursive: true });
    const storePath = join(storeDirectory, "nexa-memory2-synthetic-desktop-v5.json");
    writeFileSync(storePath, "synthetic fixture only");
    const configuredPaths: Partial<Record<"userData" | "sessionData", string>> = {};
    const app = { setPath: (name: "userData" | "sessionData", value: string) => { configuredPaths[name] = value; },
      getPath: (name: "userData" | "sessionData") => configuredPaths[name] ?? "" };
    const result = prepareDesktopIsolation({
      argv: ["electron", ".", DESKTOP_ISOLATED_ARGUMENT, DESKTOP_ORGANIC_PILOT_ARGUMENT],
      env: { NEXA_MEMORY_BACKEND: "memory2-readonly", NEXA_MEMORY2_STORE_PATH: storePath, LOCALAPPDATA: localAppData },
      app, repositoryRoot: fixture.repo, temporaryDirectory,
    });
    expect(result?.organicPilot).toBe(true);
    expect(result?.memoryStorePath).toBe(storePath);
    expect(result?.profilePath.startsWith(temporaryDirectory)).toBe(true);
  });
});
