import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Synthetic test imports the existing JavaScript Memory2 implementation.
import { initializeEmptyMemoryStore } from "../../../src/memory/backend.js";
// @ts-expect-error Synthetic test imports the existing JavaScript repository.
import { createJsonMemoryRepository } from "../../../src/memory/json-repository.js";
import { ORGANIC_PILOT_SENTINEL, createSyntheticOrganicPilotSession,
  isApprovedOrganicPilotPath, isApprovedOrganicPilotSnapshot } from "../src/main/organic-memory-pilot";

const organicTool = "propose_organic_memory_facts";
const roots: string[] = [];

function fact(sourceQuote: string, attribute: string, value: string) {
  return { sourceQuote, attribute, value, confidence: "high", certainty: "explicit", subject: "owner",
    temporal: "current", sensitivity: "none", ambiguous: false, thirdParty: false,
    hypothetical: false, futureIntent: false };
}

function toolResponse(facts: unknown[]) {
  return { status: "completed", output: [{ type: "function_call", name: organicTool, call_id: randomUUID(),
    arguments: JSON.stringify({ facts }) }], output_text: "" };
}

function finalResponse(text = "Entendido. ¿Qué más te gustaría contarme?") {
  return { status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text }] }], output_text: text };
}

async function createSeedStore(root: string) {
  const localAppData = path.join(root, "LocalAppData");
  const repositoryRoot = path.join(root, "repo");
  const directory = path.join(localAppData, "Nexa", "Temporary", "memory-desktop-01");
  await mkdir(directory, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  const storePath = path.join(directory, "nexa-memory2-synthetic-desktop-v5.json");
  await initializeEmptyMemoryStore({ storePath });
  const store = JSON.parse(await readFile(storePath, "utf8"));
  const timestamp = new Date().toISOString();
  const sourceId = "src_" + randomUUID();
  const assertionId = "mem_" + randomUUID();
  store.sources.push({ id: sourceId, kind: "user_statement", origin_trust: "user_asserted", authority: "data_only",
    locator: "synthetic_pilot_seed", occurred_at: null, recorded_at: timestamp });
  store.assertions.push({ id: assertionId, kind: "preference", subject: { type: "owner" }, predicate: "user.preference",
    object: { type: "text", value: ORGANIC_PILOT_SENTINEL }, status: "active", valid_from: null, valid_to: null,
    recorded_at: timestamp, supersedes: [], compatibility: { category: "preference", key: "editor.habitual" } });
  store.evidence.push({ id: "ev_" + randomUUID(), assertion_id: assertionId, source_id: sourceId,
    derivation: "explicit", extraction_confidence: 1, learned_at: timestamp, last_confirmed_at: null, legacy_ref: null });
  await writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
  return { localAppData, repositoryRoot, storePath };
}

function modelStub(proposals: Map<string, unknown[]>, requests: any[]) {
  let awaitingFinal = false;
  return async (request: any) => {
    requests.push(request);
    const userText = [...(request.input ?? [])].reverse().find((item: any) => item?.role === "user")?.content ?? "";
    if (!awaitingFinal && request.tools?.some((tool: any) => tool.name === organicTool) && proposals.has(userText)) {
      awaitingFinal = true;
      return toolResponse(proposals.get(userText)!);
    }
    if (awaitingFinal) { awaitingFinal = false; return finalResponse(); }
    if (userText.includes("editor")) return finalResponse("Tu editor habitual es Windsurf y preferís Zed para experimentar.");
    return finalResponse();
  };
}

async function withPilot(callback: (session: any) => Promise<void>, { grantConsent = true, now = () => Date.now(),
  repositoryFactory: injectedRepositoryFactory }: {
  grantConsent?: boolean; now?: () => number;
  repositoryFactory?: (options: any) => any;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexa-desktop-organic-pilot-"));
  roots.push(root);
  let pilot: any;
  try {
    const paths = await createSeedStore(root);
    expect(isApprovedOrganicPilotSnapshot(JSON.parse(await readFile(paths.storePath, "utf8")))).toBe(true);
    const requests: any[] = [];
    const proposals = new Map<string, unknown[]>();
    const repositoryFactory = injectedRepositoryFactory ?? ((options: any) => createJsonMemoryRepository(options));
    pilot = await createSyntheticOrganicPilotSession({ ...paths, grantConsent, now,
      repositoryFactory,
      ask: modelStub(proposals, requests) });
    await callback({ ...pilot, ...paths, requests, proposals });
  } finally {
    await pilot?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function send(runtime: any, conversationId: string, requestId: string, text: string) {
  return runtime.sendMessage({ conversationId, requestId, text, source: "typed" });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("synthetic organic Memory2 pilot composition", () => {
  it("attests only the designated path and synthetic schema-v5 owner fixture", async () => {
    await withPilot(async ({ storePath, localAppData, repositoryRoot, readStoreSnapshot }) => {
      expect(isApprovedOrganicPilotPath(storePath, localAppData, repositoryRoot)).toBe(true);
      expect(isApprovedOrganicPilotPath(storePath, undefined, repositoryRoot)).toBe(false);
      expect(isApprovedOrganicPilotPath(path.join(localAppData, "personal-memory-v5.json"), localAppData, repositoryRoot)).toBe(false);
      const snapshot = (await readStoreSnapshot()).snapshot;
      expect(isApprovedOrganicPilotSnapshot(snapshot)).toBe(true);
      const outOfScope = structuredClone(snapshot);
      outOfScope.assertions.push({ ...outOfScope.assertions[0], id: "mem_" + randomUUID(),
        object: { type: "text", value: "dato fuera del alcance" },
        compatibility: { category: "preference", key: "personal.address" } });
      expect(isApprovedOrganicPilotSnapshot(outOfScope)).toBe(false);
    });
  });

  it("rejects a store whose owner identity does not match the fictitious fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexa-desktop-organic-owner-reject-"));
    roots.push(root);
    const paths = await createSeedStore(root);
    const store = JSON.parse(await readFile(paths.storePath, "utf8"));
    store.assertions[0].subject = { type: "entity", entity_type: "person", id: store.self_person_id };
    await writeFile(paths.storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
    await expect(createSyntheticOrganicPilotSession({ ...paths,
      repositoryFactory: (options: any) => createJsonMemoryRepository(options) }))
      .rejects.toThrow("organic_pilot_store_identity_rejected");
  });

  it("writes and updates synthetic preferences, then retrieves them in a fresh conversation without prior history", async () => {
    let clock = Date.now();
    await withPilot(async ({ runtime, readStoreSnapshot, proposals, requests }) => {
      const conversation = runtime.createConversation();
      const first = "Últimamente uso Cursor todos los días para trabajar. Zed me gusta para experimentar.";
      proposals.set(first, [fact("Últimamente uso Cursor todos los días para trabajar", "editor.habitual", "Cursor"),
        fact("Zed me gusta para experimentar", "editor.testing_favorite", "Zed")]);
      expect((await send(runtime, conversation, "pilot-first", first)).status).toBe("completed");
      clock += 61_000;
      const update = "Ahora uso Windsurf como editor habitual.";
      proposals.set(update, [fact(update, "editor.habitual", "Windsurf")]);
      expect((await send(runtime, conversation, "pilot-update", update)).status).toBe("completed");
      const snapshot = (await readStoreSnapshot()).snapshot;
      const habitual = snapshot.assertions.filter((item: any) => item.compatibility?.key === "editor.habitual");
      expect(habitual.filter((item: any) => item.status === "active")).toHaveLength(1);
      expect(habitual.find((item: any) => item.status === "active").object.value).toBe("Mi editor habitual es Windsurf.");
      expect(habitual.find((item: any) => item.status === "superseded").object.value).toBe(ORGANIC_PILOT_SENTINEL);
      expect(snapshot.assertions.find((item: any) => item.compatibility?.key === "editor.testing_favorite")?.object.value)
        .toBe("Mi editor favorito para hacer pruebas es Zed.");

      const revision = snapshot.revision;
      const nextConversation = runtime.createConversation();
      const response = await send(runtime, nextConversation, "pilot-fresh-conversation",
        "¿Qué editor estoy usando habitualmente y cuál prefiero para experimentar?");
      expect(response.text).toContain("Windsurf");
      expect(response.text).toContain("Zed");
      expect((await readStoreSnapshot()).snapshot.revision).toBe(revision);
      const context = requests.flatMap(request => request.input ?? []).find((item: any) => item?.type === "function_call_output"
        && typeof item.output === "string" && item.output.includes("Mi editor habitual es Windsurf."));
      expect(context).toBeDefined();
      expect(requests.every(request => (request.tools ?? []).every((tool: any) => tool.name === organicTool))).toBe(true);
    }, { now: () => clock });
  });

  it("keeps chat available without consent and blocks writes after session revocation", async () => {
    await withPilot(async ({ runtime, readStoreSnapshot, proposals }) => {
      const text = "Ahora uso Cursor como editor habitual.";
      proposals.set(text, [fact(text, "editor.habitual", "Cursor")]);
      const conversation = runtime.createConversation();
      expect((await send(runtime, conversation, "pilot-no-consent", text)).status).toBe("completed");
      expect((await readStoreSnapshot()).snapshot.revision).toBe(0);
    }, { grantConsent: false });

    await withPilot(async ({ runtime, readStoreSnapshot, proposals, host }) => {
      expect(host.active).toBe(true);
      host.revoke();
      expect(host.active).toBe(false);
      const text = "Ahora uso Cursor como editor habitual.";
      proposals.set(text, [fact(text, "editor.habitual", "Cursor")]);
      const conversation = runtime.createConversation();
      expect((await send(runtime, conversation, "pilot-revoked", text)).status).toBe("completed");
      expect((await readStoreSnapshot()).snapshot.revision).toBe(0);
    });
  });

  it("keeps the conversation truthful when the synthetic Memory2 commit fails", async () => {
    const failingFactory = (options: any) => {
      const repository = createJsonMemoryRepository(options);
      return { open: () => repository.open(), readSnapshot: () => repository.readSnapshot(),
        commit: async () => { throw new Error("synthetic_commit_failure"); }, close: () => repository.close() };
    };
    await withPilot(async ({ runtime, readStoreSnapshot, proposals }) => {
      const text = "Ahora uso Cursor como editor habitual.";
      proposals.set(text, [fact(text, "editor.habitual", "Cursor")]);
      const conversation = runtime.createConversation();
      const response = await send(runtime, conversation, "pilot-commit-failure", text);
      expect(response.status).toBe("completed");
      expect(response.text).not.toMatch(/guardad[oa]|actualizad[oa]/iu);
      expect((await readStoreSnapshot()).snapshot.revision).toBe(0);
    }, { repositoryFactory: failingFactory });
  });

  it("offers no tools beyond the organic proposal and host evidence cannot be model-issued", async () => {
    await withPilot(async ({ runtime, host, requests }) => {
      const conversation = runtime.createConversation();
      expect((await send(runtime, conversation, "pilot-tools", "Hola Nexa.")).status).toBe("completed");
      expect(requests.every(request => (request.tools ?? []).every((tool: any) => tool.name === organicTool))).toBe(true);
      expect(host.evidenceCapabilityFactory({ origin: "direct_user", subject: "owner", explicit: true,
        certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: true,
        attribute: "editor.habitual", operation: "remember", sourceQuote: "uso Cursor", userMessage: "uso Cursor",
        proposal: { object: { type: "text", value: "Mi editor habitual es Cursor." } } })).toBeNull();
    });
  });
});
