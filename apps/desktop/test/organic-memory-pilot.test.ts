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
const verifierTool = "verify_organic_memory_facts";
const roots: string[] = [];

function fact(sourceQuote: string, attribute: string, value: string) {
  return { sourceQuote, attribute, value, confidence: "high", certainty: "explicit", subject: "owner",
    temporal: "current", validity: "current", priorAssertionId: "", sensitivity: "none", ambiguous: false, thirdParty: false,
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
    if (request.tools?.some((tool: any) => tool.name === verifierTool)) {
      const encoded = (request.input ?? []).find((item: any) => item?.role === "user" && typeof item.content === "string")?.content ?? "{}";
      const verification = JSON.parse(encoded);
      const proposed = proposals.get(verification.currentUserMessage) ?? [];
      return { status: "completed", output: [{ type: "function_call", name: verifierTool, call_id: randomUUID(),
        arguments: JSON.stringify({ decisions: verification.candidates.map((candidate: any, candidateIndex: number) => {
          const matches = proposed.some((fact: any) => fact.sourceQuote === candidate.quote
            && fact.value === candidate.proposedFact && fact.attribute === candidate.topicKey);
          const source = proposed.find((fact: any) => fact.sourceQuote === candidate.quote
            && fact.value === candidate.proposedFact && fact.attribute === candidate.topicKey);
          const checks = { supported: matches, explicit: source?.certainty === "explicit" && source?.hypothetical === false,
            subjectMatches: source?.subject === "owner", temporalMatches: ["current", "past", "future", "hypothetical", "unknown"]
              .includes(candidate.eventTime), nonSensitive: source?.sensitivity === "none", unambiguous: source?.ambiguous === false };
          return { candidateIndex, decision: Object.values(checks).every(Boolean) ? "approved" : "rejected", ...checks,
            correctedValue: "", correctedAttribute: "", correctedTemporal: candidate.eventTime,
            correctedValidity: candidate.validity };
        }) }) }], output_text: "" };
    }
    if (!awaitingFinal && request.tools?.some((tool: any) => tool.name === organicTool) && proposals.has(userText)) {
      awaitingFinal = true;
      const antecedents: any[] = [];
      for (const item of request.input ?? []) {
        if (item?.role === "user" && typeof item.content === "string") {
          const encoded = item.content.match(/(\[[\s\S]*\])\s*$/u)?.[1];
          if (encoded) {
            try {
              const parsed = JSON.parse(encoded);
              if (Array.isArray(parsed)) antecedents.push(...parsed);
            } catch { /* Ignore unrelated user-provided JSON. */ }
          }
        }
        if (item?.type !== "function_call_output" || typeof item.output !== "string") continue;
        try {
          const payload = JSON.parse(item.output);
          if (Array.isArray(payload?.assertions)) antecedents.push(...payload.assertions);
        } catch { /* Ignore non-Memory2 fixture outputs. */ }
      }
      const facts = proposals.get(userText)!.map((candidate: any) => {
        const prior = antecedents.find(assertion => assertion.status === "active"
          && assertion.compatibility?.key === candidate.attribute && assertion.subject?.type === "owner");
        return prior ? { ...candidate, priorAssertionId: prior.id, priorStatement: prior.object?.value ?? "" } : candidate;
      });
      return toolResponse(facts);
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
    const diagnostics: any[] = [];
    const proposals = new Map<string, unknown[]>();
    const repositoryFactory = injectedRepositoryFactory ?? ((options: any) => createJsonMemoryRepository(options));
    pilot = await createSyntheticOrganicPilotSession({ ...paths, grantConsent, now,
      repositoryFactory,
      agentOptions: { logger: (event: string, details: Record<string, unknown>) => diagnostics.push({ event, ...details }) },
      ask: modelStub(proposals, requests) });
    await callback({ ...pilot, ...paths, requests, proposals, diagnostics });
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
    await withPilot(async ({ runtime, readStoreSnapshot, proposals, requests, diagnostics }) => {
      const conversation = runtime.createConversation();
      const first = "Últimamente uso Cursor todos los días para trabajar. Zed me gusta para experimentar.";
      const initialSnapshot = (await readStoreSnapshot()).snapshot;
      const seededHabit = initialSnapshot.assertions.find((item: any) => item.compatibility?.key === "editor.habitual");
      proposals.set(first, [{ ...fact("Últimamente uso Cursor todos los días para trabajar", "editor.habitual", "Cursor"),
        priorAssertionId: seededHabit.id, priorStatement: seededHabit.object.value },
        fact("Zed me gusta para experimentar", "editor.testing_favorite", "Zed")]);
      expect((await send(runtime, conversation, "pilot-first", first)).status).toBe("completed");
      clock += 61_000;
      const update = "Ahora uso Windsurf como editor habitual.";
      const afterFirstSnapshot = (await readStoreSnapshot()).snapshot;
      const activeHabit = afterFirstSnapshot.assertions.find((item: any) => item.compatibility?.key === "editor.habitual"
        && item.status === "active");
      proposals.set(update, [{ ...fact(update, "editor.habitual", "Windsurf"),
        priorAssertionId: activeHabit.id, priorStatement: activeHabit.object.value }]);
      expect((await send(runtime, conversation, "pilot-update", update)).status).toBe("completed");
      const snapshot = (await readStoreSnapshot()).snapshot;
      const habitual = snapshot.assertions.filter((item: any) => item.compatibility?.key === "editor.habitual");
      expect(habitual.filter((item: any) => item.status === "active")).toHaveLength(1);
      expect(habitual.find((item: any) => item.status === "active").object.value,
        JSON.stringify(diagnostics.filter((item: any) => item.event.startsWith("organic_memory")))).toBe("Windsurf");
      expect(habitual.find((item: any) => item.status === "superseded").object.value).toBe(ORGANIC_PILOT_SENTINEL);
      expect(snapshot.assertions.find((item: any) => item.compatibility?.key === "editor.testing_favorite")?.object.value)
        .toBe("Zed");

      const revision = snapshot.revision;
      const nextConversation = runtime.createConversation();
      const response = await send(runtime, nextConversation, "pilot-fresh-conversation",
        "¿Qué editor estoy usando habitualmente y cuál prefiero para experimentar?");
      expect(response.text).toContain("Windsurf");
      expect(response.text).toContain("Zed");
      expect((await readStoreSnapshot()).snapshot.revision).toBe(revision);
      const context = requests.flatMap(request => request.input ?? []).find((item: any) => item?.type === "function_call_output"
        && typeof item.output === "string" && item.output.includes('"value":"Windsurf"'));
      expect(context).toBeDefined();
      expect(requests.every(request => (request.tools ?? []).every((tool: any) =>
        [organicTool, verifierTool, "search_memory2", "search_conversation_history", "compose_memory_history_answer",
          "interpret_memory_intent", "verify_organic_relationship_evidence"].includes(tool.name))), JSON.stringify(requests.map(request =>
            (request.tools ?? []).map((tool: any) => tool.name)))).toBe(true);
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

  it("offers only built-in Memory2 tools and host evidence cannot be model-issued", async () => {
    await withPilot(async ({ runtime, host, requests }) => {
      const conversation = runtime.createConversation();
      expect((await send(runtime, conversation, "pilot-tools", "Hola Nexa.")).status).toBe("completed");
      const internalMemoryTools = [organicTool, verifierTool, "search_memory2", "search_conversation_history",
        "compose_memory_history_answer", "interpret_memory_intent", "verify_organic_relationship_evidence"];
      const offeredTools = requests.map(request => (request.tools ?? []).map((tool: any) => tool.name));
      expect(requests.every(request => (request.tools ?? []).every((tool: any) => internalMemoryTools.includes(tool.name))),
        JSON.stringify(offeredTools)).toBe(true);
      expect(host.evidenceCapabilityFactory({ origin: "direct_user", subject: "owner", explicit: true,
        certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: true,
        attribute: "editor.habitual", operation: "remember", sourceQuote: "uso Cursor", userMessage: "uso Cursor",
        proposal: { object: { type: "text", value: "Mi editor habitual es Cursor." } } })).toBeNull();
    });
  });
});
