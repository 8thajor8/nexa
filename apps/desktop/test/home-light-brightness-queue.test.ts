import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeLightBrightnessQueue } from "../src/renderer/home-light-brightness-queue";

afterEach(() => { vi.useRealTimers(); });

describe("per-light brightness queue", () => {
  it("debounces a burst to the latest value", () => {
    vi.useFakeTimers();
    const queue = new HomeLightBrightnessQueue(300);
    const send = vi.fn();
    queue.activate();
    queue.setAuthorizedEntities(["light.office"]);
    queue.schedule("light.office", 35, send);
    vi.advanceTimersByTime(180);
    queue.schedule("light.office", 72, send);
    vi.advanceTimersByTime(299);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("light.office", 72);
    queue.dispose();
  });

  it("serializes writes and retains only the newest value while one is in flight", async () => {
    vi.useFakeTimers();
    const queue = new HomeLightBrightnessQueue(300);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: number[] = [];
    queue.activate();
    queue.setAuthorizedEntities(["light.office"]);
    queue.schedule("light.office", 30, async (_id, value) => { calls.push(value); await gate; });
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([30]);
    queue.schedule("light.office", 50, async (_id, value) => { calls.push(value); });
    vi.advanceTimersByTime(300);
    queue.schedule("light.office", 85, async (_id, value) => { calls.push(value); });
    vi.advanceTimersByTime(300);
    release();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(calls).toEqual([30, 85]);
    queue.dispose();
  });

  it("cancels pending values after revocation and disposal", () => {
    vi.useFakeTimers();
    const queue = new HomeLightBrightnessQueue(300);
    const send = vi.fn();
    queue.activate();
    queue.setAuthorizedEntities(["light.office"]);
    queue.schedule("light.office", 40, send);
    queue.setAuthorizedEntities([]);
    vi.advanceTimersByTime(300);
    expect(send).not.toHaveBeenCalled();
    queue.setAuthorizedEntities(["light.office"]);
    queue.schedule("light.office", 70, send);
    queue.dispose();
    vi.advanceTimersByTime(300);
    expect(send).not.toHaveBeenCalled();
  });
});
