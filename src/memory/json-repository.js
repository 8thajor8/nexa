import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemorySchemaError, validateMemoryStore } from './schema.js';
import { MemoryRepositoryError, applyChanges, contentDigest, immutableSnapshot, prepareCommitRequest } from './repository.js';

const processOwners = new Map();

/**
 * Explicit path only; no import-time I/O, directory creation, initialization or
 * migration. A caller must provision a valid store before open().
 * Uses native FileHandle.writeFile/sync/close, with an injectable fs facade for
 * deterministic failure tests. now() returns a UTC timestamp string.
 * Locks coordinate cooperating processes, not unrelated editors. Do not edit or
 * move the store while open. Stale locks require explicit offline recovery.
 * Rename replacement is atomic on supported local filesystems, not a promise of
 * power-loss durability on every filesystem. The destination is never unlinked.
 */
export function createJsonMemoryRepository({ storePath, fileSystem = {}, now = () => new Date().toISOString() } = {}) {
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) throw new MemoryRepositoryError('memory_repository_invalid');
    const fs = { ...nativeFs, ...fileSystem };
    let destination;
    let lockPath;
    let ownerKey;
    let token;
    let published;
    let state = 'closed';
    let queue = Promise.resolve();

    function serialized(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    function requireOpen() {
        if (state === 'uncertain') throw new MemoryRepositoryError('memory_commit_uncertain');
        if (state !== 'open') throw new MemoryRepositoryError('memory_repository_closed');
    }
    async function readDisk() {
        let bytes;
        try {
            const info = await fs.lstat(destination);
            if (!info.isFile() || info.isSymbolicLink()) throw new MemoryRepositoryError('memory_store_unreadable');
            bytes = await fs.readFile(destination);
        } catch (cause) {
            if (cause instanceof MemoryRepositoryError) throw cause;
            throw new MemoryRepositoryError(cause?.code === 'ENOENT' ? 'memory_uninitialized' : 'memory_store_unreadable', { cause });
        }
        let store;
        try { store = JSON.parse(bytes.toString('utf8')); }
        catch (cause) { throw new MemoryRepositoryError('memory_store_corrupt', { cause }); }
        try { validateMemoryStore(store); }
        catch (cause) {
            throw new MemoryRepositoryError(cause instanceof MemorySchemaError && cause.code === 'memory_schema_unsupported'
                ? 'memory_schema_unsupported' : 'memory_store_corrupt', { cause });
        }
        return { store, digest: contentDigest(bytes) };
    }
    async function verifyOwnership() {
        try {
            const info = await fs.lstat(lockPath);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error();
            const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (owner.token !== token || owner.pid !== process.pid || processOwners.get(ownerKey) !== token) throw new Error();
        } catch (cause) { throw new MemoryRepositoryError('memory_lock_lost', { cause }); }
    }
    async function releaseOwnership() {
        try {
            await verifyOwnership();
            await fs.unlink(lockPath);
        } catch (cause) {
            throw cause instanceof MemoryRepositoryError ? cause : new MemoryRepositoryError('memory_lock_lost', { cause });
        } finally {
            if (processOwners.get(ownerKey) === token) processOwners.delete(ownerKey);
        }
    }
    function assertUnchanged(current) {
        if (current.store.store_id !== published.snapshot.store_id || current.store.revision !== published.revision || current.digest !== published.digest) {
            throw new MemoryRepositoryError('memory_revision_conflict');
        }
    }
    function publish(current) {
        published = immutableSnapshot(current.store, current.digest);
        return published;
    }
    async function open() {
        return serialized(async () => {
            if (state === 'open') return published;
            if (state === 'uncertain') throw new MemoryRepositoryError('memory_commit_uncertain');
            try {
                const parent = await fs.realpath(path.dirname(storePath));
                destination = path.join(parent, path.basename(storePath));
            } catch (cause) {
                throw new MemoryRepositoryError(cause?.code === 'ENOENT' ? 'memory_uninitialized' : 'memory_store_unreadable', { cause });
            }
            lockPath = destination + '.lock';
            ownerKey = process.platform === 'win32' ? destination.toLowerCase() : destination;
            if (processOwners.has(ownerKey)) throw new MemoryRepositoryError('memory_store_locked');
            token = randomUUID();
            processOwners.set(ownerKey, token);
            let handle;
            let created = false;
            try {
                // Read before locking so missing/corrupt stores never create lockfiles.
                await readDisk();
                try { handle = await fs.open(lockPath, 'wx', 0o600); created = true; }
                catch (cause) { throw new MemoryRepositoryError(cause?.code === 'EEXIST' ? 'memory_store_locked' : 'memory_persist_failed', { cause }); }
                await handle.writeFile(JSON.stringify({ pid: process.pid, token }) + '\n', 'utf8');
                await handle.sync();
                await handle.close();
                handle = undefined;
                await verifyOwnership();
                const current = await readDisk();
                const snapshot = publish(current);
                state = 'open';
                return snapshot;
            } catch (cause) {
                if (handle) await handle.close().catch(() => {});
                // A partial/unreadable lock is retained for explicit recovery.
                if (created) await releaseOwnership().catch(() => {});
                if (processOwners.get(ownerKey) === token) processOwners.delete(ownerKey);
                throw cause instanceof MemoryRepositoryError ? cause : new MemoryRepositoryError('memory_persist_failed', { cause });
            }
        });
    }
    function readSnapshot() {
        return serialized(async () => {
            requireOpen();
            await verifyOwnership();
            const current = await readDisk();
            assertUnchanged(current);
            return published;
        });
    }
    function commit(request) {
        let prepared;
        try { prepared = prepareCommitRequest(request); }
        catch (error) { return Promise.reject(error); }
        return serialized(async () => {
            requireOpen();
            await verifyOwnership();
            const original = await readDisk();
            assertUnchanged(original);
            if (prepared.expectedRevision !== original.store.revision || prepared.expectedDigest !== original.digest) {
                throw new MemoryRepositoryError('memory_revision_conflict');
            }
            let candidate;
            try { candidate = applyChanges(original.store, prepared.changes, now()); }
            catch (cause) { throw cause instanceof MemoryRepositoryError ? cause : new MemoryRepositoryError('memory_invalid_changes', { cause }); }
            const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n', 'utf8');
            const candidateDigest = contentDigest(bytes);
            const temporaryPath = path.join(path.dirname(destination), '.' + path.basename(destination) + '.' + randomUUID() + '.tmp');
            let temporaryCreated = false;
            let handle;
            let replacementAttempted = false;
            try {
                handle = await fs.open(temporaryPath, 'wx', 0o600);
                temporaryCreated = true;
                await handle.writeFile(bytes);
                await handle.sync();
                await handle.close();
                handle = undefined;
                // Recheck after staging; never overwrite an observed external edit.
                await verifyOwnership();
                assertUnchanged(await readDisk());
                replacementAttempted = true;
                await fs.rename(temporaryPath, destination);
                const committed = await readDisk();
                if (committed.digest !== candidateDigest || committed.store.store_id !== original.store.store_id) {
                    state = 'uncertain';
                    throw new MemoryRepositoryError('memory_commit_uncertain');
                }
                return publish(committed);
            } catch (cause) {
                if (replacementAttempted) {
                    // A rename can succeed before its wrapper/OS reports an error.
                    // Reconcile actual bytes before publishing or claiming failure.
                    let current;
                    try { current = await readDisk(); }
                    catch (readCause) {
                        state = 'uncertain';
                        throw new MemoryRepositoryError('memory_commit_uncertain', { cause: readCause });
                    }
                    if (current.digest === candidateDigest && current.store.store_id === original.store.store_id) {
                        state = 'open';
                        return publish(current);
                    }
                    if (current.digest === original.digest && current.store.store_id === original.store.store_id) {
                        state = 'open';
                        throw new MemoryRepositoryError('memory_persist_failed', { cause });
                    }
                    state = 'uncertain';
                    throw new MemoryRepositoryError('memory_commit_uncertain', { cause });
                }
                if (cause instanceof MemoryRepositoryError) throw cause;
                throw new MemoryRepositoryError('memory_persist_failed', { cause });
            } finally {
                if (handle) await handle.close().catch(() => {});
                // Never remove a path we failed to exclusively create.
                if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => {});
            }
        });
    }
    function close() {
        return serialized(async () => {
            if (state === 'closed') return;
            try { await releaseOwnership(); }
            finally { state = 'closed'; published = undefined; }
        });
    }
    return Object.freeze({ open, readSnapshot, commit, close });
}
