import { describe, expect, it, vi } from "vitest";
import { MicrophoneDeviceStore } from "../src/renderer/audio/microphone-device-store";

function fakeDevices(initial: MediaDeviceInfo[]) {
  const listeners = new Set<() => void>();
  let current = initial;
  const mediaDevices = {
    enumerateDevices: vi.fn(async () => current),
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  return { mediaDevices, set(value: MediaDeviceInfo[]) { current = value; }, emitChange() { for (const listener of [...listeners]) listener(); } };
}

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "group", toJSON: () => ({}) } as MediaDeviceInfo;
}

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    read: (key: string) => values.get(key) ?? null,
  };
}

describe("MicrophoneDeviceStore", () => {
  it("stays disabled without enumeration or device listeners when isolated", async () => {
    const devices = fakeDevices([device("audioinput", "mic-a", "USB Mic")]);
    const store = new MicrophoneDeviceStore({ enabled: false, mediaDevices: devices.mediaDevices });

    store.start();
    await store.refresh();

    expect(devices.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    expect(devices.mediaDevices.addEventListener).not.toHaveBeenCalled();
    expect(store.getSnapshot().error).toBe(true);
  });

  it("enumerates audio inputs only and gives unnamed pre-permission devices a clear label", async () => {
    const devices = fakeDevices([
      device("audioinput", "default", "Default - Headset Microphone"),
      device("audioinput", "mic-a", ""),
      device("audiooutput", "speaker", "Speakers"),
      device("videoinput", "camera", "Camera"),
    ]);
    const store = new MicrophoneDeviceStore({ mediaDevices: devices.mediaDevices });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
    expect(devices.mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ defaultDeviceLabel: "Default - Headset Microphone", selectedDeviceId: null });
    expect(store.getSnapshot().devices).toEqual([{ deviceId: "mic-a", label: "Micrófono 1 (nombre no disponible hasta conceder permiso)" }]);
    store.destroy();
  });

  it("starts on Windows default and persists/reloads a chosen input", async () => {
    const media = fakeDevices([device("audioinput", "mic-a", "USB Mic")]);
    const storage = fakeStorage();
    const store = new MicrophoneDeviceStore({ mediaDevices: media.mediaDevices, storage });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
    expect(store.getSnapshot().selectedDeviceId).toBeNull();
    expect(store.getCaptureDeviceId()).toBeNull();
    store.select("mic-a");
    expect(storage.read("nexa.desktop.microphone-device.v1")).toBe("mic-a");
    expect(store.getCaptureDeviceId()).toBe("mic-a");

    const restored = new MicrophoneDeviceStore({ mediaDevices: media.mediaDevices, storage });
    restored.start();
    await vi.waitFor(() => expect(restored.getSnapshot().loading).toBe(false));
    expect(restored.getSnapshot().selectedDeviceId).toBe("mic-a");
    expect(restored.getCaptureDeviceId()).toBe("mic-a");
    store.destroy();
    restored.destroy();
  });

  it("marks a removed preference unavailable, resolves capture to default, and follows devicechange", async () => {
    const media = fakeDevices([device("audioinput", "mic-a", "USB Mic")]);
    const storage = fakeStorage({ "nexa.desktop.microphone-device.v1": "mic-a" });
    const store = new MicrophoneDeviceStore({ mediaDevices: media.mediaDevices, storage });
    expect(store.getCaptureDeviceId()).toBe("mic-a");
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
    expect(store.getCaptureDeviceId()).toBe("mic-a");

    media.set([device("audioinput", "default", "Default - Laptop Mic")]);
    media.emitChange();
    await vi.waitFor(() => expect(store.getSnapshot().selectedAvailable).toBe(false));
    expect(store.getCaptureDeviceId()).toBeNull();
    expect(store.getSnapshot().notice).toMatch(/no está disponible/);
    expect(store.getSnapshot().devices).toEqual([]);

    media.set([device("audioinput", "mic-a", "USB Mic")]);
    media.emitChange();
    await vi.waitFor(() => expect(store.getSnapshot().selectedAvailable).toBe(true));
    expect(store.getCaptureDeviceId()).toBe("mic-a");

    store.useDefault();
    expect(store.getCaptureDeviceId()).toBeNull();
    expect(storage.read("nexa.desktop.microphone-device.v1")).toBe("");
    store.destroy();
    expect(media.mediaDevices.removeEventListener).toHaveBeenCalledOnce();
  });

  it("retains the system default if enumeration fails without requesting permission", async () => {
    const media = fakeDevices([]);
    media.mediaDevices.enumerateDevices.mockRejectedValueOnce(new Error("device enumeration unavailable"));
    const store = new MicrophoneDeviceStore({ mediaDevices: media.mediaDevices });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
    expect(store.getSnapshot().error).toBe(true);
    expect(store.getSnapshot().selectedDeviceId).toBeNull();
    expect(store.getSnapshot().devices).toEqual([]);
    expect(media.mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
    store.destroy();
  });
});
