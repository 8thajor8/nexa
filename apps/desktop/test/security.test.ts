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
  it("passes the isolated renderer signal only when Main explicitly supplies it", () => {
    expect(createSecureWebPreferences("preload.cjs")).not.toHaveProperty("additionalArguments");
    expect(createSecureWebPreferences("preload.cjs", ["--nexa-renderer-isolated"]).additionalArguments)
      .toEqual(["--nexa-renderer-isolated"]);
  });
  it("uses restrictive production and loopback-only development policies", () => {
    const productionPolicy = createContentSecurityPolicy(false);
    const developmentPolicy = createContentSecurityPolicy(true);
    expect(productionPolicy).toContain("default-src 'self'");
    expect(productionPolicy).toContain("object-src 'none'");
    expect(productionPolicy).toContain("img-src 'self' data: https://i.scdn.co");
    expect(productionPolicy).not.toMatch(/img-src 'self' data: https:;/u);
    expect(productionPolicy).not.toContain("unsafe-inline");
    expect(productionPolicy).not.toContain("127.0.0.1");
    expect(developmentPolicy).toContain("127.0.0.1:5174");
    expect(developmentPolicy).toContain("ws://127.0.0.1:5174");
    expect(developmentPolicy).not.toContain("'unsafe-eval'");
    expect(developmentPolicy).toContain("'wasm-unsafe-eval'");
    expect(developmentPolicy).toContain("nexa-vad:");
  });
  it("allows only the configured entry point", () => {
    expect(isAllowedNavigation("file:///app/dist/index.html", "file:///app/dist/index.html")).toBe(true);
    expect(isAllowedNavigation("https://example.com", "file:///app/dist/index.html")).toBe(false);
  });
  it("accepts only the exact local Vite URL in development", () => {
    expect(isExpectedViteDevServerUrl("http://127.0.0.1:5174")).toBe(true);
    expect(isExpectedViteDevServerUrl("http://127.0.0.1:5174/")).toBe(true);
    expect(selectRendererEntryPoint(false, "http://127.0.0.1:5174", "dist/index.html"))
      .toEqual({ kind: "url", url: "http://127.0.0.1:5174" });
  });
  it.each([
    "https://example.com",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://user:pass@127.0.0.1:5174",
    "http://127.0.0.1:5174/other",
    "http://127.0.0.1:5174/?unexpected=1",
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
