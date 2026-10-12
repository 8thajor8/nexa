import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { registerChatNavigationHandlers, type ChatNavigationContents } from "../src/main/chat-navigation.js";

function harness() {
  const contents = new EventEmitter() as unknown as ChatNavigationContents;
  const cleanup = vi.fn();
  const trace = vi.fn();
  const entryPoint = "http://127.0.0.1:5174";
  registerChatNavigationHandlers(
    contents,
    entryPoint,
    (url) => new URL(url).origin === new URL(entryPoint).origin ? "renderer_origin" : "other_origin",
    cleanup,
    trace,
  );
  return { contents: contents as unknown as EventEmitter, cleanup, trace, entryPoint };
}

describe("Desktop navigation and active chat cleanup", () => {
  it("does not cancel an active request when a same-origin navigation attempt is blocked", () => {
    const { contents, cleanup, trace } = harness();
    const event = { preventDefault: vi.fn(), initiator: { url: "http://127.0.0.1:5174/" } };

    contents.emit("did-start-navigation", {}, "http://127.0.0.1:5174/", false, true);
    contents.emit("will-navigate", event, "http://127.0.0.1:5174/");

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(trace).toHaveBeenCalledWith("renderer_navigation_requested", {
      target: "renderer_origin", initiator: "renderer_origin", prevented: true,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleans up an active request after an allowed document navigation commits", () => {
    const { contents, cleanup, trace, entryPoint } = harness();
    const event = { preventDefault: vi.fn() };

    contents.emit("will-navigate", event, entryPoint);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();

    contents.emit("did-navigate", {}, entryPoint, 200, "OK");

    expect(trace).toHaveBeenCalledWith("renderer_navigation_committed", { target: "renderer_origin" });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
