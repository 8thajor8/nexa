import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import { isMasterVolumePercent } from "../shared/master-volume-ipc-validation.js";
import type { MasterVolumeStatus } from "../shared/ipc-contract.js";

export const MASTER_VOLUME_GET_CHANNEL = "audio:master-volume:get";
export const MASTER_VOLUME_SET_CHANNEL = "audio:master-volume:set";
export const MASTER_VOLUME_EVENT_CHANNEL = "audio:master-volume:event";
export const MASTER_VOLUME_POLL_INTERVAL_MS = 2_000;

interface VolumeBackend {
  getVolume(): Promise<number>;
  setVolume(value: number): Promise<void>;
}
interface VolumeWindow extends BrowserWindow {
  webContents: BrowserWindow["webContents"] & { send(channel: string, payload: unknown): void };
}
interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, payload?: unknown) => unknown): void;
  removeHandler(channel: string): void;
}
interface TimerPort {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
type MasterVolumeTrace = { stage: "handlers" | "get_request" | "set_request"; outcome: "registered" | "started" | "completed" | "failed"; available?: boolean; errorKind?: "ipc_handler_failed" };
interface ServiceOptions {
  getWindow: () => BrowserWindow | null;
  backend?: VolumeBackend;
  loadBackend?: () => Promise<VolumeBackend>;
  ipc?: IpcMainLike;
  timers?: TimerPort;
  pollIntervalMs?: number;
  onDiagnostic?: (details: { stage: "backend_load" | "get_volume" | "set_volume"; errorName: string; errorCode: string | null; errorKind: string }) => void;
  onTrace?: (details: MasterVolumeTrace) => void;
}

const unavailable: MasterVolumeStatus = { available: false, volume: null, errorCode: "device_unavailable" };

function safeVolumeError(error: unknown): MasterVolumeStatus["errorCode"] {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["EACCES", "EPERM", "ERROR_ACCESS_DENIED", "0x80070005"].includes(code.toUpperCase())) return "access_denied";
  if (["ENODEV", "ERROR_NOT_FOUND", "0x88890004"].includes(code.toUpperCase())) return "device_unavailable";
  return "operation_failed";
}

function safeFailureDetails(error: unknown): { errorName: string; errorCode: string | null; errorKind: string } {
  const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; message?: unknown } : {};
  const rawName = typeof value.name === "string" ? value.name : "Error";
  const errorName = /^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(rawName) ? rawName : "Error";
  const rawCode = typeof value.code === "string" ? value.code : "";
  const errorCode = /^[A-Za-z0-9_.:-]{1,48}$/u.test(rawCode) ? rawCode : null;
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const code = (errorCode ?? "").toUpperCase();
  const errorKind = ["ENOENT", "MODULE_NOT_FOUND"].includes(code) || /not found|cannot find the file/u.test(message) ? "helper_or_module_missing"
    : ["EACCES", "EPERM", "ERROR_ACCESS_DENIED", "0X80070005"].includes(code) || /access denied|permission/u.test(message) ? "access_denied"
      : ["ENODEV", "ERROR_NOT_FOUND", "0X88890004"].includes(code) || /device|endpoint/u.test(message) ? "device_unavailable"
        : "operation_failed";
  return { errorName, errorCode, errorKind };
}

async function defaultBackend(): Promise<VolumeBackend> {
  if (process.platform !== "win32") throw Object.assign(new Error("windows_audio_unavailable"), { code: "ENODEV" });
  const imported = await import("loudness");
  const api = ("default" in imported ? imported.default : imported) as unknown as VolumeBackend;
  return api;
}

export class WindowsMasterVolumeService {
  private status: MasterVolumeStatus = unavailable;
  private backendPromise: Promise<VolumeBackend> | null = null;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<MasterVolumeStatus> | null = null;
  private lastDiagnosticKey: string | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ServiceOptions) {}

  getSnapshot = (): MasterVolumeStatus => this.status;

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.refresh().finally(() => this.schedulePoll());
  }

  stop(): void {
    this.stopped = true;
    if (this.pollingTimer) (this.options.timers ?? globalThis).clearTimeout(this.pollingTimer);
    this.pollingTimer = null;
  }

  refresh(): Promise<MasterVolumeStatus> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.enqueue(async () => {
      let backend: VolumeBackend;
      try {
        backend = await this.getBackend();
      } catch (error) {
        this.reportFailure("backend_load", error);
        this.publish({ available: false, volume: null, errorCode: safeVolumeError(error) });
        return this.status;
      }
      try {
        const value = await backend.getVolume();
        if (!isMasterVolumePercent(value)) throw new Error("invalid_master_volume_value");
        this.lastDiagnosticKey = null;
        this.publish({ available: true, volume: value, errorCode: null });
      } catch (error) {
        this.reportFailure("get_volume", error);
        this.publish({ available: false, volume: null, errorCode: safeVolumeError(error) });
      }
      return this.status;
    }).finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  setVolume(value: number): Promise<MasterVolumeStatus> {
    if (!isMasterVolumePercent(value)) return Promise.resolve({ available: false, volume: null, errorCode: "operation_failed" });
    return this.enqueue(async () => {
      if (this.status.available && this.status.volume === value) return this.status;
      let backend: VolumeBackend;
      try {
        backend = await this.getBackend();
      } catch (error) {
        this.reportFailure("backend_load", error);
        this.publish({ available: false, volume: null, errorCode: safeVolumeError(error) });
        return this.status;
      }
      try {
        await backend.setVolume(value);
        this.lastDiagnosticKey = null;
        this.publish({ available: true, volume: value, errorCode: null });
      } catch (error) {
        this.reportFailure("set_volume", error);
        this.publish({ available: false, volume: null, errorCode: safeVolumeError(error) });
      }
      return this.status;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private getBackend(): Promise<VolumeBackend> {
    this.backendPromise ??= (this.options.backend ? Promise.resolve(this.options.backend)
      : this.options.loadBackend ? this.options.loadBackend() : defaultBackend()).catch((error) => {
      this.backendPromise = null;
      throw error;
    });
    return this.backendPromise;
  }

  private reportFailure(stage: "backend_load" | "get_volume" | "set_volume", error: unknown): void {
    const details = safeFailureDetails(error);
    const key = `${stage}:${details.errorName}:${details.errorCode ?? "none"}:${details.errorKind}`;
    if (key === this.lastDiagnosticKey) return;
    this.lastDiagnosticKey = key;
    this.options.onDiagnostic?.({ stage, ...details });
  }

  private publish(next: MasterVolumeStatus): void {
    if (this.status.available === next.available && this.status.volume === next.volume && this.status.errorCode === next.errorCode) return;
    this.status = next;
    const window = this.options.getWindow() as VolumeWindow | null;
    if (window && !window.isDestroyed()) {
      try { window.webContents.send(MASTER_VOLUME_EVENT_CHANNEL, next); } catch { /* Window may be closing. */ }
    }
  }

  private schedulePoll(): void {
    if (!this.started || this.stopped || this.pollingTimer) return;
    const timers = this.options.timers ?? globalThis;
    this.pollingTimer = timers.setTimeout(() => {
      this.pollingTimer = null;
      void this.refresh().finally(() => this.schedulePoll());
    }, this.options.pollIntervalMs ?? MASTER_VOLUME_POLL_INTERVAL_MS);
  }
}

function trusted(event: IpcMainInvokeEvent, window: VolumeWindow | null): boolean {
  return Boolean(window && isTrustedIpcSender(event as never, window as never));
}

let currentService: WindowsMasterVolumeService | null = null;

export function registerMasterVolumeIpcHandlers(
  getWindow: () => BrowserWindow | null,
  options: Omit<ServiceOptions, "getWindow" | "ipc"> = {},
  ipc: IpcMainLike = ipcMain,
): WindowsMasterVolumeService {
  removeMasterVolumeIpcHandlers(ipc);
  const service = new WindowsMasterVolumeService({ ...options, getWindow, ipc });
  currentService = service;
  ipc.handle(MASTER_VOLUME_GET_CHANNEL, async (event) => {
    if (!trusted(event, getWindow() as VolumeWindow | null)) throw new Error("untrusted_ipc_sender");
    options.onTrace?.({ stage: "get_request", outcome: "started" });
    try {
      const status = await service.refresh();
      options.onTrace?.({ stage: "get_request", outcome: "completed", available: status.available });
      return status;
    } catch {
      options.onTrace?.({ stage: "get_request", outcome: "failed", errorKind: "ipc_handler_failed" });
      throw new Error("master_volume_get_failed");
    }
  });
  ipc.handle(MASTER_VOLUME_SET_CHANNEL, async (event, payload) => {
    if (!trusted(event, getWindow() as VolumeWindow | null)) throw new Error("untrusted_ipc_sender");
    if (!isMasterVolumePercent(payload)) throw new Error("invalid_master_volume_request");
    options.onTrace?.({ stage: "set_request", outcome: "started" });
    try {
      const status = await service.setVolume(payload);
      options.onTrace?.({ stage: "set_request", outcome: "completed", available: status.available });
      return status;
    } catch {
      options.onTrace?.({ stage: "set_request", outcome: "failed", errorKind: "ipc_handler_failed" });
      throw new Error("master_volume_set_failed");
    }
  });
  options.onTrace?.({ stage: "handlers", outcome: "registered" });
  service.start();
  return service;
}

export function removeMasterVolumeIpcHandlers(ipc: IpcMainLike = ipcMain): void {
  ipc.removeHandler(MASTER_VOLUME_GET_CHANNEL);
  ipc.removeHandler(MASTER_VOLUME_SET_CHANNEL);
  currentService?.stop();
  currentService = null;
}
