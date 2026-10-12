import { describe, expect, it } from "vitest";
import { desktopTraceDisposition } from "../src/main/diagnostic-policy.js";

describe("Desktop diagnostic trace policy", () => {
  it("suppresses routine Spotify, window, IPC, and initialization traces by default", () => {
    for (const [area, event] of [
      ["spotify", "spotify_playback_observation"], ["spotify", "spotify_provider_response"],
      ["spotify", "spotify_response_body"], ["spotify", "spotify_play_preflight"],
      ["spotify", "spotify_action_result"], ["spotify", "spotify_control_post_state_observed"],
      ["window", "fullscreen_transition_requested"], ["window", "placement_phase"],
      ["chat_ipc", "ipc_request_accepted"], ["runtime", "agent_started"], ["desktop", "module_loaded"],
    ]) expect(desktopTraceDisposition(false, area, event, {})).toBe("silent");
  });

  it("retains actionable failures and rejected Spotify actions", () => {
    expect(desktopTraceDisposition(false, "window", "fullscreen_transition_error", {})).toBe("error");
    expect(desktopTraceDisposition(false, "runtime", "agent_run_failed", {})).toBe("error");
    expect(desktopTraceDisposition(false, "desktop", "native_dependency_warning", {})).toBe("warning");
    expect(desktopTraceDisposition(false, "spotify", "spotify_action_result", { outcome: "rejected", httpStatus: 403 })).toBe("warning");
    expect(desktopTraceDisposition(false, "spotify", "spotify_action_result", { outcome: "uncertain" })).toBe("silent");
  });

  it("restores detailed safe traces only when explicitly enabled", () => {
    expect(desktopTraceDisposition(true, "spotify", "spotify_playback_observation", {})).toBe("diagnostic");
    expect(desktopTraceDisposition(true, "chat_ipc", "renderer_event_send_called", {})).toBe("diagnostic");
    expect(desktopTraceDisposition(true, "window", "fullscreen_transition_error", {})).toBe("error");
  });
});
