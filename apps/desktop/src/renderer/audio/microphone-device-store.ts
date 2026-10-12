export interface MicrophoneInputDevice {
  readonly deviceId: string;
  readonly label: string;
}

export interface MicrophoneDeviceSnapshot {
  readonly devices: readonly MicrophoneInputDevice[];
  readonly selectedDeviceId: string | null;
  readonly selectedAvailable: boolean;
  readonly defaultDeviceLabel: string | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly notice: string | null;
}

export interface MicrophoneDeviceStoreOptions {
  readonly enabled?: boolean;
  readonly mediaDevices?: Pick<MediaDevices, "enumerateDevices" | "addEventListener" | "removeEventListener">;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

const STORAGE_KEY = "nexa.desktop.microphone-device.v1";

function browserDevices() {
  return typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
}

function browserStorage() {
  try { return typeof localStorage !== "undefined" ? localStorage : undefined; }
  catch { return undefined; }
}

/** Renderer-local device preference; enumeration never requests microphone permission. */
export class MicrophoneDeviceStore {
  private readonly mediaDevices: MicrophoneDeviceStoreOptions["mediaDevices"];
  private readonly storage: MicrophoneDeviceStoreOptions["storage"];
  private readonly listeners = new Set<() => void>();
  private snapshot: MicrophoneDeviceSnapshot;
  private started = false;
  private destroyed = false;

  constructor(options: MicrophoneDeviceStoreOptions = {}) {
    this.mediaDevices = options.enabled === false ? undefined : options.mediaDevices ?? browserDevices();
    this.storage = options.storage ?? browserStorage();
    let selectedDeviceId: string | null = null;
    try { selectedDeviceId = this.storage?.getItem(STORAGE_KEY) || null; } catch { /* Storage can be unavailable. */ }
    this.snapshot = Object.freeze({ devices: [], selectedDeviceId, selectedAvailable: selectedDeviceId === null,
      defaultDeviceLabel: null, loading: true, error: false, notice: null });
  }

  readonly getSnapshot = (): MicrophoneDeviceSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.mediaDevices?.addEventListener("devicechange", this.handleDeviceChange);
    void this.refresh();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mediaDevices?.removeEventListener("devicechange", this.handleDeviceChange);
    this.listeners.clear();
  }

  readonly refresh = async (): Promise<void> => {
    if (this.destroyed) return;
    if (!this.mediaDevices || typeof this.mediaDevices.enumerateDevices !== "function") {
      this.publish({ ...this.snapshot, loading: false, error: true });
      return;
    }
    this.publish({ ...this.snapshot, loading: true, error: false });
    try {
      const allDevices = await this.mediaDevices.enumerateDevices();
      if (this.destroyed) return;
      const audioInputs = allDevices.filter((device) => device.kind === "audioinput");
      const defaultDevice = audioInputs.find((device) => device.deviceId === "default");
      const devices = audioInputs.filter((device) => device.deviceId !== "default").map((device, index) => Object.freeze({
        deviceId: device.deviceId,
        label: device.label.trim() || `Micrófono ${index + 1} (nombre no disponible hasta conceder permiso)`,
      }));
      const selectedAvailable = this.snapshot.selectedDeviceId === null
        || devices.some((device) => device.deviceId === this.snapshot.selectedDeviceId);
      this.publish({ devices: Object.freeze(devices), selectedDeviceId: this.snapshot.selectedDeviceId,
        selectedAvailable, defaultDeviceLabel: defaultDevice?.label.trim() || null, loading: false, error: false,
        notice: selectedAvailable ? null : "El micrófono guardado no está disponible. Puedes usar el predeterminado de Windows." });
    } catch {
      if (!this.destroyed) this.publish({ ...this.snapshot, loading: false, error: true });
    }
  };

  select(deviceId: string | null): void {
    if (this.destroyed) return;
    if (deviceId !== null && !this.snapshot.devices.some((device) => device.deviceId === deviceId)) return;
    try {
      if (deviceId) this.storage?.setItem(STORAGE_KEY, deviceId);
      else this.storage?.setItem(STORAGE_KEY, "");
    } catch { /* Keep the in-memory preference if browser storage is unavailable. */ }
    this.publish({ ...this.snapshot, selectedDeviceId: deviceId, selectedAvailable: true, notice: null });
  }

  useDefault(): void { this.select(null); }

  useDefaultAfterUnavailable(): void {
    this.select(null);
    this.publish({ ...this.snapshot, notice: "El micrófono seleccionado dejó de estar disponible; se usó el predeterminado de Windows." });
  }

  /** Missing saved devices resolve to the system default, never a stale exact constraint. */
  getCaptureDeviceId(): string | null {
    return this.snapshot.selectedDeviceId && (this.snapshot.loading || this.snapshot.selectedAvailable)
      ? this.snapshot.selectedDeviceId : null;
  }

  private readonly handleDeviceChange = (): void => { void this.refresh(); };

  private publish(next: MicrophoneDeviceSnapshot): void {
    this.snapshot = Object.freeze(next);
    for (const listener of [...this.listeners]) listener();
  }
}
