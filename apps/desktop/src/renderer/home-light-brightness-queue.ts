type BrightnessSender = (entityId: string, brightnessPct: number) => void | Promise<void>;

/** Debounces per-light changes and serializes writes while retaining only the newest pending value. */
export class HomeLightBrightnessQueue {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly latestValues = new Map<string, number>();
  private readonly pendingValues = new Map<string, number>();
  private readonly senders = new Map<string, BrightnessSender>();
  private readonly inFlight = new Set<string>();
  private authorized = new Set<string>();
  private active = true;

  constructor(private readonly delayMs = 300) {}

  setAuthorizedEntities(entityIds: readonly string[]): void {
    const next = new Set(entityIds);
    this.authorized = next;
    for (const entityId of this.latestValues.keys()) {
      if (next.has(entityId)) continue;
      this.clearTimer(entityId);
      this.latestValues.delete(entityId);
      this.pendingValues.delete(entityId);
      this.senders.delete(entityId);
    }
  }

  schedule(entityId: string, brightnessPct: number, send: BrightnessSender): void {
    if (!this.active || !this.authorized.has(entityId) || !Number.isInteger(brightnessPct)
      || brightnessPct < 0 || brightnessPct > 100) return;
    this.latestValues.set(entityId, brightnessPct);
    this.senders.set(entityId, send);
    this.clearTimer(entityId);
    this.timers.set(entityId, setTimeout(() => {
      this.timers.delete(entityId);
      void this.dispatch(entityId);
    }, this.delayMs));
  }

  hasPendingOrInFlight(entityId: string): boolean {
    return this.timers.has(entityId) || this.pendingValues.has(entityId) || this.inFlight.has(entityId);
  }

  activate(): void { this.active = true; }

  dispose(): void {
    this.active = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.latestValues.clear();
    this.pendingValues.clear();
    this.senders.clear();
  }

  private clearTimer(entityId: string): void {
    const timer = this.timers.get(entityId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(entityId);
  }

  private async dispatch(entityId: string): Promise<void> {
    if (!this.active || !this.authorized.has(entityId)) return;
    if (this.inFlight.has(entityId)) {
      const latest = this.latestValues.get(entityId);
      if (latest !== undefined) this.pendingValues.set(entityId, latest);
      return;
    }
    const value = this.latestValues.get(entityId);
    const send = this.senders.get(entityId);
    if (value === undefined || !send) return;
    this.inFlight.add(entityId);
    this.pendingValues.delete(entityId);
    try { await send(entityId, value); } catch { /* UI reports the categorized control error. */ }
    finally {
      this.inFlight.delete(entityId);
      if (!this.active || !this.authorized.has(entityId)) return;
      if (this.timers.has(entityId)) {
        this.pendingValues.delete(entityId);
        return;
      }
      const pending = this.pendingValues.get(entityId);
      if (pending !== undefined) {
        this.pendingValues.delete(entityId);
        this.latestValues.set(entityId, pending);
        void this.dispatch(entityId);
      }
    }
  }
}
