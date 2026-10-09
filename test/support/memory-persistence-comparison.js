import nativeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSyntheticLocalIdentityStore, validateLocalIdentitySnapshot } from '../../src/core/identity-store.js';

const ID = /^test_[a-z0-9._-]{1,80}$/u;

export class ComparisonStoreError extends Error {
    constructor(code, options = {}) {
        super(`Synthetic comparison store failed (${code}).`, options.cause ? { cause: options.cause } : undefined);
        this.code = code;
    }
}

function bytesFor(snapshot) { return Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function projection(snapshot) {
    if (!validateLocalIdentitySnapshot(snapshot)) throw new ComparisonStoreError('corrupt');
    const bytes = bytesFor(snapshot);
    return Object.freeze({ snapshot: structuredClone(snapshot), revision: snapshot.revision,
        digest: digest(bytes), executable: false, authorization: 'DENY' });
}
function initialSnapshot(installationId, now) {
    if (typeof installationId !== 'string' || !ID.test(installationId)) throw new ComparisonStoreError('invalid');
    const value = { schemaVersion: 1, trustDomain: 'test.synthetic', installationId,
        bootstrapState: 'uninitialized', ownerPrincipalId: null, ownerCredentialRefs: [], credentials: [],
        pendingBootstrap: null, revision: 0, revocationEpoch: 0,
        recovery: { secondAuthenticatorRequired: true, secondAuthenticatorCredentialRef: null,
            offlineRecoveryKeyRequired: true, offlineRecoveryKeyStatus: 'not_generated' }, updatedAt: now };
    if (!validateLocalIdentitySnapshot(value)) throw new ComparisonStoreError('invalid');
    return value;
}

async function assertFixturePath(storePath) {
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) throw new ComparisonStoreError('path_invalid');
    const root = path.resolve(path.dirname(storePath));
    const temp = path.resolve(os.tmpdir());
    const relative = path.relative(temp, root);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || !/^nexa-m1e4-[^\\/]+$/u.test(path.basename(root))) throw new ComparisonStoreError('path_outside_fixture');
    let rootInfo;
    let realRoot;
    try {
        rootInfo = await nativeFs.lstat(root);
        realRoot = await nativeFs.realpath(root);
    } catch (cause) { throw new ComparisonStoreError('fixture_root_unavailable', { cause }); }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (Number(rootInfo.attributes ?? 0) & 0x400) !== 0
        || path.resolve(realRoot).toLowerCase() !== root.toLowerCase()) throw new ComparisonStoreError('fixture_root_redirected');
    if (path.resolve(storePath) !== path.join(root, path.basename(storePath))) throw new ComparisonStoreError('path_invalid');
    try {
        const fileInfo = await nativeFs.lstat(storePath);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || (Number(fileInfo.attributes ?? 0) & 0x400) !== 0
            || (fileInfo.nlink !== undefined && fileInfo.nlink > 1)) throw new ComparisonStoreError('store_file_redirected');
    } catch (cause) {
        if (cause?.code !== 'ENOENT') {
            if (cause instanceof ComparisonStoreError) throw cause;
            throw new ComparisonStoreError('store_file_unavailable', { cause });
        }
    }
    return { root, relative };
}

export async function openJsonComparisonStore({ storePath, clock, fileSystem } = {}) {
    await assertFixturePath(storePath);
    const store = createSyntheticLocalIdentityStore({ storePath, ...(clock ? { clock } : {}), ...(fileSystem ? { fileSystem } : {}) });
    return Object.freeze({ backend: 'json-existing-synthetic-store', initialize: input => store.initialize(input),
        readSnapshot: () => store.readSnapshot(), lockStore: input => store.lockStore(input), close: () => store.close(),
        evaluateExecutionRequest: () => store.evaluateExecutionRequest() });
}

export async function openSqliteComparisonStore({ storePath, installationId, clock = () => new Date().toISOString(),
    faultInjector = () => {} } = {}) {
    await assertFixturePath(storePath);
    if (typeof clock !== 'function' || typeof faultInjector !== 'function') throw new ComparisonStoreError('invalid');
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); }
    catch (cause) { throw new ComparisonStoreError('sqlite_unavailable', { cause }); }
    let db;
    let closed = false;
    try {
        db = new DatabaseSync(storePath, { timeout: 5_000 });
        db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
        db.exec(`CREATE TABLE IF NOT EXISTS identity_snapshot (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            digest TEXT NOT NULL CHECK (length(digest) = 64),
            body TEXT NOT NULL
        ) STRICT;`);
        const integrity = db.prepare('PRAGMA integrity_check').get();
        if (integrity?.integrity_check !== 'ok') throw new ComparisonStoreError('corrupt');
    } catch (cause) {
        try { db?.close(); } catch { /* Preserve initialization failure. */ }
        if (cause instanceof ComparisonStoreError) throw cause;
        throw new ComparisonStoreError('sqlite_open_failed', { cause });
    }

    function requireOpen() { if (closed) throw new ComparisonStoreError('closed'); }
    function readRow() {
        requireOpen();
        let row;
        try { row = db.prepare('SELECT revision, digest, body FROM identity_snapshot WHERE slot = 1').get(); }
        catch (cause) { throw new ComparisonStoreError('corrupt', { cause }); }
        if (!row) throw new ComparisonStoreError('corrupt');
        let value;
        try { value = JSON.parse(row.body); } catch (cause) { throw new ComparisonStoreError('corrupt', { cause }); }
        const snapshot = projection(value);
        if (row.revision !== value.revision || row.digest !== snapshot.digest) throw new ComparisonStoreError('corrupt');
        return snapshot;
    }
    function transaction(work) {
        requireOpen();
        db.exec('BEGIN IMMEDIATE');
        let result;
        try {
            result = work();
            faultInjector('before_commit');
            db.exec('COMMIT');
        } catch (cause) {
            try { db.exec('ROLLBACK'); } catch { /* A failed commit may have ended the transaction. */ }
            if (cause instanceof ComparisonStoreError) throw cause;
            throw new ComparisonStoreError('transaction_failed', { cause });
        }
        try { faultInjector('after_commit'); }
        catch (cause) { throw new ComparisonStoreError('response_lost_after_commit', { cause }); }
        return result;
    }
    function writeSnapshot(value) {
        if (!validateLocalIdentitySnapshot(value)) throw new ComparisonStoreError('invalid_transition');
        const serialized = JSON.stringify(value);
        const next = projection(value);
        db.prepare('UPDATE identity_snapshot SET revision = ?, digest = ?, body = ? WHERE slot = 1')
            .run(value.revision, next.digest, serialized);
        return next;
    }

    const api = {
        backend: 'sqlite-node-experimental',
        async initialize({ installationId: requested } = {}) {
            const timestamp = clock();
            const value = initialSnapshot(requested, timestamp);
            return transaction(() => {
                const existing = db.prepare('SELECT body FROM identity_snapshot WHERE slot = 1').get();
                if (existing) {
                    const current = readRow();
                    if (current.snapshot.installationId !== requested) throw new ComparisonStoreError('already_initialized');
                    return current;
                }
                const created = projection(value);
                db.prepare('INSERT INTO identity_snapshot(slot, revision, digest, body) VALUES(1, ?, ?, ?)')
                    .run(value.revision, created.digest, JSON.stringify(value));
                return created;
            });
        },
        async readSnapshot() { return readRow(); },
        async lockStore(expected) {
            return transaction(() => {
                const current = readRow();
                if (!expected || expected.revision !== current.revision || expected.digest !== current.digest)
                    throw new ComparisonStoreError('revision_conflict');
                if (current.snapshot.bootstrapState === 'locked') throw new ComparisonStoreError('invalid_transition');
                const value = structuredClone(current.snapshot);
                value.bootstrapState = 'locked';
                value.pendingBootstrap = null;
                value.revision += 1;
                value.revocationEpoch += 1;
                value.updatedAt = clock();
                return writeSnapshot(value);
            });
        },
        evaluateExecutionRequest() { return Object.freeze({ decision: 'DENY', authorization: 'DENY', executable: false,
            persistencePerformed: false, reason: 'synthetic_comparison_store_is_not_an_authorization_provider' }); },
        close() { if (!closed) { db.close(); closed = true; } },
    };
    return Object.freeze(api);
}

export async function openComparisonStore(options) {
    if (options?.backend === 'json') return openJsonComparisonStore(options);
    if (options?.backend === 'sqlite') return openSqliteComparisonStore(options);
    throw new ComparisonStoreError('backend_invalid');
}

export async function sqliteIntegrityCheck(storePath) {
    await assertFixturePath(storePath);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(storePath, { readOnly: true });
    try { return db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown'; }
    finally { db.close(); }
}

export const comparisonInitialSnapshot = initialSnapshot;
