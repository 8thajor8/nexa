import { describe, expect, it, vi } from "vitest";
import {
  getWindowsWallpaper,
  MAX_WALLPAPER_BYTES,
  WINDOWS_WALLPAPER_RELATIVE_PATH,
  type WallpaperFileSystem,
} from "../src/main/wallpaper";

const APP_DATA = "C:\\Users\\NexaTest\\AppData\\Roaming";
const JPEG_FIXTURE = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);

function createFileSystem(overrides: Partial<WallpaperFileSystem> = {}): WallpaperFileSystem {
  return {
    lstat: vi.fn(async () => ({ size: JPEG_FIXTURE.length, isFile: () => true, isSymbolicLink: () => false })),
    realpath: vi.fn(async (path: string) => path),
    readFile: vi.fn(async () => JPEG_FIXTURE),
    ...overrides,
  };
}

describe("isolated Windows wallpaper reader", () => {
  it("reads only the fixed Windows cached wallpaper and returns a local image data URL", async () => {
    const fileSystem = createFileSystem();

    await expect(getWindowsWallpaper(APP_DATA, "win32", fileSystem)).resolves.toEqual({
      available: true,
      dataUrl: "data:image/jpeg;base64,/9j/AA==",
    });
    expect(fileSystem.lstat).toHaveBeenCalledExactlyOnceWith(
      `${APP_DATA}\\${WINDOWS_WALLPAPER_RELATIVE_PATH}`,
    );
    expect(fileSystem.readFile).toHaveBeenCalledExactlyOnceWith(
      `${APP_DATA}\\${WINDOWS_WALLPAPER_RELATIVE_PATH}`,
      MAX_WALLPAPER_BYTES,
    );
  });

  it("fails closed outside Windows and when the cached wallpaper is inaccessible", async () => {
    const fileSystem = createFileSystem({
      lstat: vi.fn(async () => { throw new Error("not_found"); }),
    });

    await expect(getWindowsWallpaper(APP_DATA, "linux", fileSystem)).resolves.toEqual({ available: false });
    expect(fileSystem.lstat).not.toHaveBeenCalled();
    await expect(getWindowsWallpaper(APP_DATA, "win32", fileSystem)).resolves.toEqual({ available: false });
  });

  it("rejects symlinks, paths redirected outside the fixed cache, oversized files, and unknown formats", async () => {
    const symlink = createFileSystem({
      lstat: vi.fn(async () => ({ size: 4, isFile: () => false, isSymbolicLink: () => true })),
    });
    const redirected = createFileSystem({
      realpath: vi.fn(async () => "C:\\Users\\NexaTest\\Documents\\private.jpg"),
    });
    const oversized = createFileSystem({
      lstat: vi.fn(async () => ({ size: MAX_WALLPAPER_BYTES + 1, isFile: () => true, isSymbolicLink: () => false })),
    });
    const unknownFormat = createFileSystem({
      readFile: vi.fn(async () => new Uint8Array([0x00, 0x01, 0x02, 0x03])),
    });

    await expect(getWindowsWallpaper(APP_DATA, "win32", symlink)).resolves.toEqual({ available: false });
    await expect(getWindowsWallpaper(APP_DATA, "win32", redirected)).resolves.toEqual({ available: false });
    await expect(getWindowsWallpaper(APP_DATA, "win32", oversized)).resolves.toEqual({ available: false });
    await expect(getWindowsWallpaper(APP_DATA, "win32", unknownFormat)).resolves.toEqual({ available: false });
  });
});
