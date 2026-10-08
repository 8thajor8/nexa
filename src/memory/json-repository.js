import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MemorySchemaError, validateMemoryStore } from './schema.js';
import { MemoryRepositoryError, applyChanges, contentDigest, immutableSnapshot, prepareCommitRequest } from './repository.js';
import { createAutomaticMemoryPersistenceContract } from './automatic/persistence-contract.js';
import { normalizeAutomaticMemoryProposal } from './automatic/schema.js';
import { consumeAutomaticMemoryAuthorization, inspectAutomaticMemoryAuthorization } from './automatic/authorization-coordinator.js';
import { trustedSpeakerIdentityBindingIsCurrent, trustedSpeakerIdentityDetails } from '../core/trusted-speaker-identity.js';
import { screenMemorySecret } from './secret-screening.js';

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
    const automaticFailure = code => ({ success: false, outcome: 'rejected', error: { code } });
    function stableJson(value) {
        if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
        if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
            .map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
        return JSON.stringify(value);
    }
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    function consumeInvalidAttempt(input) {
        try {
            consumeAutomaticMemoryAuthorization(input?.capability, { recipient: input?.recipient,
                operation: null, operationFingerprint: '', snapshotRevision: -1,
                snapshotDigest: '', targetAssertionId: null });
        } catch { /* The coordinator consumes before validating the binding. */ }
    }
    async function persistCandidate(original, candidate) {
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
            if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => {});
        }
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
    function readAutomaticMemorySnapshot() {
        return serialized(async () => {
            requireOpen();
            await verifyOwnership();
            const current = await readDisk();
            assertUnchanged(current);
            // B.2a fingerprints canonical JSON semantics; the repository's
            // `digest` remains the byte-level CAS token used for persistence.
            return immutableSnapshot(current.store, sha256(JSON.stringify(current.store)));
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
            // Recheck after staging inside persistCandidate; never overwrite an observed edit.
            return persistCandidate(original, candidate);
        });
    }
    function commitAutomaticOperation(input) {
        const required = ['text', 'proposal', 'snapshot', 'operationIndex', 'recipient', 'capability'];
        const validShape = input && typeof input === 'object' && !Array.isArray(input)
            && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
            && Reflect.ownKeys(input).length === required.length
            && Reflect.ownKeys(input).every(key => typeof key === 'string' && required.includes(key)
                && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value')
                && Object.getOwnPropertyDescriptor(input, key).enumerable);
        if (!validShape || typeof input.text !== 'string' || !input.text.isWellFormed()
            || !Number.isSafeInteger(input.operationIndex) || input.operationIndex < 0
            || !input.recipient || typeof input.recipient !== 'object'
            || !input.snapshot || typeof input.snapshot !== 'object') {
            consumeInvalidAttempt(input);
            return Promise.resolve(automaticFailure('automatic_input_shape_invalid'));
        }
        const authorizationContext = inspectAutomaticMemoryAuthorization(input.capability);
        if (!authorizationContext) {
            consumeInvalidAttempt(input);
            return Promise.resolve(automaticFailure('automatic_authorization_rejected'));
        }
        let contract;
        let normalized;
        try {
            contract = createAutomaticMemoryPersistenceContract({ text: input.text,
                proposal: input.proposal, snapshot: input.snapshot,
                trustedSpeakerContext: authorizationContext.trustedSpeakerContext });
            normalized = normalizeAutomaticMemoryProposal(input.proposal);
        } catch (error) {
            consumeInvalidAttempt(input);
            return Promise.resolve(automaticFailure(typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/u.test(error.code)
                ? error.code : 'automatic_contract_exception'));
        }
        if (!contract.success || !normalized.success) {
            consumeInvalidAttempt(input);
            return Promise.resolve(automaticFailure(contract.error?.code ?? normalized.error?.code ?? 'automatic_operation_invalid'));
        }
        const operation = contract.operations[input.operationIndex];
        const candidate = operation && normalized.proposal.candidates[operation.candidateIndex];
        if (!operation || !candidate || !['ADD', 'REPLACE'].includes(operation.operation)
            || input.snapshot.snapshot?.schema_version !== 5 || !contract.snapshotBinding
            || operation.executable !== false || operation.writeReady !== false
            || operation.authorization?.granted !== false
            || (operation.operation === 'ADD' && operation.targetAssertionId !== null)
            || (operation.operation === 'REPLACE' && typeof operation.targetAssertionId !== 'string')) {
            consumeInvalidAttempt(input);
            return Promise.resolve(automaticFailure('automatic_operation_not_eligible'));
        }
        const snapshotBinding = { revision: contract.snapshotBinding.revision,
            digest: contract.snapshotBinding.digest, snapshotSha256: contract.snapshotBinding.snapshotSha256 };
        const operationFingerprint = sha256(stableJson({ version: 'automatic-memory-b2b7-coordinator-v1',
            operation: operation.operation, candidate, idempotencyKey: operation.idempotency.key,
            sourceBinding: operation.sourceBinding, snapshotBinding,
            targetAssertionId: operation.targetAssertionId ?? null }));
        if (operationFingerprint !== authorizationContext.operationFingerprint) {
            consumeInvalidAttempt(input);
            return Promise.resolve(automaticFailure('automatic_authorization_rejected'));
        }
        const operationKey = operation.idempotency.key;
        return serialized(async () => {
            requireOpen();
            await verifyOwnership();
            const original = await readDisk();
            assertUnchanged(original);
            if (original.store.schema_version !== 5) {
                consumeInvalidAttempt(input);
                return automaticFailure('memory_schema_unsupported');
            }
            const byKey = original.store.automatic_operations.find(item => item.operation_key === operationKey);
            const byFingerprint = original.store.automatic_operations.find(item => item.operation_fingerprint_sha256 === operationFingerprint);
            if (byKey || byFingerprint) {
                if (byKey?.status === 'applied' && byKey.operation_fingerprint_sha256 === operationFingerprint
                    && byKey.operation_kind === operation.operation && byKey === byFingerprint) {
                    return { success: true, outcome: 'already_applied', revision: original.store.revision };
                }
                consumeInvalidAttempt(input);
                return automaticFailure('automatic_idempotency_conflict');
            }

            // The coordinator burns the proof before validating these bindings.
            const authorized = consumeAutomaticMemoryAuthorization(input.capability, { recipient: input.recipient,
                operation: operation.operation, operationFingerprint,
                snapshotRevision: snapshotBinding.revision, snapshotDigest: snapshotBinding.digest,
                targetAssertionId: operation.targetAssertionId ?? null });
            if (!authorized.success) return automaticFailure(authorized.error?.code ?? 'automatic_authorization_rejected');

            const speakerIdentity = trustedSpeakerIdentityDetails(authorized.trustedSpeakerContext);
            const identityBindingSha256 = speakerIdentity && sha256(stableJson({ principalId: speakerIdentity.principalId,
                sessionId: speakerIdentity.sessionId, sourceTurnId: speakerIdentity.turnId,
                sourceTextSha256: speakerIdentity.sourceTextSha256, selfPersonId: speakerIdentity.selfPersonId }));
            if (!speakerIdentity || speakerIdentity.selfBindingStatus !== 'linked'
                || speakerIdentity.selfPersonId !== original.store.self_person_id
                || speakerIdentity.sourceTextSha256 !== sha256(input.text)
                || identityBindingSha256 !== authorized.identityBindingSha256
                || !await trustedSpeakerIdentityBindingIsCurrent(authorized.trustedSpeakerContext))
                return automaticFailure('automatic_speaker_identity_mismatch');

            const semanticSnapshotDigest = sha256(JSON.stringify(original.store));
            if (snapshotBinding.revision !== original.store.revision || snapshotBinding.digest !== semanticSnapshotDigest
                || snapshotBinding.snapshotSha256 !== semanticSnapshotDigest) {
                return automaticFailure('memory_revision_conflict');
            }
            if (!screenMemorySecret(input.text).safe || !screenMemorySecret(JSON.stringify(candidate)).safe)
                return automaticFailure('automatic_secret_blocked');

            const timestamp = now();
            const assertionId = `mem_${randomUUID()}`;
            const sourceId = `src_${randomUUID()}`;
            const evidenceId = `ev_${randomUUID()}`;
            const targetId = operation.targetAssertionId ?? null;
            const target = targetId && original.store.assertions.find(record => record.id === targetId);
            if (operation.operation === 'REPLACE' && (!target || target.status !== 'active'
                || target.subject.type !== 'entity' || target.subject.id !== original.store.self_person_id
                || target.predicate !== candidate.predicate || target.object?.type !== 'text')) {
                return automaticFailure('automatic_target_conflict');
            }
            const assertion = { id: assertionId, kind: candidate.candidate_type === 'preference' ? 'preference' : 'fact',
                subject: { type: 'entity', entity_type: 'person', id: original.store.self_person_id },
                predicate: candidate.predicate, object: { type: 'text', value: candidate.value_text },
                status: 'active', valid_from: null, valid_to: null, recorded_at: timestamp,
                supersedes: targetId ? [targetId] : [], compatibility: null };
            const source = { id: sourceId, kind: 'inference', origin_trust: 'derived_untrusted', authority: 'data_only',
                locator: null, occurred_at: null, recorded_at: timestamp };
            const evidence = { id: evidenceId, assertion_id: assertionId, source_id: sourceId,
                derivation: 'inferred', extraction_confidence: candidate.linguistic_confidence,
                learned_at: timestamp, last_confirmed_at: null, legacy_ref: null };
            const receipt = { operation_key: operationKey, operation_fingerprint_sha256: operationFingerprint,
                operation_kind: operation.operation, status: 'applied', authorization_request_id: `req_${authorized.requestId}`,
                expected_revision: original.store.revision, expected_digest: original.digest,
                result_revision: original.store.revision + 1, result_assertion_id: assertionId,
                target_assertion_id: targetId, result_code: null, recorded_at: timestamp };
            const changes = [
                ...(target ? [{ type: 'put', collection: 'assertions', record: { ...target, status: 'superseded' } }] : []),
                { type: 'put', collection: 'assertions', record: assertion },
                { type: 'put', collection: 'sources', record: source },
                { type: 'put', collection: 'evidence', record: evidence },
                { type: 'put', collection: 'automatic_operations', record: receipt },
            ];
            let candidateStore;
            try { candidateStore = applyChanges(original.store, changes, timestamp); }
            catch { return automaticFailure('automatic_operation_invalid'); }
            const committed = await persistCandidate(original, candidateStore);
            return { success: true, outcome: 'applied', revision: committed.revision,
                assertionId, operationKey };
        });
    }
    function close() {
        return serialized(async () => {
            if (state === 'closed') return;
            try { await releaseOwnership(); }
            finally { state = 'closed'; published = undefined; }
        });
    }
    return Object.freeze({ open, readSnapshot, readAutomaticMemorySnapshot, commit,
        commitAutomaticOperation, close });
}
