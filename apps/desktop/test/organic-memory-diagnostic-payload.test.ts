import { describe, expect, it } from "vitest";
import { sanitizeOrganicMemoryDiagnosticDetails } from "../src/main/organic-memory-diagnostic-payload.js";

describe("organic Memory2 diagnostic payload sanitizer", () => {
  it("preserves approved categorical counters while excluding personal content", () => {
    const sanitized = sanitizeOrganicMemoryDiagnosticDetails("agent", "organic_memory_evaluation", {
      verifierApprovedCount: 1,
      postVerificationRejectedCount: 1,
      postValidationPassedCount: 2,
      postVerificationRejectionCodes: Object.assign(Object.create(null), {
        prior_statement_mismatch: 1,
        injected_personal_text: 99,
      }),
      factWriteOutcomeCounts: { created: 1, equivalent: 0, unexpectedKey: 9 },
      message: "private synthetic statement",
      candidate: { value: "private synthetic fact" },
    });

    expect(sanitized).toEqual({
      verifierApprovedCount: 1,
      postVerificationRejectedCount: 1,
      postValidationPassedCount: 2,
      postVerificationRejectionCodes: { prior_statement_mismatch: 1 },
      factWriteOutcomeCounts: { created: 1, equivalent: 0 },
    });
    expect(JSON.stringify(sanitized)).not.toContain("private");
  });

  it("does not pass nested diagnostic objects from unrelated events or areas", () => {
    const details = { rejectedChecks: { supported: 1 }, message: "private" };
    expect(sanitizeOrganicMemoryDiagnosticDetails("agent", "unrelated_event", details)).toEqual({});
    expect(sanitizeOrganicMemoryDiagnosticDetails("runtime", "organic_memory_evaluation", details)).toEqual({});
  });

  it("keeps organic search and extraction traces categorical and correlated only with technical IDs", () => {
    const search = sanitizeOrganicMemoryDiagnosticDetails("agent", "organic_memory_context_search", {
      status: "found", recoveredCount: 24, deliveredCount: 12, candidateCount: 12,
      durationMs: 4.6, requestId: "request-123", conversationId: "conversation-456",
      message: "private statement", memories: [{ value: "private memory" }], prompt: "private prompt",
    });
    const extraction = sanitizeOrganicMemoryDiagnosticDetails("agent", "organic_memory_extraction", {
      status: "completed", factsCount: 2, relationshipsCount: 1, durationMs: 18,
      response: "private model response", quote: "private quote", name: "private name",
    });
    expect(search).toEqual({ status: "found", recoveredCount: 24, deliveredCount: 12,
      candidateCount: 12, durationMs: 5 });
    expect(extraction).toEqual({ status: "completed", factsCount: 2, relationshipsCount: 1, durationMs: 18 });
    expect(JSON.stringify([search, extraction])).not.toMatch(/private|statement|memory|prompt|response|quote|name/iu);
  });

  it("normalizes unknown search and extractor states rather than forwarding arbitrary strings", () => {
    expect(sanitizeOrganicMemoryDiagnosticDetails("agent", "organic_memory_context_search", {
      status: "personal text supplied as status", recoveredCount: -1, deliveredCount: 1.5,
    })).toEqual({ status: "invalid_result" });
    expect(sanitizeOrganicMemoryDiagnosticDetails("agent", "organic_memory_extraction", {
      status: "model output", factsCount: 1, relationshipsCount: Number.MAX_SAFE_INTEGER + 1,
    })).toEqual({ status: "invalid_output", factsCount: 1 });
  });

  it("sanitizes verifier checks to known nonnegative counters only", () => {
    expect(sanitizeOrganicMemoryDiagnosticDetails("agent", "organic_memory_fact_verification", {
      rejectedChecks: { explicit: 1, nonSensitive: 0, personalText: 4, temporalMatches: -1 },
    })).toEqual({ rejectedChecks: { explicit: 1, nonSensitive: 0 } });
  });

  it("forwards one verifier pass and correction counts while dropping all free text", () => {
    const sanitized = sanitizeOrganicMemoryDiagnosticDetails("agent", "organic_memory_fact_verification", {
      outcome: "approved",
      failureClass: "none",
      rejectedChecks: { temporalMatches: 1 },
      verificationPass: {
        status: "completed", decisionCounts: { approved: 0, correctable: 1, rejected: 0, invalid: 0 },
          rejectedChecks: { temporalMatches: 1 }, decisions: [{ candidateIndex: 0, decision: "correctable",
            checks: { supported: true, explicit: true, subjectMatches: true, temporalMatches: false,
              nonSensitive: true, unambiguous: true }, quote: "private quote" }] },
      correctionCounts: { proposed: 1, accepted: 1, rejected: 0, invalid: 0, technicalFailures: 0 },
      message: "private message",
    });

    expect(sanitized).toEqual({
      rejectedChecks: { temporalMatches: 1 },
      failureClass: "none",
      verificationPass: {
        status: "completed", decisionCounts: { approved: 0, correctable: 1, rejected: 0, invalid: 0 },
          rejectedChecks: { temporalMatches: 1 }, decisions: [{ candidateIndex: 0, decision: "correctable",
            checks: { supported: true, explicit: true, subjectMatches: true, temporalMatches: false,
              nonSensitive: true, unambiguous: true } }]
      },
      correctionCounts: { proposed: 1, accepted: 1, rejected: 0, invalid: 0, technicalFailures: 0 },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/private|quote|value/iu);
  });
});
