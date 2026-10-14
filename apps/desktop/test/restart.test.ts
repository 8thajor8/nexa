import { describe, expect, it, vi } from "vitest";
import { createDesktopRestartController, DEV_RESTART_EXIT_CODE } from "../src/main/restart";

function createApp() {
  return { relaunch: vi.fn(), quit: vi.fn(), exit: vi.fn() };
}

describe("Desktop restart lifecycle", () => {
  it("queues a packaged relaunch followed by the ordinary quit lifecycle", () => {
    const app = createApp();
    let scheduled!: () => void;
    const restart = createDesktopRestartController(app, true, false, callback => { scheduled = callback; });
    expect(restart.request()).toEqual({ ok: true, accepted: true });
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    expect(restart.request()).toEqual({ ok: false, error: "restart_pending" });
    scheduled();
    expect(app.quit).toHaveBeenCalledOnce();
    restart.onWillQuit();
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("signals the existing development launcher only after quit completes", () => {
    const app = createApp();
    let scheduled!: () => void;
    const restart = createDesktopRestartController(app, false, true, callback => { scheduled = callback; });
    expect(restart.request()).toEqual({ ok: true, accepted: true });
    expect(app.relaunch).not.toHaveBeenCalled();
    scheduled();
    expect(app.quit).toHaveBeenCalledOnce();
    restart.onWillQuit();
    expect(app.exit).toHaveBeenCalledWith(DEV_RESTART_EXIT_CODE);
  });

  it("rejects unsupported development starts and relaunch errors without quitting", () => {
    const app = createApp();
    const unsupported = createDesktopRestartController(app, false, false);
    expect(unsupported.request()).toEqual({ ok: false, error: "restart_unavailable" });
    app.relaunch.mockImplementationOnce(() => { throw new Error("failed"); });
    const packaged = createDesktopRestartController(app, true, false);
    expect(packaged.request()).toEqual({ ok: false, error: "relaunch_failed" });
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
    unsupported.onWillQuit();
    expect(app.exit).not.toHaveBeenCalled();
  });
});
