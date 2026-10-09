import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyntheticLocalIdentityStore, validateLocalIdentitySnapshot } from '../src/core/identity-store.js';
import { createSyntheticOwnerBootstrap } from './support/owner-bootstrap-harness.js';

const WORKER = fileURLToPath(new URL('../test-support/identity-store-worker.js', import.meta.url));
let fixedNow = Date.parse('2030-06-01T12:00:00.000Z');

async function fixture(t, options = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-'));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let now = fixedNow;
    const storePath = path.join(directory, 'identity.json');
    const store = createSyntheticLocalIdentityStore({ storePath, clock: () => new Date(now).toISOString(), ...options });
    const initial = await store.initialize({ installationId: 'test_installation_m1d1' });
    t.after(() => store.close());
    return { directory, storePath, store, initial, setNow(value) { now = value; }, getNow() { return now; } };
}

function child(storePath, mode, revision = '-', digest = '-', suffix = '-') {
    return new Promise((resolve, reject) => {
        const processChild = spawn(process.execPath, [WORKER, storePath, mode, String(revision), digest, suffix], {
            windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        processChild.stdout.setEncoding('utf8');
        processChild.stderr.setEncoding('utf8');
        processChild.stdout.on('data', chunk => { stdout += chunk; });
        processChild.stderr.on('data', chunk => { stderr += chunk; });
        processChild.once('error', reject);
        processChild.once('close', code => resolve({ code, stdout, stderr }));
    });
}

async function childHoldingLock(storePath, revision, expectedDigest) {
    const processChild = spawn(process.execPath, [WORKER, storePath, 'hold-lock', String(revision), expectedDigest], {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    processChild.stdout.setEncoding('utf8');
    processChild.stderr.setEncoding('utf8');
    processChild.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('LOCK_HELD')) processChild.kill();
    });
    processChild.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => processChild.kill(), 10_000);
    const code = await new Promise((resolve, reject) => {
        processChild.once('error', reject);
        processChild.once('close', resolve);
    }).finally(() => clearTimeout(timeout));
    assert.match(stdout, /LOCK_HELD/u, `lock-holder did not reach critical section: ${stderr}`);
    return { code, stdout, stderr };
}

test('persistent store is explicit, synthetic-only, strict, and starts without an Owner', async t => {
    const { store, initial, storePath } = await fixture(t);
    assert.equal(initial.snapshot.trustDomain, 'test.synthetic');
    assert.equal(initial.snapshot.bootstrapState, 'uninitialized');
    assert.equal(initial.snapshot.ownerPrincipalId, null);
    assert.equal(initial.snapshot.recovery.secondAuthenticatorRequired, true);
    assert.equal(initial.snapshot.recovery.offlineRecoveryKeyRequired, true);
    assert.equal(initial.snapshot.recovery.offlineRecoveryKeyStatus, 'not_generated');
    assert.equal(initial.executable, false);
    assert.equal(initial.authorization, 'DENY');
    assert.equal(validateLocalIdentitySnapshot(initial.snapshot), true);
    const inconsistentRecovery = structuredClone(initial.snapshot);
    inconsistentRecovery.recovery.secondAuthenticatorCredentialRef = 'test_credential_unbound';
    assert.equal(validateLocalIdentitySnapshot(inconsistentRecovery), false);
    assert.equal(store.evaluateExecutionRequest({ action: 'create_owner' }).decision, 'DENY');
    assert.equal((await readFile(storePath, 'utf8')).includes('privateKey'), false);
    await assert.rejects(store.initialize({ installationId: 'real_installation' }), { code: 'identity_store_invalid' });
});

test('two independent processes race initialization without replacing or duplicating the store', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-race-init-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const storePath = path.join(directory, 'identity.json');
    const results = await Promise.all([
        child(storePath, 'initialize'), child(storePath, 'initialize'),
    ]);
    assert.equal(results.some(item => item.code === 0), true);
    assert.equal(results.every(item => item.code === 0 || JSON.parse(item.stdout || '{"code":""}').code === 'identity_store_locked'), true);
    const store = createSyntheticLocalIdentityStore({ storePath });
    await store.initialize({ installationId: 'test_installation_m1d1' });
    const snapshot = await store.readSnapshot();
    assert.equal(snapshot.snapshot.bootstrapState, 'uninitialized');
    assert.equal(snapshot.snapshot.ownerPrincipalId, null);
    await store.close();
});

test('the synthetic coordinator reuses M.1c proof checks and commits one Owner atomically', async t => {
    const { store, initial, storePath } = await fixture(t, { clock: () => new Date(fixedNow).toISOString() });
    const coordinator = createSyntheticOwnerBootstrap({ store, clock: () => fixedNow });
    const pending = await coordinator.begin();
    assert.equal(pending.status, 'pending_synthetic');
    assert.equal(pending.executable, false);
    assert.equal((await store.readSnapshot()).snapshot.bootstrapState, 'pending');
    const completed = await pending.confirm();
    assert.equal(completed.status, 'accepted_synthetic');
    assert.equal(completed.executable, false);
    assert.equal(completed.authorization, 'DENY');
    assert.equal(completed.persistencePerformed, true);
    const active = await store.readSnapshot();
    assert.equal(active.snapshot.bootstrapState, 'active');
    assert.equal(active.snapshot.ownerPrincipalId, 'test_principal_owner');
    assert.equal(active.snapshot.ownerCredentialRefs.length, 2);
    assert.equal(active.snapshot.credentials.length, 2);
    assert.equal(active.snapshot.credentials.every(item => item.evidenceKind === 'test.synthetic_webauthn'), true);
    assert.equal(active.snapshot.credentials.every(item => !Object.hasOwn(item, 'publicKeyPem')), true);
    assert.equal(active.snapshot.recovery.offlineRecoveryKeyStatus, 'not_generated');
    assert.equal(active.revision, initial.revision + 2);

    const reopened = createSyntheticLocalIdentityStore({ storePath });
    await reopened.initialize({ installationId: 'test_installation_m1d1' });
    const persisted = await reopened.readSnapshot();
    assert.equal(persisted.digest, active.digest);
    assert.equal(persisted.snapshot.ownerPrincipalId, 'test_principal_owner');
    await reopened.close();
    assert.equal((await coordinator.evaluateExecutionRequest({ operation: 'admin.*' })).authorization, 'DENY');
});

test('unverified or falsified synthetic assertion cannot finish bootstrap and consumes its ceremony', async t => {
    const { store } = await fixture(t);
    const coordinator = createSyntheticOwnerBootstrap({ store, clock: () => fixedNow });
    const pending = await coordinator.begin();
    assert.equal((await pending.confirm({ verified: true, principalId: 'test_principal_attacker' })).code,
        'synthetic_confirmation_input_invalid');
    const failed = await pending.confirm({ userVerified: false });
    assert.equal(failed.status, 'rejected');
    assert.equal(failed.code, 'user_verification_required');
    assert.equal((await pending.confirm()).code, 'bootstrap_ceremony_replayed');
    assert.equal((await store.readSnapshot()).snapshot.bootstrapState, 'pending');
    assert.equal((await store.readSnapshot()).snapshot.ownerPrincipalId, null);
});

test('a pending ceremony cannot be resumed with volatile proof after restart', async t => {
    const { store, storePath } = await fixture(t);
    const originalCoordinator = createSyntheticOwnerBootstrap({ store, clock: () => fixedNow });
    const oldPending = await originalCoordinator.begin();
    await store.close();
    const reopened = createSyntheticLocalIdentityStore({ storePath, clock: () => new Date(fixedNow).toISOString() });
    await reopened.initialize({ installationId: 'test_installation_m1d1' });
    const newCoordinator = createSyntheticOwnerBootstrap({ store: reopened, clock: () => fixedNow });
    assert.equal((await newCoordinator.begin()).code, 'bootstrap_state_invalid');
    assert.equal((await oldPending.confirm()).code, 'identity_store_closed');
    assert.equal((await reopened.readSnapshot()).snapshot.bootstrapState, 'pending');
    await reopened.close();
});

test('same-process competing begin requests use revision CAS and leave one pending ceremony', async t => {
    const { store, initial, storePath } = await fixture(t);
    const expiry = new Date(fixedNow + 60_000).toISOString();
    const requests = ['alpha', 'beta'].map(suffix => store.beginBootstrap({
        expected: { revision: initial.revision, digest: initial.digest },
        principalId: `test_principal_${suffix}`, ceremonyId: `test_ceremony_${suffix}`,
        challenge: `challenge-value-${suffix}-123456789`, expiresAt: expiry,
    }));
    const results = await Promise.allSettled(requests);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter(item => item.status === 'rejected' && item.reason.code === 'identity_store_revision_conflict').length, 1);
    const snapshot = await store.readSnapshot();
    assert.equal(snapshot.snapshot.bootstrapState, 'pending');
    assert.equal(snapshot.snapshot.revision, 1);
    const persisted = await readFile(storePath, 'utf8');
    assert.equal(persisted.includes('challenge-value-alpha'), false);
    assert.equal(persisted.includes('challenge-value-beta'), false);
});

test('two processes racing to begin bootstrap cannot claim two principals', async t => {
    const { store, initial, storePath } = await fixture(t);
    const results = await Promise.all([
        child(storePath, 'begin', initial.revision, initial.digest, 'alpha'),
        child(storePath, 'begin', initial.revision, initial.digest, 'beta'),
    ]);
    assert.equal(results.filter(item => item.code === 0).length, 1);
    assert.equal(results.filter(item => item.code !== 0).length, 1);
    const snapshot = await store.readSnapshot();
    assert.equal(snapshot.snapshot.bootstrapState, 'pending');
    assert.match(snapshot.snapshot.pendingBootstrap.principalId, /^test_principal_(alpha|beta)$/u);
    assert.equal(snapshot.snapshot.ownerPrincipalId, null);
});

test('two processes racing the same pending snapshot commit at most one Owner', async t => {
    const { store, initial, storePath } = await fixture(t);
    const pending = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_shared',
        challenge: 'shared-synthetic-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() });
    const results = await Promise.all([
        child(storePath, 'complete', pending.revision, pending.digest, 'alpha'),
        child(storePath, 'complete', pending.revision, pending.digest, 'beta'),
    ]);
    assert.equal(results.filter(item => item.code === 0).length, 1);
    assert.equal(results.filter(item => item.code !== 0).length, 1);
    const snapshot = await store.readSnapshot();
    assert.equal(snapshot.snapshot.bootstrapState, 'active');
    assert.equal(snapshot.snapshot.ownerPrincipalId, 'test_principal_owner');
    assert.equal(snapshot.snapshot.ownerCredentialRefs.length, 2);
    assert.equal(snapshot.revision, pending.revision + 1);
});

test('stale snapshot, replay, second Owner, and changed installation are rejected', async t => {
    const { store, initial } = await fixture(t);
    const first = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_one',
        challenge: 'one-synthetic-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() });
    await assert.rejects(store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_second', ceremonyId: 'test_ceremony_two',
        challenge: 'two-synthetic-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() }),
    { code: 'identity_store_revision_conflict' });
    const snap = first.snapshot.pendingBootstrap;
    const fakeEvidence = { kind: 'test.synthetic_webauthn_assertion', installationId: first.snapshot.installationId,
        principalId: snap.principalId, ceremonyId: snap.ceremonyId, purpose: 'owner_bootstrap',
        operationFingerprint: snap.operationFingerprint, challengeFingerprint: snap.challengeFingerprint,
        binding: 'hypothetical_synthetic' };
    const credential = suffix => ({ credentialRef: `test_credential_${suffix}`,
        publicKeyFingerprint: 'a'.repeat(64), evidenceKind: 'test.synthetic_webauthn' });
    await assert.rejects(store.completeSyntheticBootstrap({ expected: { revision: first.revision, digest: first.digest },
        ceremonyId: snap.ceremonyId, evidence: { ...fakeEvidence, verified: true },
        primaryCredential: credential('invalid-one'), secondaryCredential: { ...credential('invalid-two'),
            publicKeyFingerprint: 'b'.repeat(64) } }), { code: 'identity_store_bootstrap_state_invalid' });
    const active = await store.completeSyntheticBootstrap({ expected: { revision: first.revision, digest: first.digest },
        ceremonyId: snap.ceremonyId, evidence: fakeEvidence,
        primaryCredential: credential('one'), secondaryCredential: { ...credential('two'), publicKeyFingerprint: 'b'.repeat(64) } });
    await assert.rejects(store.completeSyntheticBootstrap({ expected: { revision: first.revision, digest: first.digest },
        ceremonyId: snap.ceremonyId, evidence: fakeEvidence,
        primaryCredential: credential('three'), secondaryCredential: credential('four') }),
    { code: 'identity_store_revision_conflict' });
    await assert.rejects(store.beginBootstrap({ expected: { revision: active.revision, digest: active.digest },
        principalId: 'test_principal_second', ceremonyId: 'test_ceremony_second',
        challenge: 'second-synthetic-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() }),
    { code: 'identity_store_bootstrap_replayed' });
    await assert.rejects(store.initialize({ installationId: 'test_installation_other' }),
    { code: 'identity_store_already_initialized' });
    assert.equal((await store.readSnapshot()).snapshot.ownerPrincipalId, 'test_principal_owner');
});

test('expired bootstrap requires recovery state and a fresh ceremony', async t => {
    let now = fixedNow;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-expire-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = createSyntheticLocalIdentityStore({ storePath: path.join(directory, 'identity.json'),
        clock: () => new Date(now).toISOString() });
    const initial = await store.initialize({ installationId: 'test_installation_m1d1' });
    const pending = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_expiring',
        challenge: 'expired-synthetic-challenge-123456789', expiresAt: new Date(now + 1000).toISOString() });
    now += 1001;
    const expired = pending.snapshot.pendingBootstrap;
    const expiredEvidence = { kind: 'test.synthetic_webauthn_assertion', installationId: pending.snapshot.installationId,
        principalId: expired.principalId, ceremonyId: expired.ceremonyId, purpose: 'owner_bootstrap',
        operationFingerprint: expired.operationFingerprint, challengeFingerprint: expired.challengeFingerprint,
        binding: 'hypothetical_synthetic' };
    const expiredCredential = (id, fingerprint) => ({ credentialRef: id, publicKeyFingerprint: fingerprint,
        evidenceKind: 'test.synthetic_webauthn' });
    await assert.rejects(store.completeSyntheticBootstrap({ expected: { revision: pending.revision, digest: pending.digest },
        ceremonyId: 'test_ceremony_expiring', evidence: expiredEvidence,
        primaryCredential: expiredCredential('test_credential_expired1', 'a'.repeat(64)),
        secondaryCredential: expiredCredential('test_credential_expired2', 'b'.repeat(64)) }),
    { code: 'identity_store_bootstrap_expired' });
    const recovery = await store.markPendingRecoveryRequired({ revision: pending.revision, digest: pending.digest });
    assert.equal(recovery.snapshot.bootstrapState, 'recovery_required');
    const fresh = await store.beginBootstrap({ expected: { revision: recovery.revision, digest: recovery.digest },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_fresh',
        challenge: 'fresh-synthetic-challenge-123456789', expiresAt: new Date(now + 60_000).toISOString() });
    assert.notEqual(fresh.snapshot.pendingBootstrap.challengeFingerprint,
        pending.snapshot.pendingBootstrap.challengeFingerprint);
    await store.close();
});

test('locking is terminal, advances the revocation epoch, and never enables execution', async t => {
    const { store, initial } = await fixture(t);
    const locked = await store.lockStore({ revision: initial.revision, digest: initial.digest });
    assert.equal(locked.snapshot.bootstrapState, 'locked');
    assert.equal(locked.snapshot.revocationEpoch, initial.snapshot.revocationEpoch + 1);
    assert.equal(locked.executable, false);
    assert.equal(store.evaluateExecutionRequest({ action: 'anything' }).decision, 'DENY');
    await assert.rejects(store.lockStore({ revision: locked.revision, digest: locked.digest }),
        { code: 'identity_store_bootstrap_state_invalid' });
});

test('corrupt stores fail closed without rewriting the source file', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-corrupt-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const storePath = path.join(directory, 'identity.json');
    const corrupt = Buffer.from('{"schemaVersion":1,"bootstrapState":"active"');
    await writeFile(storePath, corrupt);
    const store = createSyntheticLocalIdentityStore({ storePath });
    await assert.rejects(store.initialize({ installationId: 'test_installation_m1d1' }),
        { code: 'identity_store_corrupt' });
    assert.deepEqual(await readFile(storePath), corrupt);
    await assert.rejects(readFile(`${storePath}.lock`), { code: 'ENOENT' });
    await store.close();
});

test('recomputed file digest cannot make an impossible snapshot valid', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-invalid-snapshot-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const storePath = path.join(directory, 'identity.json');
    const initial = { schemaVersion: 1, trustDomain: 'test.synthetic', installationId: 'test_installation_m1d1',
        bootstrapState: 'uninitialized', ownerPrincipalId: 'test_principal_forged', ownerCredentialRefs: [], credentials: [],
        pendingBootstrap: null, revision: 91, revocationEpoch: 0,
        recovery: { secondAuthenticatorRequired: true, secondAuthenticatorCredentialRef: null,
            offlineRecoveryKeyRequired: true, offlineRecoveryKeyStatus: 'not_generated' }, updatedAt: new Date(fixedNow).toISOString() };
    assert.equal(validateLocalIdentitySnapshot(initial), false);
    const bytes = Buffer.from(JSON.stringify(initial));
    await writeFile(storePath, bytes);
    const store = createSyntheticLocalIdentityStore({ storePath });
    await assert.rejects(store.initialize({ installationId: initial.installationId }),
        { code: 'identity_store_corrupt' });
    assert.deepEqual(await readFile(storePath), bytes);
    await store.close();
});

test('same-revision digest mismatch is rejected without changing the snapshot', async t => {
    const { store, initial, storePath } = await fixture(t);
    const before = await readFile(storePath);
    await assert.rejects(store.beginBootstrap({ expected: { revision: initial.revision, digest: '0'.repeat(64) },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_bad_digest',
        challenge: 'synthetic-bad-digest-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() }),
    { code: 'identity_store_revision_conflict' });
    assert.deepEqual(await readFile(storePath), before);
});

test('store path through a directory symlink is rejected before creating files', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-symlink-parent-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'target');
    const alias = path.join(root, 'alias');
    await nativeFs.mkdir(target);
    try { await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) return t.skip('filesystem does not permit synthetic directory symlinks');
        throw error;
    }
    t.after(() => unlink(alias).catch(() => {}));
    const store = createSyntheticLocalIdentityStore({ storePath: path.join(alias, 'identity.json') });
    await assert.rejects(store.initialize({ installationId: 'test_installation_m1d1' }),
        { code: 'identity_store_persist_failed' });
    assert.deepEqual(await readdir(target), []);
    await store.close();
});

test('a symlink store file is rejected without reading or changing its target', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-symlink-file-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'target.json');
    const storePath = path.join(directory, 'identity.json');
    const bytes = Buffer.from('synthetic-target-must-remain-untouched');
    await writeFile(target, bytes);
    try { await symlink(target, storePath, 'file'); }
    catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) return t.skip('filesystem does not permit synthetic file symlinks');
        throw error;
    }
    const store = createSyntheticLocalIdentityStore({ storePath });
    await assert.rejects(store.initialize({ installationId: 'test_installation_m1d1' }),
        { code: 'identity_store_corrupt' });
    assert.deepEqual(await readFile(target), bytes);
    assert.equal((await nativeFs.lstat(storePath)).isSymbolicLink(), true);
    await assert.rejects(readFile(`${storePath}.lock`), { code: 'ENOENT' });
    await store.close();
});

test('an unowned or stale lock is not stolen and blocks initialization', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1d1-lock-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const storePath = path.join(directory, 'identity.json');
    const lockPath = `${storePath}.lock`;
    const lockBytes = Buffer.from('{"pid":999999,"token":"stale-test-lock"}\n');
    await writeFile(lockPath, lockBytes, { flag: 'wx' });
    const store = createSyntheticLocalIdentityStore({ storePath });
    await assert.rejects(store.initialize({ installationId: 'test_installation_m1d1' }),
        { code: 'identity_store_locked' });
    assert.deepEqual(await readFile(lockPath), lockBytes);
    assert.equal((await readdir(directory)).includes('identity.json'), false);
    await store.close();
});

test('a process killed while holding the lock leaves it untouched and blocks retry until offline cleanup', async t => {
    const { store, initial, storePath } = await fixture(t);
    const held = await childHoldingLock(storePath, initial.revision, initial.digest);
    assert.notEqual(held.code, 0);
    const lockPath = `${storePath}.lock`;
    const lockBytes = await readFile(lockPath);
    await assert.rejects(store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_retry', ceremonyId: 'test_ceremony_retry',
        challenge: 'synthetic-retry-after-lock-death-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() }),
    { code: 'identity_store_locked' });
    assert.deepEqual(await readFile(lockPath), lockBytes);
    await unlink(lockPath); // Explicit offline cleanup confined to this test fixture.
    const retried = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_retry', ceremonyId: 'test_ceremony_retry',
        challenge: 'synthetic-retry-after-lock-death-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() });
    assert.equal(retried.snapshot.bootstrapState, 'pending');
});

test('partial staging failure preserves the snapshot, cleans its temp, and permits a fresh-ceremony retry', async t => {
    let injectFailure = false;
    const fileSystem = {
        async open(target, ...args) {
            const handle = await nativeFs.open(target, ...args);
            if (!injectFailure || !target.endsWith('.tmp')) return handle;
            return {
                stat: handle.stat.bind(handle), close: handle.close.bind(handle), sync: handle.sync.bind(handle),
                async writeFile(bytes, ...rest) {
                    await handle.writeFile(bytes.subarray(0, 20), ...rest);
                    throw Object.assign(new Error('synthetic partial write'), { code: 'EIO' });
                },
            };
        },
    };
    const { store, initial, directory, setNow } = await fixture(t, { fileSystem });
    const pending = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_partial',
        challenge: 'partial-write-challenge-123456789', expiresAt: new Date(fixedNow + 1000).toISOString() });
    const fields = pending.snapshot.pendingBootstrap;
    const evidence = { kind: 'test.synthetic_webauthn_assertion', installationId: pending.snapshot.installationId,
        principalId: fields.principalId, ceremonyId: fields.ceremonyId, purpose: 'owner_bootstrap',
        operationFingerprint: fields.operationFingerprint, challengeFingerprint: fields.challengeFingerprint,
        binding: 'hypothetical_synthetic' };
    const credential = (id, fingerprint) => ({ credentialRef: id, publicKeyFingerprint: fingerprint,
        evidenceKind: 'test.synthetic_webauthn' });
    injectFailure = true;
    await assert.rejects(store.completeSyntheticBootstrap({ expected: { revision: pending.revision, digest: pending.digest },
        ceremonyId: fields.ceremonyId, evidence,
        primaryCredential: credential('test_credential_partial1', 'a'.repeat(64)),
        secondaryCredential: credential('test_credential_partial2', 'b'.repeat(64)) }),
    { code: 'identity_store_persist_failed' });
    injectFailure = false;
    const snapshot = await store.readSnapshot();
    assert.equal(snapshot.revision, pending.revision);
    assert.equal(snapshot.snapshot.bootstrapState, 'pending');
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
    const now = fixedNow + 1001;
    setNow(now);
    const recovery = await store.markPendingRecoveryRequired({ revision: pending.revision, digest: pending.digest });
    assert.equal(recovery.snapshot.bootstrapState, 'recovery_required');
    const coordinator = createSyntheticOwnerBootstrap({ store, clock: () => now });
    const fresh = await coordinator.begin();
    assert.equal(fresh.status, 'pending_synthetic');
    assert.equal((await fresh.confirm()).status, 'accepted_synthetic');
});

test('cleanup failure preserves the original persistence error and reports the temporary residue', async t => {
    let failWrite = false;
    let failCleanup = false;
    const fileSystem = {
        async open(target, ...args) {
            const handle = await nativeFs.open(target, ...args);
            if (!failWrite || !target.endsWith('.tmp')) return handle;
            return { stat: handle.stat.bind(handle), close: handle.close.bind(handle), sync: handle.sync.bind(handle),
                async writeFile(bytes) {
                    await handle.writeFile(bytes.subarray(0, 16));
                    throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
                } };
        },
        async unlink(target) {
            if (failCleanup && target.endsWith('.tmp')) throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
            return nativeFs.unlink(target);
        },
    };
    const { store, initial, directory } = await fixture(t, { fileSystem });
    const pending = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_cleanup',
        challenge: 'cleanup-failure-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() });
    const record = pending.snapshot.pendingBootstrap;
    const evidence = { kind: 'test.synthetic_webauthn_assertion', installationId: pending.snapshot.installationId,
        principalId: record.principalId, ceremonyId: record.ceremonyId, purpose: 'owner_bootstrap',
        operationFingerprint: record.operationFingerprint, challengeFingerprint: record.challengeFingerprint,
        binding: 'hypothetical_synthetic' };
    const credential = (id, fp) => ({ credentialRef: id, publicKeyFingerprint: fp, evidenceKind: 'test.synthetic_webauthn' });
    failWrite = true;
    failCleanup = true;
    await assert.rejects(store.completeSyntheticBootstrap({ expected: { revision: pending.revision, digest: pending.digest },
        ceremonyId: record.ceremonyId, evidence, primaryCredential: credential('test_credential_cleanup1', 'a'.repeat(64)),
        secondaryCredential: credential('test_credential_cleanup2', 'b'.repeat(64)) }), error => {
        assert.equal(error.code, 'identity_store_persist_failed');
        assert.equal(error.cause.code, 'EIO');
        assert.equal(error.cleanupCode, 'EACCES');
        assert.equal(error.temporaryResidue, true);
        assert.match(error.residuePath, /^.+\.tmp$/u);
        return true;
    });
    assert.equal((await store.readSnapshot()).snapshot.bootstrapState, 'pending');
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), true);
});

test('rename failure does not alter the store and a lost response is reconciled after process exit', async t => {
    let failRename = false;
    const fileSystem = { async rename(from, to) {
        if (failRename) { failRename = false; throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); }
        return nativeFs.rename(from, to);
    } };
    const { store, initial, storePath } = await fixture(t, { fileSystem });
    const pending = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
        principalId: 'test_principal_owner', ceremonyId: 'test_ceremony_rename',
        challenge: 'rename-failure-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() });
    const current = pending.snapshot.pendingBootstrap;
    const cred = n => ({ credentialRef: `test_credential_${n}`, publicKeyFingerprint: String(n).repeat(64), evidenceKind: 'test.synthetic_webauthn' });
    const evidence = { kind: 'test.synthetic_webauthn_assertion', installationId: pending.snapshot.installationId,
        principalId: current.principalId, ceremonyId: current.ceremonyId, purpose: 'owner_bootstrap',
        operationFingerprint: current.operationFingerprint, challengeFingerprint: current.challengeFingerprint,
        binding: 'hypothetical_synthetic' };
    failRename = true;
    await assert.rejects(store.completeSyntheticBootstrap({ expected: { revision: pending.revision, digest: pending.digest },
        ceremonyId: current.ceremonyId, evidence, primaryCredential: cred(1), secondaryCredential: cred(2) }),
    { code: 'identity_store_persist_failed' });
    assert.equal((await store.readSnapshot()).snapshot.bootstrapState, 'pending');

    const lost = await child(storePath, 'complete-lost-response', pending.revision, pending.digest, 'lost');
    assert.equal(lost.code, 23);
    assert.equal(lost.stdout, '');
    const reopened = createSyntheticLocalIdentityStore({ storePath });
    await reopened.initialize({ installationId: 'test_installation_m1d1' });
    const reconciled = await reopened.readSnapshot();
    assert.equal(reconciled.snapshot.bootstrapState, 'active');
    assert.equal(reconciled.snapshot.ownerPrincipalId, 'test_principal_owner');
    await assert.rejects(reopened.completeSyntheticBootstrap({ expected: { revision: pending.revision, digest: pending.digest },
        ceremonyId: current.ceremonyId, evidence, primaryCredential: cred(1), secondaryCredential: cred(2) }),
    { code: 'identity_store_revision_conflict' });
    await reopened.close();
});

test('rename response failure after publication is reconciled; missing state after rename is uncertain', async t => {
    let failAfterPublish = false;
    let removeAfterPublish = false;
    const fileSystem = { async rename(from, to) {
        await nativeFs.rename(from, to);
        if (failAfterPublish) {
            failAfterPublish = false;
            if (removeAfterPublish) await nativeFs.unlink(to);
            throw Object.assign(new Error('synthetic post-publication response failure'), { code: 'EIO' });
        }
    } };
    const first = await fixture(t, { fileSystem });
    const pending = await first.store.beginBootstrap({ expected: { revision: first.initial.revision, digest: first.initial.digest },
        principalId: 'test_principal_reconciled', ceremonyId: 'test_ceremony_reconciled',
        challenge: 'synthetic-post-publish-challenge-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() });
    const fields = pending.snapshot.pendingBootstrap;
    const evidence = { kind: 'test.synthetic_webauthn_assertion', installationId: pending.snapshot.installationId,
        principalId: fields.principalId, ceremonyId: fields.ceremonyId, purpose: 'owner_bootstrap',
        operationFingerprint: fields.operationFingerprint, challengeFingerprint: fields.challengeFingerprint,
        binding: 'hypothetical_synthetic' };
    const credential = (id, fingerprint) => ({ credentialRef: id, publicKeyFingerprint: fingerprint,
        evidenceKind: 'test.synthetic_webauthn' });
    failAfterPublish = true;
    const applied = await first.store.completeSyntheticBootstrap({ expected: { revision: pending.revision, digest: pending.digest },
        ceremonyId: fields.ceremonyId, evidence, primaryCredential: credential('test_credential_after1', 'a'.repeat(64)),
        secondaryCredential: credential('test_credential_after2', 'b'.repeat(64)) });
    assert.equal(applied.snapshot.bootstrapState, 'active');

    const second = await fixture(t, { fileSystem });
    const secondPending = await second.store.beginBootstrap({ expected: { revision: second.initial.revision, digest: second.initial.digest },
        principalId: 'test_principal_uncertain', ceremonyId: 'test_ceremony_uncertain',
        challenge: 'synthetic-post-publish-disappears-123456789', expiresAt: new Date(fixedNow + 60_000).toISOString() });
    const secondFields = secondPending.snapshot.pendingBootstrap;
    const secondEvidence = { ...evidence, installationId: secondPending.snapshot.installationId,
        principalId: secondFields.principalId, ceremonyId: secondFields.ceremonyId,
        operationFingerprint: secondFields.operationFingerprint, challengeFingerprint: secondFields.challengeFingerprint };
    failAfterPublish = true;
    removeAfterPublish = true;
    await assert.rejects(second.store.completeSyntheticBootstrap({ expected: {
        revision: secondPending.revision, digest: secondPending.digest }, ceremonyId: secondFields.ceremonyId,
    evidence: secondEvidence, primaryCredential: credential('test_credential_uncertain1', 'c'.repeat(64)),
    secondaryCredential: credential('test_credential_uncertain2', 'd'.repeat(64)) }),
    { code: 'identity_store_commit_uncertain' });
});

test('execution mode always denies and runtime does not import the synthetic harness', async () => {
    const source = await readFile(new URL('../src/core/identity-store.js', import.meta.url), 'utf8');
    assert.equal(source.includes('test/support'), false);
    assert.equal(source.includes('webauthn-harness'), false);
});
