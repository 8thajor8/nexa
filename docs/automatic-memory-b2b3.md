# Automatic Memory B.2b.3 — Idempotency, concurrency, and executor design

## Scope and safety boundary

B.2b.3 documents the current Memory2 persistence guarantees and tests a transaction simulator using files created only under the operating system temporary directory. It adds no production writer, receipt store, authorization path, retry loop, agent integration, or personal-memory operation. B.2a still reports `idempotency.recorded: false`, `executable: false`, and `writeReady: false`; B.2b.1 still does not grant authorization. The B.2b.2 writer and its synthetic permits remain test-only.

No Memory1 or Memory2 personal store is opened. The simulator validates a Memory v4 store and writes its test assertions and test receipts together into one temporary envelope. That envelope is **not** the real Memory2 repository format and proves no production receipt guarantee.

## Existing persistence architecture

`MemoryService` validates an explicit authorization before it calls the repository. The repository accepts typed collection changes with an expected revision and digest, clones the complete store, applies all changes, increments the revision, validates the full schema and references, and publishes one new snapshot. It does not silently rebase stale requests. Its `MemoryRepositoryError` outcomes are non-retryable by default.

The JSON repository requires a caller-supplied absolute path to an already valid store. It takes an exclusive `wx` lock file, writes and syncs a unique same-directory temporary file, checks lock ownership and the actual revision/digest again, then renames the completed file over the destination. A post-rename error is reconciled against the actual bytes; if those bytes cannot be established, the live repository becomes uncertain and requires close/reopen and inspection. Failed pre-rename writes clean up their own temporary files. A process terminated before cleanup can leave an orphan temporary file; startup does not recover or garbage-collect it.

The lock coordinates cooperating repository instances across processes. It is not protection against an editor or other writer that ignores the lock. Stale lock files are never stolen automatically. Rename is atomic only where the local filesystem supports that behavior; the implementation syncs the temporary file but does not promise directory-entry or universal power-loss durability.

Schema v4 has `entities`, `assertions`, `sources`, `evidence`, and `migrations`. Migration receipts are keyed to a legacy source fingerprint and have migration semantics; they are not a safe place to store Automatic Memory operation receipts. Reusing them would conflate unrelated lifecycle and retention rules. The current schema and repository therefore cannot commit an operation receipt alongside an assertion. B.2a's key is deterministic and bound to the operation/candidate, source text, snapshot, and replacement target, but it is not persisted.

## Idempotency design to review

The future production transaction needs a durable operation receipt in the **same atomic commit** as the assertion/evidence/source changes. A retry first checks that receipt:

- matching key and matching exact-operation fingerprint with `applied` returns the prior result without applying changes again;
- matching key with different operation content fails closed as key reuse;
- `rejected` returns the recorded terminal rejection and never writes;
- `unknown` never retries automatically; it requires reconciliation against the persisted store before a caller can decide what to do.

The operation fingerprint should bind the operation type, normalized candidate, evidence/source digest, resolved subject, exact replacement target where relevant, schema/policy contract version, and the snapshot revision plus digest. The caller must not supply an ID or a digest as proof: trusted code recomputes and verifies the key and fingerprint. A conflict is not silently rebased; it requires a fresh snapshot and a fresh plan. The new snapshot usually yields a different key.

There is an unresolved state-model choice before production work: B.2a's operation key identifies a requested effect but does not include a future authorization or confirmation request. The design must specify which rejections are terminal receipts and how a later separately authorized attempt for the same effect gets a distinct attempt identity without weakening replay protection. Transient lock, stale-snapshot, and pre-commit I/O failures should not be recorded as terminal rejection receipts. Authorization remains unavailable, so B.2b.3 does not choose or implement this transition policy.

## Transaction simulator and test results

`test/memory-automatic-idempotency.test.js` implements a test-only envelope containing a validated v4 store and receipt list. It uses an exclusive temporary lock and replaces the complete envelope as one file. Its cases cover:

- deterministic B.2a ADD keys and unchanged dry-run fields;
- ADD and REPLACE replay, including restart, with one assertion effect and preserved supersession history;
- same-key/different-content rejection;
- failure before commit, a lost response after commit, and a persisted unknown outcome;
- rejected REPLACE confirmation;
- same-snapshot competing writers, ADD/REPLACE conflicts, stale retry, and re-planning from a fresh snapshot;
- corrupt receipt state failing closed;
- the actual JSON repository lock rejecting a separate Node process while another process owns it.

The simulator demonstrates the proposed receipt state machine and atomic envelope semantics only. Its injected failures are controlled test branches, not power-loss or filesystem fault injection. The independent-process test exercises the real repository's existing exclusive lock, but does not claim that non-cooperating writers are excluded or that a receipt can be stored in the real v4 transaction.

Existing `test/memory-repository.test.js` also exercises revision/digest checks, queued stale commits, external edits during staging, lock lifecycle, temporary-file failures, successful rename reported as failure, and uncertain post-rename outcomes. Those tests demonstrate implemented repository behavior under their fixtures; they do not prove universal filesystem durability.

## Future internal executor boundary

No executor is implemented. A future private executor should accept only an exact validated ADD or REPLACE plan, verified evidence/provenance, authentic one-use authorization, a separately trusted exact-target confirmation for REPLACE, a recomputed idempotency key, and the expected snapshot revision/digest. It should recompute policy and target selection, then submit the receipt plus all memory changes in one repository transaction. ADD remains append-only; REPLACE changes only its exact target and preserves supersession history. A lock/revision conflict returns a conflict result and requires re-planning. A post-rename uncertain result blocks further use until explicit reconciliation.

The executor must have no public `force`, `skipAuthorization`, `trusted: true`, or caller-controlled identity switch. The model, memory content, tools, imports, and B.2a/B.2b.1 contract cannot provide authorization. Until the authorization contract can grant an authentic one-use capability and the repository can atomically store receipts, all Automatic Memory operations remain non-executable.

## Required production decision before implementation

Persistent operation receipts require a reviewed schema/repository change. Because v4 validates an exact store shape, a new strictly validated operation-receipt collection would require a schema-version bump (likely v5), a typed repository put operation, and an explicit initialization/upgrade story. The receipt and assertion/evidence/source changes must be included in the same candidate-store validation and atomic rename. The new records need explicit uniqueness, retention, versioning, status-transition, and recovery rules. This changes the real schema/repository and is outside B.2b.3 authorization; request approval for that design before modifying either.

The next architectural review should settle receipt status transitions and operation/attempt identity, retention and compaction, reconciliation of `unknown`, and the filesystem durability target. This stage stops before production persistence or Automatic Memory C.
