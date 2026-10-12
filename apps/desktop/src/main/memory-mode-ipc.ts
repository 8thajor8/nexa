import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  MEMORY_MODE_GET_CHANNEL, MEMORY_MODE_SET_CHANNEL,
  isDesktopMemoryMode, type DesktopMemoryMode, type DesktopMemoryModeResult,
  type DesktopMemoryModeStatus,
} from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import type { MemoryModeFallbackReason } from "./memory-mode-preferences.js";

const SYNTHETIC_EDITOR_FACT = "El usuario ficticio prefiere VS Code como editor de código.";
const SYNTHETIC_EDITOR_QUERY = "¿Qué editor de código prefiero?";

export interface MemoryModeRuntime { close(): Promise<void>; getMemoryMode?(): string; }
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
  openReader,
  beginRuntimeSwitch,
  refreshRuntimeAfterSwitch,
  endRuntimeSwitch,
  initialMode = "memory2-confirmed-write",
  initialFallbackReason = null,
  preferencesStore,
  ipc = ipcMain,
}: {
  getWindow: () => BrowserWindow | null;
  getRuntime: () => MemoryModeRuntime | null;
  setRuntime: (runtime: MemoryModeRuntime | null) => void;
  createRuntime: (mode: DesktopMemoryMode, storePath?: string) => MemoryModeRuntime | Promise<MemoryModeRuntime>;
  resolveStorePath: () => string | null;
  resolveWriteStorePath: () => string | null;
  prepareWriteStore: (storePath: string) => Promise<void>;
  openReader: (options: { storePath: string }) => Promise<MemoryModeReader>;
  beginRuntimeSwitch: () => boolean;
  refreshRuntimeAfterSwitch: () => void;
  endRuntimeSwitch: () => void;
  initialMode?: DesktopMemoryMode;
  initialFallbackReason?: MemoryModeFallbackReason;
  preferencesStore?: { write(mode: DesktopMemoryMode): void };
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
    };
  };
  ipc.removeHandler(MEMORY_MODE_GET_CHANNEL);
  ipc.removeHandler(MEMORY_MODE_SET_CHANNEL);
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
  return () => {
    ipc.removeHandler(MEMORY_MODE_GET_CHANNEL);
    ipc.removeHandler(MEMORY_MODE_SET_CHANNEL);
  };
}
