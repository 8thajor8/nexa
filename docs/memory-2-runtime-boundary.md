# Memory 2 A.2 + A.3 boundary

Memory 1 remains the default personal runtime. `src/index.js` calls `createAgent()`
without a Memory 2 repository. No environment switch, default v2 path, store
initialization, or personal migration is introduced. Tests explicitly inject an
already-open repository backed by a temporary synthetic store.

## Authority and lifetime

`core/direct-user-input.js` owns the process stdin reader. Its `readDirectUserTurn`
accepts a recipient identity, never input text, an input stream, an event, or a
callback. It captures the actual line, parses a deterministic command, and keeps
the authoritative request in a module-private WeakMap. The returned capability
has no fields and cannot survive cloning or serialization. Parsing alone grants
no authority. There is no exported synthetic issuer or production test bypass.

The operating-system owner of stdin is the trust root for this terminal app.
This boundary rejects untrusted application data; it is not a sandbox against
arbitrary JavaScript execution, replacement of builtins, or control of the host
process/terminal. Those capabilities already permit direct repository writes.

A proof is bound to the recipient service and complete request. Authorizing
consumes it once; grants are independently one-use and bound to the same request,
service, and live turn. Reading another turn or releasing the current turn
invalidates outstanding proofs/grants. The agent holds the capability privately
and releases it in `finally`. Model requests, tools, memory, and imported data
never receive it. `agent.run(text)` cannot authorize Memory 2 mutations and is
labelled untrusted when forwarding provenance to existing tools. Only terminal
input gets the legacy tools' internal `direct_user` context label.

## Deterministic commands

The anchored phrases `remember that`, `save that`, `keep this in memory:`,
`recorda que`/`recordá que`, and `guarda que`/`guardá que` retain their literal
payload as an owner fact with predicate `user.note` and a content-derived key.
No semantic extraction or additional model call is performed.

The explicit terminal form `/remember <JSON proposal>` supplies all assertion
fields for deterministic structured updates. It must pass the existing schema.
The proof binds every field, including subject, predicate, validity, and slot;
there is no model-proposed override. `/forget assertion <id>` and
`/forget slot <category>:<key>` retain exact deletion policies. A compatibility
slot spanning different subjects or predicates requires clarification.

These commands are processed before calling the model when Memory 2 is explicitly
configured. Memory 1 tools are withheld and denied in that mode. The default
Memory 1 agent keeps its existing tools and behavior.

## Context and forgetting

The provider reads a fresh snapshot before each model request, selects active
assertions in stable ID order, and emits a function-call/output pair labelled
`data_only`. Stored text is never appended to system/developer instructions.
Only the fixed policy describing this separation is added to instructions.
Defaults are 20 records and 12,000 UTF-16 code units of serialized payload;
configuration is capped at 100 records and 32,000 code units. Whole records that
do not fit are omitted, with a truncation indicator. No embeddings are used.

Memory context items are ephemeral and never retained in conversation history.
A successful forget invalidates the provider generation and clears the retained
conversation, including assistant/tool echoes. Subsequent model calls rebuild
from the repository. A changed repository digest also resets derived history.
Agent input/model turns are serialized, preventing an in-flight model response
from being appended after an internal forget. Previously emitted text cannot be
erased. No session invalidation occurs for a failed deletion.

## Validation

The terminal test driver spawns an isolated Node process and writes synthetic
lines through its real OS stdin pipe. No production issuer or injectable reader
is exposed for testing. Filesystem tests use Windows temporary directories and
safe cleanup checks. Live OpenAI calls and the user's personal stores are not
needed for these tests.
