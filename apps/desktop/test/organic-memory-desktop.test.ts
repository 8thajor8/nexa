import { describe, expect, it } from "vitest";
import { createDesktopOrganicMemoryHost } from "../src/main/organic-memory-desktop.js";
// @ts-expect-error Shared Runtime contract has no generated declaration file.
import { ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE } from "../../../src/core/organic-memory-authorization.js";

function makeHost(enabled = false) {
  const host = createDesktopOrganicMemoryHost({ storePath: "C:/synthetic/memory-v5.json", relationshipLearningEnabled: enabled });
  const repository = {};
  const authorization = host.authorizationFactory({ repository, persist: async () => ({ success: true }) });
  return { host, authorization, repository };
}

const directEvidence = {
  origin: "direct_user", subject: "owner", explicit: true, certain: true, sensitive: false,
  ambiguous: false, thirdParty: false, modelOriginated: false, operation: "remember_relationship",
  scope: "personal_relationships", attribute: "relationship.partner", preferredName: "Alex",
  sourceQuote: "Alex es mi pareja.", userMessage: "Alex es mi pareja.",
};
const approvedFactAssessment = Object.freeze({ supported: true, explicit: true, subjectMatches: true,
  temporalMatches: true, nonSensitive: true, unambiguous: true });
const verifiedRelationshipAssessment = Object.fromEntries(["quoteIsLiteral", "ownerIsParticipant", "relationshipIsCurrent",
  "relationshipIsExplicit", "notHypotheticalOrQuestion", "notQuotedOrThirdParty", "personNameSupported",
  "relationshipLabelSupported", "categorySupported", "notSensitive", "unambiguous"].map(key => [key, true]));

describe("Desktop relationship-learning consent issuer", () => {
  it("issues third-party evidence only for an identified entity and rechecks the independent scope", () => {
    const { host, authorization } = makeHost(false);
    const quote = "Coti es arquitecta.";
    const evidence = { origin: "direct_user", subject: "third_party", explicit: true, certain: true,
      sensitive: false, ambiguous: false, thirdParty: true, modelOriginated: false,
      operation: "remember", attribute: "biography.occupation", value: "arquitecta", sourceQuote: quote,
      semanticEvidenceVerified: "organic_memory_fact_v1", verificationAssessment: approvedFactAssessment,
      userMessage: quote, subjectName: "Coti", subjectReference: null, extractionConfidence: 0.95,
      proposal: { kind: "fact", subject: { type: "entity", entity_type: "person", id: "person_00000000-0000-4000-8000-000000000001" },
        predicate: "user.biography", object: { type: "text", value: quote }, valid_from: null, valid_to: null,
        compatibility: { category: "fact", key: "biography.occupation" } } };
    const capability = host.thirdPartyEvidenceCapabilityFactory(evidence);
    expect(capability).toBeTruthy();
    const input = { scope: "third_party_facts", operation: "remember", attribute: "biography.occupation", evidenceCapability: capability };
    expect(authorization.verify(input).allowed).toBe(true);
    expect(authorization.inspect().scopes).not.toContain("personal_relationships");
    host.setThirdPartyLearningEnabled(false);
    expect(authorization.verify(input).allowed).toBe(false);
    expect(host.thirdPartyEvidenceCapabilityFactory(evidence)).toBeNull();
    expect(authorization.inspect().scopes).not.toContain("third_party_facts");
    host.revoke();
  });
  it("accepts only literal owner evidence for new everyday categories and explicit cessation", () => {
    const { host, authorization } = makeHost();
    const sourceQuote = "Soy desarrollador web.";
    const evidence = { origin: "direct_user", subject: "owner", explicit: true, certain: true,
      sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
      operation: "remember", attribute: "biography.occupation", value: "desarrollador web",
      semanticEvidenceVerified: "organic_memory_fact_v1", verificationAssessment: approvedFactAssessment,
      sourceQuote, userMessage: sourceQuote, extractionConfidence: 0.95,
      proposal: { kind: "fact", subject: { type: "owner" }, predicate: "user.biography",
        object: { type: "text", value: "Mi ocupación es desarrollador web." },
        valid_from: null, valid_to: null, compatibility: { category: "fact", key: "biography.occupation" } } };
    const capability = host.evidenceCapabilityFactory(evidence);
    expect(capability).toBeTruthy();
    expect(authorization.verify({ scope: "biography", operation: "remember",
      attribute: "biography.occupation", evidenceCapability: capability }).allowed).toBe(true);
    const cessation = { ...evidence, sourceQuote: "Ya no practico buceo.", userMessage: "Ya no practico buceo.",
      attribute: "practice.diving", value: "buceo", operation: "update",
      proposal: { kind: "fact", subject: { type: "owner" }, predicate: "user.practice",
        object: { type: "text", value: "Ya no practico buceo." }, valid_from: null, valid_to: null,
        compatibility: { category: "fact", key: "practice.diving" } } };
    expect(host.evidenceCapabilityFactory(cessation)).toBeTruthy();
    expect(host.evidenceCapabilityFactory({ ...cessation, sourceQuote: "Antes practicaba buceo.",
      userMessage: "Antes practicaba buceo.", proposal: { ...cessation.proposal,
        object: { type: "text", value: "Antes practicaba buceo." } } })).toBeNull();
    expect(host.evidenceCapabilityFactory({ ...evidence, subject: "third_party", thirdParty: true })).toBeNull();
    expect(host.evidenceCapabilityFactory({ ...evidence, semanticEvidenceVerified: undefined })).toBeNull();
    expect(host.evidenceCapabilityFactory({ ...evidence,
      verificationAssessment: { ...approvedFactAssessment, supported: false } })).toBeNull();
    host.revoke();
  });

  it("accepts a semantically verified normalized value without requiring it inside the literal quote", () => {
    const { host, authorization } = makeHost();
    const quote = "Toco viola de gamba.";
    const evidence = { origin: "direct_user", subject: "owner", explicit: true, certain: true,
      sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
      operation: "remember", attribute: "hobby.instrument_viola_da_gamba", value: "viola da gamba",
      semanticEvidenceVerified: "organic_memory_fact_v1", verificationAssessment: approvedFactAssessment,
      sourceQuote: quote, userMessage: quote, extractionConfidence: 0.95,
      proposal: { kind: "fact", subject: { type: "owner" }, predicate: "user.hobby",
        object: { type: "text", value: "Toco viola da gamba." }, valid_from: null, valid_to: null,
        compatibility: { category: "fact", key: "hobby.instrument_viola_da_gamba" } } };
    const capability = host.evidenceCapabilityFactory(evidence);
    expect(capability).toBeTruthy();
    expect(authorization.verify({ scope: "hobbies", operation: "remember", attribute: evidence.attribute,
      evidenceCapability: capability }).allowed).toBe(true);
    expect(host.evidenceCapabilityFactory({ ...evidence, userMessage: "Una cita diferente." })).toBeNull();
    host.revoke();
  });
  it("keeps its scope out of the normal owner consent by default and adds/removes it on setting changes", () => {
    const { host, authorization } = makeHost();
    expect(authorization.inspect().scopes).not.toContain("personal_relationships");
    host.setRelationshipLearningEnabled(true);
    expect(authorization.inspect().scopes).toContain("personal_relationships");
    host.setRelationshipLearningEnabled(false);
    expect(authorization.inspect().scopes).not.toContain("personal_relationships");
    host.revoke();
  });

  it("issues direct relationship evidence only while enabled and for an exact owner declaration", () => {
    const { host, authorization } = makeHost(true);
    const capability = host.relationshipEvidenceCapabilityFactory(directEvidence);
    expect(capability).toBeTruthy();
    expect(authorization.verify({ scope: "personal_relationships", operation: "remember_relationship",
      attribute: "relationship.partner", evidenceCapability: capability }).allowed).toBe(true);
    expect(host.relationshipEvidenceCapabilityFactory({ ...directEvidence, sourceQuote: "Alex es la pareja de Sam", userMessage: "Alex es la pareja de Sam" })).toBeNull();
    expect(host.relationshipEvidenceCapabilityFactory({ ...directEvidence,
      sourceQuote: "Alex es mi pareja.", userMessage: "Alex dijo: Alex es mi pareja." })).toBeNull();
    expect(host.relationshipEvidenceCapabilityFactory({ ...directEvidence, certain: false })).toBeNull();
    host.setRelationshipLearningEnabled(false);
    expect(host.relationshipLearningEnabled).toBe(false);
    expect(host.relationshipEvidenceCapabilityFactory(directEvidence)).toBeNull();
    host.revoke();
  });

  it("issues typed relationship evidence only after semantic verification and for supported own categories", () => {
    const { host, authorization } = makeHost(true);
    const typedEvidence = { ...directEvidence, attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE,
      preferredName: "Diego", sourceQuote: "Diego es mi hermano.", userMessage: "Diego es mi hermano.",
      relationshipType: { category: "family", label: "hermano" },
      verificationAssessment: verifiedRelationshipAssessment,
      semanticEvidenceVerified: "direct_owner_relationship_v1" };
    const capability = host.relationshipEvidenceCapabilityFactory(typedEvidence);
    expect(capability).toBeTruthy();
    expect(authorization.verify({ scope: "personal_relationships", operation: "remember_relationship",
      attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, evidenceCapability: capability }).allowed).toBe(true);
    const inflectedEvidence = { ...typedEvidence, sourceQuote: "Diego y yo somos hermanos.",
      userMessage: "Diego y yo somos hermanos." };
    const inflectedCapability = host.relationshipEvidenceCapabilityFactory(inflectedEvidence);
    expect(inflectedCapability).toBeTruthy();
    expect(authorization.verify({ scope: "personal_relationships", operation: "remember_relationship",
      attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, evidenceCapability: inflectedCapability }).allowed).toBe(true);
    expect(host.relationshipEvidenceCapabilityFactory({ ...inflectedEvidence,
      verificationAssessment: { ...verifiedRelationshipAssessment, relationshipLabelSupported: false } })).toBeNull();
    expect(host.relationshipEvidenceCapabilityFactory({ ...typedEvidence, semanticEvidenceVerified: "" })).toBeNull();
    expect(host.relationshipEvidenceCapabilityFactory({ ...typedEvidence,
      relationshipType: { category: "professional", label: "jefe" } })).toBeNull();
    expect(host.relationshipEvidenceCapabilityFactory({ ...typedEvidence,
      sourceQuote: "Diego dijo que es mi hermano.", userMessage: "Diego dijo que es mi hermano.",
      verificationAssessment: { ...verifiedRelationshipAssessment, notQuotedOrThirdParty: false } })).toBeNull();
    expect(host.relationshipEvidenceCapabilityFactory({ ...typedEvidence,
      verificationAssessment: { ...verifiedRelationshipAssessment, notQuotedOrThirdParty: false } })).toBeNull();
    host.setRelationshipLearningEnabled(false);
    expect(host.relationshipEvidenceCapabilityFactory(typedEvidence)).toBeNull();
    host.revoke();
  });
});
