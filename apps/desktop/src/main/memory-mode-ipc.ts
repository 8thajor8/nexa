import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  MEMORY_MODE_GET_CHANNEL, MEMORY_MODE_SET_CHANNEL, MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL,
  MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL,
  MEMORY_CLEAR_ALL_CHANNEL,
  isDesktopMemoryMode, type DesktopMemoryMode, type DesktopMemoryModeResult,
  type DesktopMemoryModeStatus, type DesktopMemoryClearResult,
} from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import type { MemoryModeFallbackReason } from "./memory-mode-preferences.js";

const SYNTHETIC_EDITOR_FACT = "El usuario ficticio prefiere VS Code como editor de código.";
const SYNTHETIC_EDITOR_QUERY = "¿Qué editor de código prefiero?";

export interface MemoryModeRuntime { close(): Promise<void>; getMemoryMode?(): string; clearAllMemory?(): Promise<boolean>; setRelationshipLearningEnabled?(enabled: boolean): boolean;
  setThirdPartyLearningEnabled?(enabled: boolean): boolean; }
export interface MemoryModeReader {
  readContext(options: { message: string }): Promise<{ items: Array<{ type: string; output?: string }> }>;
  close(): Promise<void>;
}
interface MemoryModeIpc {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, value?: unknown) => unknown): void;
  removeHandler(channel: string): void;
}

export async function isApprovedSyntheticStore(storePath: string | null,
  openReader: (options: { storePath: string }) => Promise<MemoryModeReader>): Promise<boolean> {
  if (!storePath) return false;
  let reader: MemoryModeReader | undefined;
  try {
    reader = await openReader({ storePath });
    const result = await reader.readContext({ message: SYNTHETIC_EDITOR_QUERY });
    const output = result.items.find(item => item.type === "function_call_output")?.output;
    if (typeof output !== "string") return false;
    const payload = JSON.parse(output) as { assertions?: Array<{ object?: { value?: unknown } }> };
    return Array.isArray(payload.assertions) && payload.assertions.length === 1
      && payload.assertions[0]?.object?.value === SYNTHETIC_EDITOR_FACT;
  } catch {
    return false;
  } finally {
    await reader?.close().catch(() => undefined);
  }
}

export async function isReadableMemory2Store(storePath: string | null,
  openReader: (options: { storePath: string }) => Promise<MemoryModeReader>): Promise<boolean> {
  if (!storePath) return false;
  let reader: MemoryModeReader | undefined;
  try {
    reader = await openReader({ storePath });
    return Boolean(reader && typeof reader.readContext === "function");
  } catch {
    return false;
  } finally {
    await reader?.close().catch(() => undefined);
  }
}

export function registerMemoryModeIpcHandlers({
  getWindow,
  getRuntime,
  setRuntime,
  createRuntime,
  resolveStorePath,
  resolveWriteStorePath,
  prepareWriteStore,
  clearMemoryStore,
  openReader,
  beginRuntimeSwitch,
  refreshRuntimeAfterSwitch,
  endRuntimeSwitch,
  initialMode = "memory2-confirmed-write",
  initialFallbackReason = null,
  preferencesStore,
  relationshipPreferencesStore,
  ipc = ipcMain,
}: {
  getWindow: () => BrowserWindow | null;
  getRuntime: () => MemoryModeRuntime | null;
  setRuntime: (runtime: MemoryModeRuntime | null) => void;
  createRuntime: (mode: DesktopMemoryMode, storePath?: string) => MemoryModeRuntime | Promise<MemoryModeRuntime>;
  resolveStorePath: () => string | null;
  resolveWriteStorePath: () => string | null;
  prepareWriteStore: (storePath: string) => Promise<void>;
  clearMemoryStore: () => Promise<boolean>;
  openReader: (options: { storePath: string }) => Promise<MemoryModeReader>;
  beginRuntimeSwitch: () => boolean;
  refreshRuntimeAfterSwitch: () => void;
  endRuntimeSwitch: () => void;
  initialMode?: DesktopMemoryMode;
  initialFallbackReason?: MemoryModeFallbackReason;
  preferencesStore?: { write(mode: DesktopMemoryMode): void };
  relationshipPreferencesStore?: { readRelationshipLearningEnabled(): boolean; writeRelationshipLearningEnabled(enabled: boolean): void;
    readThirdPartyLearningEnabled(): boolean; writeThirdPartyLearningEnabled(enabled: boolean): void };
  ipc?: MemoryModeIpc;
}) {
  let mode: DesktopMemoryMode = initialMode;
  let fallbackReason = initialFallbackReason;
  let switching = false;
  const status = async (): Promise<DesktopMemoryModeStatus> => {
    const runtimeMode = getRuntime()?.getMemoryMode?.();
    return {
      mode: isDesktopMemoryMode(runtimeMode) ? runtimeMode : mode,
      memory2Available: await isApprovedSyntheticStore(resolveStorePath(), openReader),
      memory2WriteAvailable: Boolean(resolveWriteStorePath()), switching, fallbackReason,
      relationshipLearningEnabled: relationshipPreferencesStore?.readRelationshipLearningEnabled() ?? false,
      relationshipLearningEffective: (relationshipPreferencesStore?.readRelationshipLearningEnabled() ?? false)
        && (isDesktopMemoryMode(runtimeMode) ? runtimeMode : mode) === "memory2-confirmed-write",
      thirdPartyLearningEnabled: relationshipPreferencesStore?.readThirdPartyLearningEnabled() ?? true,
      thirdPartyLearningEffective: (relationshipPreferencesStore?.readThirdPartyLearningEnabled() ?? true)
        && (isDesktopMemoryMode(runtimeMode) ? runtimeMode : mode) === "memory2-confirmed-write",
    };
  };
  ipc.removeHandler(MEMORY_MODE_GET_CHANNEL);
  ipc.removeHandler(MEMORY_MODE_SET_CHANNEL);
  ipc.removeHandler(MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL);
  ipc.removeHandler(MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL);
  ipc.removeHandler(MEMORY_CLEAR_ALL_CHANNEL);
  ipc.handle(MEMORY_MODE_GET_CHANNEL, async event => {
    const window = getWindow();
    if (!window || !isTrustedIpcSender(event as never, window as never)) throw new Error("untrusted_ipc_sender");
    return status();
  });
  ipc.handle(MEMORY_MODE_SET_CHANNEL, async (event, value) => {
    const window = getWindow();
    if (!window || !isTrustedIpcSender(event as never, window as never)) throw new Error("untrusted_ipc_sender");
    if (!isDesktopMemoryMode(value)) return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
    if (value === mode) {
      try {
        preferencesStore?.write(value);
        fallbackReason = null;
        return { ok: true, status: await status() } satisfies DesktopMemoryModeResult;
      } catch {
        return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
      }
    }

    let storePath: string | undefined;
    if (value === "memory2-readonly") {
      const resolvedStorePath = resolveStorePath();
      if (!(await isApprovedSyntheticStore(resolvedStorePath, openReader))) {
        return { ok: false, error: "memory2_unavailable" } satisfies DesktopMemoryModeResult;
      }
      storePath = resolvedStorePath ?? undefined;
    } else if (value === "memory2-confirmed-write") {
      const resolvedStorePath = resolveWriteStorePath();
      if (!resolvedStorePath) return { ok: false, error: "memory2_write_unavailable" } satisfies DesktopMemoryModeResult;
      storePath = resolvedStorePath;
    }
    if (!beginRuntimeSwitch()) return { ok: false, error: "busy" } satisfies DesktopMemoryModeResult;
    switching = true;
    const previousMode = mode;
    const previousFallbackReason = fallbackReason;
    const previousRuntimeMode = getRuntime()?.getMemoryMode?.();
    const previousRuntime = getRuntime();
    let previousClosed = false;
    let createdRuntime: MemoryModeRuntime | null = null;
    try {
      if (value === "memory2-confirmed-write" && storePath) await prepareWriteStore(storePath);
      await previousRuntime?.close();
      previousClosed = Boolean(previousRuntime);
      const nextRuntime = await createRuntime(value, storePath);
      createdRuntime = nextRuntime;
      if (nextRuntime.getMemoryMode && nextRuntime.getMemoryMode() !== value) throw new Error("runtime_memory_mode_mismatch");
      setRuntime(nextRuntime);
      createdRuntime = null;
      mode = value;
      fallbackReason = null;
      refreshRuntimeAfterSwitch();
      const nextStatus = await status();
      preferencesStore?.write(value);
      return { ok: true, status: { ...nextStatus, switching: false } } satisfies DesktopMemoryModeResult;
    } catch {
      await createdRuntime?.close().catch(() => undefined);
      try {
        const restoredRuntime = previousClosed
          ? await createRuntime(previousRuntimeMode === "memory2-confirmed-write" ? "memory2-confirmed-write" : previousMode,
            previousRuntimeMode === "memory2-confirmed-write" ? resolveWriteStorePath() ?? undefined
              : previousMode === "memory2-readonly" ? resolveStorePath() ?? undefined : undefined)
          : previousRuntime;
        setRuntime(restoredRuntime);
        refreshRuntimeAfterSwitch();
      } catch {
        setRuntime(null);
        refreshRuntimeAfterSwitch();
      }
      mode = previousMode;
      fallbackReason = previousFallbackReason;
      return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
    } finally {
      switching = false;
      endRuntimeSwitch();
    }
  });
  ipc.handle(MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL, async (event, value) => {
    const window = getWindow();
    if (!window || !isTrustedIpcSender(event as never, window as never)) throw new Error("untrusted_ipc_sender");
    if (switching) return { ok: false, error: "busy" } satisfies DesktopMemoryModeResult;
    if (typeof value !== "boolean" || !relationshipPreferencesStore)
      return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
    const runtime = getRuntime();
    const runtimeMode = runtime?.getMemoryMode?.();
    const effective = (isDesktopMemoryMode(runtimeMode) ? runtimeMode : mode) === "memory2-confirmed-write";
    const previous = relationshipPreferencesStore.readRelationshipLearningEnabled();
    try {
      if (effective && (!runtime || typeof runtime.setRelationshipLearningEnabled !== "function"))
        return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
      if (effective) runtime?.setRelationshipLearningEnabled?.(value);
      relationshipPreferencesStore.writeRelationshipLearningEnabled(value);
      return { ok: true, status: await status() } satisfies DesktopMemoryModeResult;
    } catch {
      if (effective) try { runtime?.setRelationshipLearningEnabled?.(previous); } catch { /* Fail closed if rollback fails. */ }
      return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
    }
  });
  ipc.handle(MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL, async (event, value) => {
    const window = getWindow();
    if (!window || !isTrustedIpcSender(event as never, window as never)) throw new Error("untrusted_ipc_sender");
    if (switching) return { ok: false, error: "busy" } satisfies DesktopMemoryModeResult;
    if (typeof value !== "boolean" || !relationshipPreferencesStore)
      return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
    const runtime = getRuntime();
    const runtimeMode = runtime?.getMemoryMode?.();
    const effective = (isDesktopMemoryMode(runtimeMode) ? runtimeMode : mode) === "memory2-confirmed-write";
    const previous = relationshipPreferencesStore.readThirdPartyLearningEnabled();
    try {
      if (effective && (!runtime || typeof runtime.setThirdPartyLearningEnabled !== "function"))
        return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
      if (effective) runtime?.setThirdPartyLearningEnabled?.(value);
      relationshipPreferencesStore.writeThirdPartyLearningEnabled(value);
      return { ok: true, status: await status() } satisfies DesktopMemoryModeResult;
    } catch {
      if (effective) try { runtime?.setThirdPartyLearningEnabled?.(previous); } catch { /* Fail closed if rollback fails. */ }
      return { ok: false, error: "operation_failed" } satisfies DesktopMemoryModeResult;
    }
  });
  ipc.handle(MEMORY_CLEAR_ALL_CHANNEL, async (event, value): Promise<DesktopMemoryClearResult> => {
    const window = getWindow();
    if (!window || !isTrustedIpcSender(event as never, window as never)) throw new Error("untrusted_ipc_sender");
    if (value !== undefined || switching) return { ok: false, error: "busy" };
    const runtime = getRuntime();
    const runtimeMode = runtime?.getMemoryMode?.();
    if (!resolveWriteStorePath()) return { ok: false, error: "memory2_write_unavailable" };
    if (!beginRuntimeSwitch()) return { ok: false, error: "busy" };
    switching = true;
    try {
      const cleared = runtimeMode === "memory2-confirmed-write"
        ? typeof runtime?.clearAllMemory === "function" && await runtime.clearAllMemory()
        : await clearMemoryStore();
      return cleared
        ? { ok: true }
        : { ok: false, error: "operation_failed" };
    } catch {
      return { ok: false, error: "operation_failed" };
    } finally {
      switching = false;
      endRuntimeSwitch();
    }
  });
  return () => {
    ipc.removeHandler(MEMORY_MODE_GET_CHANNEL);
    ipc.removeHandler(MEMORY_MODE_SET_CHANNEL);
    ipc.removeHandler(MEMORY_RELATIONSHIP_LEARNING_SET_CHANNEL);
    ipc.removeHandler(MEMORY_THIRD_PARTY_LEARNING_SET_CHANNEL);
    ipc.removeHandler(MEMORY_CLEAR_ALL_CHANNEL);
  };
}
