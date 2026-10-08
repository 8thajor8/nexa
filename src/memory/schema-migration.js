import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, validateMemoryStore } from './schema.js';
import { contentDigest } from './repository.js';

const messages = Object.freeze({
    memory_schema_migration_invalid: 'The explicit schema migration request is invalid.',
    memory_schema_migration_locked: 'The memory store is owned by another process.',
    memory_schema_migration_corrupt: 'The source memory store is not valid.',
    memory_schema_migration_backup_exists: 'A migration backup already exists.',
    memory_schema_migration_backup_cleanup_failed: 'Backup creation failed and its owned temporary file could not be cleaned up; manual recovery is required.',
    memory_schema_migration_failed: 'The schema migration could not be completed.',
    memory_schema_migration_uncertain: 'The schema migration outcome could not be verified; inspect the store and backup.',
});

export class MemorySchemaMigrationError extends Error {
    constructor(code, options = {}) {
        super(Object.hasOwn(messages, code) ? messages[code] : messages.memory_schema_migration_failed, options);
        this.name = 'MemorySchemaMigrationError';
        this.code = Object.hasOwn(messages, code) ? code : 'memory_schema_migration_failed';
    }
    toJSON() { return { code: this.code, message: this.message }; }
}

function migrateShapeV4ToV5(source, updatedAt) {
    const candidate = structuredClone(source);
    candidate.schema_version = SCHEMA_VERSION;
    candidate.automatic_operations = [];
    candidate.revision += 1;
    candidate.updated_at = updatedAt;
    validateMemoryStore(candidate);
    return candidate;
}

async function readValidated(fs, filePath) {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new MemorySchemaMigrationError('memory_schema_migration_corrupt');
    const bytes = await fs.readFile(filePath);
    let store;
    try { store = JSON.parse(bytes.toString('utf8')); validateMemoryStore(store); }
    catch { throw new MemorySchemaMigrationError('memory_schema_migration_corrupt'); }
    return { bytes, digest: contentDigest(bytes), store };
}

function sameFileIdentity(left, right) {
    return typeof left?.ino === 'bigint' && left.ino !== 0n && left.ino === right?.ino &&
        (left.dev === 0n || right?.dev === 0n || left.dev === right.dev);
}

/**
 * Explicitly migrates only the caller-provided file. There is no startup hook,
 * default path, Memory1 access, backend selection, or automatic invocation.
 * A byte-for-byte v4 backup is created exclusively before replacing the store.
 */
export async function migrateMemoryStoreV4ToV5({ storePath, fileSystem = {}, now = () => new Date().toISOString() } = {}) {
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath) || typeof now !== 'function') {
        throw new MemorySchemaMigrationError('memory_schema_migration_invalid');
    }
    const fs = { ...nativeFs, ...fileSystem };
    let destination;
    let lockPath;
    let lockHandle;
    let lockCreated = false;
    let backupPath;
    let backupTemporaryPath;
    let backupTemporaryIdentity;
    let backupTemporaryOwned = false;
    let backupComplete = false;
    let temporaryPath;
    let backupHandle;
    let temporaryHandle;
    let replacementAttempted = false;
    const token = randomUUID();
    try {
        const parent = await fs.realpath(path.dirname(storePath));
        destination = path.join(parent, path.basename(storePath));
        lockPath = destination + '.lock';
        try { lockHandle = await fs.open(lockPath, 'wx', 0o600); lockCreated = true; }
        catch (error) { throw new MemorySchemaMigrationError(error?.code === 'EEXIST' ? 'memory_schema_migration_locked' : 'memory_schema_migration_failed'); }
        await lockHandle.writeFile(JSON.stringify({ pid: process.pid, token }) + '\n', 'utf8');
        await lockHandle.sync();
        await lockHandle.close(); lockHandle = undefined;

        const original = await readValidated(fs, destination);
        if (original.store.schema_version === SCHEMA_VERSION) {
            return { success: true, outcome: 'already_v5', revision: original.store.revision, digest: original.digest };
        }
        if (original.store.schema_version !== 4) throw new MemorySchemaMigrationError('memory_schema_migration_corrupt');
        const updatedAt = now();
        const candidate = migrateShapeV4ToV5(original.store, updatedAt);
        const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n', 'utf8');
        const candidateDigest = contentDigest(candidateBytes);
        backupPath = destination + '.v4.bak';
        let backupExists = false;
        try { await fs.lstat(backupPath); backupExists = true; }
        catch (error) { if (error?.code !== 'ENOENT') throw new MemorySchemaMigrationError('memory_schema_migration_failed'); }
        if (backupExists) throw new MemorySchemaMigrationError('memory_schema_migration_backup_exists');
        backupTemporaryPath = `${backupPath}.${token}.tmp`;
        try { backupHandle = await fs.open(backupTemporaryPath, 'wx', 0o600); }
        catch (error) { throw new MemorySchemaMigrationError(error?.code === 'EEXIST' ? 'memory_schema_migration_backup_exists' : 'memory_schema_migration_failed'); }
        backupTemporaryOwned = true;
        const ownedBackup = await backupHandle.stat({ bigint: true });
        backupTemporaryIdentity = { dev: ownedBackup.dev, ino: ownedBackup.ino };
        await backupHandle.writeFile(original.bytes);
        await backupHandle.sync();
        await backupHandle.close(); backupHandle = undefined;
        if (contentDigest(await fs.readFile(backupTemporaryPath)) !== original.digest) throw new MemorySchemaMigrationError('memory_schema_migration_failed');
        // link() publishes atomically and fails with EEXIST; unlike rename(), it
        // cannot replace a backup created by another process.
        try { await fs.link(backupTemporaryPath, backupPath); }
        catch (error) { throw new MemorySchemaMigrationError(error?.code === 'EEXIST' ? 'memory_schema_migration_backup_exists' : 'memory_schema_migration_failed'); }
        const publishedBackup = await fs.lstat(backupPath, { bigint: true });
        if (!publishedBackup.isFile() || publishedBackup.isSymbolicLink() ||
            !sameFileIdentity(publishedBackup, backupTemporaryIdentity) ||
            contentDigest(await fs.readFile(backupPath)) !== original.digest) {
            throw new MemorySchemaMigrationError('memory_schema_migration_failed');
        }
        backupComplete = true;
        await fs.unlink(backupTemporaryPath);
        backupTemporaryPath = undefined;

        temporaryPath = path.join(path.dirname(destination), '.' + path.basename(destination) + '.' + token + '.tmp');
        temporaryHandle = await fs.open(temporaryPath, 'wx', 0o600);
        await temporaryHandle.writeFile(candidateBytes);
        await temporaryHandle.sync();
        await temporaryHandle.close(); temporaryHandle = undefined;

        const lockInfo = await fs.lstat(lockPath);
        if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new MemorySchemaMigrationError('memory_schema_migration_locked');
        const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (lock.pid !== process.pid || lock.token !== token) throw new MemorySchemaMigrationError('memory_schema_migration_locked');
        const unchanged = await readValidated(fs, destination);
        if (unchanged.digest !== original.digest || unchanged.store.schema_version !== 4) throw new MemorySchemaMigrationError('memory_schema_migration_locked');

        replacementAttempted = true;
        await fs.rename(temporaryPath, destination);
        temporaryPath = undefined;
        const committed = await readValidated(fs, destination);
        if (committed.digest !== candidateDigest || committed.store.schema_version !== SCHEMA_VERSION) {
            throw new MemorySchemaMigrationError('memory_schema_migration_uncertain');
        }
        return { success: true, outcome: 'migrated', revision: committed.store.revision,
            digest: committed.digest, backupPath };
    } catch (error) {
        if (replacementAttempted && destination) {
            try {
                const current = await readValidated(fs, destination);
                if (current.store.schema_version === SCHEMA_VERSION) {
                    return { success: true, outcome: 'migrated', revision: current.store.revision,
                        digest: current.digest, backupPath };
                }
                if (current.store.schema_version !== 4) throw new Error();
            } catch {
                throw new MemorySchemaMigrationError('memory_schema_migration_uncertain');
            }
        }
        if (!backupComplete && backupTemporaryPath && backupTemporaryOwned) {
            try {
                if (backupHandle) {
                    if (!backupTemporaryIdentity) {
                        const ownedBackup = await backupHandle.stat({ bigint: true });
                        backupTemporaryIdentity = { dev: ownedBackup.dev, ino: ownedBackup.ino };
                    }
                    await backupHandle.close(); backupHandle = undefined;
                }
                if (!backupTemporaryIdentity) throw new Error('The owned temporary file identity could not be verified.');
                const current = await fs.lstat(backupTemporaryPath, { bigint: true });
                if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, backupTemporaryIdentity)) {
                    throw new Error(`Temporary file identity changed (expected ${backupTemporaryIdentity.dev}:${backupTemporaryIdentity.ino}, observed ${current.dev}:${current.ino}).`);
                }
                try {
                        const published = await fs.lstat(backupPath, { bigint: true });
                    if (published.isFile() && !published.isSymbolicLink() && sameFileIdentity(published, backupTemporaryIdentity)) {
                        await fs.unlink(backupPath);
                    }
                } catch (publishedError) {
                    if (publishedError?.code !== 'ENOENT') throw publishedError;
                }
                await fs.unlink(backupTemporaryPath);
                backupTemporaryPath = undefined;
            } catch (cleanupError) {
                const cleanupFailure = new MemorySchemaMigrationError('memory_schema_migration_backup_cleanup_failed', { cause: error });
                cleanupFailure.cleanupCause = cleanupError;
                cleanupFailure.residuePath = backupTemporaryPath;
                throw cleanupFailure;
            }
        }
        if (error instanceof MemorySchemaMigrationError) throw error;
        throw new MemorySchemaMigrationError('memory_schema_migration_failed');
    } finally {
        if (temporaryHandle) await temporaryHandle.close().catch(() => {});
        if (backupHandle) await backupHandle.close().catch(() => {});
        if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
        if (lockHandle) await lockHandle.close().catch(() => {});
        if (lockCreated && lockPath) {
            try {
                const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
                if (owner.pid === process.pid && owner.token === token) await fs.unlink(lockPath).catch(() => {});
            } catch { /* Leave unreadable or replaced locks for explicit recovery. */ }
        }
    }
}

/** Pure, validated v4→v5 transform for fixtures and offline review. */
export function planMemorySchemaV4ToV5({ store, now = () => new Date().toISOString() } = {}) {
    try {
        validateMemoryStore(store);
        if (store.schema_version !== 4 || typeof now !== 'function') throw new Error();
        const candidate = migrateShapeV4ToV5(store, now());
        return { success: true, sourceRevision: store.revision, candidate: structuredClone(candidate) };
    } catch {
        return { success: false, error: { code: 'memory_schema_migration_invalid' } };
    }
}
