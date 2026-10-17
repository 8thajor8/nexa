import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopOrganicMemoryHost } from "../src/main/organic-memory-desktop.js";
// @ts-expect-error The shared JavaScript Runtime intentionally has no generated declaration file.
import { createAgent } from "../../../src/core/agent.js";
// @ts-expect-error The shared Memory2 backend intentionally has no generated declaration file.
import { initializeEmptyMemoryStore } from "../../../src/memory/backend.js";
// @ts-expect-error The shared Memory2 repository intentionally has no generated declaration file.
import { createJsonMemoryRepository } from "../../../src/memory/json-repository.js";

const proposalTool = "propose_organic_memory_facts";
const verifierTool = "verify_organic_memory_facts";

describe("Desktop organic Memory2 evidence integration", () => {
  it("persists an approved paraphrastic fact through Agent and the trusted Desktop capability", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexa-desktop-organic-evidence-"));
    const storePath = path.join(directory, "memory-v5.json");
    let repository: any;
    let agent: any;
    let host: ReturnType<typeof createDesktopOrganicMemoryHost> | undefined;
    try {
      await initializeEmptyMemoryStore({ storePath });
      repository = createJsonMemoryRepository({ storePath });
      await repository.open();
      host = createDesktopOrganicMemoryHost({ storePath });

      const userMessage = "Toco viola de gamba.";
      const candidate = { sourceQuote: userMessage, attribute: "hobby.instrument_viola_da_gamba",
        value: "viola da gamba", confidence: "high", certainty: "explicit", subject: "owner",
        temporal: "current", validity: "current", priorAssertionId: "", sensitivity: "none", ambiguous: false, thirdParty: false,
        hypothetical: false, futureIntent: false };
      const diagnostics: Array<Record<string, unknown>> = [];
      const ask = async (request: Record<string, any>) => {
        if (request.tools?.some((tool: any) => tool.name === proposalTool)) {
          return { status: "completed", output: [{ type: "function_call", name: proposalTool, call_id: "proposal-1",
            arguments: JSON.stringify({ facts: [candidate] }) }], output_text: "" };
        }
        if (request.tools?.some((tool: any) => tool.name === verifierTool)) {
          const input = JSON.parse(request.input[0].content);
          expect(input.currentUserMessage).toBe(userMessage);
          expect(input.candidates[0]).toMatchObject({ quote: userMessage, proposedFact: "viola da gamba",
            topicKey: candidate.attribute, subject: "owner", eventTime: "current" });
          return { status: "completed", output: [{ type: "function_call", name: verifierTool, call_id: "verify-1",
            arguments: JSON.stringify({ decisions: [{ candidateIndex: 0, decision: "approved", supported: true, explicit: true,
              subjectMatches: true, temporalMatches: true, nonSensitive: true, unambiguous: true,
              correctedValue: "", correctedAttribute: "", correctedTemporal: "current", correctedValidity: "current" }] }) }], output_text: "" };
        }
        return { status: "completed", output: [{ type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Entendido." }] }], output_text: "Entendido." };
      };

      agent = await createAgent({ memoryBackend: "memory2", memory2Repository: repository,
        operationalMemoryMode: "memory2-confirmed-write", enableConfirmedMemoryWrites: true,
        enableOrganicMemoryLearning: true, organicMemoryAuthorizationFactory: host.authorizationFactory,
        organicEvidenceCapabilityFactory: host.evidenceCapabilityFactory,
        organicThirdPartyEvidenceCapabilityFactory: host.thirdPartyEvidenceCapabilityFactory,
        organicRelationshipEvidenceCapabilityFactory: host.relationshipEvidenceCapabilityFactory,
        isOrganicThirdPartyLearningEnabled: () => host?.thirdPartyLearningEnabled === true,
        isOrganicRelationshipLearningEnabled: () => host?.relationshipLearningEnabled === true,
        memoryRetrievalEnabled: false, getTools: () => [], execute: async () => { throw new Error("external_tool_forbidden"); },
        ask, logger: (event: string, details: Record<string, unknown>) => diagnostics.push({ event, ...details }) });

      await agent.run(userMessage, "typed", { userMessageSource: "direct_user" });
      const evaluation = diagnostics.find(item => item.event === "organic_memory_evaluation");
      const verification = diagnostics.find(item => item.event === "organic_memory_fact_verification");
      expect(evaluation?.verifierApprovedCount, JSON.stringify(verification)).toBe(1);
      expect(evaluation).toMatchObject({ postValidationPassedCount: 1, persistedCount: 1, createdCount: 1 });
      const snapshot = await repository.readSnapshot();
      expect(snapshot.snapshot.assertions).toHaveLength(1);
      expect(snapshot.snapshot.assertions[0].object.value).toBe("viola da gamba");
    } finally {
      try { await agent?.close(); } catch { /* preserve test failure */ }
      host?.revoke();
      try { await repository?.close(); } catch { /* preserve test failure */ }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed and reports the categorized rejection when evidence issuance is unavailable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexa-desktop-organic-evidence-unavailable-"));
    const storePath = path.join(directory, "memory-v5.json");
    let repository: any;
    let agent: any;
    let host: ReturnType<typeof createDesktopOrganicMemoryHost> | undefined;
    try {
      await initializeEmptyMemoryStore({ storePath });
      repository = createJsonMemoryRepository({ storePath });
      await repository.open();
      host = createDesktopOrganicMemoryHost({ storePath });
      const userMessage = "Toco viola de gamba.";
      const candidate = { sourceQuote: userMessage, attribute: "hobby.instrument_viola_da_gamba",
        value: "viola da gamba", confidence: "high", certainty: "explicit", subject: "owner",
        temporal: "current", validity: "current", priorAssertionId: "", sensitivity: "none", ambiguous: false, thirdParty: false,
        hypothetical: false, futureIntent: false };
      const diagnostics: Array<Record<string, unknown>> = [];
      const ask = async (request: Record<string, any>) => {
        if (request.tools?.some((tool: any) => tool.name === proposalTool))
          return { status: "completed", output: [{ type: "function_call", name: proposalTool, call_id: "proposal-2",
            arguments: JSON.stringify({ facts: [candidate] }) }], output_text: "" };
        if (request.tools?.some((tool: any) => tool.name === verifierTool))
          return { status: "completed", output: [{ type: "function_call", name: verifierTool, call_id: "verify-2",
            arguments: JSON.stringify({ decisions: [{ candidateIndex: 0, decision: "approved", supported: true, explicit: true,
              subjectMatches: true, temporalMatches: true, nonSensitive: true, unambiguous: true,
              correctedValue: "", correctedAttribute: "", correctedTemporal: "current", correctedValidity: "current" }] }) }], output_text: "" };
        return { status: "completed", output: [{ type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Entendido." }] }], output_text: "Entendido." };
      };
      agent = await createAgent({ memoryBackend: "memory2", memory2Repository: repository,
        operationalMemoryMode: "memory2-confirmed-write", enableConfirmedMemoryWrites: true,
        enableOrganicMemoryLearning: true, organicMemoryAuthorizationFactory: host.authorizationFactory,
        organicEvidenceCapabilityFactory: () => null,
        organicThirdPartyEvidenceCapabilityFactory: host.thirdPartyEvidenceCapabilityFactory,
        organicRelationshipEvidenceCapabilityFactory: host.relationshipEvidenceCapabilityFactory,
        isOrganicThirdPartyLearningEnabled: () => host?.thirdPartyLearningEnabled === true,
        isOrganicRelationshipLearningEnabled: () => host?.relationshipLearningEnabled === true,
        memoryRetrievalEnabled: false, getTools: () => [], execute: async () => { throw new Error("external_tool_forbidden"); },
        ask, logger: (event: string, details: Record<string, unknown>) => diagnostics.push({ event, ...details }) });

      await agent.run(userMessage, "typed", { userMessageSource: "direct_user" });
      const evaluation = diagnostics.find(item => item.event === "organic_memory_evaluation");
      expect(evaluation).toMatchObject({ verifierApprovedCount: 1, postValidationPassedCount: 0,
        persistedCount: 0, postVerificationRejectedCount: 1,
        postVerificationRejectionCodes: { evidence_capability_unavailable: 1 } });
      expect((await repository.readSnapshot()).snapshot.assertions).toHaveLength(0);
    } finally {
      try { await agent?.close(); } catch { /* preserve test failure */ }
      host?.revoke();
      try { await repository?.close(); } catch { /* preserve test failure */ }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
