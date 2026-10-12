import { config as loadDotEnv } from "dotenv";
import { resolve } from "node:path";

export function loadRootEnvironment(repositoryRoot: string): boolean {
  loadDotEnv({
    path: resolve(repositoryRoot, ".env"),
    override: false,
    quiet: true,
  });

  return typeof process.env.OPENAI_API_KEY === "string"
    && process.env.OPENAI_API_KEY.trim().length > 0;
}
