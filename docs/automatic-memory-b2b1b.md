# Automatic Memory B.2b.1b — Trusted local runtime context

`direct-user-input.js` remains the sole issuer of local-input context. It reads the process `stdin` directly; callers cannot provide a stream, text, session identifier, turn identifier, hash, or principal and have those values treated as provenance.

For each runtime recipient object, the module keeps a private local session. Each actual line read from `stdin` receives a fresh random turn identifier and a SHA-256 digest of the exact original line. The private capability state binds the recipient object, session, turn, `local_cli` origin, purpose `automatic_memory_assessment`, and source digest. The returned capability is an empty frozen object whose identity is recognized only by a module-private `WeakMap`.

`consumeTrustedLocalTurnContext` consumes the capability on its first verification attempt, before checking recipient identity or text integrity. Therefore wrong-recipient and altered-text attempts burn the capability, and successful verification cannot be replayed. A later input line invalidates the prior capability. Session closure, reader closure, EOF, and process restart invalidate remaining proof. The verifier accepts only the exact original text for the current recipient and turn.

The resulting principal identifies a trusted local runtime session, not an authenticated person. Its permission scope list is always empty. The separate `runtime-context-adapter.js` can pass a verified context into the existing B.2b.1 assessment contract, but deliberately supplies no permission scope and cannot grant authorization, execute an operation, or write memory. The adapter does not change B.2b.1's contract.

The runtime context capability is not passed to the model, tools, logs, or the conversational agent. No remote provenance is supported. A future remote transport needs its own authenticated ingress boundary. Arbitrary code execution inside the same process or control of the operating system's stdin is outside this in-process boundary; this mechanism does not prove a human identity.

Tests use synthetic lines delivered to child processes through their real stdin. They verify issuance, turn/session binding, exact-text integrity, failed-attempt consumption, replay rejection, recipient binding, next-turn/EOF/close/restart invalidation, rejection of model-shaped claims and plain objects, and the adapter's permanently denied/non-executable behavior. No persistent store, MemoryService, agent integration, model call, or migration is involved.
