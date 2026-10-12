import { randomUUID } from "node:crypto";
// @ts-expect-error Shared Runtime contract has no generated declaration file.
import { createOrganicMemoryAuthorization, getOrganicMemoryAttributePolicy } from "../../../../src/core/organic-memory-authorization.js";

const OWNER_SCOPES = Object.freeze([
  "tool_preferences", "entertainment_preferences", "food_activity_preferences", "interaction_preferences",
  "daily_routines", "work_patterns", "recurring_activities", "active_projects", "interests", "goals",
]);
const CONSENT_TTL_MS = 12 * 60 * 60 * 1000;

type EvidenceInput = Record<string, unknown>;
type OrganicRepository = object;

/** Trusted Main-process issuer bound to one selected personal Memory2 repository. */
export function createDesktopOrganicMemoryHost({ storePath, mode = "memory2-confirmed-write" }: {
  storePath: string;
  mode?: "memory2-confirmed-write";
}) {
  const sessionId = randomUUID();
  const ownerId = randomUUID();
  let active = true;
  const storeProofs = new WeakMap<object, object>();
  const consentProofs = new WeakMap<object, object>();
  const evidenceProofs = new WeakMap<object, object>();
  const authorizations: Array<{ authorization: { setOwnerConsent: Function; revokeOwnerConsent: Function };
    revokeCapability: object }> = [];

  const authorizationFactory = ({ repository, persist }: { repository: OrganicRepository; persist: (...args: unknown[]) => unknown }) => {
    if (!active || !repository || typeof repository !== "object") throw new Error("organic_owner_repository_rejected");
    const storeCapability = Object.freeze(Object.create(null)) as object;
    storeProofs.set(storeCapability, Object.freeze({ sessionId, repository, storePath, ownerId,
      kind: "memory2_personal", personalData: true, mode }));
    const authorization = createOrganicMemoryAuthorization({
      storeCapability,
      verifyStoreCapability: (capability: object) => {
        const proof = storeProofs.get(capability) as Record<string, unknown> | undefined;
        return active && proof?.sessionId === sessionId && proof.repository === repository
          && proof.storePath === storePath && proof.ownerId === ownerId && proof.mode === mode ? proof : null;
      },
      persist,
      verifyConsentCapability: (capability: object) => {
        const proof = consentProofs.get(capability) as Record<string, unknown> | undefined;
        return active && proof?.sessionId === sessionId && proof.ownerId === ownerId && proof.mode === mode ? proof : null;
      },
      verifyEvidenceCapability: (capability: object) => {
        const proof = evidenceProofs.get(capability) as Record<string, unknown> | undefined;
        return active && proof?.sessionId === sessionId && proof.ownerId === ownerId ? proof : null;
      },
    });
    const revokeCapability = Object.freeze(Object.create(null)) as object;
    consentProofs.set(revokeCapability, Object.freeze({ sessionId, ownerId, mode, issuer: "owner", personal: true,
      purpose: "organic_memory_learning", decision: "revoked", scopes: OWNER_SCOPES }));
    const grantCapability = Object.freeze(Object.create(null)) as object;
    consentProofs.set(grantCapability, Object.freeze({ sessionId, ownerId, mode, issuer: "owner", personal: true,
      purpose: "organic_memory_learning", decision: "granted", scopes: OWNER_SCOPES }));
    const grant = authorization.setOwnerConsent(grantCapability, "granted", [...OWNER_SCOPES], CONSENT_TTL_MS);
    if (grant?.status !== "granted") throw new Error("organic_owner_consent_rejected");
    authorizations.push({ authorization, revokeCapability });
    return authorization;
  };

  const evidenceCapabilityFactory = (evidence: EvidenceInput): object | null => {
    if (!active || evidence.origin !== "direct_user" || evidence.subject !== "owner"
      || evidence.explicit !== true || evidence.certain !== true || evidence.sensitive !== false
      || evidence.ambiguous !== false || evidence.thirdParty !== false || evidence.modelOriginated !== false
      || !["remember", "update"].includes(String(evidence.operation))) return null;
    const attributePolicy = getOrganicMemoryAttributePolicy(evidence.attribute);
    if (!attributePolicy || !OWNER_SCOPES.includes(attributePolicy.scope)) return null;
    const quote = evidence.sourceQuote;
    const userMessage = evidence.userMessage;
    const value = evidence.value;
    const proposal = evidence.proposal as Record<string, unknown> | undefined;
    const object = proposal?.object as Record<string, unknown> | undefined;
    const subject = proposal?.subject as Record<string, unknown> | undefined;
    const compatibility = proposal?.compatibility as Record<string, unknown> | undefined;
    if (typeof quote !== "string" || quote.length < 3 || typeof value !== "string" || value.length < 1 || value.length > 180
      || typeof userMessage !== "string"
      || !userMessage.includes(quote) || !proposal || object?.type !== "text" || typeof object.value !== "string") return null;
    if (!quote.includes(value) || proposal?.kind !== attributePolicy.kind
      || proposal.predicate !== attributePolicy.predicate || subject?.type !== "owner"
      || compatibility?.category !== attributePolicy.category
      || compatibility?.key !== evidence.attribute || object.value !== attributePolicy.render(value)
      || proposal.valid_from !== null || proposal.valid_to !== null) return null;
    const capability = Object.freeze(Object.create(null)) as object;
    evidenceProofs.set(capability, Object.freeze({ sessionId, ownerId, origin: "direct_user", subject: "owner",
      explicit: true, certain: true, sensitive: false, ambiguous: false, thirdParty: false,
      modelOriginated: false, attribute: evidence.attribute, extractionConfidence: evidence.extractionConfidence,
      proposal }));
    return capability;
  };

  function revoke() {
    if (!active) return;
    for (const item of authorizations) {
      try { item.authorization.revokeOwnerConsent(item.revokeCapability); } catch { /* Deactivation below is authoritative. */ }
    }
    active = false;
  }

  return Object.freeze({ authorizationFactory, evidenceCapabilityFactory, revoke,
    get active() { return active; }, storePath, mode });
}
