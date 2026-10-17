import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeLightSpeedQueue } from "../src/renderer/home-light-speed-queue.js";

afterEach(() => vi.useRealTimers());

describe("HomeLightSpeedQueue", () => {
  it("debounces one light and keeps only the latest value while a request is in flight", async () => {
    vi.useFakeTimers();
    const queue = new HomeLightSpeedQueue(300);
    queue.setAuthorizedEntities(["light.office"]);
    const calls: number[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const sender = async (_entityId: string, value: number) => {
      calls.push(value);
      if (calls.length === 1) await first;
    };

    queue.schedule("light.office", 30, sender);
    queue.schedule("light.office", 40, sender);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([40]);
    queue.schedule("light.office", 50, sender);
    await vi.advanceTimersByTimeAsync(300);
    queue.schedule("light.office", 60, sender);
    await vi.advanceTimersByTimeAsync(300);
    releaseFirst();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(calls).toEqual([40, 60]);
    queue.dispose();
  });

  it("drops pending writes when authorization is revoked", async () => {
    vi.useFakeTimers();
    const queue = new HomeLightSpeedQueue(200);
    queue.setAuthorizedEntities(["light.office"]);
    const sender = vi.fn();
    queue.schedule("light.office", 45, sender);
    queue.setAuthorizedEntities([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(sender).not.toHaveBeenCalled();
    queue.dispose();
  });
});
