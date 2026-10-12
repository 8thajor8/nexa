import { describe, expect, it } from "vitest";
import { createDesktopOrganicMemoryHost } from "../src/main/organic-memory-desktop.js";
import { getOrganicMemoryAttributePolicy } from "../../../src/core/organic-memory-authorization.js";

const sourceQuote = "Últimamente uso Cursor todos los días para trabajar.";
const userMessage = `${sourceQuote} Zed me gusta para hacer pruebas.`;
const proposal = { kind: "preference", subject: { type: "owner" }, predicate: "user.preference",
  compatibility: { category: "preference", key: "editor.habitual" }, object: { type: "text", value: "Mi editor habitual es Cursor." },
  valid_from: null, valid_to: null };

describe("Desktop personal organic Memory2 host", () => {
  it("authorizes only direct, owner-scoped preference evidence for the selected writable mode", async () => {
    const host = createDesktopOrganicMemoryHost({ storePath: "C:/nexa/data/memory-v2.json" });
    const repository = {};
    let persisted = 0;
    const authorization = host.authorizationFactory({ repository, persist: async (_input, context) => {
      persisted += 1;
      return { success: true, ownerOnly: context.ownerOnly };
    } });
    const evidenceCapability = host.evidenceCapabilityFactory({ origin: "direct_user", subject: "owner", explicit: true,
      certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
      attribute: "editor.habitual", value: "Cursor", operation: "remember", sourceQuote, userMessage, proposal, extractionConfidence: 0.99 });
    expect(evidenceCapability).toBeTruthy();
    const result = await authorization.persistIfAuthorized({ scope: "tool_preferences", operation: "remember",
      attribute: "editor.habitual", evidenceCapability });
    expect(result.success).toBe(true);
    expect(result.result.ownerOnly).toBe(true);
    expect(persisted).toBe(1);
    host.revoke();
    expect((await authorization.persistIfAuthorized({ scope: "tool_preferences", operation: "remember",
      attribute: "editor.habitual", evidenceCapability })).success).toBe(false);
  });

  it("rejects hypothetical, sensitive, third-party, model-originated and mismatched quote evidence", () => {
    const host = createDesktopOrganicMemoryHost({ storePath: "C:/nexa/data/memory-v2.json" });
    for (const overrides of [{ sensitive: true }, { certain: false }, { thirdParty: true },
      { modelOriginated: true }, { sourceQuote: "Quizás vuelva a Cursor." }]) {
      expect(host.evidenceCapabilityFactory({ origin: "direct_user", subject: "owner", explicit: true,
        certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
        attribute: "editor.habitual", operation: "remember", sourceQuote, userMessage, proposal,
        extractionConfidence: 0.99, ...overrides })).toBeNull();
    }
    host.revoke();
  });

  it("issues scoped evidence for general everyday categories but rejects unknown or unsafe namespaces", async () => {
    const host = createDesktopOrganicMemoryHost({ storePath: "C:/nexa/data/memory-v2.json" });
    const repository = {};
    const authorization = host.authorizationFactory({ repository, persist: async () => ({ success: true }) });
    const quote = "Me interesa la astronomía y suelo leer sobre planetas.";
    const attribute = "interest.astronomy";
    const policy = getOrganicMemoryAttributePolicy(attribute)!;
    const value = "la astronomía";
    const candidateProposal = { kind: policy.kind, subject: { type: "owner" }, predicate: policy.predicate,
      compatibility: { category: policy.category, key: attribute }, object: { type: "text", value: policy.render(value) },
      valid_from: null, valid_to: null };
    const evidenceCapability = host.evidenceCapabilityFactory({ origin: "direct_user", subject: "owner", explicit: true,
      certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
      attribute, value, operation: "remember", sourceQuote: quote, userMessage: quote, proposal: candidateProposal,
      extractionConfidence: 0.95 });
    expect(evidenceCapability).toBeTruthy();
    await expect(authorization.persistIfAuthorized({ scope: policy.scope, operation: "remember", attribute, evidenceCapability }))
      .resolves.toMatchObject({ success: true });

    for (const rejectedAttribute of ["medical.diagnosis", "__proto__.polluted", "interest", "interest." + "x".repeat(100)]) {
      expect(getOrganicMemoryAttributePolicy(rejectedAttribute)).toBeNull();
    }
    expect(host.evidenceCapabilityFactory({ origin: "direct_user", subject: "owner", explicit: true,
      certain: true, sensitive: true, ambiguous: false, thirdParty: false, modelOriginated: false,
      attribute, value, operation: "remember", sourceQuote: quote, userMessage: quote,
      proposal: candidateProposal, extractionConfidence: 0.95 })).toBeNull();
    host.revoke();
  });
});
