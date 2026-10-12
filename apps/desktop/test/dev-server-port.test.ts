import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Desktop development server port", () => {
  it("keeps Vite, the dev launcher, and Electron's renderer URL aligned on 5174", () => {
    const viteConfig = readFileSync(resolve(appRoot, "vite.config.ts"), "utf8");
    const devScript = readFileSync(resolve(appRoot, "scripts", "dev.mjs"), "utf8");
    const security = readFileSync(resolve(appRoot, "src", "main", "security.ts"), "utf8");

    expect(viteConfig).toMatch(/server:\s*\{[^}]*port:\s*5174[^}]*strictPort:\s*true/u);
    expect(devScript).toContain('const rendererUrl = "http://127.0.0.1:5174"');
    expect(devScript).toContain("VITE_DEV_SERVER_URL: rendererUrl");
    expect(security).toContain('EXPECTED_VITE_DEV_SERVER_URL = "http://127.0.0.1:5174"');
  });
});
