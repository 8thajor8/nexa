import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
// @ts-expect-error The repository's JavaScript Runtime intentionally has no generated declaration file.
import { createAgent } from "../../../../src/core/agent.js";
// @ts-expect-error The authorization contract is shared with the existing Runtime.
import { createOrganicMemoryAuthorization } from "../../../../src/core/organic-memory-authorization.js";
// @ts-expect-error The existing JSON repository is the sole Memory2 persistence layer.
import { createJsonMemoryRepository } from "../../../../src/memory/json-repository.js";
// @ts-expect-error The existing conversation Runtime is the sole Desktop chat Runtime.
import { createConversationRuntime } from "../../../../src/core/conversation-runtime.js";

export const ORGANIC_PILOT_MODE = "memory2-organic-synthetic-test";
export const ORGANIC_PILOT_LABEL = "PILOTO SINTÉTICO — SIN DATOS PERSONALES";
export const ORGANIC_PILOT_SENTINEL = "El usuario ficticio prefiere VS Code como editor de código.";
export const ORGANIC_PILOT_OWNER_ID = "synthetic-owner-memory2-pilot-01";
const ORGANIC_ATTRIBUTES = new Set(["editor.habitual", "editor.testing_favorite"]);
const ORGANIC_SCOPES = Object.freeze(["tool_preferences"]);
const pilotConsentStore = Object.freeze({ async load() { return null; }, async grant() { throw new Error("automatic_memory_disabled"); }, async revoke() { return { success: false }; } });
const pilotProposalQueue = Object.freeze({ async listGrouped() { return []; }, async review() { return null; },
  async approve() { return { success: false }; }, async reject() { return { success: false }; },
  async discard() { return { success: false }; }, async excludeConversation() { return { success: false }; },
  async revokeConsent() { return { success: false }; } });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

/** Main-only attestation of the narrowly synthetic editor-preference fixture. */
export function isApprovedOrganicPilotSnapshot(value: unknown): boolean {
  if (!isPlainRecord(value) || value.schema_version !== 5 || !Array.isArray(value.entities)
    || !Array.isArray(value.assertions) || !Array.isArray(value.sources) || !Array.isArray(value.evidence)
    || value.entities.length !== 1) return false;
  const owner = value.entities[0] as Record<string, unknown> | undefined;
  if (!owner || owner.id !== value.self_person_id || owner.type !== "person") return false;
  const assertions = value.assertions as Array<Record<string, unknown>>;
  const sentinel = assertions.filter(record => (record.subject as Record<string, unknown> | undefined)?.type === "owner"
    && (record.object as Record<string, unknown> | undefined)?.value === ORGANIC_PILOT_SENTINEL);
  if (sentinel.length !== 1) return false;
  for (const record of assertions) {
    if ((record.subject as Record<string, unknown> | undefined)?.type !== "owner") return false;
    if (record === sentinel[0]) continue;
    const compatibility = record.compatibility as Record<string, unknown> | null;
    const object = record.object as Record<string, unknown> | undefined;
    if (record.kind !== "preference" || record.predicate !== "user.preference"
      || !compatibility || compatibility.category !== "preference"
      || typeof compatibility.key !== "string" || !ORGANIC_ATTRIBUTES.has(compatibility.key)
      || object?.type !== "text" || typeof object.value !== "string" || object.value.length > 200) return false;
  }
  return true;
}

export function isApprovedOrganicPilotPath(storePath: string, localAppData: string | undefined,
  repositoryRoot: string): boolean {
  if (!localAppData || !isAbsolute(localAppData) || !isAbsolute(storePath)) return false;
  try {
    const info = lstatSync(storePath);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const localRoot = realpathSync(localAppData);
    const expectedParent = realpathSync(resolve(localRoot, "Nexa", "Temporary", "memory-desktop-01"));
    const actualParent = realpathSync(dirname(storePath));
    const actualPath = realpathSync(storePath).toLocaleLowerCase("en-US");
    const repositoryPath = realpathSync(repositoryRoot).toLocaleLowerCase("en-US");
    const repositoryRelative = relative(repositoryPath, actualPath);
    const insideRepository = repositoryRelative === "" || (repositoryRelative !== ".."
      && !repositoryRelative.startsWith(`..${sep}`) && !isAbsolute(repositoryRelative));
    return actualParent.toLocaleLowerCase("en-US") === expectedParent.toLocaleLowerCase("en-US")
      && basename(storePath) === "nexa-memory2-synthetic-desktop-v5.json"
      && !insideRepository;
  } catch { return false; }
}

export interface OrganicPilotRepository {
  open(): Promise<unknown>;
  readSnapshot(): Promise<{ snapshot: unknown }>;
  close(): Promise<void>;
}

/** Trusted Main host. Capabilities never cross IPC and are revoked on close. */
export function createSyntheticOrganicPilotHost({ repository, now = () => Date.now(), grantConsent = true }: {
  repository: OrganicPilotRepository;
  now?: () => number;
  grantConsent?: boolean;
}) {
  let active = true;
  const storeProofs = new WeakMap<object, object>();
  const consentProofs = new WeakMap<object, object>();
  const evidenceProofs = new WeakMap<object, object>();
  const authorizations: Array<{ authorization: { setSyntheticConsent(capability: object, decision: string, scopes: string[], ttlMs?: number): unknown;
    revokeSyntheticConsent(capability: object): unknown }; grantCapability: object; revokeCapability: object }> = [];
  const sessionId = randomUUID();

  const authorizationFactory = ({ repository: target, persist }: {
    repository: OrganicPilotRepository; persist: (...args: unknown[]) => unknown;
  }) => {
    if (target !== repository) throw new Error("organic_pilot_repository_rejected");
    const storeCapability = Object.freeze(Object.create(null)) as object;
    storeProofs.set(storeCapability, Object.freeze({ sessionId, repository, ownerId: ORGANIC_PILOT_OWNER_ID,
      kind: "synthetic_test", isolated: true, personalData: false }));
    const authorization = createOrganicMemoryAuthorization({
      storeCapability,
      verifyStoreCapability: (capability: object) => {
        const proof = storeProofs.get(capability) as Record<string, unknown> | undefined;
        return active && proof?.sessionId === sessionId && proof.repository === repository ? proof : null;
      },
      persist,
      verifyConsentCapability: (capability: object) => {
        const proof = consentProofs.get(capability) as Record<string, unknown> | undefined;
        return active && proof?.sessionId === sessionId ? proof : null;
      },
      verifyEvidenceCapability: (capability: object) => {
        const proof = evidenceProofs.get(capability) as Record<string, unknown> | undefined;
        return active && proof?.sessionId === sessionId ? proof : null;
      },
      now,
    });
    const grantCapability = Object.freeze(Object.create(null)) as object;
    consentProofs.set(grantCapability, Object.freeze({ sessionId, ownerId: ORGANIC_PILOT_OWNER_ID, issuer: "owner", synthetic: true,
      purpose: "organic_memory_learning", decision: "granted", scopes: ORGANIC_SCOPES }));
    if (active && grantConsent) authorization.setSyntheticConsent(grantCapability, "granted", [...ORGANIC_SCOPES]);
    const revokeCapability = Object.freeze(Object.create(null)) as object;
    consentProofs.set(revokeCapability, Object.freeze({ sessionId, ownerId: ORGANIC_PILOT_OWNER_ID, issuer: "owner", synthetic: true,
      purpose: "organic_memory_learning", decision: "revoked", scopes: ORGANIC_SCOPES }));
    authorizations.push({ authorization, grantCapability, revokeCapability });
    return authorization;
  };

  const evidenceCapabilityFactory = (evidence: Record<string, unknown>): object | null => {
    if (!active || evidence.origin !== "direct_user" || evidence.subject !== "owner"
      || evidence.explicit !== true || evidence.certain !== true || evidence.sensitive !== false
      || evidence.ambiguous !== false || evidence.thirdParty !== false || evidence.modelOriginated !== false
      || !ORGANIC_ATTRIBUTES.has(String(evidence.attribute)) || !["remember", "update"].includes(String(evidence.operation))) return null;
    const quote = evidence.sourceQuote;
    const userMessage = evidence.userMessage;
    const proposal = evidence.proposal as Record<string, unknown> | undefined;
    const object = proposal?.object as Record<string, unknown> | undefined;
    if (typeof quote !== "string" || quote.length < 3 || typeof userMessage !== "string"
      || !userMessage.includes(quote) || !object || object.type !== "text" || typeof object.value !== "string") return null;
    // The Runtime persists the verifier-approved normalized fact value. This
    // synthetic host mirrors that contract while still requiring literal quote evidence.
    if (!object.value.trim() || !quote.includes(object.value.trim())) return null;
    if (grantConsent) {
      for (const item of authorizations) {
        try { item.authorization.setSyntheticConsent(item.grantCapability, "granted", [...ORGANIC_SCOPES], 60_000); }
        catch { /* An expired or revoked host authorization cannot be silently restored. */ }
      }
    }
    const capability = Object.freeze(Object.create(null)) as object;
    evidenceProofs.set(capability, Object.freeze({ sessionId, ownerId: ORGANIC_PILOT_OWNER_ID, origin: "direct_user", subject: "owner",
      explicit: true, certain: true, sensitive: false, ambiguous: false, thirdParty: false,
      modelOriginated: false, attribute: evidence.attribute, extractionConfidence: evidence.extractionConfidence,
      proposal }));
    return capability;
  };

  function revoke() {
    if (!active) return;
    for (const item of authorizations) {
      try { item.authorization.revokeSyntheticConsent(item.revokeCapability); } catch { /* Session invalidation below is authoritative. */ }
    }
    active = false;
  }

  return Object.freeze({ sessionId, authorizationFactory, evidenceCapabilityFactory, revoke,
    get active() { return active; } });
}

export async function createSyntheticOrganicPilotSession({ storePath, repositoryRoot, localAppData,
  repositoryFactory = createJsonMemoryRepository, agentOptions = {}, ask, grantConsent = true, now = () => Date.now() }:
  { storePath: string; repositoryRoot: string; localAppData?: string; repositoryFactory?: (options: { storePath: string }) => OrganicPilotRepository;
    agentOptions?: Record<string, unknown>; ask?: (...args: unknown[]) => unknown; grantConsent?: boolean; now?: () => number }) {
  if (!isApprovedOrganicPilotPath(storePath, localAppData, repositoryRoot)) throw new Error("organic_pilot_store_path_rejected");
  const repository = repositoryFactory({ storePath });
  try {
    await repository.open();
    if (!isApprovedOrganicPilotSnapshot((await repository.readSnapshot()).snapshot)) throw new Error("organic_pilot_store_identity_rejected");
    const host = createSyntheticOrganicPilotHost({ repository, grantConsent, now });
    const runtime = createConversationRuntime({
      memoryMode: "memory2",
      agentOptions: { getTools: () => [], ...agentOptions },
      agentFactory: ({ agentOptions: runtimeAgentOptions }: { agentOptions: Record<string, unknown> }) => createAgent({
        ...runtimeAgentOptions,
        ...(ask ? { ask } : {}),
        memoryBackend: "memory2",
        memory2Repository: repository,
        memoryRetrievalEnabled: true,
        enableSyntheticOrganicLearning: true,
        operationalMemoryMode: ORGANIC_PILOT_MODE,
        operationalMemoryStoreIdentity: "synthetic_memory_desktop_01",
        enableConfirmedMemoryWrites: false,
        enableAutomaticMemoryAssessment: false,
        automaticMemoryConsentStore: pilotConsentStore,
        automaticMemoryProposalQueue: pilotProposalQueue,
        getTools: () => [],
        organicMemoryAuthorizationFactory: host.authorizationFactory,
        organicEvidenceCapabilityFactory: host.evidenceCapabilityFactory,
      }),
    });
    let closed = false;
    return Object.freeze({ runtime, host, close: async () => {
      if (closed) return;
      closed = true;
      host.revoke();
      try { await runtime.close(); } finally { await repository.close(); }
    }, readStoreSnapshot: () => repository.readSnapshot() });
  } catch (error) {
    await repository.close().catch(() => undefined);
    throw error;
  }
}
