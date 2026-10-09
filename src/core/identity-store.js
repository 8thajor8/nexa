import nativeFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const STATES = Object.freeze(['uninitialized', 'pending', 'active', 'recovery_required', 'locked']);
const ID = /^test_[a-z0-9._-]{1,80}$/u;
const HASH = /^[a-f0-9]{64}$/u;
// Node reports an inconsistent `dev` value for Windows handle.stat() versus
// path-based lstat(); the NTFS file index is stable across both calls.
const FILE_ID = info => info && info.ino !== undefined && String(info.ino) !== '0'
    ? String(info.ino) : null;

const MESSAGES = Object.freeze({
    identity_store_invalid: 'The local identity store is invalid.',
    identity_store_corrupt: 'The local identity store is corrupt.',
    identity_store_locked: 'The local identity store is locked by another process.',
    identity_store_lock_lost: 'Ownership of the local identity store lock was lost.',
    identity_store_revision_conflict: 'The local identity store changed; refresh before retrying.',
    identity_store_bootstrap_state_invalid: 'The requested bootstrap transition is not allowed.',
    identity_store_bootstrap_expired: 'The bootstrap ceremony has expired.',
    identity_store_bootstrap_replayed: 'The bootstrap ceremony was already consumed.',
    identity_store_persist_failed: 'The identity store change was not published.',
    identity_store_commit_uncertain: 'The identity store commit outcome could not be verified.',
    identity_store_already_initialized: 'The identity store already exists with a different installation.',
    identity_store_closed: 'The local identity store is closed.',
});

export class IdentityStoreError extends Error {
    constructor(code, { cause } = {}) {
        super(MESSAGES[code] ?? MESSAGES.identity_store_invalid, cause === undefined ? undefined : { cause });
        this.name = 'IdentityStoreError';
        this.code = Object.hasOwn(MESSAGES, code) ? code : 'identity_store_invalid';
        this.retryable = false;
    }
}

/** Stable operation label used only to bind synthetic bootstrap test evidence. */
export function ownerBootstrapOperationFingerprint(installationId, principalId) {
    if (typeof installationId !== 'string' || !ID.test(installationId)
        || typeof principalId !== 'string' || !ID.test(principalId))
        throw new IdentityStoreError('identity_store_invalid');
    return digest(Buffer.from(JSON.stringify({ purpose: 'owner_bootstrap', installationId, principalId }), 'utf8'));
}

function exactRecord(value, keys) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
        const own = Reflect.ownKeys(value);
        return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
            && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
    } catch { return false; }
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function cloneFreeze(value) {
    const copy = structuredClone(value);
    const freeze = item => {
        if (item && typeof item === 'object' && !Object.isFrozen(item)) {
            Object.values(item).forEach(freeze);
            Object.freeze(item);
        }
        return item;
    };
    return freeze(copy);
}

function validDate(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
    try { return new Date(value).toISOString() === value; } catch { return false; }
}

/**
 * Strict schema for the isolated M.1d.1 store. All identifiers and credentials
 * are test-domain values; this format can never represent production auth.
 */
export function validateLocalIdentitySnapshot(value) {
    if (!exactRecord(value, ['schemaVersion', 'trustDomain', 'installationId', 'bootstrapState', 'ownerPrincipalId',
        'ownerCredentialRefs', 'credentials', 'pendingBootstrap', 'revision', 'revocationEpoch', 'recovery', 'updatedAt'])
        || value.schemaVersion !== 1 || value.trustDomain !== 'test.synthetic'
        || typeof value.installationId !== 'string' || !ID.test(value.installationId)
        || !STATES.includes(value.bootstrapState)
        || !(value.ownerPrincipalId === null || (typeof value.ownerPrincipalId === 'string' && ID.test(value.ownerPrincipalId)))
        || !Array.isArray(value.ownerCredentialRefs) || !Array.isArray(value.credentials)
        || !(value.pendingBootstrap === null || exactRecord(value.pendingBootstrap,
            ['ceremonyId', 'principalId', 'challengeFingerprint', 'operationFingerprint', 'createdAt', 'expiresAt']))
        || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Number.isSafeInteger(value.revocationEpoch) || value.revocationEpoch < 0
        || !exactRecord(value.recovery, ['secondAuthenticatorRequired', 'secondAuthenticatorCredentialRef',
            'offlineRecoveryKeyRequired', 'offlineRecoveryKeyStatus'])
        || value.recovery.secondAuthenticatorRequired !== true || value.recovery.offlineRecoveryKeyRequired !== true
        || !(value.recovery.secondAuthenticatorCredentialRef === null
            || (typeof value.recovery.secondAuthenticatorCredentialRef === 'string' && ID.test(value.recovery.secondAuthenticatorCredentialRef)))
        || value.recovery.offlineRecoveryKeyStatus !== 'not_generated'
        || !validDate(value.updatedAt)) return false;

    const credentialIds = new Set();
    for (const credential of value.credentials) {
        if (!exactRecord(credential, ['credentialRef', 'principalId', 'installationId', 'publicKeyFingerprint', 'status', 'evidenceKind'])
            || typeof credential.credentialRef !== 'string' || !ID.test(credential.credentialRef)
            || typeof credential.principalId !== 'string' || !ID.test(credential.principalId)
            || credential.installationId !== value.installationId || !HASH.test(credential.publicKeyFingerprint)
            || credential.status !== 'active' || credential.evidenceKind !== 'test.synthetic_webauthn') return false;
        if (credentialIds.has(credential.credentialRef)) return false;
        credentialIds.add(credential.credentialRef);
    }
    if (new Set(value.ownerCredentialRefs).size !== value.ownerCredentialRefs.length
        || value.ownerCredentialRefs.some(id => typeof id !== 'string' || !credentialIds.has(id))) return false;

    if (value.pendingBootstrap !== null) {
        const pending = value.pendingBootstrap;
        if (typeof pending.ceremonyId !== 'string' || !ID.test(pending.ceremonyId)
            || typeof pending.principalId !== 'string' || !ID.test(pending.principalId)
            || !HASH.test(pending.challengeFingerprint) || !HASH.test(pending.operationFingerprint)
            || !validDate(pending.createdAt) || !validDate(pending.expiresAt)
            || Date.parse(pending.expiresAt) <= Date.parse(pending.createdAt)
            || pending.operationFingerprint !== ownerBootstrapOperationFingerprint(value.installationId, pending.principalId)) return false;
    }

    if (value.bootstrapState === 'uninitialized') {
        return value.ownerPrincipalId === null && value.ownerCredentialRefs.length === 0
            && value.credentials.length === 0 && value.pendingBootstrap === null && value.revision === 0
            && value.recovery.secondAuthenticatorCredentialRef === null
            && value.recovery.offlineRecoveryKeyStatus === 'not_generated';
    }
    if (value.bootstrapState === 'pending') {
        return value.ownerPrincipalId === null && value.ownerCredentialRefs.length === 0
            && value.credentials.length === 0 && value.pendingBootstrap !== null
            && value.recovery.secondAuthenticatorCredentialRef === null;
    }
    if (value.bootstrapState === 'active') {
        return value.ownerPrincipalId !== null && value.pendingBootstrap === null
            && value.ownerCredentialRefs.length === 2 && value.credentials.length === 2
            && value.credentials.every(item => item.principalId === value.ownerPrincipalId)
            && new Set(value.credentials.map(item => item.publicKeyFingerprint)).size === 2
            && value.recovery.secondAuthenticatorCredentialRef === value.ownerCredentialRefs[1]
            && value.recovery.offlineRecoveryKeyStatus === 'not_generated';
    }
    if (value.bootstrapState === 'recovery_required') {
        return value.ownerPrincipalId === null && value.ownerCredentialRefs.length === 0
            && value.credentials.length === 0 && value.pendingBootstrap === null
            && value.recovery.secondAuthenticatorCredentialRef === null;
    }
    return value.bootstrapState === 'locked' && value.pendingBootstrap === null
        && value.ownerCredentialRefs.length === (value.ownerPrincipalId === null ? 0 : 2)
        && value.credentials.length === value.ownerCredentialRefs.length
        && value.credentials.every(item => item.principalId === value.ownerPrincipalId)
        && new Set(value.credentials.map(item => item.publicKeyFingerprint)).size === value.credentials.length
        && value.recovery.secondAuthenticatorCredentialRef === (value.ownerPrincipalId === null
            ? null : value.ownerCredentialRefs[1]);
}

function makeSnapshot(value, bytes) {
    if (!validateLocalIdentitySnapshot(value)) throw new IdentityStoreError('identity_store_corrupt');
    return Object.freeze({ snapshot: cloneFreeze(value), revision: value.revision, digest: digest(bytes),
        executable: false, authorization: 'DENY' });
}

/**
 * Local, storage-only identity snapshot store. It requires an explicit absolute
 * path and never initializes on import. Mutations are narrowly defined
 * synthetic bootstrap transitions; they do not authenticate or authorize.
 * Cooperative writers are serialized by an exclusive lock and publish one JSON
 * snapshot by same-directory rename. Power-loss durability is filesystem-bound.
 */
export function createSyntheticLocalIdentityStore({ storePath, fileSystem = {}, clock = () => new Date().toISOString() } = {}) {
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath) || typeof clock !== 'function')
        throw new IdentityStoreError('identity_store_invalid');
    const fs = { ...nativeFs, ...fileSystem };
    let destination;
    let lockPath;
    let closed = false;
    let queue = Promise.resolve();

    const serialize = work => {
        const result = queue.then(work);
        queue = result.catch(() => {});
        return result;
    };
    const requireOpen = () => { if (closed || !destination) throw new IdentityStoreError('identity_store_closed'); };

    async function resolvePaths() {
        try {
            const requestedParent = path.resolve(path.dirname(storePath));
            const parentInfo = await fs.lstat(requestedParent);
            const parent = await fs.realpath(requestedParent);
            // Do not silently redirect an explicitly supplied store path through
            // a symlink/junction. ACLs and hostile writers still require a
            // separately trusted directory; this check only closes redirection.
            if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
                || path.relative(requestedParent, parent) !== '')
                throw new Error('untrusted_store_directory');
            destination = path.join(parent, path.basename(storePath));
            lockPath = destination + '.lock';
        } catch (cause) { throw new IdentityStoreError('identity_store_persist_failed', { cause }); }
    }

    async function readDisk() {
        let bytes;
        try {
            const info = await fs.lstat(destination);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('not_regular_file');
            bytes = await fs.readFile(destination);
        } catch (cause) {
            if (cause?.code === 'ENOENT') return null;
            throw new IdentityStoreError('identity_store_corrupt', { cause });
        }
        let value;
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch (cause) { throw new IdentityStoreError('identity_store_corrupt', { cause }); }
        if (!validateLocalIdentitySnapshot(value)) throw new IdentityStoreError('identity_store_corrupt');
        return { value, bytes, snapshot: makeSnapshot(value, bytes) };
    }

    async function acquireLock() {
        const token = randomUUID();
        let handle;
        try {
            handle = await fs.open(lockPath, 'wx', 0o600);
            const identity = FILE_ID(await handle.stat());
            await handle.writeFile(JSON.stringify({ pid: process.pid, token }) + '\n', 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            return { token, identity };
        } catch (cause) {
            if (handle) await handle.close().catch(() => {});
            if (cause?.code === 'EEXIST') throw new IdentityStoreError('identity_store_locked', { cause });
            throw new IdentityStoreError('identity_store_persist_failed', { cause });
        }
    }

    async function verifyLock(lock) {
        try {
            const info = await fs.lstat(lockPath);
            if (!info.isFile() || info.isSymbolicLink() || FILE_ID(info) !== lock.identity) throw new Error('lock_identity_mismatch');
            const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (current.pid !== process.pid || current.token !== lock.token) throw new Error('lock_token_mismatch');
        } catch (cause) { throw new IdentityStoreError('identity_store_lock_lost', { cause }); }
    }

    async function releaseLock(lock) {
        await verifyLock(lock);
        await fs.unlink(lockPath);
    }

    async function withLock(work) {
        const lock = await acquireLock();
        let result;
        let primaryError;
        try {
            result = await work(lock);
        } catch (error) { primaryError = error; }
        try { await releaseLock(lock); }
        catch (cleanupError) {
            if (primaryError) {
                primaryError.lockCleanupError = cleanupError.code ?? 'identity_store_lock_cleanup_failed';
                throw primaryError;
            }
            throw cleanupError;
        }
        if (primaryError) throw primaryError;
        return result;
    }

    async function writeAtomic(original, next, lock) {
        const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8');
        const expectedDigest = digest(bytes);
        const temporaryPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
        let handle;
        let temporaryIdentity;
        let renameAttempted = false;
        let operationError;
        let result;
        try {
            handle = await fs.open(temporaryPath, 'wx', 0o600);
            temporaryIdentity = FILE_ID(await handle.stat());
            if (!temporaryIdentity) throw new IdentityStoreError('identity_store_persist_failed');
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await verifyTemporary();
            const stagedBytes = await fs.readFile(temporaryPath);
            if (digest(stagedBytes) !== expectedDigest || !validateLocalIdentitySnapshot(JSON.parse(stagedBytes.toString('utf8'))))
                throw new IdentityStoreError('identity_store_persist_failed');
            await verifyLock(lock);
            const current = await readDisk();
            if (!current || current.snapshot.revision !== original.snapshot.revision || current.snapshot.digest !== original.snapshot.digest)
                throw new IdentityStoreError('identity_store_revision_conflict');
            await verifyTemporary();
            renameAttempted = true;
            await fs.rename(temporaryPath, destination);
            const committed = await readDisk();
            if (!committed || committed.snapshot.digest !== expectedDigest) throw new IdentityStoreError('identity_store_commit_uncertain');
            result = committed.snapshot;
        } catch (cause) {
            operationError = cause instanceof IdentityStoreError ? cause
                : new IdentityStoreError('identity_store_persist_failed', { cause });
            if (renameAttempted) {
                try {
                    const observed = await readDisk();
                    if (observed?.snapshot.digest === expectedDigest) {
                        result = observed.snapshot;
                        operationError = null;
                    } else if (!observed || observed.snapshot.digest !== original.snapshot.digest) {
                        operationError = new IdentityStoreError('identity_store_commit_uncertain', { cause });
                    }
                } catch (readError) {
                    operationError = readError.code === 'identity_store_commit_uncertain' ? readError
                        : new IdentityStoreError('identity_store_commit_uncertain', { cause: readError });
                }
            }
        } finally {
            if (handle) await handle.close().catch(() => {});
            if (temporaryIdentity) {
                try {
                    const current = await fs.lstat(temporaryPath);
                    if (current.isFile() && !current.isSymbolicLink() && FILE_ID(current) === temporaryIdentity)
                        await fs.unlink(temporaryPath);
                    else throw new Error('temporary_identity_changed');
                } catch (error) {
                    if (error?.code !== 'ENOENT') {
                        operationError ??= new IdentityStoreError('identity_store_persist_failed', { cause: error });
                        operationError.cleanupCode = error?.code ?? 'temporary_cleanup_failed';
                        operationError.temporaryResidue = true;
                        operationError.residuePath = temporaryPath;
                    }
                }
            }
        }
        if (operationError) throw operationError;
        return result;

        async function verifyTemporary() {
            const info = await fs.lstat(temporaryPath);
            if (!info.isFile() || info.isSymbolicLink() || FILE_ID(info) !== temporaryIdentity)
                throw new IdentityStoreError('identity_store_persist_failed');
        }
    }

    async function initialize({ installationId } = {}) {
        return serialize(async () => {
            if (closed) throw new IdentityStoreError('identity_store_closed');
            if (!destination) await resolvePaths();
            if (typeof installationId !== 'string' || !ID.test(installationId)) throw new IdentityStoreError('identity_store_invalid');
            return withLock(async () => {
                const current = await readDisk();
                if (current) {
                    if (current.value.installationId !== installationId)
                        throw new IdentityStoreError('identity_store_already_initialized');
                    return current.snapshot;
                }
                const timestamp = clock();
                if (!validDate(timestamp)) throw new IdentityStoreError('identity_store_invalid');
                const initial = { schemaVersion: 1, trustDomain: 'test.synthetic', installationId,
                    bootstrapState: 'uninitialized', ownerPrincipalId: null,
                    ownerCredentialRefs: [], credentials: [], pendingBootstrap: null, revision: 0, revocationEpoch: 0,
                    recovery: { secondAuthenticatorRequired: true, secondAuthenticatorCredentialRef: null,
                        offlineRecoveryKeyRequired: true, offlineRecoveryKeyStatus: 'not_generated' }, updatedAt: timestamp };
                if (!validateLocalIdentitySnapshot(initial)) throw new IdentityStoreError('identity_store_invalid');
                const bytes = Buffer.from(JSON.stringify(initial, null, 2) + '\n', 'utf8');
                const temporaryPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
                let handle;
                let identity;
                try {
                    handle = await fs.open(temporaryPath, 'wx', 0o600);
                    identity = FILE_ID(await handle.stat());
                    if (!identity) throw new IdentityStoreError('identity_store_persist_failed');
                    await handle.writeFile(bytes);
                    await handle.sync();
                    await handle.close();
                    handle = undefined;
                    await fs.link(temporaryPath, destination); // Atomic create-if-absent; never replaces an existing store.
                    return makeSnapshot(initial, bytes);
                } catch (cause) {
                    if (cause?.code === 'EEXIST') throw new IdentityStoreError('identity_store_already_initialized', { cause });
                    throw new IdentityStoreError('identity_store_persist_failed', { cause });
                } finally {
                    if (handle) await handle.close().catch(() => {});
                    if (identity) {
                        try {
                            const current = await fs.lstat(temporaryPath);
                            if (current.isFile() && !current.isSymbolicLink() && FILE_ID(current) === identity)
                                await fs.unlink(temporaryPath);
                            else throw new Error('temporary_identity_changed');
                        } catch (error) {
                            if (error?.code !== 'ENOENT') {
                                const failure = new IdentityStoreError('identity_store_persist_failed', { cause: error });
                                failure.temporaryResidue = true;
                                failure.residuePath = temporaryPath;
                                throw failure;
                            }
                        }
                    }
                }
            });
        });
    }

    async function readSnapshot() {
        return serialize(async () => {
            requireOpen();
            const current = await readDisk();
            if (!current) throw new IdentityStoreError('identity_store_corrupt');
            return current.snapshot;
        });
    }

    async function transact(expected, mutate) {
        requireOpen();
        if (!exactRecord(expected, ['revision', 'digest']) || !Number.isSafeInteger(expected.revision)
            || expected.revision < 0 || !HASH.test(expected.digest)) throw new IdentityStoreError('identity_store_invalid');
        return withLock(async lock => {
            await verifyLock(lock);
            const original = await readDisk();
            if (!original) throw new IdentityStoreError('identity_store_corrupt');
            if (original.snapshot.revision !== expected.revision || original.snapshot.digest !== expected.digest)
                throw new IdentityStoreError('identity_store_revision_conflict');
            const next = mutate(structuredClone(original.value));
            if (!validateLocalIdentitySnapshot(next)) throw new IdentityStoreError('identity_store_bootstrap_state_invalid');
            if (next.installationId !== original.value.installationId || next.revision !== original.value.revision + 1
                || next.revocationEpoch < original.value.revocationEpoch)
                throw new IdentityStoreError('identity_store_bootstrap_state_invalid');
            return writeAtomic(original, next, lock);
        });
    }

    async function beginBootstrap(input) {
        const keys = ['expected', 'principalId', 'ceremonyId', 'challenge', 'expiresAt'];
        if (!exactRecord(input, keys) || typeof input.principalId !== 'string' || !ID.test(input.principalId)
            || typeof input.ceremonyId !== 'string' || !ID.test(input.ceremonyId)
            || typeof input.challenge !== 'string' || input.challenge.length < 16 || input.challenge.length > 512
            || !validDate(input.expiresAt)) throw new IdentityStoreError('identity_store_invalid');
        return serialize(() => transact(input.expected, current => {
            if (!['uninitialized', 'recovery_required'].includes(current.bootstrapState))
                throw new IdentityStoreError(current.bootstrapState === 'active' ? 'identity_store_bootstrap_replayed'
                    : 'identity_store_bootstrap_state_invalid');
            const timestamp = clock();
            if (!validDate(timestamp) || Date.parse(input.expiresAt) <= Date.parse(timestamp))
                throw new IdentityStoreError('identity_store_bootstrap_expired');
            const challengeFingerprint = digest(Buffer.from(input.challenge, 'utf8'));
            const operationFingerprint = ownerBootstrapOperationFingerprint(current.installationId, input.principalId);
            current.bootstrapState = 'pending';
            current.pendingBootstrap = { ceremonyId: input.ceremonyId, principalId: input.principalId,
                challengeFingerprint, operationFingerprint, createdAt: timestamp, expiresAt: input.expiresAt };
            current.revision += 1;
            current.updatedAt = timestamp;
            return current;
        }));
    }

    async function completeSyntheticBootstrap(input) {
        const keys = ['expected', 'ceremonyId', 'evidence', 'primaryCredential', 'secondaryCredential'];
        if (!exactRecord(input, keys) || typeof input.ceremonyId !== 'string') throw new IdentityStoreError('identity_store_invalid');
        const exactEvidenceKeys = ['kind', 'installationId', 'principalId', 'ceremonyId', 'purpose', 'operationFingerprint',
            'challengeFingerprint', 'binding'];
        const validEvidence = exactRecord(input.evidence, exactEvidenceKeys)
            && input.evidence.kind === 'test.synthetic_webauthn_assertion'
            && input.evidence.purpose === 'owner_bootstrap' && input.evidence.binding === 'hypothetical_synthetic';
        const validCredential = value => exactRecord(value, ['credentialRef', 'publicKeyFingerprint', 'evidenceKind'])
            && typeof value.credentialRef === 'string' && ID.test(value.credentialRef)
            && HASH.test(value.publicKeyFingerprint) && value.evidenceKind === 'test.synthetic_webauthn';
        if (!validEvidence || !validCredential(input.primaryCredential) || !validCredential(input.secondaryCredential)
            || input.primaryCredential.credentialRef === input.secondaryCredential.credentialRef)
            throw new IdentityStoreError('identity_store_bootstrap_state_invalid');
        return serialize(() => transact(input.expected, current => {
            const pending = current.pendingBootstrap;
            const timestamp = clock();
            if (current.bootstrapState !== 'pending' || !pending || pending.ceremonyId !== input.ceremonyId)
                throw new IdentityStoreError(current.bootstrapState === 'active' ? 'identity_store_bootstrap_replayed'
                    : 'identity_store_bootstrap_state_invalid');
            if (Date.parse(pending.expiresAt) <= Date.parse(timestamp))
                throw new IdentityStoreError('identity_store_bootstrap_expired');
            const evidence = input.evidence;
            if (evidence.installationId !== current.installationId || evidence.principalId !== pending.principalId
                || evidence.ceremonyId !== pending.ceremonyId || evidence.operationFingerprint !== pending.operationFingerprint
                || evidence.challengeFingerprint !== pending.challengeFingerprint)
                throw new IdentityStoreError('identity_store_bootstrap_state_invalid');
            const credentials = [input.primaryCredential, input.secondaryCredential].map(item => ({
                credentialRef: item.credentialRef, principalId: pending.principalId,
                installationId: current.installationId, publicKeyFingerprint: item.publicKeyFingerprint,
                status: 'active', evidenceKind: 'test.synthetic_webauthn',
            }));
            current.bootstrapState = 'active';
            current.ownerPrincipalId = pending.principalId;
            current.ownerCredentialRefs = credentials.map(item => item.credentialRef);
            current.credentials = credentials;
            current.pendingBootstrap = null;
            current.recovery.secondAuthenticatorCredentialRef = credentials[1].credentialRef;
            // A placeholder is not an offline key and grants no recovery capability.
            current.recovery.offlineRecoveryKeyStatus = 'not_generated';
            current.revision += 1;
            current.updatedAt = timestamp;
            return current;
        }));
    }

    async function markPendingRecoveryRequired(expected) {
        return serialize(() => transact(expected, current => {
            if (current.bootstrapState !== 'pending' || !current.pendingBootstrap
                || Date.parse(current.pendingBootstrap.expiresAt) > Date.parse(clock()))
                throw new IdentityStoreError('identity_store_bootstrap_state_invalid');
            current.bootstrapState = 'recovery_required';
            current.pendingBootstrap = null;
            current.revision += 1;
            current.updatedAt = clock();
            return current;
        }));
    }

    async function lockStore(expected) {
        return serialize(() => transact(expected, current => {
            if (current.bootstrapState === 'locked') throw new IdentityStoreError('identity_store_bootstrap_state_invalid');
            current.bootstrapState = 'locked';
            current.pendingBootstrap = null;
            current.revision += 1;
            current.revocationEpoch += 1;
            current.updatedAt = clock();
            return current;
        }));
    }

    function evaluateExecutionRequest() {
        return Object.freeze({ decision: 'DENY', executable: false, authorization: 'DENY',
            persistencePerformed: false, reason: 'identity_store_is_not_an_authorization_provider' });
    }

    async function close() {
        await serialize(async () => { closed = true; });
    }

    return Object.freeze({ initialize, readSnapshot, beginBootstrap, completeSyntheticBootstrap,
        markPendingRecoveryRequired, lockStore, evaluateExecutionRequest, close });
}
