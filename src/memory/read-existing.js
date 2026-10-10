import * as fs from 'node:fs/promises';
import path from 'node:path';
import { contentDigest, immutableSnapshot } from './repository.js';
import { SCHEMA_VERSION, MemorySchemaError, validateMemoryStore } from './schema.js';
import { createMemory2ReadOnly } from './read-only.js';

const MAX_STORE_BYTES = 32 * 1024 * 1024;
const messages = Object.freeze({
    memory_store_path_invalid: 'An absolute Memory 2 store path is required.',
    memory_store_missing: 'The Memory 2 store does not exist.',
    memory_store_invalid: 'The Memory 2 store is not valid.',
    memory_schema_unsupported: 'The Memory 2 schema version is not supported.',
    memory_store_changed: 'The Memory 2 store changed while this reader was open.',
    memory_reader_closed: 'The Memory 2 reader is closed.',
    memory_reader_close_failed: 'The Memory 2 reader could not be closed.',
});

function publicError(code) {
    const error = new Error(messages[code] ?? messages.memory_store_invalid);
    error.name = 'Memory2ExistingReaderError';
    error.code = code;
    Object.defineProperty(error, 'stack', { value: undefined, enumerable: false, writable: false });
    error.toJSON = () => ({ code, message: error.message });
    return Object.freeze(error);
}

function identity(stat) {
    return `${stat.dev}:${stat.ino}`;
}

function sameFile(a, b) {
    return a.isFile() && b.isFile() && a.ino === b.ino
        && (!a.dev || !b.dev || a.dev === b.dev);
}

function sameVersion(a, b) {
    return sameFile(a, b) && a.size === b.size
        && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function mapOpenError(cause) {
    if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') return publicError('memory_store_missing');
    if (cause instanceof MemorySchemaError && cause.code === 'memory_schema_unsupported') {
        return publicError('memory_schema_unsupported');
    }
    return publicError('memory_store_invalid');
}

async function readHandle(handle, expectedIdentity) {
    const before = await handle.stat();
    if (!before.isFile() || identity(before) !== expectedIdentity || before.size > MAX_STORE_BYTES) {
        throw publicError('memory_store_changed');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw publicError('memory_store_changed');
        offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameVersion(before, after)) throw publicError('memory_store_changed');
    return bytes;
}

function parseV5(bytes) {
    let store;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        store = JSON.parse(text);
        validateMemoryStore(store);
        if (store.schema_version !== SCHEMA_VERSION) throw publicError('memory_schema_unsupported');
    } catch (cause) {
        if (cause?.code === 'memory_schema_unsupported') throw cause;
        throw mapOpenError(cause);
    }
    return store;
}

/**
 * Open an existing Schema v5 file for read-only context retrieval. No store,
 * directory, lock, migration, or temporary file is created. This detects
 * changes observed between reads and while each read is in progress; it does
 * not coordinate with or provide a consistent snapshot against concurrent
 * writers that ignore this reader.
 */
export async function openExistingMemory2Reader({ storePath } = {}) {
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) {
        throw publicError('memory_store_path_invalid');
    }

    let handle;
    let baselineDigest;
    let baselineIdentity;
    let state = 'open';
    let queue = Promise.resolve();

    try {
        const linkInfo = await fs.lstat(storePath);
        if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw publicError('memory_store_invalid');
        handle = await fs.open(storePath, 'r');
        const openedInfo = await handle.stat();
        if (!sameFile(linkInfo, openedInfo) || openedInfo.size > MAX_STORE_BYTES) {
            throw publicError('memory_store_invalid');
        }
        baselineIdentity = identity(openedInfo);
        const initialBytes = await readHandle(handle, baselineIdentity);
        const currentLink = await fs.lstat(storePath);
        if (!sameVersion(linkInfo, currentLink)) throw publicError('memory_store_changed');
        const store = parseV5(initialBytes);
        baselineDigest = contentDigest(initialBytes);

        const repository = Object.freeze({
            readSnapshot() {
                const result = queue.then(async () => {
                    if (state === 'closed') throw publicError('memory_reader_closed');
                    if (state === 'changed') throw publicError('memory_store_changed');
                    try {
                        const linkBefore = await fs.lstat(storePath);
                        const handleBefore = await handle.stat();
                        if (!sameFile(linkBefore, handleBefore)
                            || identity(handleBefore) !== baselineIdentity) throw publicError('memory_store_changed');
                        const bytes = await readHandle(handle, baselineIdentity);
                        const linkAfter = await fs.lstat(storePath);
                        if (!sameVersion(linkBefore, linkAfter) || contentDigest(bytes) !== baselineDigest) {
                            throw publicError('memory_store_changed');
                        }
                        const currentStore = parseV5(bytes);
                        if (currentStore.store_id !== store.store_id || currentStore.revision !== store.revision) {
                            throw publicError('memory_store_changed');
                        }
                        return immutableSnapshot(currentStore, baselineDigest);
                    } catch (error) {
                        if (error?.code === 'memory_store_changed') state = 'changed';
                        throw error;
                    }
                });
                queue = result.catch(() => {});
                return result;
            },
        });

        const facade = createMemory2ReadOnly({ repository });
        const result = Object.create(null);
        Object.defineProperties(result, {
            readContext: { enumerable: true, value: options => {
                if (state === 'closed') return Promise.reject(publicError('memory_reader_closed'));
                if (state === 'changed') return Promise.reject(publicError('memory_store_changed'));
                return facade.readContext(options).catch(error => {
                    if (state === 'changed') throw publicError('memory_store_changed');
                    throw error;
                });
            } },
            close: { enumerable: true, value: async () => {
                if (state === 'closed') return;
                state = 'closed';
                await queue;
                await facade.close();
                try { await handle.close(); }
                catch { throw publicError('memory_reader_close_failed'); }
            } },
        });
        return Object.freeze(result);
    } catch (cause) {
        if (handle) await handle.close().catch(() => {});
        if (cause?.code && Object.hasOwn(messages, cause.code)) throw cause;
        throw mapOpenError(cause);
    }
}
