import { describe, expect, it, vi } from "vitest";
import { MEMORY_MODE_GET_CHANNEL, MEMORY_MODE_SET_CHANNEL, MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL,
  MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL,
  MEMORY_CLEAR_ALL_CHANNEL,
  type DesktopMemoryMode } from "../src/shared/ipc-contract.js";
import { registerMemoryModeIpcHandlers, type MemoryModeRuntime } from "../src/main/memory-mode-ipc.js";

const fact = "El usuario ficticio prefiere VS Code como editor de código.";

function setup({ busy = false, validStore = true, failCreate = false, preferenceWriteFails = false,
  initialMode = "memory1", initialFallbackReason = null, relationshipEnabled = false }: {
    busy?: boolean; validStore?: boolean; failCreate?: boolean; preferenceWriteFails?: boolean;
    initialMode?: DesktopMemoryMode; initialFallbackReason?: "invalid_preference" | "mode_unavailable" | null;
    relationshipEnabled?: boolean;
  } = {}) {
  const handlers = new Map<string, (event: never, value?: unknown) => unknown>();
  const ipc = { handle: vi.fn((channel: string, handler: (event: never, value?: unknown) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)) };
  const contents = { mainFrame: {} };
  const window = { webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame } as never;
  let relationshipValue = relationshipEnabled;
  let thirdPartyValue = true;
  const current = { value: { getMemoryMode: () => initialMode,
    clearAllMemory: vi.fn(async () => true),
    setRelationshipLearningEnabled: vi.fn((enabled: boolean) => { relationshipValue = enabled; return enabled; }),
    setThirdPartyLearningEnabled: vi.fn((enabled: boolean) => { thirdPartyValue = enabled; return enabled; }),
    close: vi.fn(async () => undefined) } as MemoryModeRuntime | null };
  let createCount = 0;
  const createRuntime = vi.fn(async (_mode: string, _path?: string) => {
    createCount += 1;
    if (failCreate && createCount === 1) throw new Error("runtime startup failed");
    return { getMemoryMode: () => _mode, close: vi.fn(async () => undefined) };
  });
  const openReader = vi.fn(async () => ({
    readContext: async () => ({ items: validStore ? [{ type: "function_call_output",
      output: JSON.stringify({ assertions: [{ object: { value: fact } }] }) }] : [] }),
    close: vi.fn(async () => undefined),
  }));
  const beginRuntimeSwitch = vi.fn(() => !busy);
  const refreshRuntimeAfterSwitch = vi.fn();
  const endRuntimeSwitch = vi.fn();
  const prepareWriteStore = vi.fn(async () => undefined);
  const clearMemoryStore = vi.fn(async () => true);
  const preferencesStore = { write: vi.fn((mode: string) => { if (preferenceWriteFails) throw new Error("write failed"); }) };
  const relationshipPreferencesStore = { readRelationshipLearningEnabled: () => relationshipValue,
    writeRelationshipLearningEnabled: vi.fn((enabled: boolean) => { if (preferenceWriteFails) throw new Error("write failed"); relationshipValue = enabled; }),
    readThirdPartyLearningEnabled: () => thirdPartyValue,
    writeThirdPartyLearningEnabled: vi.fn((enabled: boolean) => { if (preferenceWriteFails) throw new Error("write failed"); thirdPartyValue = enabled; }) };
  registerMemoryModeIpcHandlers({ getWindow: () => window as never, getRuntime: () => current.value,
    setRuntime: runtime => { current.value = runtime; }, createRuntime,
    resolveStorePath: () => "C:/Users/test/AppData/Local/Nexa/Temporary/memory-desktop-01/nexa-memory2-synthetic-desktop-v5.json",
    resolveWriteStorePath: () => "C:/Users/test/AppData/Local/Nexa/Temporary/memory-write-01/nexa-memory2-synthetic-write-v5.json",
    prepareWriteStore,
    clearMemoryStore,
    openReader, beginRuntimeSwitch, refreshRuntimeAfterSwitch, endRuntimeSwitch, preferencesStore, initialMode,
    initialFallbackReason, relationshipPreferencesStore, ipc });
  const invoke = (channel: string, value?: unknown, senderEvent = event) => handlers.get(channel)!(senderEvent, value);
  return { invoke, current, createRuntime, openReader, prepareWriteStore, clearMemoryStore, preferencesStore, relationshipPreferencesStore, beginRuntimeSwitch, refreshRuntimeAfterSwitch, endRuntimeSwitch };
}

const relationshipDisabled = { relationshipLearningEnabled: false, relationshipLearningEffective: false,
  thirdPartyLearningEnabled: true, thirdPartyLearningEffective: false };

describe("Desktop session-only Memory2 selection", () => {
  it("starts in Memory1 and only exposes Memory2 for the exact synthetic read-only fixture", async () => {
    const h = setup();
    await expect(h.invoke(MEMORY_MODE_GET_CHANNEL)).resolves.toEqual({ mode: "memory1", memory2Available: true, memory2WriteAvailable: true, switching: false, fallbackReason: null, ...relationshipDisabled });
    await expect(h.invoke(MEMORY_MODE_SET_CHANNEL, "memory2-readonly")).resolves.toEqual({ ok: true,
      status: { mode: "memory2-readonly", memory2Available: true, memory2WriteAvailable: true, switching: false, fallbackReason: null, ...relationshipDisabled } });
    expect(h.createRuntime).toHaveBeenCalledWith("memory2-readonly", expect.stringContaining("nexa-memory2-synthetic"));
    expect(h.refreshRuntimeAfterSwitch).toHaveBeenCalledOnce();
    expect(h.openReader).toHaveBeenCalled();
    await expect(h.invoke(MEMORY_MODE_GET_CHANNEL)).resolves.toEqual({ mode: "memory2-readonly", memory2Available: true, memory2WriteAvailable: true, switching: false, fallbackReason: null, ...relationshipDisabled });
  });

  it("reports a restored Runtime mode and a visible safe fallback reason", async () => {
    const restored = setup({ initialMode: "memory2-confirmed-write" });
    await expect(restored.invoke(MEMORY_MODE_GET_CHANNEL)).resolves.toMatchObject({ mode: "memory2-confirmed-write", fallbackReason: null });
    const fallback = setup({ initialFallbackReason: "mode_unavailable" });
    await expect(fallback.invoke(MEMORY_MODE_GET_CHANNEL)).resolves.toMatchObject({ mode: "memory1", fallbackReason: "mode_unavailable" });
  });

  it("reports the active Runtime mode rather than a stale IPC shadow value", async () => {
    const h = setup();
    await h.invoke(MEMORY_MODE_SET_CHANNEL, "memory2-readonly");
    h.current.value = { getMemoryMode: () => "memory1", close: vi.fn(async () => undefined) };
    await expect(h.invoke(MEMORY_MODE_GET_CHANNEL)).resolves.toEqual({ mode: "memory1", memory2Available: true, memory2WriteAvailable: true, switching: false, fallbackReason: null, ...relationshipDisabled });
  });

  it("does not switch when the fixture is invalid or the conversation is busy", async () => {
    const invalid = setup({ validStore: false });
    await expect(invalid.invoke(MEMORY_MODE_SET_CHANNEL, "memory2-readonly")).resolves.toEqual({ ok: false, error: "memory2_unavailable" });
    expect(invalid.createRuntime).not.toHaveBeenCalled();
    const busy = setup({ busy: true });
    await expect(busy.invoke(MEMORY_MODE_SET_CHANNEL, "memory2-readonly")).resolves.toEqual({ ok: false, error: "busy" });
    expect(busy.createRuntime).not.toHaveBeenCalled();
  });

  it("restores Memory1 if Memory2 Runtime creation fails", async () => {
    const h = setup({ failCreate: true });
    await expect(h.invoke(MEMORY_MODE_SET_CHANNEL, "memory2-readonly")).resolves.toEqual({ ok: false, error: "operation_failed" });
    expect(h.current.value).not.toBeNull();
    expect(h.refreshRuntimeAfterSwitch).toHaveBeenCalledOnce();
    expect(h.endRuntimeSwitch).toHaveBeenCalledOnce();
  });

  it("creates the dedicated store only after explicit selection and starts the controlled write mode", async () => {
    const h = setup();
    await expect(h.invoke(MEMORY_MODE_SET_CHANNEL, "memory2-confirmed-write")).resolves.toMatchObject({ ok: true,
      status: { mode: "memory2-confirmed-write", memory2WriteAvailable: true } });
    expect(h.prepareWriteStore).toHaveBeenCalledWith(expect.stringContaining("memory-write-01"));
    expect(h.createRuntime).toHaveBeenCalledWith("memory2-confirmed-write", expect.stringContaining("memory-write-01"));
    expect(h.preferencesStore.write).toHaveBeenCalledWith("memory2-confirmed-write");
  });

  it("persists Memory1 selection and rejects a switch when the local preference cannot be saved", async () => {
    const h = setup();
    await h.invoke(MEMORY_MODE_SET_CHANNEL, "memory1");
    expect(h.preferencesStore.write).toHaveBeenCalledWith("memory1");
    const failing = setup({ preferenceWriteFails: true });
    await expect(failing.invoke(MEMORY_MODE_SET_CHANNEL, "memory2-readonly")).resolves.toEqual({ ok: false, error: "operation_failed" });
    expect(failing.current.value?.getMemoryMode?.()).toBe("memory1");
  });

  it("fails closed when the dedicated write store cannot be resolved", async () => {
    const handlers = new Map<string, (event: never, value?: unknown) => unknown>();
    const ipc = { handle: (_channel: string, handler: (event: never, value?: unknown) => unknown) => handlers.set(_channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel) };
    const contents = { mainFrame: {} };
    const event = { sender: contents, senderFrame: contents.mainFrame } as never;
    const runtime = { getMemoryMode: () => "memory1", close: vi.fn(async () => undefined) };
    const createRuntime = vi.fn(async () => runtime);
    registerMemoryModeIpcHandlers({ getWindow: () => ({ webContents: contents } as never), getRuntime: () => runtime,
      setRuntime: () => undefined, createRuntime, resolveStorePath: () => null, resolveWriteStorePath: () => null,
      prepareWriteStore: vi.fn(async () => undefined), clearMemoryStore: vi.fn(async () => true),
      openReader: vi.fn(async () => ({ readContext: async () => ({ items: [] }), close: async () => undefined })),
      beginRuntimeSwitch: () => true, refreshRuntimeAfterSwitch: () => undefined, endRuntimeSwitch: () => undefined,
      initialMode: "memory1", ipc });
    await expect(handlers.get(MEMORY_MODE_SET_CHANNEL)!(event, "memory2-confirmed-write"))
      .resolves.toEqual({ ok: false, error: "memory2_write_unavailable" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("rejects invalid modes and untrusted senders", async () => {
    const h = setup();
    await expect(h.invoke(MEMORY_MODE_SET_CHANNEL, "memory2")).resolves.toEqual({ ok: false, error: "operation_failed" });
    await expect(h.invoke(MEMORY_MODE_GET_CHANNEL, undefined)).resolves.toBeDefined();
    const other = { sender: {}, senderFrame: {} } as never;
    await expect(h.invoke(MEMORY_MODE_GET_CHANNEL, undefined, other)).rejects.toThrow("untrusted_ipc_sender");
  });

  it("persists relationship consent and wires revocation to Memory2 authorization", async () => {
    const h = setup({ initialMode: "memory2-confirmed-write" });
    await expect(h.invoke(MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL, true)).resolves.toMatchObject({
      ok: true, status: { relationshipLearningEnabled: true, relationshipLearningEffective: true },
    });
    expect(h.current.value?.setRelationshipLearningEnabled).toHaveBeenCalledWith(true);
    await expect(h.invoke(MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL, false)).resolves.toMatchObject({
      ok: true, status: { relationshipLearningEnabled: false, relationshipLearningEffective: false },
    });
    expect(h.current.value?.setRelationshipLearningEnabled).toHaveBeenLastCalledWith(false);
  });

  it("stores the preference without enabling writes when general Memory2 writing is inactive", async () => {
    const h = setup({ initialMode: "memory1" });
    await expect(h.invoke(MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL, true)).resolves.toMatchObject({
      ok: true, status: { relationshipLearningEnabled: true, relationshipLearningEffective: false },
    });
    expect(h.current.value?.setRelationshipLearningEnabled).not.toHaveBeenCalled();
  });

  it("changes third-party permission independently and rejects untrusted or invalid requests", async () => {
    const h = setup({ initialMode: "memory2-confirmed-write" });
    await expect(h.invoke(MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL, false)).resolves.toMatchObject({ ok: true,
      status: { thirdPartyLearningEnabled: false, thirdPartyLearningEffective: false, relationshipLearningEnabled: false } });
    expect(h.current.value?.setThirdPartyLearningEnabled).toHaveBeenCalledWith(false);
    await expect(h.invoke(MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL, "false")).resolves
      .toEqual({ ok: false, error: "operation_failed" });
    await expect(h.invoke(MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL, true, { sender: {}, senderFrame: {} } as never))
      .rejects.toThrow("untrusted_ipc_sender");
  });

  it("clears only through the trusted Main Runtime with no renderer-supplied path", async () => {
    const h = setup({ initialMode: "memory2-confirmed-write" });
    await expect(h.invoke(MEMORY_CLEAR_ALL_CHANNEL)).resolves.toEqual({ ok: true });
    expect(h.current.value?.clearAllMemory).toHaveBeenCalledOnce();
    expect(h.beginRuntimeSwitch).toHaveBeenCalledOnce();
    expect(h.endRuntimeSwitch).toHaveBeenCalledOnce();
    await expect(h.invoke(MEMORY_CLEAR_ALL_CHANNEL, "C:/arbitrary/store.json")).resolves.toEqual({ ok: false, error: "busy" });
    await expect(h.invoke(MEMORY_CLEAR_ALL_CHANNEL, undefined, { sender: {}, senderFrame: {} } as never))
      .rejects.toThrow("untrusted_ipc_sender");
    const readonly = setup({ initialMode: "memory2-readonly" });
    await expect(readonly.invoke(MEMORY_CLEAR_ALL_CHANNEL)).resolves.toEqual({ ok: true });
    expect(readonly.clearMemoryStore).toHaveBeenCalledOnce();
  });

  it("does not report success when the Runtime wipe fails", async () => {
    const h = setup({ initialMode: "memory2-confirmed-write" });
    h.current.value!.clearAllMemory = vi.fn(async () => false);
    await expect(h.invoke(MEMORY_CLEAR_ALL_CHANNEL)).resolves.toEqual({ ok: false, error: "operation_failed" });
    expect(h.endRuntimeSwitch).toHaveBeenCalledOnce();
  });
});
