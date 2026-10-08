# Automatic Memory B.2b.1 — Trusted-turn authorization contract

## Runtime trust currently available

The CLI reads ordinary turns through `readDirectUserTurn()` from process stdin. That boundary can issue an opaque, one-use capability for a current direct terminal turn. A.2/A.3 authorization consumes that capability for an explicit structured remember/forget/person/relation command. It is not an automatic-memory grant and must not be repurposed for extraction authorization.

The agent also creates an opaque random `sessionId`, and `run(message)` accepts caller-supplied text. That session identifier is not an authenticated principal or turn identifier. The current runtime does not expose a stable authenticated owner ID, a trusted per-message turn reference to Automatic Memory, a source-evidence reference, or an automatic-memory permission grant. The existing tool permission map classifies broad tool actions; it does not authenticate a user or authorize an exact memory candidate.

## Separation and implemented assessment

Extraction still produces model-owned candidate data. B.1/B.2a recompute and classify the candidate and operation. The new `assessAutomaticMemoryAuthorization()` recomputes the B.2a contract and checks whether a supplied set of **untrusted context claims** matches the exact operation fingerprint, source/evidence hashes, snapshot revision/digest, and narrow proposed permission scope.

This comparison is a policy/consistency simulation only. Principal IDs, turn IDs, and scope strings in the input are ordinary claims; their presence or shape is never proof. The result distinguishes:

- `policyEligibility`: whether a supported operation's claims are consistent (`eligible` for a synthetic matching ADD; `confirmation_required` for REPLACE; otherwise `denied`);
- `authorizationRequestEligible`: always false because no trusted authenticated principal/turn capability is available to make a real request;
- `authorization.granted`: always `false` because this phase has no trusted-boundary capability verifier;
- `executable` and `writeReady`: always `false`.

The module does not expose an issuer, grant, token, capability, runtime hook, service call, or executor. Even a perfectly matching synthetic fixture remains denied for real authorization. It can compare a claimed turn ID syntactically but cannot establish which trusted turn it belongs to; consequently its `turnAuthenticated` result is always false.

## Binding requirements for a future trusted boundary

A future issuer/verifier must provide evidence unavailable in B.2b.1 and bind it to one exact action:

- authenticated principal/owner identity from a real authentication provider;
- a unique, authenticated conversation turn, with expiration and recipient binding;
- the original user-evidence reference and source-text/evidence hashes;
- a recomputed candidate and operation fingerprint, including operation kind and exact REPLACE target;
- the Memory2 snapshot revision and digest;
- an explicit narrow permission scope for ADD or REPLACE;
- a separate trusted confirmation proof for REPLACE, bound to the exact candidate, target, snapshot and principal.

No string, boolean, object shape, model response, stored memory value, tool output, or import can substitute for those proofs. The current terminal capability only covers explicitly parsed memory commands; no code connects it to this assessment or to automatic extraction.

## Replay and transaction limits

Fingerprint equality detects edits relative to the supplied candidate and snapshot. It cannot authenticate the context's principal/turn or prove that the snapshot is still current. Repeating the same assessment returns the same policy result. There is no durable consumption ledger, so B.2b.1 explicitly reports replay protection unavailable and grants nothing. B.2b.3 must add and review atomic one-use consumption and idempotency receipts before any execution path exists. An idempotency key is not authorization.

## REPLACE confirmation

REPLACE cannot become eligible for authorization in this stage. The assessment returns `confirmation_required`; no trusted confirmation boundary exists. A bare “yes”, a model-proposed confirmation flag, or a confirmation for a different operation/target is insufficient. Future confirmation must originate from trusted direct-user input and bind to the exact replacement operation and snapshot.

## Safety coverage and remaining infrastructure

Synthetic tests exercise matching claims, absent/malformed claims, altered evidence and operations, inadequate scope, third-party and textual-only project decisions, secret screening, REPLACE confirmation, snapshot mismatch and repeated requests. They verify that all outcomes remain non-authorized and non-executable and that the module has no service/repository/write route.

Still unverified and unavailable are real user authentication, authenticated turn/evidence provenance, turn expiry at the automatic-memory boundary, permission issuance, trusted REPLACE confirmation, persistent replay consumption, current-snapshot comparison at commit, and atomic persistence. Therefore Nexa cannot authorize or perform automatic Memory2 writes after B.2b.1. No runtime, agent, prompt, tool, MemoryService, schema, dependency, or personal-memory changes are included.
