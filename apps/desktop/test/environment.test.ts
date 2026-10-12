import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadRootEnvironment } from "../src/main/environment.js";

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
});

describe("Main root environment loading", () => {
  it("loads a non-empty key from the explicit repository root", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "nexa-env-test-"));
    try {
      await writeFile(resolve(root, ".env"), "OPENAI_API_KEY=test-key\n", "utf8");
      delete process.env.OPENAI_API_KEY;

      expect(loadRootEnvironment(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an environment variable already provided by the launcher", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "nexa-env-test-"));
    try {
      await writeFile(resolve(root, ".env"), "OPENAI_API_KEY=file-key\n", "utf8");
      process.env.OPENAI_API_KEY = "launcher-key";

      expect(loadRootEnvironment(root)).toBe(true);
      expect(process.env.OPENAI_API_KEY).toBe("launcher-key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns false when the key is absent", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "nexa-env-test-"));
    try {
      delete process.env.OPENAI_API_KEY;

      expect(loadRootEnvironment(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
