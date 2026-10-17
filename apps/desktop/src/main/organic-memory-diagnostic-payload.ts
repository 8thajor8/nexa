const POST_VERIFICATION_REJECTION_CODES = [
  "third_party_permission_revoked",
  "third_party_identity_unresolved",
  "owner_relationship_lookup_failed",
  "third_party_identity_not_unique",
  "third_party_identity_unavailable",
  "owner_identity_unavailable",
  "third_party_resolved_to_owner",
  "duplicate_candidate_in_turn",
  "memory_slot_lookup_failed",
  "multiple_active_slot_records",
  "prior_statement_mismatch",
  "required_active_record_missing",
  "evidence_capability_unavailable",
] as const;

const FACT_WRITE_OUTCOMES = ["created", "updated", "equivalent", "failed", "unexpected"] as const;
const VERIFIER_REJECTION_CHECKS = ["supported", "explicit", "subjectMatches", "temporalMatches", "nonSensitive", "unambiguous"] as const;
const VERIFIER_PASS_STATUSES = ["not_run", "running", "completed", "semantic_rejection", "malformed", "timeout", "error"] as const;
const VERIFIER_DECISIONS = ["approved", "correctable", "rejected", "invalid"] as const;
const CORRECTION_COUNTS = ["proposed", "accepted", "rejected", "invalid", "technicalFailures"] as const;
const CONTEXT_SEARCH_STATUSES = ["found", "empty", "invalid_query", "query_not_eligible", "subject_unresolved",
  "subject_not_authorized", "semantic_search_unavailable", "embedding_unavailable", "unavailable", "invalid_result", "search_error"] as const;
const EXTRACTION_STATUSES = ["completed", "error", "cancelled", "invalid_output"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeCounts(value: unknown, allowedKeys: readonly string[]): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = allowedKeys.flatMap((key) => {
    const count = value[key];
    return Number.isSafeInteger(count) && (count as number) >= 0 ? [[key, count as number] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function safeVerifierPass(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !VERIFIER_PASS_STATUSES.includes(value.status as typeof VERIFIER_PASS_STATUSES[number])) return undefined;
  const decisionCounts = safeCounts(value.decisionCounts, VERIFIER_DECISIONS);
  const rejectedChecks = safeCounts(value.rejectedChecks, VERIFIER_REJECTION_CHECKS);
  if (!decisionCounts || !rejectedChecks || !Array.isArray(value.decisions) || value.decisions.length > 4) return undefined;
  const decisions = value.decisions.flatMap((item) => {
    if (!isRecord(item) || !Number.isSafeInteger(item.candidateIndex)
      || (item.candidateIndex as number) < 0 || (item.candidateIndex as number) > 3
      || !VERIFIER_DECISIONS.includes(item.decision as typeof VERIFIER_DECISIONS[number])) return [];
    const rawChecks = isRecord(item.checks) ? item.checks : {};
    const checks = Object.fromEntries(VERIFIER_REJECTION_CHECKS.flatMap((key) => typeof rawChecks[key] === "boolean"
      ? [[key, rawChecks[key]] as const] : []));
    return [{ candidateIndex: item.candidateIndex, decision: item.decision, checks }];
  });
  if (decisions.length !== value.decisions.length) return undefined;
  return { status: value.status, decisionCounts, rejectedChecks, decisions };
}

/** Selects only categorical counters for the organic-learning diagnostic events. */
export function sanitizeOrganicMemoryDiagnosticDetails(
  area: string,
  event: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  if (area !== "agent") return {};
  const safe: Record<string, unknown> = {};
  if (event === "organic_memory_context_search") {
    safe.status = CONTEXT_SEARCH_STATUSES.includes(details.status as typeof CONTEXT_SEARCH_STATUSES[number])
      ? details.status : "invalid_result";
    for (const field of ["recoveredCount", "deliveredCount", "candidateCount"] as const) {
      const value = details[field];
      if (Number.isSafeInteger(value) && (value as number) >= 0) safe[field] = value;
    }
    if (typeof details.durationMs === "number" && Number.isFinite(details.durationMs) && details.durationMs >= 0)
      safe.durationMs = Math.round(details.durationMs);
  } else if (event === "organic_memory_extraction") {
    safe.status = EXTRACTION_STATUSES.includes(details.status as typeof EXTRACTION_STATUSES[number])
      ? details.status : "invalid_output";
    for (const field of ["factsCount", "relationshipsCount"] as const) {
      const value = details[field];
      if (Number.isSafeInteger(value) && (value as number) >= 0) safe[field] = value;
    }
    if (typeof details.durationMs === "number" && Number.isFinite(details.durationMs) && details.durationMs >= 0)
      safe.durationMs = Math.round(details.durationMs);
  } else if (event === "organic_memory_evaluation") {
    for (const field of ["verifierApprovedCount", "postVerificationRejectedCount", "postValidationPassedCount"] as const) {
      const value = details[field];
      if (Number.isSafeInteger(value) && (value as number) >= 0) safe[field] = value;
    }
    const rejectionCodes = safeCounts(details.postVerificationRejectionCodes, POST_VERIFICATION_REJECTION_CODES);
    const writeOutcomes = safeCounts(details.factWriteOutcomeCounts, FACT_WRITE_OUTCOMES);
    if (rejectionCodes) safe.postVerificationRejectionCodes = rejectionCodes;
    if (writeOutcomes) safe.factWriteOutcomeCounts = writeOutcomes;
  } else if (event === "organic_memory_fact_verification") {
    const rejectedChecks = safeCounts(details.rejectedChecks, VERIFIER_REJECTION_CHECKS);
    if (rejectedChecks) safe.rejectedChecks = rejectedChecks;
    if (details.failureClass === "none" || details.failureClass === "semantic_rejection"
      || details.failureClass === "technical_failure" || details.failureClass === "mixed") safe.failureClass = details.failureClass;
    const verificationPass = safeVerifierPass(details.verificationPass);
    if (verificationPass) safe.verificationPass = verificationPass;
    const corrections = safeCounts(details.correctionCounts, CORRECTION_COUNTS);
    if (corrections) safe.correctionCounts = corrections;
  }
  return safe;
}
