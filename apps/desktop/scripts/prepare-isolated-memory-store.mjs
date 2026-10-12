import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initializeEmptyMemoryStore } from "../../../src/memory/backend.js";

const directory = await mkdtemp(join(tmpdir(), "nexa-memory2-synthetic-"));
const storePath = join(directory, `nexa-memory2-synthetic-${randomUUID()}.json`);
await initializeEmptyMemoryStore({ storePath });
process.stdout.write(`${JSON.stringify({ storePath })}\n`);
