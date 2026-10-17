import { randomUUID } from "node:crypto";
// @ts-expect-error Shared Runtime contract has no generated declaration file.
import { createOrganicMemoryAuthorization, getOrganicMemoryAttributePolicy, ORGANIC_RELATIONSHIP_SCOPE, ORGANIC_RELATIONSHIP_ATTRIBUTE, ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, ORGANIC_THIRD_PARTY_SCOPE, parseDirectOwnerPartnerStatement } from "../../../../src/core/organic-memory-authorization.js";
// @ts-expect-error Shared Memory2 contract has no generated declaration file.
import { normalizeEntityName } from "../../../../src/memory/entities.js";
// @ts-expect-error Shared Memory2 contract has no generated declaration file.
import { validateRelationshipType } from "../../../../src/memory/schema.js";

const OWNER_SCOPES = Object.freeze([
  "everyday_facts",
  "tool_preferences", "entertainment_preferences", "food_activity_preferences", "interaction_preferences",
  "daily_routines", "work_patterns", "recurring_activities", "active_projects", "interests", "goals",
  "biography", "hobbies", "decisions",
]);
const RELATIONSHIP_SCOPE = ORGANIC_RELATIONSHIP_SCOPE;
const CONSENT_TTL_MS = 12 * 60 * 60 * 1000;
const RELATIONSHIP_VERIFIER_FIELDS = Object.freeze(["quoteIsLiteral", "ownerIsParticipant", "relationshipIsCurrent",
  "relationshipIsExplicit", "notHypotheticalOrQuestion", "notQuotedOrThirdParty", "personNameSupported",
  "relationshipLabelSupported", "categorySupported", "notSensitive", "unambiguous"]);
const ORGANIC_FACT_VERIFIER_FIELDS = Object.freeze(["supported", "explicit", "subjectMatches", "temporalMatches",
  "nonSensitive", "unambiguous"]);

function hasApprovedOrganicFactAssessment(evidence: EvidenceInput): boolean {
  const assessment = evidence.verificationAssessment;
  return evidence.semanticEvidenceVerified === "organic_memory_fact_v1"
    && assessment !== null && typeof assessment === "object" && !Array.isArray(assessment)
    && Object.getPrototypeOf(assessment) === Object.prototype
    && Object.keys(assessment).length === ORGANIC_FACT_VERIFIER_FIELDS.length
    && ORGANIC_FACT_VERIFIER_FIELDS.every(field => (assessment as Record<string, unknown>)[field] === true);
}

type EvidenceInput = Record<string, unknown>;
type OrganicRepository = object;

function containsNamedPerson(text: string, name: string): boolean {
  const normalizedText = normalizeEntityName(text);
  const normalizedName = normalizeEntityName(name);
  if (!normalizedText || !normalizedName) return false;
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(normalizedText);
}

/** Trusted Main-process issuer bound to one selected personal Memory2 repository. */
export function createDesktopOrganicMemoryHost({ storePath, mode = "memory2-confirmed-write", relationshipLearningEnabled = false,
  thirdPartyLearningEnabled = true }: {
  storePath: string;
  mode?: "memory2-confirmed-write";
  relationshipLearningEnabled?: boolean;
  thirdPartyLearningEnabled?: boolean;
}) {
  const sessionId = randomUUID();
  const ownerId = randomUUID();
  let active = true;
  const storeProofs = new WeakMap<object, object>();
  const consentProofs = new WeakMap<object, object>();
  const evidenceProofs = new WeakMap<object, object>();
  const authorizations: Array<{ authorization: { setOwnerConsent: Function; revokeOwnerConsent: Function; inspect: Function } }> = [];
  let relationLearningEnabled = relationshipLearningEnabled === true;
  let thirdPartyEnabled = thirdPartyLearningEnabled === true;

  function consentCapability(scopes: readonly string[], decision: "granted" | "revoked") {
    const capability = Object.freeze(Object.create(null)) as object;
    consentProofs.set(capability, Object.freeze({ sessionId, ownerId, mode, issuer: "owner", personal: true,
      purpose: "organic_memory_learning", decision, scopes: [...scopes] }));
    return capability;
  }

  function activeScopes() {
    return [...OWNER_SCOPES, ...(relationLearningEnabled ? [RELATIONSHIP_SCOPE] : []),
      ...(thirdPartyEnabled ? [ORGANIC_THIRD_PARTY_SCOPE] : [])];
  }

  function updateAuthorizations() {
    const scopes = activeScopes();
    for (const { authorization } of authorizations) {
      const capability = consentCapability(scopes, "granted");
      const grant = authorization.setOwnerConsent(capability, "granted", scopes, CONSENT_TTL_MS);
      if (grant?.status !== "granted") throw new Error("organic_owner_consent_rejected");
    }
  }

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
    const scopes = activeScopes();
    const grant = authorization.setOwnerConsent(consentCapability(scopes, "granted"), "granted", [...scopes], CONSENT_TTL_MS);
    if (grant?.status !== "granted") throw new Error("organic_owner_consent_rejected");
    authorizations.push({ authorization });
    return authorization;
  };

  const evidenceCapabilityFactory = (evidence: EvidenceInput): object | null => {
    if (!active || evidence.origin !== "direct_user" || evidence.subject !== "owner"
      || evidence.explicit !== true || evidence.certain !== true || evidence.sensitive !== false
      || evidence.ambiguous !== false || evidence.thirdParty !== false || evidence.modelOriginated !== false
      || !["remember", "update"].includes(String(evidence.operation))
      || !hasApprovedOrganicFactAssessment(evidence)) return null;
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
    if (proposal?.kind !== attributePolicy.kind
      || proposal.predicate !== attributePolicy.predicate || subject?.type !== "owner"
      || compatibility?.category !== attributePolicy.category
      || compatibility?.key !== evidence.attribute
      || object.value.trim().length < 1 || object.value.length > 180
      || (evidence.expectedPriorAssertionId !== undefined && evidence.expectedPriorAssertionId !== null
        && typeof evidence.expectedPriorAssertionId !== "string")
      || proposal.valid_from !== null || proposal.valid_to !== null) return null;
    const capability = Object.freeze(Object.create(null)) as object;
    evidenceProofs.set(capability, Object.freeze({ sessionId, ownerId, origin: "direct_user", subject: "owner",
      explicit: true, certain: true, sensitive: false, ambiguous: false, thirdParty: false,
      modelOriginated: false, attribute: evidence.attribute, extractionConfidence: evidence.extractionConfidence,
      ...(evidence.expectedPriorAssertionId !== undefined
        ? { expectedPriorAssertionId: evidence.expectedPriorAssertionId } : {}),
      proposal }));
    return capability;
  };

  const thirdPartyEvidenceCapabilityFactory = (evidence: EvidenceInput): object | null => {
    if (!active || !thirdPartyEnabled || evidence.origin !== "direct_user" || evidence.subject !== "third_party"
      || evidence.explicit !== true || evidence.certain !== true || evidence.sensitive !== false
      || evidence.ambiguous !== false || evidence.thirdParty !== true || evidence.modelOriginated !== false
      || !["remember", "update"].includes(String(evidence.operation))
      || !hasApprovedOrganicFactAssessment(evidence)) return null;
    const attributePolicy = getOrganicMemoryAttributePolicy(evidence.attribute);
    if (!attributePolicy) return null;
    const quote = evidence.sourceQuote;
    const userMessage = evidence.userMessage;
    const value = evidence.value;
    const subjectName = evidence.subjectName;
    const subjectReference = evidence.subjectReference;
    const proposal = evidence.proposal as Record<string, unknown> | undefined;
    const object = proposal?.object as Record<string, unknown> | undefined;
    const subject = proposal?.subject as Record<string, unknown> | undefined;
    const compatibility = proposal?.compatibility as Record<string, unknown> | undefined;
    if (typeof quote !== "string" || quote.length < 3 || typeof userMessage !== "string"
      || !userMessage.includes(quote) || typeof value !== "string"
      || typeof subjectName !== "string" || !subjectName.trim() || typeof object?.value !== "string"
      || !object.value.trim() || object.value.length > 180 || !proposal || !compatibility
      || subject?.type !== "entity" || subject.entity_type !== "person"
      || typeof subject.id !== "string" || proposal.kind !== attributePolicy.kind
      || proposal.predicate !== attributePolicy.predicate || compatibility.category !== attributePolicy.category
      || compatibility.key !== evidence.attribute || proposal.valid_from !== null || proposal.valid_to !== null
      || (subjectReference === null
        ? !containsNamedPerson(quote, subjectName)
        : typeof subjectReference !== "string" || !/^[\p{L} ]{2,50}$/u.test(subjectReference))) return null;
    const capability = Object.freeze(Object.create(null)) as object;
    evidenceProofs.set(capability, Object.freeze({ sessionId, ownerId, origin: "direct_user", subject: "third_party",
      explicit: true, certain: true, sensitive: false, ambiguous: false, thirdParty: true, modelOriginated: false,
      attribute: evidence.attribute, extractionConfidence: evidence.extractionConfidence,
      ...(evidence.expectedPriorAssertionId !== undefined
        ? { expectedPriorAssertionId: evidence.expectedPriorAssertionId } : {}),
      sourceQuote: quote, userMessage, subjectName, subjectReference, proposal }));
    return capability;
  };

  /** Separate evidence issuer for a future relationship extractor; not exposed to Agent today. */
  const relationshipEvidenceCapabilityFactory = (evidence: EvidenceInput): object | null => {
    if (!active || !relationLearningEnabled || evidence.origin !== "direct_user" || evidence.subject !== "owner"
      || evidence.explicit !== true || evidence.certain !== true || evidence.sensitive !== false
      || evidence.ambiguous !== false || evidence.thirdParty !== false || evidence.modelOriginated !== false
      || evidence.operation !== "remember_relationship" || evidence.scope !== RELATIONSHIP_SCOPE) return null;
    const quote = evidence.sourceQuote;
    const userMessage = evidence.userMessage;
    const preferredName = evidence.preferredName;
    if (typeof quote !== "string" || typeof userMessage !== "string" || typeof preferredName !== "string") return null;
    if (evidence.attribute === ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE) {
      const relationshipType = evidence.relationshipType as Record<string, unknown> | undefined;
      const verification = evidence.verificationAssessment as Record<string, unknown> | undefined;
      if (!relationLearningEnabled || evidence.semanticEvidenceVerified !== "direct_owner_relationship_v1"
        || !verification || Object.getPrototypeOf(verification) !== Object.prototype
        || Object.keys(verification).length !== RELATIONSHIP_VERIFIER_FIELDS.length
        || !RELATIONSHIP_VERIFIER_FIELDS.every(field => verification[field] === true)
        || !["family", "partner", "friend"].includes(String(relationshipType?.category))) return null;
      try { validateRelationshipType(relationshipType, "evidence.relationshipType"); } catch { return null; }
      if (!userMessage.includes(quote) || !containsNamedPerson(quote, preferredName)) return null;
      const capability = Object.freeze(Object.create(null)) as object;
      evidenceProofs.set(capability, Object.freeze({ sessionId, ownerId, origin: "direct_user", subject: "owner",
        explicit: true, certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
        attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, preferredName: preferredName.trim().replace(/\s+/gu, " "),
        relationshipType: Object.freeze({ category: relationshipType?.category, label: relationshipType?.label }),
        semanticEvidenceVerified: "direct_owner_relationship_v1", sourceQuote: quote, userMessage }));
      return capability;
    }
    if (evidence.attribute !== ORGANIC_RELATIONSHIP_ATTRIBUTE) return null;
    const parsed = parseDirectOwnerPartnerStatement(quote);
    const isStandaloneCurrentUserStatement = userMessage.split(/(?<=[.!?])\s+|\r?\n/u)
      .some(sentence => sentence.trim() === quote.trim());
    if (!parsed || !isStandaloneCurrentUserStatement
      || normalizeEntityName(parsed.preferredName) !== normalizeEntityName(preferredName)) return null;
    const capability = Object.freeze(Object.create(null)) as object;
    evidenceProofs.set(capability, Object.freeze({ sessionId, ownerId, origin: "direct_user", subject: "owner",
      explicit: true, certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
      attribute: ORGANIC_RELATIONSHIP_ATTRIBUTE, preferredName: parsed.preferredName, sourceQuote: quote, userMessage }));
    return capability;
  };

  function setRelationshipLearningEnabled(enabled: boolean) {
    if (typeof enabled !== "boolean") throw new TypeError("relationship_learning_preference_invalid");
    relationLearningEnabled = enabled;
    updateAuthorizations();
    return relationLearningEnabled;
  }

  function setThirdPartyLearningEnabled(enabled: boolean) {
    if (typeof enabled !== "boolean") throw new TypeError("third_party_learning_preference_invalid");
    thirdPartyEnabled = enabled;
    updateAuthorizations();
    return thirdPartyEnabled;
  }

  function revoke() {
    if (!active) return;
    for (const { authorization } of authorizations) {
      try {
        const scopes = authorization.inspect()?.scopes;
        const revokeScopes = Array.isArray(scopes) && scopes.length ? scopes : [...OWNER_SCOPES];
        authorization.revokeOwnerConsent(consentCapability(revokeScopes, "revoked"));
      } catch { /* Deactivation below is authoritative. */ }
    }
    active = false;
  }

  return Object.freeze({ authorizationFactory, evidenceCapabilityFactory, relationshipEvidenceCapabilityFactory,
    thirdPartyEvidenceCapabilityFactory, setRelationshipLearningEnabled, setThirdPartyLearningEnabled, revoke,
    get active() { return active; }, get relationshipLearningEnabled() { return active && relationLearningEnabled; },
    get thirdPartyLearningEnabled() { return active && thirdPartyEnabled; }, storePath, mode });
}
