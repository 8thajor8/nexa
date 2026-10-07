import { createHash } from 'node:crypto';
import { assertDenseArray, assertExactObject, COLLECTIONS, validateId, validateMemoryRecord, validateMemoryStore } from './schema.js';

const messages = Object.freeze({
    memory_uninitialized: 'The memory store has not been initialized.',
    memory_store_corrupt: 'The memory store is not valid.',
    memory_store_unreadable: 'The memory store could not be read.',
    memory_schema_unsupported: 'The memory schema version is not supported.',
    memory_store_locked: 'The memory store is owned by another repository.',
    memory_lock_lost: 'Exclusive memory store ownership could not be verified.',
    memory_revision_conflict: 'The memory store changed; refresh before attempting another write.',
    memory_persist_failed: 'The memory change was not persisted.',
    memory_commit_uncertain: 'The memory commit outcome could not be verified. Reopen after inspection.',
    memory_invalid_changes: 'The memory change set is invalid.',
    memory_repository_closed: 'The memory repository is not open.',
    memory_repository_invalid: 'An explicit absolute memory store path is required.',
});
export class MemoryRepositoryError extends Error {
    constructor(code, { cause } = {}) {
        if (!Object.hasOwn(messages, code)) code = 'memory_persist_failed';
        super(messages[code], cause === undefined ? undefined : { cause });
        this.name = 'MemoryRepositoryError';
        this.code = code;
        this.retryable = false; // No implicit retries, including conflicts and locks.
    }
    toJSON() { return { code: this.code, message: this.message, retryable: this.retryable }; }
}
export function contentDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
export function immutableSnapshot(store, digest) {
    validateMemoryStore(store);
    return freeze({ snapshot: structuredClone(store), revision: store.revision, digest });
}

/**
 * Repository contract: open(), readSnapshot(), commit(request), close().
 * Methods return promises; failures throw MemoryRepositoryError. readSnapshot and
 * commit return { snapshot, revision, digest }, recursively immutable.
 * No initialization or migration occurs in this layer. open requires a valid file.
 * Request changes are an array of:
 *   { type: 'put', collection, record }
 *   { type: 'delete', collection, id } (assertions/sources/evidence)
 *   { type: 'delete', collection: 'migrations', source_sha256 }
 * All operations apply together; complete referential validation follows them.
 * Migration receipts use source_sha256 as their stable key. Duplicate operations
 * on one key are rejected. Deleting an absent key is rejected, not silently ignored.
 */
export function prepareCommitRequest(request) {
    try {
        assertExactObject(request, ['expectedRevision', 'expectedDigest', 'changes']);
        if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
            || typeof request.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedDigest)) throw new Error();
        assertDenseArray(request.changes);
        if (!request.changes.length) throw new Error();
        const keys = new Set();
        for (const change of request.changes) {
            const type = Object.getOwnPropertyDescriptor(change ?? {}, 'type')?.value;
            const collection = Object.getOwnPropertyDescriptor(change ?? {}, 'collection')?.value;
            if (!COLLECTIONS.includes(collection)) throw new Error();
            if (type === 'put') {
                assertExactObject(change, ['type', 'collection', 'record']);
                validateMemoryRecord(collection, change.record);
            } else if (type === 'delete') {
                assertExactObject(change, ['type', 'collection', collection === 'migrations' ? 'source_sha256' : 'id']);
                if (collection === 'migrations') {
                    if (typeof change.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(change.source_sha256)) throw new Error();
                } else validateId(change.id, collection);
            } else throw new Error();
            const record = type === 'put' ? change.record : change;
            const key = collection + ':' + (collection === 'migrations' ? record.source_sha256 : record.id);
            if (keys.has(key)) throw new Error();
            keys.add(key);
        }
        return structuredClone(request); // Snapshot caller input before joining a queue.
    } catch (cause) { throw new MemoryRepositoryError('memory_invalid_changes', { cause }); }
}
export function applyChanges(store, changes, updatedAt) {
    try {
        const candidate = structuredClone(store);
        for (const change of changes) {
            const key = change.collection === 'migrations' ? 'source_sha256' : 'id';
            const id = change.type === 'put' ? change.record[key] : change[key];
            const records = candidate[change.collection];
            const index = records.findIndex(record => record[key] === id);
            if (change.type === 'put') {
                if (index === -1) records.push(structuredClone(change.record));
                else records[index] = structuredClone(change.record);
            } else {
                if (index === -1) throw new Error();
                records.splice(index, 1);
            }
        }
        candidate.revision += 1;
        candidate.updated_at = updatedAt;
        validateMemoryStore(candidate);
        return candidate;
    } catch (cause) { throw new MemoryRepositoryError('memory_invalid_changes', { cause }); }
}
