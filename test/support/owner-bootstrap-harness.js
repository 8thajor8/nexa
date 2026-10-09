import { createHash } from 'node:crypto';
import { createWebAuthnTestHarness } from './webauthn-harness.js';
import { ownerBootstrapOperationFingerprint } from '../../src/core/identity-store.js';

const RP_ID = 'nexa.test';
const ORIGIN = 'https://nexa.test';
const sha256 = value => createHash('sha256').update(value).digest('hex');
function exactInput(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}
const safe = (status, code, fields = {}, persistencePerformed = false) => Object.freeze({ status, code, ...fields,
    executable: false, authorization: 'DENY', persistencePerformed });

function register(harness, authenticator, installationId, principalId, operationFingerprint) {
    const issued = harness.beginCeremony({ installationId, principalId, purpose: 'registration',
        operationFingerprint, rpId: RP_ID, origin: ORIGIN, ttlMs: 30_000,
        requireUserVerification: true, credentialId: null });
    if (issued.status !== 'accepted_synthetic') return null;
    const response = harness.createSyntheticRegistrationResponse(authenticator, issued.ceremonyId);
    if (!response) return null;
    const verified = harness.verifySyntheticRegistration(response);
    if (verified.status !== 'accepted_synthetic') return null;
    return Object.freeze({ credentialRef: `test_credential_${sha256(verified.credentialId).slice(0, 32)}`,
        publicKeyFingerprint: sha256(response.publicKeyPem), evidenceKind: 'test.synthetic_webauthn',
        credentialId: verified.credentialId });
}

/** Test-only coordinator. Never import from src/, agent, tools, or CLI. */
export function createSyntheticOwnerBootstrap({ store, clock = () => Date.now(), randomBytes } = {}) {
    if (!store || typeof store.beginBootstrap !== 'function' || typeof store.completeSyntheticBootstrap !== 'function')
        throw new TypeError('synthetic_bootstrap_store_required');
    const harness = createWebAuthnTestHarness({ clock, ...(randomBytes ? { randomBytes } : {}) });

    async function begin(input = {}) {
        if (!exactInput(input, ['principalId', 'ttlMs'])) return safe('rejected', 'bootstrap_input_invalid');
        const { principalId = 'test_principal_owner', ttlMs = 30_000 } = input;
        if (typeof principalId !== 'string' || !/^test_[a-z0-9._-]{1,80}$/u.test(principalId)
            || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000)
            return safe('rejected', 'bootstrap_input_invalid');
        const initial = await store.readSnapshot();
        if (!['uninitialized', 'recovery_required'].includes(initial.snapshot.bootstrapState))
            return safe('rejected', 'bootstrap_state_invalid');
        const installationId = initial.snapshot.installationId;
        const operationFingerprint = ownerBootstrapOperationFingerprint(installationId, principalId);
        const primaryAuthenticator = harness.createSyntheticAuthenticator({ installationId, principalId, rpId: RP_ID, origin: ORIGIN });
        const secondaryAuthenticator = harness.createSyntheticAuthenticator({ installationId, principalId, rpId: RP_ID, origin: ORIGIN });
        const primaryCredential = register(harness, primaryAuthenticator, installationId, principalId, operationFingerprint);
        const secondaryCredential = register(harness, secondaryAuthenticator, installationId, principalId, operationFingerprint);
        if (!primaryCredential || !secondaryCredential) return safe('rejected', 'synthetic_credential_registration_failed');

        const issued = harness.beginCeremony({ installationId, principalId, purpose: 'owner_bootstrap',
            operationFingerprint, rpId: RP_ID, origin: ORIGIN, ttlMs,
            requireUserVerification: true, credentialId: primaryCredential.credentialId });
        // The store keeps an opaque test reference, not the challenge or a reusable credential.
        if (issued.status !== 'accepted_synthetic') return safe('rejected', issued.code);
        const ceremonyRef = `test_ceremony_${issued.ceremonyId}`;
        let pending;
        try {
            pending = await store.beginBootstrap({ expected: { revision: initial.revision, digest: initial.digest },
                principalId, ceremonyId: ceremonyRef, challenge: issued.request.challenge,
                expiresAt: new Date(clock() + ttlMs).toISOString() });
        } catch (error) { return safe('rejected', error.code ?? 'bootstrap_begin_failed'); }

        let attempted = false;
        async function confirm(input = {}) {
            if (!exactInput(input, ['userPresent', 'userVerified'])
                || (input.userPresent !== undefined && typeof input.userPresent !== 'boolean')
                || (input.userVerified !== undefined && typeof input.userVerified !== 'boolean'))
                return safe('rejected', 'synthetic_confirmation_input_invalid');
            if (attempted) return safe('rejected', 'bootstrap_ceremony_replayed');
            attempted = true;
            const { userPresent = true, userVerified = true } = input;
            const response = harness.createSyntheticAssertionResponse(primaryAuthenticator, issued.ceremonyId,
                { userPresent, userVerified });
            const verified = harness.verifySyntheticAssertion(issued.ceremonyId, response, {
                installationId, principalId, purpose: 'owner_bootstrap', operationFingerprint,
            });
            if (verified.status !== 'accepted_synthetic') return safe('rejected', verified.code);
            const evidence = { kind: 'test.synthetic_webauthn_assertion', installationId,
                principalId, ceremonyId: ceremonyRef, purpose: 'owner_bootstrap', operationFingerprint,
                challengeFingerprint: sha256(issued.request.challenge), binding: 'hypothetical_synthetic' };
            try {
                const committed = await store.completeSyntheticBootstrap({ expected: {
                    revision: pending.revision, digest: pending.digest }, ceremonyId: ceremonyRef,
                evidence,
                    primaryCredential: { credentialRef: primaryCredential.credentialRef,
                        publicKeyFingerprint: primaryCredential.publicKeyFingerprint, evidenceKind: primaryCredential.evidenceKind },
                    secondaryCredential: { credentialRef: secondaryCredential.credentialRef,
                        publicKeyFingerprint: secondaryCredential.publicKeyFingerprint, evidenceKind: secondaryCredential.evidenceKind } });
                return safe('accepted_synthetic', 'owner_bootstrap_committed_synthetic', {
                    revision: committed.revision, installationId, principalId,
                }, true);
            } catch (error) { return safe('rejected', error.code ?? 'bootstrap_commit_failed'); }
        }

        return safe('pending_synthetic', 'owner_bootstrap_pending_synthetic', {
            installationId, principalId, revision: pending.revision, confirm,
        });
    }

    return Object.freeze({ begin, evaluateExecutionRequest: () => safe('rejected', 'real_execution_unavailable') });
}
