# Automatic Memory B.1 — Persistence planning (dry-run)

## Scope and boundary

B.1 adds a pure planner after Automatic Memory A. It does not connect to the conversational agent, call OpenAI, read personal Memory 2, create authorization, or write to a repository. Its result is advisory and always has `executable: false` and `writeReady: false`.

The planner accepts only:

- the original source turn text;
- the closed Automatic Memory proposal object;
- a validated, read-only Memory 2 snapshot envelope, or `null`.

It normalizes and validates the proposal again, verifies its exact evidence quote against the source turn, reruns policy A against the supplied snapshot, and then classifies each candidate. It does not accept model-supplied canonical IDs, target IDs, source provenance, authority, or disposition as instructions. Any replacement target ID in the plan is selected by code from the validated snapshot after matching the prior value in the exact evidence quote.

Each operation reports a candidate index, operation name, reason codes, whether confirmation is required, and whether a write is ready. The planner never returns a MemoryService request or a proposed source/evidence record.

## Planned outcomes

- **ADD**: an A-approved Self candidate is evidenced, no exact active duplicate exists, and no unresolved same-predicate conflict exists. An explicit addition such as “También tengo una Fender” can remain ADD beside an existing Ibanez. It never selects an old assertion as a target.
- **REPLACE**: only an asserted, non-sensitive, non-temporal correction/supersession with a uniquely identified active Self assertion whose old value appears in the exact evidence quote. The output includes that snapshot-derived target ID and always requires explicit confirmation.
- **ASK**: policy review, sensitive or third-party claims, conflicts, ambiguous replacement targets, temporal mapping uncertainty, or any project decision without a canonical project entity.
- **DUPLICATE**: an equivalent active assertion already exists; no write is proposed.
- **IGNORE**: policy rejects the candidate, including quoted/imported content, unasserted or negated facts, and secrets.

All five outcomes are non-executable in B.1. ADD does not mean the current service can safely append it; REPLACE is only a proposed target for later confirmation, never an authorization.

## Existing API constraints

`MemoryService.remember()` consumes its existing one-use explicit-user authorization, assigns `user_statement` provenance and `explicit` evidence, and supersedes the active assertion when the same subject/predicate/compatibility slot already exists. It does not accept model-derived provenance or a caller-selected append-versus-replace mode. Consequently B.1 does not call it and marks every plan `writeReady: false`.

Before any persistence phase, architecture must decide how to represent model-derived evidence honestly, issue narrow runtime-bound authorization, and expose a service operation whose append and replacement semantics are explicit. That work requires a separate review of authorization and service boundaries; it is outside B.1.

Schema v4 has canonical Person entities but no canonical project entities. A project candidate marked `textual_only` cannot be linked to a project assertion and becomes ASK in this planner. No project ID is inferred or created.

## Validation

Tests use synthetic snapshots only. They cover additions beside existing facts, duplicates, conflicts, evidence-supported replacements, ambiguous targets, third parties, sensitive claims, quotes, negative polarity, and text-only project decisions. Snapshot fingerprints must remain identical before and after planning.
