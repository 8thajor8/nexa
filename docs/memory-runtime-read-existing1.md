# MEMORY-READ-EXISTING1 — Reader for an existing Memory2 store

`src/memory/read-existing.js` exports the asynchronous function
`openExistingMemory2Reader({ storePath })`. It requires an absolute path to an
existing regular file containing a valid Schema v5 store. It rejects missing,
corrupt, unsupported, symbolic-link, and non-file targets. It never initializes
or migrates a store and never creates directories, locks, temporary files, or
other auxiliaries.

The returned frozen, null-prototype object exposes only `readContext({ message
= "", recentUserMessages = [] } = {})` and `close()`. Reads delegate to the
existing `createMemory2ReadOnly()` facade and preserve the Context Provider
result `{ revision, digest, generation, items }`. The reader owns one read-only
file handle; `close()` is idempotent, invalidates subsequent reads, and closes
that handle. Public errors use stable codes and omit local paths, file content,
causes, and stack traces.

The reader pins the file identity and SHA-256 digest observed when it opens. It
checks the path and open handle around each later read and rejects if the file
identity, metadata, or bytes change. This detects changes observed during the
reader session; it does not provide a transactional snapshot, coordinate with
writers, prevent a writer from changing and restoring bytes between checks, or
guarantee consistency against concurrent writers. A file replacement or
in-place edit that is observed causes the reader to fail closed for the rest of
the session. Files are limited to 32 MiB to bound memory use; larger stores are
rejected as invalid.

The internal repository object is minimal and read-only, compatible with
`createMemoryContextProvider()`. It exposes only `readSnapshot()` and is not
returned publicly. The implementation does not use `createJsonMemoryRepository()`
because that repository creates a coordination lock and exposes commit
operations. This reader does not change backend selection or connect to Runtime;
Memory1 remains the configured default when `NEXA_MEMORY_BACKEND` is unset.

Tests use synthetic Schema v5 stores in isolated temporary directories. They
verify valid and empty reads, missing/corrupt/unsupported stores, detected
modification, close behavior, sanitized errors, unchanged fixture bytes, and
absence of auxiliary files. No real user store is opened. The API is a
capability boundary for ordinary callers, not an isolation boundary against
malicious code in the same process or a guarantee of filesystem-level
immutability.
