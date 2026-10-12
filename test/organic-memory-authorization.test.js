import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrganicMemoryAuthorization } from '../src/core/organic-memory-authorization.js';

function scenario({ storeKind = 'synthetic_test', now = () => Date.now(), evidenceVerifier } = {}) {
    const consentProofs = new WeakMap();
    const evidenceProofs = new WeakMap();
    const storeProofs = new WeakMap();
    const storeCapability = Object.freeze(Object.create(null));
    const ownerId = 'desktop-owner-test';
    storeProofs.set(storeCapability, { kind: storeKind, isolated: storeKind === 'synthetic_test',
        personalData: storeKind !== 'synthetic_test', ...(storeKind === 'memory2_personal'
            ? { ownerId, mode: 'memory2-confirmed-write' } : {}) });
    let writes = 0;
    const consentCapability = (decision = 'granted', scopes = ['tool_preferences'], overrides = {}) => {
        const capability = Object.freeze(Object.create(null));
        consentProofs.set(capability, { issuer: 'owner', synthetic: true, personal: true, ownerId,
            mode: 'memory2-confirmed-write', purpose: 'organic_memory_learning', decision, scopes: [...scopes], ...overrides });
        return capability;
    };
    const evidenceCapability = (overrides = {}) => {
        const capability = Object.freeze(Object.create(null));
        evidenceProofs.set(capability, { origin: 'direct_user', subject: 'owner', explicit: true, certain: true,
            sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false, ownerId,
            attribute: 'preferred_editor', ...overrides });
        return capability;
    };
    const authorization = createOrganicMemoryAuthorization({ storeCapability, now,
        verifyStoreCapability: value => storeProofs.get(value) ?? null,
        persist: async (_input, context) => { writes++; return context; },
        verifyConsentCapability: value => consentProofs.get(value) ?? null,
        verifyEvidenceCapability: evidenceVerifier ?? (value => evidenceProofs.get(value) ?? null) });
    return { authorization, consentCapability, evidenceCapability, writeCount: () => writes };
}

const eligible = (evidenceCapability, overrides = {}) => ({ scope: 'tool_preferences', operation: 'remember',
    attribute: 'preferred_editor', evidenceCapability, ...overrides });

test('missing authorization blocks before persistence is invoked', async () => {
    const { authorization, evidenceCapability, writeCount } = scenario();
    const result = await authorization.persistIfAuthorized(eligible(evidenceCapability()));
    assert.equal(result.success, false);
    assert.equal(result.authorization.reason, 'consent_absent');
    assert.equal(authorization.inspect().status, 'absent');
    assert.equal(writeCount(), 0);
});

test('an explicit synthetic scoped grant authorizes an eligible owner fact', async () => {
    const { authorization, consentCapability, evidenceCapability, writeCount } = scenario();
    const grant = authorization.setSyntheticConsent(consentCapability(), 'granted', ['tool_preferences']);
    assert.equal(grant.status, 'granted');
    const result = await authorization.persistIfAuthorized(eligible(evidenceCapability()));
    assert.equal(result.success, true);
    assert.equal(result.authorization.scope, 'tool_preferences');
    assert.equal(result.result.syntheticOnly, true);
    assert.equal(writeCount(), 1);
});

test('revoked and denied consent reject and do not invoke persistence', async () => {
    for (const decision of ['revoked', 'denied']) {
        const { authorization, consentCapability, evidenceCapability, writeCount } = scenario();
        authorization.setSyntheticConsent(consentCapability(decision), decision, ['tool_preferences']);
        const result = await authorization.persistIfAuthorized(eligible(evidenceCapability()));
        assert.equal(result.success, false);
        assert.equal(result.authorization.reason, `consent_${decision}`);
        assert.equal(authorization.inspect().status, decision);
        assert.equal(writeCount(), 0);
    }
});

test('revocation invalidates a previously granted permission', async () => {
    const { authorization, consentCapability, evidenceCapability, writeCount } = scenario();
    authorization.setSyntheticConsent(consentCapability(), 'granted', ['tool_preferences']);
    assert.equal(authorization.revokeSyntheticConsent(consentCapability('revoked')).status, 'revoked');
    const result = await authorization.persistIfAuthorized(eligible(evidenceCapability()));
    assert.equal(result.success, false);
    assert.equal(result.authorization.reason, 'consent_revoked');
    assert.equal(authorization.inspect().status, 'revoked');
    assert.equal(writeCount(), 0);
});

test('assessment candidate-only consent cannot be used as an owner grant', () => {
    const proofs = new WeakMap();
    const cap = Object.freeze(Object.create(null));
    proofs.set(cap, { issuer: 'owner', synthetic: true, purpose: 'automatic_memory_assessment', decision: 'granted',
        scopes: ['tool_preferences'], grantsMemoryWrite: false });
    const storeProofs = new WeakMap(), storeCapability = Object.freeze(Object.create(null));
    storeProofs.set(storeCapability, { kind: 'synthetic_test', isolated: true, personalData: false });
    const authorization = createOrganicMemoryAuthorization({ storeCapability,
        verifyStoreCapability: value => storeProofs.get(value) ?? null, persist: async () => {},
        verifyConsentCapability: value => proofs.get(value) ?? null,
        verifyEvidenceCapability: () => null });
    assert.equal(authorization.setSyntheticConsent(cap, 'granted', ['tool_preferences']).reason,
        'trusted_owner_consent_required');
});

test('sensitive, ambiguous, third-party, uncertain, non-explicit, and model-originated evidence is denied', async () => {
    for (const overrides of [
        { sensitive: true }, { ambiguous: true }, { thirdParty: true }, { certain: false },
        { explicit: false }, { modelOriginated: true }, { subject: 'third_party' }, { origin: 'model' },
    ]) {
        const { authorization, consentCapability, evidenceCapability, writeCount } = scenario();
        authorization.setSyntheticConsent(consentCapability(), 'granted', ['tool_preferences']);
        const result = await authorization.persistIfAuthorized(eligible(evidenceCapability(overrides)));
        assert.equal(result.success, false, JSON.stringify(overrides));
        assert.equal(authorization.inspect().status, 'granted');
        assert.equal(writeCount(), 0, JSON.stringify(overrides));
    }
});

test('ambiguous attributes, unsupported operations, and out-of-scope permissions are denied', async () => {
    const { authorization, consentCapability, evidenceCapability, writeCount } = scenario();
    authorization.setSyntheticConsent(consentCapability('granted', ['daily_preferences']), 'granted', ['daily_preferences']);
    for (const input of [
        eligible(evidenceCapability(), { scope: 'tool_preferences' }),
        eligible(evidenceCapability(), { scope: 'unknown_scope' }),
        eligible(evidenceCapability(), { operation: 'forget' }),
        eligible(evidenceCapability(), { attribute: '' }),
    ]) {
        const result = await authorization.persistIfAuthorized(input);
        assert.equal(result.success, false);
        assert.notEqual(result.authorization.status, 'granted');
        assert.equal(writeCount(), 0);
    }
});

test('model-created consent and failed evidence verification fail closed', async () => {
    const { authorization, evidenceCapability, writeCount } = scenario();
    assert.equal(authorization.setSyntheticConsent({ issuer: 'model' }, 'granted', ['tool_preferences']).status, 'denied');
    authorization.setSyntheticConsent((() => {
        const cap = Object.freeze(Object.create(null));
        // No verifier-issued proof exists for this ordinary object.
        return cap;
    })(), 'granted', ['tool_preferences']);
    const result = await authorization.persistIfAuthorized(eligible(evidenceCapability()));
    assert.equal(result.success, false);
    assert.equal(result.authorization.reason, 'consent_absent');
    assert.equal(authorization.inspect().status, 'absent');
    assert.equal(writeCount(), 0);
});

test('verification exceptions reject without calling persistence', async () => {
    const { consentCapability, authorization, writeCount } = scenario({ evidenceVerifier: () => { throw new Error('opaque'); } });
    const capability = consentCapability();
    authorization.setSyntheticConsent(capability, 'granted', ['tool_preferences']);
    const result = await authorization.persistIfAuthorized(eligible({}));
    assert.equal(result.success, false);
    assert.equal(result.authorization.reason, 'evidence_verification_failed');
    assert.equal(authorization.inspect().status, 'granted');
    assert.equal(writeCount(), 0);
});

test('scope expiry is fail-closed and observable as revoked', () => {
    let time = 100;
    const { authorization, consentCapability } = scenario({ now: () => time });
    assert.equal(authorization.setSyntheticConsent(consentCapability(), 'granted', ['tool_preferences'], 1).status, 'granted');
    time += 2;
    assert.equal(authorization.inspect().status, 'revoked');
});

test('personal Memory2 and Memory1 cannot accept synthetic grants', () => {
    for (const storeKind of ['memory1', 'memory2_personal']) {
        const { authorization, consentCapability } = scenario({ storeKind });
        const result = authorization.setSyntheticConsent(consentCapability(), 'granted', ['tool_preferences']);
        assert.equal(result.reason, 'synthetic_store_required');
        assert.equal(authorization.inspect().status, 'absent');
    }
});

test('personal Memory2 requires a matching owner and writable Desktop mode grant', async () => {
    const { authorization, consentCapability, evidenceCapability, writeCount } = scenario({ storeKind: 'memory2_personal' });
    const grant = authorization.setOwnerConsent(consentCapability(), 'granted', ['tool_preferences']);
    assert.equal(grant.status, 'granted');
    const accepted = await authorization.persistIfAuthorized(eligible(evidenceCapability()));
    assert.equal(accepted.success, true);
    assert.equal(accepted.result.ownerOnly, true);
    assert.equal(writeCount(), 1);

    for (const overrides of [{ ownerId: 'another-owner' }, { mode: 'memory2-readonly' }]) {
        const other = scenario({ storeKind: 'memory2_personal' });
        const capability = other.consentCapability('granted', ['tool_preferences'], overrides);
        assert.equal(other.authorization.setOwnerConsent(capability, 'granted', ['tool_preferences']).status, 'denied');
    }
});

test('personal organic authorization is revoked and evidence from another owner is denied', async () => {
    const { authorization, consentCapability, evidenceCapability, writeCount } = scenario({ storeKind: 'memory2_personal' });
    const grant = consentCapability();
    authorization.setOwnerConsent(grant, 'granted', ['tool_preferences']);
    assert.equal((await authorization.persistIfAuthorized(eligible(evidenceCapability({ ownerId: 'other-owner' })))).success, false);
    assert.equal(authorization.revokeOwnerConsent(consentCapability('revoked')).status, 'revoked');
    assert.equal((await authorization.persistIfAuthorized(eligible(evidenceCapability()))).success, false);
    assert.equal(writeCount(), 0);
});

test('synthetic store attestation is rechecked immediately before every persistence attempt', async () => {
    const storeCapability = Object.freeze(Object.create(null));
    const consentCapability = Object.freeze(Object.create(null));
    const evidenceCapability = Object.freeze(Object.create(null));
    const consentProofs = new WeakMap([[consentCapability, { issuer: 'owner', synthetic: true,
        purpose: 'organic_memory_learning', decision: 'granted', scopes: ['tool_preferences'] }]]);
    const evidenceProofs = new WeakMap([[evidenceCapability, { origin: 'direct_user', subject: 'owner', explicit: true,
        certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
        attribute: 'preferred_editor' }]]);
    let attestationValid = true, writes = 0;
    const authorization = createOrganicMemoryAuthorization({ storeCapability,
        verifyStoreCapability: value => value === storeCapability && attestationValid
            ? { kind: 'synthetic_test', isolated: true, personalData: false } : null,
        verifyConsentCapability: value => consentProofs.get(value) ?? null,
        verifyEvidenceCapability: value => evidenceProofs.get(value) ?? null,
        persist: async () => { writes++; return { success: true }; },
    });
    authorization.setSyntheticConsent(consentCapability, 'granted', ['tool_preferences']);
    attestationValid = false;
    const result = await authorization.persistIfAuthorized(eligible(evidenceCapability));
    assert.equal(result.success, false);
    assert.equal(result.authorization.reason, 'synthetic_store_required');
    assert.equal(writes, 0);
});

test('existing confirmed-write authorization remains separate from organic consent', () => {
    const { authorization, consentCapability, evidenceCapability } = scenario();
    authorization.setSyntheticConsent(consentCapability(), 'granted', ['tool_preferences']);
    assert.equal(authorization.inspect().status, 'granted');
    // This contract has no route into explicit remember/update confirmation APIs.
    assert.equal(typeof authorization.setOwnerConsent, 'function');
    assert.equal(typeof authorization.setSyntheticConsent, 'function');
    assert.notEqual(authorization.setOwnerConsent, authorization.setSyntheticConsent);
    assert.equal(authorization.verify(eligible(evidenceCapability(), { operation: 'forget' })).allowed, false);
});
