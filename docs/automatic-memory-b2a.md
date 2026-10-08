# Automatic Memory B.2a — Persistence contract (dry-run)

## Boundary and current capabilities

B.2a adds `createAutomaticMemoryPersistenceContract()`, a pure wrapper around the B.1 planner. It accepts only source text, the closed Automatic Memory candidate proposal, and a validated snapshot envelope (or `null`). It reruns normalization and planning; it rejects extra fields such as caller-provided provenance, entity IDs, user identity, turn IDs, grants, and authorization. It imports neither MemoryService nor the repository or authorization modules.

The returned contract is advisory: `executable`, `writeReady`, `committed`, and authorization `granted` are always false. ADD, REPLACE, ASK, DUPLICATE, and IGNORE stay non-writing outcomes. No service request or authority capability is created.

The current `MemoryService.remember()` consumes the existing explicit direct-user command grant, stamps `user_statement` / `user_asserted` provenance and `explicit` derivation, then supersedes an active assertion in the same slot. It has no explicit append-only ADD mode and cannot persist model-derived provenance truthfully. B.2a therefore does not call it. A write-capable phase must first design and review a service API that makes append-versus-replace behavior explicit and preserves the existing authorization boundary.

## Provenance proposal

For a future automatic extraction, code—not the model—should assign `source.kind = inference`, the schema-defined `origin_trust = derived_untrusted`, and evidence `derivation = inferred`. The model's linguistic confidence is only an untrusted hint and must never be upgraded into trust or authority. A later direct user confirmation is a distinct source event and should be recorded as such rather than rewriting the original extraction as an explicit user instruction.

The simulation reports hashes of the source text and quoted evidence, not the quote itself. It does not persist an audit record. Schema v4 can represent inference kind/trust and inferred derivation, but has no dedicated turn ID, authenticated owner ID, evidence span, or source-text digest fields. Its opaque source `locator` is not a substitute for a reviewed provenance contract. B.2b must propose the minimum durable audit fields and retention policy; it should avoid retaining full conversation text or secrets.

## Authorization and runtime binding

The existing A.2/A.3 authorization capability is issued only by the trusted direct-user input boundary for explicit remember/forget commands. Automatic extraction is not that command and cannot reuse that grant. The current automatic-memory path receives no authenticated user ID or trusted conversation-turn ID. B.2a consequently reports those bindings and effective authorization as unavailable and blocks every operation.

A future authorization design must require an unforgeable capability from a trusted runtime boundary and bind it to the authenticated owner, exact turn and evidence, candidate fingerprint, operation kind, replacement target where relevant, recipient, and snapshot version. It must be one-use and consumed on mismatch/failure. Model output, stored memory, tools, imports, and structured caller fields must never mint or substitute that capability. ADD and REPLACE may need distinct scopes; REPLACE always requires explicit user confirmation.

## Operation semantics

- **ADD** means append a new assertion without selecting or superseding compatible assertions. The current service does not implement this behavior, so the contract states the intent but remains blocked.
- **REPLACE** references only the unique old assertion selected by B.1 from the validated snapshot and exact evidence. It always requires confirmation. Missing or ambiguous targets remain ASK.
- **DUPLICATE**, **ASK**, and **IGNORE** are non-writing dispositions. Text-only project decisions and unresolved third parties remain outside persistence.

The deterministic idempotency key binds the operation, normalized candidate digest, source-text digest, snapshot revision/digest, and selected target. It is not a durable receipt and does not stop retries: `recorded` is false. Snapshot metadata is a proposed optimistic-concurrency guard only; no current-state freshness check occurs. An executor must compare the repository revision and digest atomically at commit time.

## Transactional requirements before real writes

Before enabling persistence, a separately reviewed design must cover: append-only ADD; confirmed and exact-target REPLACE; idempotency receipts stored atomically with the operation; optimistic revision/digest checks; all-or-nothing assertion/source/evidence changes; secret screening before persistence and non-echoing errors; verified Self versus third-party resolution; provenance retention; and one-use runtime authorization. B.2a simulates none of those writes and makes no claim that retry or stale-snapshot protection is already enforced.

## Verification boundary

Tests use synthetic snapshots only. They check ADD beside an existing assertion, confirmed REPLACE and ambiguous target handling, duplicates/retries, secret rejection without echo, third-party and textual-project blocking, forged metadata rejection, missing Self, deterministic snapshot binding, and the absence of writer/auth dependencies. No agent integration, OpenAI request, memory write, migration, personal Memory 2 store, or activation is part of B.2a.
