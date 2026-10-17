const statuses: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tool_offer: ["offered", "not_offered"],
  proposal: ["invoked", "not_invoked", "no_relationship_candidate", "invalid_arguments"],
  local_validation: ["accepted", "rejected"],
  verification: ["started", "approved", "rejected", "timeout", "error", "malformed", "cancelled"],
  evidence: ["issued", "rejected"],
  write: ["started", "created", "equivalent", "conflict", "error"],
});

const codes: Readonly<Record<string, readonly string[]>> = Object.freeze({
  local_validation: ["permission_unavailable", "not_direct_input", "candidate_shape_invalid",
    "eligibility_flags_invalid", "source_quote_invalid", "person_name_invalid", "category_invalid",
    "source_message_unavailable", "quote_not_literal_sentence", "relationship_type_invalid",
    "person_name_unsafe", "person_not_in_quote", "quote_sensitive", "quote_question_or_reported",
    "quote_uncertain_or_past", "owner_reference_missing"],
  verification: ["response_incomplete", "response_status_missing", "response_status_unexpected", "output_missing",
    "response_refusal", "tool_call_missing", "tool_call_multiple", "arguments_missing", "arguments_invalid_json",
    "assessment_shape_invalid", "assessment_negative", "request_timeout", "api_error"],
  evidence: ["permission_revoked", "capability_unavailable"],
  write: ["write_failed"],
});

/** Emits ephemeral, allowlisted relationship-learning diagnostics; never writes files. */
export function createOrganicRelationshipTraceWriter({
  enabled = false,
  sink = (line: string) => console.info(line),
}: { enabled?: boolean; sink?: (line: string) => void } = {}) {
  return (details: Record<string, unknown>): boolean => {
    if (!enabled || !details || typeof details !== "object") return false;
    const stage = details.stage;
    const status = details.status;
    if (typeof stage !== "string" || !Object.hasOwn(statuses, stage)
      || typeof status !== "string" || !statuses[stage].includes(status)) return false;

    const entry: Record<string, string | number | boolean> = { stage, status };
    if (typeof details.permissionEnabled === "boolean") entry.permissionEnabled = details.permissionEnabled;
    if (Number.isSafeInteger(details.turn) && Number(details.turn) >= 1
      && Number(details.turn) <= 1_000_000) entry.turn = Number(details.turn);
    if (Number.isSafeInteger(details.iteration) && Number(details.iteration) >= 1
      && Number(details.iteration) <= 32) entry.iteration = Number(details.iteration);
    if (typeof details.durationMs === "number" && Number.isFinite(details.durationMs)
      && details.durationMs >= 0 && details.durationMs <= 600_000)
      entry.durationMs = Math.round(details.durationMs);
    if (typeof details.code === "string" && codes[stage]?.includes(details.code)) entry.code = details.code;

    sink(`[nexa-organic-relationship] ${JSON.stringify(entry)}`);
    return true;
  };
}
