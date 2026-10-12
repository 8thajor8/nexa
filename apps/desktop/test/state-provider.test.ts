import { describe, expect, it, vi } from "vitest";
import { ASSISTANT_STATES, createMockAssistantStateProvider } from "../src/shared/assistant-state";

describe("mock assistant state provider", () => {
  it("starts idle and supports every declared state", () => {
    const provider = createMockAssistantStateProvider();
    expect(provider.getSnapshot()).toBe("idle");
    for (const state of ASSISTANT_STATES) {
      provider.setState(state);
      expect(provider.getSnapshot()).toBe(state);
    }
  });
  it("notifies subscribers only when the state changes", () => {
    const provider = createMockAssistantStateProvider();
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);
    provider.setState("thinking");
    provider.setState("thinking");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    provider.setState("idle");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});