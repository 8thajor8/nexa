import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSpotifyLiveStatusHandlers, SpotifyLiveStatusService, removeSpotifyLiveStatusHandlers } from "../src/main/spotify-live-status.js";
import type { SpotifyPlaybackControl } from "../src/shared/ipc-contract.js";
import { SPOTIFY_CONTROL_CHANNEL, SPOTIFY_LIVE_STATUS_CHANNEL, SPOTIFY_LIVE_VISIBILITY_CHANNEL } from "../src/shared/ipc-contract.js";
import { isSpotifyControlResponse, isSpotifyLiveStatus } from "../src/shared/spotify-live-ipc-validation.js";

const nowPlaying = {
  success: true, playing: true,
  track: { id: "track-a", name: "Blue Hour", artists: ["Nexa Test"], imageUrl: "https://i.scdn.co/image/test",
    spotifyUrl: "https://open.spotify.com/track/abc123" },
};
const windowLike = {
  isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
  webContents: { send: vi.fn() },
} as never;

function readyExecutor(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown>; context: Record<string, unknown> }> = [];
  const execute = vi.fn(async (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => {
    calls.push({ name, args, context });
    if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false }] };
    if (name === "spotify_get_current_track") return nowPlaying;
    if (name === "spotify_play" || name === "spotify_pause" || name === "spotify_next" || name === "spotify_previous") {
      return { success: true, action: name, accepted: true, outcome: "provider_accepted" };
    }
    return { success: false, error: { code: "unexpected_tool" } };
  });
  Object.assign(execute, overrides);
  return { execute, calls };
}

afterEach(() => vi.useRealTimers());

describe("Spotify live status and controls", () => {
  it("uses shared Runtime tools and validates live metadata without exposing credentials", async () => {
    const { execute, calls } = readyExecutor();
    const service = new SpotifyLiveStatusService(() => windowLike, execute);
    const status = await service.refresh();
    expect(status).toMatchObject({ state: "playing", connected: true, deviceAvailable: true, controlsEnabled: true });
    expect(status.track).toMatchObject({ name: "Blue Hour", artists: ["Nexa Test"], playing: true });
    expect(isSpotifyLiveStatus(status)).toBe(true);
    expect(calls.map(({ name }) => name)).toEqual(["spotify_get_devices", "spotify_get_current_track"]);
    expect(calls.every(({ context }) => context.permissionPolicy !== undefined)).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/token|secret|authorization/i);
    service.stop();
  });

  it("routes all playback controls through the existing dispatcher and reconciles after confirmation", async () => {
    const { execute, calls } = readyExecutor();
    const service = new SpotifyLiveStatusService(() => windowLike, execute);
    for (const action of ["previous", "pause", "play", "next"] as SpotifyPlaybackControl[]) {
      const result = await service.control(action);
      expect(result).toEqual({ ok: true, action, outcome: "provider_accepted", providerAccepted: true, reconciliation: "available" });
    }
    expect(calls.filter(({ name }) => name.startsWith("spotify_")).map(({ name }) => name)).toEqual([
      "spotify_get_devices", "spotify_get_current_track", "spotify_previous", "spotify_get_devices", "spotify_get_current_track",
      "spotify_get_devices", "spotify_get_current_track", "spotify_pause", "spotify_get_devices", "spotify_get_current_track",
      "spotify_get_devices", "spotify_get_current_track", "spotify_play", "spotify_get_devices", "spotify_get_current_track",
      "spotify_get_devices", "spotify_get_current_track", "spotify_next", "spotify_get_devices", "spotify_get_current_track",
    ]);
    expect(calls.find(({ name }) => name === "spotify_play")?.args).toEqual({ query: "", type: "track" });
    expect(calls.find(({ name }) => name === "spotify_previous")?.args).toEqual({});
    service.stop();
  });

  it("presents Spotify HTTP 403 as an ambiguous provider restriction, not proven missing scopes", async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return nowPlaying;
      return { success: false, status: 403, outcome: "rejected", error: { code: "spotify_forbidden" } };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    await service.refresh();
    const result = await service.control("play");
    expect(result).toEqual({ ok: false, action: "play", error: { code: "provider_restricted",
      message: "Spotify rechazó la acción (HTTP 403); puede deberse a permisos, cuenta o una restricción del proveedor." } });
    expect(execute.mock.calls.filter(([name]) => name === "spotify_play")).toHaveLength(1);
    service.stop();
  });

  it("traces miniplayer controls from request through provider outcome and reconciliation", async () => {
    const { execute, calls } = readyExecutor();
    const traces: Array<{ event: string; details: Record<string, unknown> }> = [];
    const service = new SpotifyLiveStatusService(() => windowLike, execute, undefined, undefined, undefined,
      (event, details) => traces.push({ event, details }));
    const result = await service.control("pause");
    expect(result).toMatchObject({ ok: true, action: "pause", outcome: "provider_accepted", providerAccepted: true, reconciliation: "available" });
    const request = calls.find(({ name }) => name === "spotify_pause")?.context;
    expect(request?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(typeof request?.diagnostic).toBe("function");
    expect(traces).toContainEqual(expect.objectContaining({ event: "spotify_control_started",
      details: expect.objectContaining({ requestId: request?.requestId, tool: "spotify_pause", outcome: "started" }) }));
    expect(traces).toContainEqual(expect.objectContaining({ event: "spotify_control_result",
      details: expect.objectContaining({ requestId: request?.requestId, stage: "desktop_reconciliation", outcome: "provider_accepted", reconciliation: "available" }) }));
    service.stop();
  });

  it("reconciles changed tracks, pause and resume state, and a connected idle player", async () => {
    let current: { success: boolean; playing: boolean; track: { name: string; artists: string[]; imageUrl: string; spotifyUrl: string } | null } = { ...nowPlaying };
    const execute = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return current;
      if (name === "spotify_pause") { current = { ...nowPlaying, playing: false }; return { success: true, accepted: true, outcome: "provider_accepted" }; }
      if (name === "spotify_play") { current = { ...nowPlaying, playing: true }; return { success: true, accepted: true, outcome: "provider_accepted" }; }
      return { success: true, accepted: true, outcome: "provider_accepted" };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    expect((await service.refresh()).state).toBe("playing");
    await service.control("pause");
    expect(service.getSnapshot().state).toBe("paused");
    await service.control("play");
    await vi.waitFor(() => expect(service.getSnapshot().state).toBe("playing"));
    current = { success: true, playing: true, track: { ...nowPlaying.track!, name: "New Track" } };
    expect((await service.refresh()).track?.name).toBe("New Track");
    current = { success: true, playing: false, track: null };
    expect(await service.refresh()).toMatchObject({ state: "no_track", connected: true, deviceAvailable: true, controlsEnabled: true });
    service.stop();
  });

  it("reports transient provider failures without inventing playback", async () => {
    const service = new SpotifyLiveStatusService(() => windowLike, async (name) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      return { success: false, error: { code: "spotify_network_error", message: "network detail" } };
    });
    expect(await service.refresh()).toMatchObject({ state: "unavailable", connected: true, deviceAvailable: true,
      controlsEnabled: false, track: null, message: "No se pudo actualizar el estado de Spotify." });
    service.stop();
  });

  it("preserves provider acceptance when the following status reconciliation fails", async () => {
    let accepted = false;
    const execute = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return accepted
        ? { success: false, error: { code: "spotify_network_error" } }
        : { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return nowPlaying;
      if (name === "spotify_next") { accepted = true; return { success: true, accepted: true, outcome: "provider_accepted" }; }
      return { success: true, accepted: true, outcome: "provider_accepted" };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    expect(await service.refresh()).toMatchObject({ connected: true, controlsEnabled: true });
    expect(await service.control("next")).toEqual({ ok: true, action: "next", outcome: "provider_accepted", providerAccepted: true, reconciliation: "unavailable" });
    expect(execute.mock.calls.filter(([name]) => name === "spotify_next")).toHaveLength(1);
    service.stop();
  });

  it("does not report an undocumented provider write response as accepted or repeat the action", async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return nowPlaying;
      return { success: false, outcome: "uncertain", error: { code: "spotify_action_outcome_uncertain",
        message: "No se repetirá automáticamente." } };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    await service.refresh();
    const result = await service.control("next");
    expect(result).toEqual({ ok: false, action: "next", reconciliation: "unchanged", error: { code: "outcome_uncertain",
      message: "Spotify no confirmó la acción y la lectura posterior no muestra un cambio verificable. No se repetirá automáticamente." } });
    expect(execute.mock.calls.filter(([name]) => name === "spotify_next")).toHaveLength(1);
    expect(calls).not.toContain("spotify_play");
    service.stop();
  });

  it("keeps an uncertain action visible after status reconciliation and does not retry it", async () => {
    let changedState = false;
    const execute = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return changedState
        ? { ...nowPlaying, track: { ...nowPlaying.track, spotifyUrl: "https://open.spotify.com/track/next123" } }
        : nowPlaying;
      if (name === "spotify_next") { changedState = true; return { success: false, outcome: "uncertain", verification: "track_changed_observed",
        error: { code: "spotify_action_outcome_uncertain" } }; }
      return { success: true };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    const result = await service.control("next");
    expect(result).toMatchObject({ ok: false, observedState: "track_changed", reconciliation: "changed", error: { code: "outcome_uncertain",
      message: "Canción cambiada" } });
    await vi.waitFor(() => expect(service.getSnapshot().state).toBe("playing"));
    expect(execute.mock.calls.filter(([name]) => name === "spotify_next")).toHaveLength(1);
    service.stop();
  });

  it("reports observed playback without attributing it to Play when the prior state was unknown", async () => {
    let reads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") {
        reads++;
        return reads === 1
          ? { success: true, playing: false, track: null }
          : { ...nowPlaying, playing: true };
      }
      if (name === "spotify_play") return { success: false, outcome: "uncertain", verification: "target_state_observed",
        error: { code: "spotify_action_outcome_uncertain" } };
      return { success: true };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    const result = await service.control("play");
    expect(result).toEqual({ ok: false, action: "play", reconciliation: "unavailable", observedState: "playing", error: { code: "outcome_uncertain",
      message: "Spotify está reproduciendo" } });
    expect(service.getSnapshot().state).toBe("playing");
    expect(execute.mock.calls.filter(([name]) => name === "spotify_play")).toHaveLength(1);
    service.stop();
  });

  it("reports a state-confirmed pause in the miniplayer without claiming HTTP acceptance", async () => {
    const expected = "Spotify pausado";
    let isPlaying = true;
    const execute = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return { ...nowPlaying, playing: isPlaying };
      if (name === "spotify_pause") { isPlaying = false; return { success: true, accepted: false, confirmed: true,
        stateConfirmed: true, outcome: "state_confirmed", verification: "target_transition_observed" }; }
      return { success: true };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    const result = await service.control("pause");
    expect(result).toEqual({ ok: true, action: "pause", outcome: "state_confirmed", stateConfirmed: true,
      verification: "target_transition_observed", reconciliation: "available" });
    expect(service.getSnapshot().state).toBe("paused");
    expect(result).not.toHaveProperty("providerAccepted");
    expect(execute.mock.calls.filter(([name]) => name === "spotify_pause")).toHaveLength(1);
    service.stop();
  });

  it("propagates dispatcher permission denial without claiming an action succeeded", async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return nowPlaying;
      return { success: false, error: { code: "permission_denied" } };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute as never);
    const result = await service.control("next");
    expect(result).toMatchObject({ ok: false, action: "next", error: { code: "permission_denied" } });
    expect(execute).toHaveBeenCalledWith("spotify_next", {}, expect.objectContaining({ permissionPolicy: expect.any(Object) }));
    service.stop();
  });

  it("disables controls without authorization or a compatible device", async () => {
    const unauthorized = new SpotifyLiveStatusService(() => windowLike, async () => ({
      success: false, error: { code: "spotify_auth_required", message: "secretly detailed provider message" },
    }));
    const authStatus = await unauthorized.refresh();
    expect(authStatus).toMatchObject({ state: "not_connected", connected: false, controlsEnabled: false });
    expect(authStatus.message).not.toContain("secretly");
    const deniedControl = await unauthorized.control("play");
    expect(deniedControl.ok).toBe(false);
    if (!deniedControl.ok) expect(deniedControl.error.code).toBe("not_connected");
    unauthorized.stop();

    const noDevice = new SpotifyLiveStatusService(() => windowLike, async () => ({ success: true, devices: [] }));
    expect(await noDevice.refresh()).toMatchObject({ state: "no_device", connected: true, controlsEnabled: false });
    const noDeviceControl = await noDevice.control("next");
    expect(noDeviceControl.ok).toBe(false);
    if (!noDeviceControl.ok) expect(noDeviceControl.error.code).toBe("no_device");
    noDevice.stop();

    const ambiguous = new SpotifyLiveStatusService(() => windowLike, async (name) => name === "spotify_get_devices"
      ? { success: true, devices: [{ restricted: false, active: false }, { restricted: false, active: false }] }
      : nowPlaying);
    expect(await ambiguous.refresh()).toMatchObject({ state: "no_device", connected: true, controlsEnabled: false,
      message: "Hay varios dispositivos Spotify; abrí o activá uno para usar los controles." });
    ambiguous.stop();
  });

  it("returns discreet typed errors and serializes simultaneous controls", async () => {
    const { execute } = readyExecutor();
    let finishAction!: (value: { success: boolean; accepted: boolean; outcome: string }) => void;
    execute.mockImplementation(async (name) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false }] };
      if (name === "spotify_get_current_track") return nowPlaying;
      if (name === "spotify_pause") return new Promise((resolve) => { finishAction = resolve; });
      return { success: true, accepted: true, outcome: "provider_accepted" };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, execute);
    const first = service.control("pause");
    await vi.waitFor(() => expect(finishAction).toBeTypeOf("function"));
    const concurrent = await service.control("next");
    expect(concurrent).toMatchObject({ ok: false, action: "next", error: { code: "busy" } });
    finishAction({ success: true, accepted: true, outcome: "provider_accepted" });
    expect(await first).toMatchObject({ ok: true, action: "pause" });
    service.stop();
  });

  it("honors Retry-After and pauses polling while hidden", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    const schedule = vi.fn((handler: TimerHandler, delay?: number) => {
      delays.push(Number(delay));
      pending.push(handler as () => void);
      return pending.length as never;
    });
    const cancel = vi.fn();
    const executor = vi.fn(async () => ({ success: false, retryAfter: 37, error: { code: "spotify_rate_limited" } }));
    const service = new SpotifyLiveStatusService(() => windowLike, executor, schedule as never, cancel as never, () => 1_000);
    service.start();
    service.setRendererVisible(true);
    service.setWindowVisible(true);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
    expect(delays[0]).toBe(37_000);
    service.setWindowVisible(false);
    expect(cancel).toHaveBeenCalled();
    service.stop();
  });

  it("cleans up scheduled polling when the Desktop service stops", async () => {
    const scheduled: TimerHandler[] = [];
    const cancel = vi.fn();
    const schedule = vi.fn((handler: TimerHandler) => { scheduled.push(handler); return scheduled.length as never; });
    const { execute } = readyExecutor();
    const service = new SpotifyLiveStatusService(() => windowLike, execute, schedule as never, cancel as never);
    service.start();
    service.setRendererVisible(true);
    service.setWindowVisible(true);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
    service.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
  });

  it("honors Retry-After returned by a playback control", async () => {
    const delays: number[] = [];
    const handlers: Array<() => void> = [];
    let time = 10_000;
    const schedule = vi.fn((handler: TimerHandler, delay?: number) => {
      delays.push(Number(delay)); handlers.push(handler as () => void); return handlers.length as never;
    });
    const cancel = vi.fn();
    const executor = vi.fn(async (name: string) => {
      if (name === "spotify_get_devices") return { success: true, devices: [{ restricted: false, active: true }] };
      if (name === "spotify_get_current_track") return nowPlaying;
      if (name === "spotify_pause") return { success: false, retryAfter: 42, error: { code: "spotify_rate_limited" } };
      return { success: true, accepted: true, outcome: "provider_accepted" };
    });
    const service = new SpotifyLiveStatusService(() => windowLike, executor as never, schedule as never, cancel as never, () => time);
    service.start();
    service.setRendererVisible(true);
    service.setWindowVisible(true);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    const result = await service.control("pause");
    expect(result).toMatchObject({ ok: false, action: "pause", error: { code: "rate_limited" } });
    expect(delays.at(-1)).toBe(42_000);
    time += 42_000;
    service.stop();
    expect(cancel).toHaveBeenCalled();
  });

  it("accepts only exact playback results and safe status shapes", () => {
    expect(isSpotifyControlResponse({ ok: true, action: "pause", outcome: "provider_accepted", providerAccepted: true,
      reconciliation: "available" }, "pause")).toBe(true);
    expect(isSpotifyControlResponse({ ok: true, action: "pause", outcome: "state_confirmed", stateConfirmed: true,
      verification: "target_transition_observed", reconciliation: "available" }, "pause")).toBe(true);
    expect(isSpotifyControlResponse({ ok: true, action: "pause", outcome: "state_confirmed", stateConfirmed: true,
      verification: "track_changed_observed", reconciliation: "available" }, "pause")).toBe(false);
    expect(isSpotifyControlResponse({ ok: true, action: "pause", outcome: "state_confirmed", stateConfirmed: true,
      verification: "target_transition_observed", reconciliation: "available", accepted: true }, "pause")).toBe(false);
    expect(isSpotifyControlResponse({ ok: true, action: "play", outcome: "provider_accepted", providerAccepted: true,
      reconciliation: "available" }, "pause")).toBe(false);
    expect(isSpotifyControlResponse({ ok: false, action: "next", error: { code: "outcome_uncertain",
      message: "Spotify recibió la acción, pero no devolvió una confirmación verificable. El cambio pudo aplicarse; no se repetirá automáticamente." } }, "next")).toBe(true);
    expect(isSpotifyControlResponse({ ok: false, action: "next", reconciliation: "changed", error: { code: "outcome_uncertain",
      message: "La lectura posterior muestra un cambio, pero no permite atribuirlo con certeza." } }, "next")).toBe(true);
    expect(isSpotifyControlResponse({ ok: false, action: "next", reconciliation: "changed", error: { code: "outcome_uncertain",
      message: "Resultado inválido." } }, "next")).toBe(true);
    expect(isSpotifyControlResponse({ ok: false, action: "next", reconciliation: "changed", observedState: "track_changed",
      error: { code: "outcome_uncertain", message: "Canción cambiada" } }, "next")).toBe(true);
    expect(isSpotifyControlResponse({ ok: false, action: "next", observedState: "playing",
      error: { code: "outcome_uncertain", message: "Resultado inválido." } }, "next")).toBe(false);
    expect(isSpotifyLiveStatus({ state: "playing", connected: true, deviceAvailable: true, controlsEnabled: true,
      track: { name: "Song", artists: [], imageUrl: "https://example.com/image", spotifyUrl: null, playing: true }, message: null, updatedAt: 1 })).toBe(false);
  });

  it("restricts the IPC surface to the trusted Renderer and valid playback actions", async () => {
    const mainFrame = {};
    const webContents = { mainFrame, send: vi.fn() };
    const window = { webContents, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false } as never;
    const handlers = new Map<string, (event: never, payload?: unknown) => unknown>();
    const listeners = new Map<string, (event: never, payload: unknown) => void>();
    const ipc = {
      handle: (channel: string, listener: (event: never, payload?: unknown) => unknown) => handlers.set(channel, listener),
      removeHandler: (channel: string) => { handlers.delete(channel); },
      on: (channel: string, listener: (event: never, payload: unknown) => void) => listeners.set(channel, listener),
      removeAllListeners: (channel: string) => { listeners.delete(channel); },
    };
    const { execute } = readyExecutor();
    registerSpotifyLiveStatusHandlers(() => window, ipc as never, execute);
    const trustedEvent = { sender: webContents, senderFrame: mainFrame } as never;
    const status = await handlers.get(SPOTIFY_LIVE_STATUS_CHANNEL)!(trustedEvent);
    expect(isSpotifyLiveStatus(status)).toBe(true);
    const invalid = await handlers.get(SPOTIFY_CONTROL_CHANNEL)!(trustedEvent, "launch-arbitrary");
    expect(invalid).toMatchObject({ ok: false, error: { code: "operation_failed" } });
    expect(() => handlers.get(SPOTIFY_LIVE_STATUS_CHANNEL)!({ sender: {}, senderFrame: mainFrame } as never)).toThrow("untrusted_ipc_sender");
    listeners.get(SPOTIFY_LIVE_VISIBILITY_CHANNEL)!(trustedEvent, false);
    expect(handlers.has(SPOTIFY_CONTROL_CHANNEL)).toBe(true);
    removeSpotifyLiveStatusHandlers(ipc as never);
    expect(handlers.size).toBe(0);
  });
});
