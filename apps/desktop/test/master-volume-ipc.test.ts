import { beforeEach, describe, expect, it, vi } from "vitest";

const electronIpc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: electronIpc }));

import { isMasterVolumePercent, isMasterVolumeStatus } from "../src/shared/master-volume-ipc-validation";
import { MASTER_VOLUME_EVENT_CHANNEL, MASTER_VOLUME_GET_CHANNEL, MASTER_VOLUME_SET_CHANNEL,
  registerMasterVolumeIpcHandlers, removeMasterVolumeIpcHandlers, WindowsMasterVolumeService } from "../src/main/master-volume-ipc";

function createHarness(initial = 42) {
  let volume = initial;
  const backend = {
    getVolume: vi.fn(async () => volume),
    setVolume: vi.fn(async (next: number) => { volume = next; }),
  };
  const listeners = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => listeners.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => listeners.delete(channel)),
  };
  const send = vi.fn();
  const mainFrame = {};
  const webContents = { mainFrame, send };
  const window = { webContents, isDestroyed: () => false };
  const timers = { setTimeout: vi.fn(() => 1 as never), clearTimeout: vi.fn() };
  return { backend, listeners, ipc, send, mainFrame, webContents, window, timers };
}

describe("Windows master volume IPC", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("validates bounded volume and status responses", () => {
    expect(isMasterVolumePercent(0)).toBe(true);
    expect(isMasterVolumePercent(100)).toBe(true);
    expect(isMasterVolumePercent(101)).toBe(false);
    expect(isMasterVolumePercent(5.5)).toBe(false);
    expect(isMasterVolumeStatus({ available: true, volume: 40, errorCode: null })).toBe(true);
    expect(isMasterVolumeStatus({ available: false, volume: null, errorCode: "access_denied" })).toBe(true);
    expect(isMasterVolumeStatus({ available: false, volume: 1, errorCode: null })).toBe(false);
  });

  it("reads and writes asynchronously, publishes changes, and refreshes external changes", async () => {
    const harness = createHarness();
    const service = new WindowsMasterVolumeService({ getWindow: () => harness.window as never,
      backend: harness.backend, timers: harness.timers });
    expect(await service.refresh()).toEqual({ available: true, volume: 42, errorCode: null });
    expect(await service.setVolume(67)).toEqual({ available: true, volume: 67, errorCode: null });
    expect(harness.backend.setVolume).toHaveBeenCalledWith(67);
    expect(harness.send).toHaveBeenLastCalledWith(MASTER_VOLUME_EVENT_CHANNEL, { available: true, volume: 67, errorCode: null });
    await harness.backend.setVolume(33);
    expect(await service.refresh()).toEqual({ available: true, volume: 33, errorCode: null });
    service.stop();
  });

  it("validates IPC sender and request values without invoking unauthorized writes", async () => {
    const harness = createHarness();
    registerMasterVolumeIpcHandlers(() => harness.window as never, { backend: harness.backend, timers: harness.timers }, harness.ipc as never);
    const get = harness.listeners.get(MASTER_VOLUME_GET_CHANNEL)!;
    const set = harness.listeners.get(MASTER_VOLUME_SET_CHANNEL)!;
    const trustedEvent = { sender: harness.webContents, senderFrame: harness.mainFrame };
    const untrustedEvent = { sender: {}, senderFrame: {} };
    await expect(set(untrustedEvent, 50)).rejects.toThrow("untrusted_ipc_sender");
    await expect(set(trustedEvent, 101)).rejects.toThrow("invalid_master_volume_request");
    expect(harness.backend.setVolume).not.toHaveBeenCalled();
    expect(await set(trustedEvent, 50)).toEqual({ available: true, volume: 50, errorCode: null });
    expect(await get(trustedEvent)).toEqual({ available: true, volume: 50, errorCode: null });
    removeMasterVolumeIpcHandlers(harness.ipc as never);
  });

  it("traces Main registration and accepted get/set request completion without logging values", async () => {
    const harness = createHarness();
    const onTrace = vi.fn();
    registerMasterVolumeIpcHandlers(() => harness.window as never, { backend: harness.backend, timers: harness.timers, onTrace }, harness.ipc as never);
    const get = harness.listeners.get(MASTER_VOLUME_GET_CHANNEL)!;
    const set = harness.listeners.get(MASTER_VOLUME_SET_CHANNEL)!;
    const trustedEvent = { sender: harness.webContents, senderFrame: harness.mainFrame };

    expect(onTrace).toHaveBeenCalledWith({ stage: "handlers", outcome: "registered" });
    await expect(get(trustedEvent)).resolves.toEqual({ available: true, volume: 42, errorCode: null });
    await expect(set(trustedEvent, 70)).resolves.toEqual({ available: true, volume: 70, errorCode: null });
    expect(onTrace.mock.calls).toContainEqual([{ stage: "get_request", outcome: "completed", available: true }]);
    expect(onTrace.mock.calls).toContainEqual([{ stage: "set_request", outcome: "completed", available: true }]);
    expect(JSON.stringify(onTrace.mock.calls)).not.toContain("70");
    removeMasterVolumeIpcHandlers(harness.ipc as never);
  });

  it("reports unavailable devices and access errors without leaking native messages", async () => {
    const denied = createHarness();
    denied.backend.getVolume.mockRejectedValue(Object.assign(new Error("private native detail"), { code: "EACCES" }));
    const service = new WindowsMasterVolumeService({ getWindow: () => denied.window as never, backend: denied.backend });
    expect(await service.refresh()).toEqual({ available: false, volume: null, errorCode: "access_denied" });
    expect(JSON.stringify(service.getSnapshot())).not.toContain("private native detail");
    service.stop();
  });

  it("reports a bounded stage and native error code once without exposing the native message", async () => {
    const failed = createHarness();
    const onDiagnostic = vi.fn();
    failed.backend.getVolume.mockRejectedValue(Object.assign(new Error("private path and user data"), { code: "ENOENT" }));
    const service = new WindowsMasterVolumeService({ getWindow: () => failed.window as never,
      backend: failed.backend, onDiagnostic, timers: failed.timers });

    await service.refresh();
    await service.refresh();

    expect(service.getSnapshot()).toEqual({ available: false, volume: null, errorCode: "operation_failed" });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith({ stage: "get_volume", errorName: "Error", errorCode: "ENOENT",
      errorKind: "helper_or_module_missing" });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private path and user data");
    service.stop();
  });

  it("identifies backend loading separately from volume access", async () => {
    const onDiagnostic = vi.fn();
    const service = new WindowsMasterVolumeService({ getWindow: () => null,
      loadBackend: () => Promise.reject(Object.assign(new Error("private module path"), { code: "MODULE_NOT_FOUND" })), onDiagnostic });
    await service.refresh();
    expect(onDiagnostic).toHaveBeenCalledWith({ stage: "backend_load", errorName: "Error", errorCode: "MODULE_NOT_FOUND",
      errorKind: "helper_or_module_missing" });
    service.stop();
  });

  it("retries loading the backend after an initial module-load failure", async () => {
    const backend = createHarness().backend;
    const loadBackend = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("private module path"), { code: "MODULE_NOT_FOUND" }))
      .mockResolvedValueOnce(backend);
    const service = new WindowsMasterVolumeService({ getWindow: () => null, loadBackend });

    expect((await service.refresh()).available).toBe(false);
    expect(await service.refresh()).toEqual({ available: true, volume: 42, errorCode: null });
    expect(loadBackend).toHaveBeenCalledTimes(2);
    service.stop();
  });
});
