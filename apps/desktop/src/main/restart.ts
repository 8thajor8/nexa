import type { DesktopRestartResponse } from "../shared/ipc-contract.js";

export const DEV_RESTART_EXIT_CODE = 87;

interface RestartAppPort {
  relaunch(): void;
  quit(): void;
  exit(code: number): void;
}

/** The dev launcher owns Vite and starts the next Electron process after this one closes. */
export function createDesktopRestartController(app: RestartAppPort, packaged: boolean, devLauncherAvailable: boolean,
  schedule: (callback: () => void) => void = setImmediate) {
  let requested = false;
  return {
    request(): DesktopRestartResponse {
      if (requested) return { ok: false, error: "restart_pending" };
      if (!packaged && !devLauncherAvailable) return { ok: false, error: "restart_unavailable" };
      if (packaged) {
        try { app.relaunch(); }
        catch { return { ok: false, error: "relaunch_failed" }; }
      }
      requested = true;
      schedule(() => app.quit());
      return { ok: true, accepted: true };
    },
    onWillQuit(): void {
      if (requested && !packaged) app.exit(DEV_RESTART_EXIT_CODE);
    },
  };
}
