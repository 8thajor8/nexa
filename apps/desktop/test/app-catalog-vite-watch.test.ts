import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverApps } from "../../../src/windows/app-discovery.js";

describe("Vite HMR and the runtime application catalog", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("observes the catalog write but does not send a full reload for this unimported data file", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "nexa-vite-catalog-watch-"));
    await mkdir(join(temporaryRoot, "data"), { recursive: true });
    const catalogFile = join(temporaryRoot, "data", "apps.json");

    server = await createServer({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      root: temporaryRoot,
      appType: "custom",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true },
    });

    const observed: string[] = [];
    server.watcher.on("all", (_event, filePath) => observed.push(filePath.replaceAll("\\", "/")));
    const hotPayloads: Array<{ type?: string }> = [];
    const clientHot = server.environments.client.hot;
    const sendHotPayload = clientHot.send.bind(clientHot);
    clientHot.send = (payload) => {
      hotPayloads.push(payload);
      sendHotPayload(payload);
    };
    await new Promise((resolve) => setTimeout(resolve, 150));

    const discovery = await discoverApps({
      platform: "win32",
      environment: { ProgramData: "C:\\ProgramData" },
      directories: [],
      catalogPath: catalogFile,
      readAppxApps: async () => ({ success: true, apps: [] }),
    });
    expect(discovery.success).toBe(true);
    expect(JSON.parse(await readFile(catalogFile, "utf8")).apps).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(observed.some((filePath) => filePath.endsWith("/data/apps.json"))).toBe(true);
    expect(hotPayloads.some((payload) => payload.type === "full-reload")).toBe(false);
  }, 10_000);
});
