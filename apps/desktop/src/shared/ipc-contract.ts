export const PING_CHANNEL = "nexa:ping" as const;

export interface PingResponse { ok: true; message: "pong"; }
export interface NexaDesktopApi { ping: () => Promise<PingResponse>; }

export function createPingResponse(): PingResponse {
  return { ok: true, message: "pong" };
}

export function isPingResponse(value: unknown): value is PingResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && record.ok === true && record.message === "pong";
}