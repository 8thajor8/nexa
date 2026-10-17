type SpeedSender = (lightEntityId: string, value: number) => void | Promise<void>;

/** Per-light debounced, serialized speed writes; only the newest pending value is retained. */
export class HomeLightSpeedQueue {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly latest = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private readonly senders = new Map<string, SpeedSender>();
  private readonly inFlight = new Set<string>();
  private authorized = new Set<string>();
  private active = true;

  constructor(private readonly delayMs = 300) {}

  setAuthorizedEntities(entityIds: readonly string[]): void {
    this.authorized = new Set(entityIds);
    for (const entityId of this.latest.keys()) {
      if (this.authorized.has(entityId)) continue;
      this.clearTimer(entityId);
      this.latest.delete(entityId);
      this.pending.delete(entityId);
      this.senders.delete(entityId);
    }
  }

  schedule(entityId: string, value: number, send: SpeedSender): void {
    if (!this.active || !this.authorized.has(entityId) || !Number.isFinite(value)) return;
    this.latest.set(entityId, value);
    this.senders.set(entityId, send);
    this.clearTimer(entityId);
    this.timers.set(entityId, setTimeout(() => {
      this.timers.delete(entityId);
      void this.dispatch(entityId);
    }, this.delayMs));
  }

  activate(): void { this.active = true; }
  hasPendingOrInFlight(entityId: string): boolean {
    return this.timers.has(entityId) || this.pending.has(entityId) || this.inFlight.has(entityId);
  }
  dispose(): void {
    this.active = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.latest.clear(); this.pending.clear(); this.senders.clear();
  }
  private clearTimer(entityId: string): void {
    const timer = this.timers.get(entityId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(entityId);
  }
  private async dispatch(entityId: string): Promise<void> {
    if (!this.active || !this.authorized.has(entityId)) return;
    if (this.inFlight.has(entityId)) {
      const value = this.latest.get(entityId);
      if (value !== undefined) this.pending.set(entityId, value);
      return;
    }
    const value = this.latest.get(entityId);
    const send = this.senders.get(entityId);
    if (value === undefined || !send) return;
    this.inFlight.add(entityId); this.pending.delete(entityId);
    try { await send(entityId, value); } catch { /* The panel presents the categorized error. */ }
    finally {
      this.inFlight.delete(entityId);
      if (!this.active || !this.authorized.has(entityId) || this.timers.has(entityId)) return;
      const next = this.pending.get(entityId);
      if (next !== undefined) { this.pending.delete(entityId); this.latest.set(entityId, next); void this.dispatch(entityId); }
    }
  }
}
