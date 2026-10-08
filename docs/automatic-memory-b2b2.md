# Automatic Memory B.2b.2 — Test-only ADD and REPLACE writes

## Scope and boundary

B.2b.2 exercises concrete Memory2 `ADD` and `REPLACE` persistence against JSON stores created under the operating system's temporary directory. The operation writer and synthetic test permits are local to `test/memory-automatic-write-operations.test.js`; no production module imports or exports them. They are test fixtures, not MemoryService authorization grants, authenticated user proofs, or an application `skipAuthorization` switch.

The B.2a persistence contract and B.2b.1 authorization assessment remain dry-run. Their `executable`, `writeReady`, and `authorization.granted` fields remain false. The B.2b.1b trusted local context remains unconnected to a write path. MemoryService, the agent, backend selection, schema, and production authorization are unchanged. No personal store is opened or initialized.

## ADD

The test writer recomputes the existing planner result from the candidate and a validated snapshot, accepts only an `ADD` decision with no target, validates the resulting v4 records, screens the value for secrets, and commits a new assertion with `supersedes: []`. Its source is `inference` with `derived_untrusted` trust, and the evidence derivation is `inferred` with the model confidence retained as an untrusted hint. Existing compatible assertions are not updated or superseded. Exact duplicates, unresolved subjects, and non-ADD policy outcomes are not written.

## REPLACE

The test writer accepts only a planner-produced `REPLACE` whose target assertion ID is exact, active, belongs to the already resolved Self person, has the same predicate, and whose previous text is present in the verified evidence quote. It marks only that target superseded and writes the new assertion with that one ID in `supersedes`. Other assertions and their evidence remain unchanged.

Tests issue a separate opaque synthetic confirmation held in a private `WeakMap`, bound to the temporary repository, operation fingerprint, and exact target. The token is consumed once. It exists only in the test file; it does not represent a real user confirmation and cannot make production authorization eligible. The replacement keeps both inferred evidence and synthetic explicit-confirmation evidence as separate source/evidence records.

## Atomicity and limits

The JSON repository validates the complete resulting store, applies all changes to a clone, writes and syncs a temporary file, rechecks its process lock and the expected revision/digest, then replaces the destination by rename. A synthetic rename failure leaves the original bytes and revision unchanged. On supported local filesystems the replacement is atomic; the repository does not claim universal power-loss durability. Snapshots are not silently rebased: stale revision or repository digest fails closed. Persistent idempotency and multi-writer/concurrency policy remain for B.2b.3.

These tests demonstrate storage semantics only. They do not enable automatic writes, resolve project entities, support third-party writes, provide a conversational confirmation flow, or establish repository freshness across processes beyond the repository's current lock/revision/digest checks.
