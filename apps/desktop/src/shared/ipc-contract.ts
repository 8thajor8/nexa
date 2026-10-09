export const PING_CHANNEL = "nexa:ping" as const;
export const GET_WALLPAPER_CHANNEL = "nexa:wallpaper:get" as const;
export const WINDOW_MINIMIZE_CHANNEL = "nexa:window:minimize" as const;
export const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = "nexa:window:toggle-maximize" as const;
export const WINDOW_CLOSE_CHANNEL = "nexa:window:close" as const;

export interface PingResponse { ok: true; message: "pong"; }
export type WallpaperResponse =
  | { available: true; dataUrl: string }
  | { available: false };
export interface NexaDesktopApi {
  ping: () => Promise<PingResponse>;
  getWallpaper: () => Promise<WallpaperResponse>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
}

export function createPingResponse(): PingResponse {
  return { ok: true, message: "pong" };
}

export function isPingResponse(value: unknown): value is PingResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && record.ok === true && record.message === "pong";
}

const MAX_WALLPAPER_DATA_URL_LENGTH = 14 * 1024 * 1024;
const WALLPAPER_DATA_URL_PATTERN = /^data:image\/(?:jpeg|png|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isWallpaperResponse(value: unknown): value is WallpaperResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.available === false) return keys.length === 1;
  return record.available === true &&
    keys.length === 2 &&
    typeof record.dataUrl === "string" &&
    record.dataUrl.length <= MAX_WALLPAPER_DATA_URL_LENGTH &&
    WALLPAPER_DATA_URL_PATTERN.test(record.dataUrl);
}
