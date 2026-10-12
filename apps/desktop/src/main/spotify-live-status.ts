import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
// @ts-expect-error The shared JavaScript Runtime intentionally has no generated declaration file.
import { executeTool } from "../../../../src/tools/index.js";
// @ts-expect-error The shared JavaScript Runtime intentionally has no generated declaration file.
import { defaultPermissionPolicy } from "../../../../src/tools/permissions.js";
// @ts-expect-error The shared JavaScript Runtime intentionally has no generated declaration file.
import { createSpotifyNowPlayingCard } from "../../../../src/tools/spotify.js";
// @ts-expect-error The shared JavaScript Runtime intentionally has no generated declaration file.
import { formatSpotifyActionOutcome } from "../../../../src/integrations/spotify/playback.js";
import {
  SPOTIFY_CONTROL_CHANNEL, SPOTIFY_LIVE_STATUS_CHANNEL, SPOTIFY_LIVE_STATUS_EVENT_CHANNEL,
  SPOTIFY_LIVE_VISIBILITY_CHANNEL, type SpotifyControlErrorCode, type SpotifyLiveStatus,
  type SpotifyPlaybackControl, type SpotifyStateVerification,
} from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";
import { isSpotifyPlaybackControl } from "../shared/spotify-live-ipc-validation.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const AUTH_ERRORS = new Set(["spotify_auth_required", "spotify_auth_expired", "spotify_reauthorization_required", "spotify_auth_error",
  "spotify_token_store_error", "spotify_config_missing", "spotify_config_invalid"]);
const STATE_VERIFICATIONS = new Set<SpotifyStateVerification>([
  "target_transition_observed", "target_already_observed", "previous_track_restarted_observed",
]);

function isStateVerification(value: string | undefined): value is SpotifyStateVerification {
  return typeof value === "string" && STATE_VERIFICATIONS.has(value as SpotifyStateVerification);
}

type ToolResult = {
  success?: boolean;
  outcome?: string;
  playing?: boolean;
  track?: { name?: string; artists?: string[]; imageUrl?: string | null; spotifyUrl?: string | null } | null;
  devices?: Array<{ restricted?: boolean }>;
  confirmed?: boolean;
  stateConfirmed?: boolean;
  accepted?: boolean;
  verification?: string;
  retryAfter?: number | null;
  error?: { code?: string; message?: string };
};
type ToolExecutor = (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => Promise<ToolResult>;
type Diagnostic = (event: string, details: Record<string, unknown>) => void;
const UNCERTAIN_ACTION_MESSAGE = "Spotify recibió la acción, pero no devolvió una confirmación verificable. El cambio pudo aplicarse; no se repetirá automáticamente.";

function playbackObservation(status: SpotifyLiveStatus): string | null {
  if (!status.connected || !status.deviceAvailable || status.state === "unavailable") return null;
  const track = status.track;
  return JSON.stringify([status.state, track?.spotifyUrl ?? null, track?.name ?? null,
    track?.artists.join("|") ?? null, track?.playing ?? null]);
}
type WindowLike = BrowserWindow & {
  isVisible(): boolean;
  isMinimized(): boolean;
  webContents: BrowserWindow["webContents"] & { send(channel: string, payload: unknown): void };
};
interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, payload?: unknown) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: { sender: object; senderFrame: object | null }, payload: unknown) => void): void;
  removeAllListeners(channel: string): void;
}

function safeStatusError(code?: string): string {
  if (code && AUTH_ERRORS.has(code)) return "Conectá Spotify desde Nexa para ver la reproducción.";
  if (code === "spotify_rate_limited") return "Spotify pidió reducir la frecuencia de consultas.";
  if (code === "spotify_forbidden") return "Spotify rechazó la consulta (HTTP 403); puede deberse a permisos, cuenta o una restricción del proveedor.";
  if (code === "spotify_no_device") return "No hay un dispositivo Spotify compatible disponible.";
  if (code === "spotify_ambiguous_device") return "Hay varios dispositivos Spotify; abrí o activá uno para usar los controles.";
  return "No se pudo actualizar el estado de Spotify.";
}

function failureCode(result: ToolResult): string {
  return typeof result.error?.code === "string" ? result.error.code : "spotify_error";
}

function retryDelay(result: ToolResult): number {
  const seconds = Number(result.retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return POLL_INTERVAL_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(POLL_INTERVAL_MS, seconds * 1_000));
}

function resolveCompatibleDevice(devices: ToolResult["devices"]): "available" | "none" | "ambiguous" {
  const usable = Array.isArray(devices) ? devices.filter((device) => device?.restricted !== true) : [];
  if (usable.length === 0) return "none";
  const active = usable.filter((device) => (device as { active?: boolean }).active === true);
  if (active.length === 1) return "available";
  if (active.length > 1) return "ambiguous";
  const desktop = usable.filter((device) => {
    const value = device as { type?: string; name?: string };
    return value.type === "computer" && /spotify|desktop|laptop|pc/iu.test(value.name ?? "");
  });
  if (desktop.length === 1) return "available";
  if (desktop.length > 1 || usable.length > 1) return "ambiguous";
  return "available";
}

export class SpotifyLiveStatusService {
  private status: SpotifyLiveStatus = {
    state: "loading", connected: false, deviceAvailable: false, controlsEnabled: false,
    track: null, message: null, updatedAt: null,
  };
  private started = false;
  private windowVisible = false;
  private rendererVisible = false;
  private inFlight = false;
  private controlInFlight = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryAfterAt = 0;
  private readonly listeners = new Set<(status: SpotifyLiveStatus) => void>();
  private refreshPromise: Promise<SpotifyLiveStatus> | null = null;

  constructor(
    private readonly getWindow: () => WindowLike | null,
    private readonly execute: ToolExecutor = executeTool as ToolExecutor,
    private readonly schedule: typeof setTimeout = setTimeout,
    private readonly cancelSchedule: typeof clearTimeout = clearTimeout,
    private readonly now: () => number = Date.now,
    private readonly diagnostic: Diagnostic = () => undefined,
  ) {}

  getSnapshot = (): SpotifyLiveStatus => this.status;
  subscribe = (listener: (status: SpotifyLiveStatus) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.stopped) return;
    this.started = true;
    this.syncPolling();
  }

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
    this.syncPolling();
  }

  setRendererVisible(visible: boolean): void {
    this.rendererVisible = visible;
    this.syncPolling();
  }

  async refresh(): Promise<SpotifyLiveStatus> {
    if (this.refreshPromise) return this.refreshPromise;
    this.inFlight = true;
    this.refreshPromise = this.readStatus().then((next) => {
      this.publish(next);
      return next;
    }).catch(() => {
      const next: SpotifyLiveStatus = { state: "unavailable", connected: false, deviceAvailable: false,
        controlsEnabled: false, track: null, message: "No se pudo actualizar el estado de Spotify.", updatedAt: this.now() };
      this.publish(next);
      return next;
    }).finally(() => {
      this.inFlight = false;
      this.refreshPromise = null;
      this.scheduleNext();
    });
    return this.refreshPromise;
  }

  async control(action: SpotifyPlaybackControl): Promise<
    | { ok: true; action: SpotifyPlaybackControl; outcome: "provider_accepted"; providerAccepted: true; reconciliation: "available" | "unavailable" }
    | { ok: true; action: SpotifyPlaybackControl; outcome: "state_confirmed"; stateConfirmed: true;
        verification: SpotifyStateVerification; reconciliation: "available" | "unavailable" }
    | { ok: false; action: SpotifyPlaybackControl; reconciliation?: "changed" | "unchanged" | "unavailable";
        error: { code: SpotifyControlErrorCode; message: string } }
  > {
    if (!isSpotifyPlaybackControl(action)) return this.controlError("play", "operation_failed");
    const requestId = randomUUID();
    if (this.controlInFlight) {
      this.trace("spotify_control_result", { requestId, tool: `spotify_${action}`, stage: "desktop_control", outcome: "rejected", errorCode: "busy" });
      return this.controlError(action, "busy");
    }
    this.controlInFlight = true;
    const startedAt = this.now();
    this.trace("spotify_control_started", { requestId, tool: `spotify_${action}`, stage: "desktop_control", outcome: "started" });
    if (this.timer) this.cancelSchedule(this.timer);
    this.timer = null;
    try {
      const current = this.refreshPromise ? await this.refreshPromise : await this.refresh();
      if (!current.connected) return this.controlError(action, "not_connected");
      if (!current.controlsEnabled) return this.controlError(action, "no_device");
      const tool = ({ play: "spotify_play", pause: "spotify_pause", previous: "spotify_previous", next: "spotify_next" } as const)[action];
      const args = action === "play" ? { query: "", type: "track" } : {};
      const result = await this.execute(tool, args, { permissionPolicy: defaultPermissionPolicy, requestId,
        diagnostic: (event: string, details: Record<string, unknown>) => this.trace(event, { ...details, requestId }) });
      const providerAccepted = result.success === true && result.accepted === true && result.outcome === "provider_accepted";
      const stateVerification = result.verification;
      const stateConfirmed = result.success === true && result.stateConfirmed === true && result.outcome === "state_confirmed"
        && isStateVerification(stateVerification);
      if (!providerAccepted && !stateConfirmed) {
        const code = failureCode(result);
        this.trace("spotify_control_result", { requestId, tool, stage: "provider_write", outcome: result.outcome ?? "rejected",
          errorCode: code, durationMs: Math.max(0, this.now() - startedAt) });
        if (code === "spotify_rate_limited") this.retryAfterAt = this.now() + retryDelay(result);
        if (result.outcome === "uncertain" || code === "spotify_action_outcome_uncertain") {
          const refreshed = await this.refresh();
          const before = playbackObservation(current);
          const after = playbackObservation(refreshed);
          const fallbackObservation = before === null || after === null ? "unavailable" : before === after ? "unchanged" : "changed";
          const verification = result.verification ?? "unavailable";
          const targetObserved = ["target_transition_observed", "target_already_observed", "target_state_observed"].includes(verification);
          const observedState = action === "play" && targetObserved ? "playing"
            : action === "pause" && targetObserved ? "paused"
              : (action === "next" || action === "previous") && verification === "track_changed_observed" ? "track_changed"
                : action === "previous" && verification === "previous_track_restarted_observed" ? "track_restarted" : undefined;
          const observation = ["target_transition_observed", "track_changed_observed"].includes(verification)
            ? "changed" : ["target_already_observed", "unchanged"].includes(verification) ? "unchanged"
              : verification === "unavailable" ? fallbackObservation : "unavailable";
          this.trace("spotify_control_post_state_observed", { requestId, tool, stage: "desktop_reconciliation",
            outcome: "uncertain", reconciliation: observation, verification, durationMs: Math.max(0, this.now() - startedAt) });
          const message = (typeof result.verification === "string"
            ? formatSpotifyActionOutcome(action, "uncertain", verification) : null) ??
            (observation === "changed"
              ? "Spotify no confirmó la acción. La lectura posterior muestra un cambio, pero no permite atribuirlo con certeza. No se repetirá automáticamente."
              : observation === "unchanged"
                ? "Spotify no confirmó la acción y la lectura posterior no muestra un cambio verificable. No se repetirá automáticamente."
                : UNCERTAIN_ACTION_MESSAGE);
          return { ok: false, action, reconciliation: observation, ...(observedState ? { observedState } : {}),
            error: { code: "outcome_uncertain", message } };
        }
        await this.refresh();
        return this.controlError(action, mapControlError(code));
      }
      // A successful provider write or verified desired state remains successful
      // when the follow-up status refresh is unavailable.
      let reconciliation: "available" | "unavailable" = "unavailable";
      try {
        const refreshed = await this.refresh();
        if (refreshed.connected && refreshed.deviceAvailable && refreshed.state !== "unavailable") reconciliation = "available";
      } catch { /* Reconciliation cannot retroactively reject an accepted provider action. */ }
      const outcome = stateConfirmed ? "state_confirmed" : "provider_accepted";
      this.trace("spotify_control_result", { requestId, tool, stage: "desktop_reconciliation", outcome,
        reconciliation, durationMs: Math.max(0, this.now() - startedAt) });
      return stateConfirmed
        ? { ok: true, action, outcome: "state_confirmed", stateConfirmed: true,
            verification: stateVerification, reconciliation }
        : { ok: true, action, outcome: "provider_accepted", providerAccepted: true, reconciliation };
    } catch {
      this.trace("spotify_control_result", { requestId, tool: `spotify_${action}`, stage: "desktop_control", outcome: "failed",
        errorCode: "operation_failed", durationMs: Math.max(0, this.now() - startedAt) });
      await this.refresh();
      return this.controlError(action, "operation_failed");
    } finally {
      this.controlInFlight = false;
      this.scheduleNext();
    }
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) this.cancelSchedule(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private async readStatus(): Promise<SpotifyLiveStatus> {
    const devices = await this.execute("spotify_get_devices", {}, { permissionPolicy: defaultPermissionPolicy });
    const deviceCode = devices.success === true ? null : failureCode(devices);
    if (deviceCode && AUTH_ERRORS.has(deviceCode)) return this.unavailable("not_connected", false, deviceCode, devices);
    if (!devices.success) {
      if (deviceCode === "spotify_rate_limited") this.retryAfterAt = this.now() + retryDelay(devices);
      return this.unavailable("unavailable", false, deviceCode ?? "spotify_error", devices);
    }
    const deviceResolution = resolveCompatibleDevice(devices.devices);
    const deviceAvailable = deviceResolution === "available";
    if (!deviceAvailable) return this.unavailable("no_device", true,
      deviceResolution === "ambiguous" ? "spotify_ambiguous_device" : "spotify_no_device", devices);

    const current = await this.execute("spotify_get_current_track", {}, { permissionPolicy: defaultPermissionPolicy });
    if (!current.success) {
      const code = failureCode(current);
      if (AUTH_ERRORS.has(code)) return this.unavailable("not_connected", false, code, current);
      const status = this.unavailable(code === "spotify_no_device" ? "no_device" : "unavailable", true, code, current);
      if (code !== "spotify_no_device") status.deviceAvailable = true;
      if (code === "spotify_rate_limited") this.retryAfterAt = this.now() + retryDelay(current);
      return status;
    }
    const track = createSpotifyNowPlayingCard({ success: true, track: current.track, playing: current.playing === true });
    return { state: track ? (current.playing ? "playing" : "paused") : "no_track", connected: true,
      deviceAvailable: true, controlsEnabled: true, track, message: null, updatedAt: this.now() };
  }

  private unavailable(state: SpotifyLiveStatus["state"], connected: boolean, code: string, result: ToolResult): SpotifyLiveStatus {
    if (code === "spotify_rate_limited") this.retryAfterAt = this.now() + retryDelay(result);
    return { state, connected, deviceAvailable: false, controlsEnabled: false,
      track: null, message: safeStatusError(code), updatedAt: this.now() };
  }

  private publish(status: SpotifyLiveStatus): void {
    this.status = status;
    for (const listener of this.listeners) { try { listener(status); } catch { /* Subscribers cannot change playback state. */ } }
    const window = this.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(SPOTIFY_LIVE_STATUS_EVENT_CHANNEL, status);
  }

  private syncPolling(): void {
    if (!this.started || this.stopped || !this.isVisible()) {
      if (this.timer) this.cancelSchedule(this.timer);
      this.timer = null;
      return;
    }
    if (!this.timer && !this.inFlight && !this.status.connected && this.status.state === "not_connected") return;
    if (!this.timer && !this.inFlight) void this.refresh();
  }

  private isVisible(): boolean {
    const window = this.getWindow();
    return this.windowVisible && this.rendererVisible && Boolean(window?.isVisible() && !window.isMinimized());
  }

  private scheduleNext(): void {
    if (!this.started || this.stopped || !this.isVisible() || this.timer || this.controlInFlight) return;
    if (this.status.state === "not_connected") return;
    const delay = Math.max(POLL_INTERVAL_MS, this.retryAfterAt - this.now());
    this.timer = this.schedule(() => { this.timer = null; if (this.isVisible()) void this.refresh(); }, delay);
  }

  private controlError(action: SpotifyPlaybackControl, code: SpotifyControlErrorCode) {
    const messages: Record<SpotifyControlErrorCode, string> = {
      not_connected: "Conectá Spotify desde Nexa para usar estos controles.",
      no_device: "No hay un dispositivo Spotify compatible disponible.",
      permission_denied: "La política de permisos no permite esta acción.",
      rate_limited: "Spotify pidió reducir la frecuencia de acciones.",
      provider_restricted: "Spotify rechazó la acción (HTTP 403); puede deberse a permisos, cuenta o una restricción del proveedor.",
      busy: "Spotify está procesando otra acción.",
      operation_failed: "Spotify no pudo completar la acción.",
      outcome_uncertain: UNCERTAIN_ACTION_MESSAGE,
    };
    return { ok: false as const, action, error: { code, message: messages[code] } };
  }

  private trace(event: string, details: Record<string, unknown>): void {
    try { this.diagnostic(event, details); } catch { /* Diagnostics cannot alter playback behavior. */ }
  }
}

function mapControlError(code: string): SpotifyControlErrorCode {
  if (code === "spotify_action_outcome_uncertain" || code === "spotify_unexpected_write_response") return "outcome_uncertain";
  if (AUTH_ERRORS.has(code)) return "not_connected";
  if (code === "spotify_no_device" || code === "device_timeout" || code === "ambiguous_device") return "no_device";
  if (code === "permission_denied") return "permission_denied";
  if (code === "spotify_rate_limited") return "rate_limited";
  if (code === "spotify_forbidden") return "provider_restricted";
  return "operation_failed";
}

function trusted(event: IpcMainInvokeEvent | { sender: object; senderFrame: object | null }, window: WindowLike | null): boolean {
  return Boolean(window && isTrustedIpcSender(event as never, window as never));
}

let service: SpotifyLiveStatusService | null = null;
export function registerSpotifyLiveStatusHandlers(
  getWindow: () => BrowserWindow | null,
  ipc: IpcMainLike = ipcMain,
  execute?: ToolExecutor,
  diagnostic?: Diagnostic,
): SpotifyLiveStatusService {
  removeSpotifyLiveStatusHandlers(ipc);
  service = new SpotifyLiveStatusService(getWindow as () => WindowLike | null, execute, setTimeout, clearTimeout, Date.now, diagnostic);
  ipc.handle(SPOTIFY_LIVE_STATUS_CHANNEL, (event) => {
    const window = getWindow() as WindowLike | null;
    if (!trusted(event, window)) throw new Error("untrusted_ipc_sender");
    return service!.refresh();
  });
  ipc.handle(SPOTIFY_CONTROL_CHANNEL, async (event, payload) => {
    const window = getWindow() as WindowLike | null;
    if (!trusted(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isSpotifyPlaybackControl(payload)) return { ok: false, action: "play", error: { code: "operation_failed", message: "La acción de Spotify no es válida." } };
    return service!.control(payload);
  });
  ipc.on(SPOTIFY_LIVE_VISIBILITY_CHANNEL, (event, payload) => {
    const window = getWindow() as WindowLike | null;
    if (!trusted(event, window) || typeof payload !== "boolean") return;
    service!.setRendererVisible(payload);
  });
  return service;
}

export function removeSpotifyLiveStatusHandlers(ipc: IpcMainLike = ipcMain): void {
  ipc.removeHandler(SPOTIFY_LIVE_STATUS_CHANNEL);
  ipc.removeHandler(SPOTIFY_CONTROL_CHANNEL);
  ipc.removeAllListeners(SPOTIFY_LIVE_VISIBILITY_CHANNEL);
  service?.stop();
  service = null;
}
