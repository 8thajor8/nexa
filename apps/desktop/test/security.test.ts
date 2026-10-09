import { describe, expect, it, vi } from "vitest";
import {
  FRAMELESS_WINDOW_OPTIONS,
  createContentSecurityPolicy,
  createSecureWebPreferences,
  isExpectedViteDevServerUrl,
  loadRendererEntryPoint,
  selectRendererEntryPoint,
} from "../src/main/security";
import { isAllowedNavigation } from "../src/shared/ipc-security";

describe("Electron security configuration", () => {
  it("uses a frameless resizable window with native window controls still enabled", () => {
    expect(FRAMELESS_WINDOW_OPTIONS).toEqual({
      frame: false,
      autoHideMenuBar: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
    });
  });

  it("keeps renderer privileges disabled and sandboxed", () => {
    expect(createSecureWebPreferences("preload.cjs")).toEqual({
      preload: "preload.cjs", nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    });
  });
  it("uses restrictive production and loopback-only development policies", () => {
    const productionPolicy = createContentSecurityPolicy(false);
    const developmentPolicy = createContentSecurityPolicy(true);
    expect(productionPolicy).toContain("default-src 'self'");
    expect(productionPolicy).toContain("object-src 'none'");
    expect(productionPolicy).not.toContain("unsafe-inline");
    expect(productionPolicy).not.toContain("127.0.0.1");
    expect(developmentPolicy).toContain("127.0.0.1:5173");
    expect(developmentPolicy).toContain("ws://127.0.0.1:5173");
    expect(developmentPolicy).not.toContain("unsafe-eval");
  });
  it("allows only the configured entry point", () => {
    expect(isAllowedNavigation("file:///app/dist/index.html", "file:///app/dist/index.html")).toBe(true);
    expect(isAllowedNavigation("https://example.com", "file:///app/dist/index.html")).toBe(false);
  });
  it("accepts only the exact local Vite URL in development", () => {
    expect(isExpectedViteDevServerUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isExpectedViteDevServerUrl("http://127.0.0.1:5173/")).toBe(true);
    expect(selectRendererEntryPoint(false, "http://127.0.0.1:5173", "dist/index.html"))
      .toEqual({ kind: "url", url: "http://127.0.0.1:5173" });
  });
  it.each([
    "https://example.com",
    "http://localhost:5173",
    "http://127.0.0.1:5174",
    "http://user:pass@127.0.0.1:5173",
    "http://127.0.0.1:5173/other",
    "http://127.0.0.1:5173/?unexpected=1",
    "not a url",
  ])("rejects unsafe or malformed development URL %s", (url) => {
    expect(isExpectedViteDevServerUrl(url)).toBe(false);
    expect(() => selectRendererEntryPoint(false, url, "dist/index.html"))
      .toThrow("invalid_vite_dev_server_url");
  });
  it("ignores the environment URL when packaged and loads the compiled local file", () => {
    const entryPoint = selectRendererEntryPoint(true, "https://attacker.example/app", "dist/index.html");
    const loadURL = vi.fn();
    const loadFile = vi.fn();

    expect(entryPoint).toEqual({ kind: "file", filePath: "dist/index.html" });
    loadRendererEntryPoint(entryPoint, { loadURL, loadFile });
    expect(loadFile).toHaveBeenCalledExactlyOnceWith("dist/index.html");
    expect(loadURL).not.toHaveBeenCalled();
  });
  it("uses the local compiled file for an unpackaged launch without a dev URL", () => {
    expect(selectRendererEntryPoint(false, undefined, "dist/index.html"))
      .toEqual({ kind: "file", filePath: "dist/index.html" });
  });
});
