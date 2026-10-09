import { lstat, open, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import type { WallpaperResponse } from "../shared/ipc-contract.js";

export const WINDOWS_WALLPAPER_RELATIVE_PATH = win32.join(
  "Microsoft", "Windows", "Themes", "TranscodedWallpaper",
);
export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;

export interface WallpaperFileInfo {
  size: number;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

export interface WallpaperFileSystem {
  lstat: (path: string) => Promise<WallpaperFileInfo>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string, maxBytes: number) => Promise<Uint8Array>;
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const openedFile = await handle.stat();
    if (!openedFile.isFile() || openedFile.size > maxBytes) throw new Error("invalid_wallpaper_file");

    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

const defaultFileSystem: WallpaperFileSystem = { lstat, realpath, readFile: readBoundedFile };

function getImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return null;
}

function isSamePath(left: string, right: string, platform: string): boolean {
  if (platform !== "win32") return false;
  return win32.resolve(left).toLocaleLowerCase("en-US") ===
    win32.resolve(right).toLocaleLowerCase("en-US");
}

export async function getWindowsWallpaper(
  appDataPath: string,
  platform = process.platform,
  fileSystem: WallpaperFileSystem = defaultFileSystem,
): Promise<WallpaperResponse> {
  if (platform !== "win32" || !win32.isAbsolute(appDataPath)) return { available: false };

  const appDataRoot = win32.resolve(appDataPath);
  const wallpaperPath = win32.resolve(appDataRoot, WINDOWS_WALLPAPER_RELATIVE_PATH);
  if (!wallpaperPath.toLocaleLowerCase("en-US").startsWith(`${appDataRoot.toLocaleLowerCase("en-US")}${win32.sep}`)) {
    return { available: false };
  }

  try {
    const fileInfo = await fileSystem.lstat(wallpaperPath);
    if (
      !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size <= 0 ||
      fileInfo.size > MAX_WALLPAPER_BYTES
    ) return { available: false };

    const actualPath = await fileSystem.realpath(wallpaperPath);
    if (!isSamePath(actualPath, wallpaperPath, platform)) return { available: false };

    const bytes = await fileSystem.readFile(wallpaperPath, MAX_WALLPAPER_BYTES);
    if (bytes.length <= 0 || bytes.length > MAX_WALLPAPER_BYTES) return { available: false };
    const mimeType = getImageMimeType(bytes);
    if (!mimeType) return { available: false };

    return { available: true, dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` };
  } catch {
    return { available: false };
  }
}
