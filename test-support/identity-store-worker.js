import { createSyntheticLocalIdentityStore } from '../src/core/identity-store.js';
import nativeFs from 'node:fs/promises';

const [storePath, mode, revisionText, expectedDigest, suffix = 'worker'] = process.argv.slice(2);
let holdLockClose = false;
const fileSystem = mode === 'hold-lock' ? {
    async open(target, ...args) {
        const handle = await nativeFs.open(target, ...args);
        if (!target.endsWith('.lock')) return handle;
        return { stat: handle.stat.bind(handle), writeFile: handle.writeFile.bind(handle), sync: handle.sync.bind(handle),
            async close() {
                await handle.close();
                if (holdLockClose) {
                    process.stdout.write('LOCK_HELD\n');
                    await new Promise(() => {});
                }
            } };
    },
} : {};
const store = createSyntheticLocalIdentityStore({ storePath, fileSystem });

try {
    await store.initialize({ installationId: 'test_installation_m1d1' });
    if (mode === 'hold-lock') {
        holdLockClose = true;
        await store.beginBootstrap({ expected: { revision: Number(revisionText), digest: expectedDigest },
            principalId: 'test_principal_lock_holder', ceremonyId: 'test_ceremony_lock_holder',
            challenge: 'synthetic-lock-holder-challenge-123456789',
            expiresAt: new Date(Date.now() + 60_000).toISOString() });
    } else if (mode === 'initialize') {
        const result = await store.readSnapshot();
        process.stdout.write(JSON.stringify({ outcome: 'initialized', revision: result.revision }));
    } else if (mode === 'begin') {
        const result = await store.beginBootstrap({ expected: { revision: Number(revisionText), digest: expectedDigest },
            principalId: `test_principal_${suffix}`, ceremonyId: `test_ceremony_${suffix}`,
            challenge: `synthetic-challenge-${suffix}-0123456789`,
            expiresAt: new Date(Date.now() + 60_000).toISOString() });
        process.stdout.write(JSON.stringify({ outcome: 'begun', revision: result.revision }));
    } else if (mode === 'complete' || mode === 'complete-lost-response') {
        const current = await store.readSnapshot();
        const pending = current.snapshot.pendingBootstrap;
        const evidence = { kind: 'test.synthetic_webauthn_assertion', installationId: current.snapshot.installationId,
            principalId: pending.principalId, ceremonyId: pending.ceremonyId, purpose: 'owner_bootstrap',
            operationFingerprint: pending.operationFingerprint, challengeFingerprint: pending.challengeFingerprint,
            binding: 'hypothetical_synthetic' };
        const credential = n => ({ credentialRef: `test_credential_${suffix}_${n}`,
            publicKeyFingerprint: String(n).repeat(64), evidenceKind: 'test.synthetic_webauthn' });
        const result = await store.completeSyntheticBootstrap({
            expected: { revision: Number(revisionText), digest: expectedDigest }, ceremonyId: pending.ceremonyId,
            evidence, primaryCredential: credential(1), secondaryCredential: credential(2),
        });
        if (mode === 'complete-lost-response') process.exit(23);
        process.stdout.write(JSON.stringify({ outcome: 'completed', revision: result.revision }));
    } else {
        process.stderr.write('invalid test worker mode');
        process.exitCode = 2;
    }
} catch (error) {
    process.stdout.write(JSON.stringify({ outcome: 'rejected', code: error.code ?? 'unexpected_error' }));
    process.exitCode = 1;
} finally {
    await store.close();
}
