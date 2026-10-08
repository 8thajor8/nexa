import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../src/core/identity-contracts.js';

const installationId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'principal_22222222-2222-4222-8222-222222222222';
const memberId = 'principal_33333333-3333-4333-8333-333333333333';
const personId = 'person_44444444-4444-4444-8444-444444444444';
const now = '2030-01-01T00:00:00.000Z';

function owner(overrides = {}) {
    return { principalId: ownerId, accountStatus: 'active', role: 'owner', authenticationState: 'authenticated',
        assuranceLevel: 'strong', authenticationMethod: 'native_passkey', memoryPersonId: personId, accountEpoch: 1, ...overrides };
}
function member(overrides = {}) {
    return { principalId: memberId, accountStatus: 'active', role: 'member', authenticationState: 'unauthenticated',
        assuranceLevel: 'none', authenticationMethod: null, memoryPersonId: null, accountEpoch: 1, ...overrides };
}
function activeInstallation(overrides = {}) {
    return { schemaVersion: 1, installationId, bootstrapState: 'active', ownerPrincipalId: ownerId, ownerEpoch: 1, ...overrides };
}
function adminRequest(overrides = {}) {
    return { requestId: '55555555-5555-4555-8555-555555555555', installationId, actorPrincipalId: ownerId,
        actorAccountEpoch: 1, action: 'invite_user', targetPrincipalId: null, targetDeviceId: null,
        permission: null, operationFingerprint: 'a'.repeat(64), expiresAt: '2030-01-01T00:01:00.000Z', ...overrides };
}

test('Owner directory has exactly one active structural Owner, independent from Memory Self', () => {
    assert.deepEqual(contracts.validateIdentityDirectory(activeInstallation(), [owner(), member()]),
        { valid: true, code: 'valid_contract' });
    assert.equal(contracts.validateIdentityDirectory(activeInstallation(), [owner(), owner({ principalId: memberId })]).valid, false);
    assert.equal(contracts.validateIdentityDirectory(activeInstallation({ ownerPrincipalId: memberId }), [owner()]).code,
        'owner_directory_inconsistent');
    assert.equal(contracts.validatePrincipalContract(owner({ memoryPersonId: null })).valid, true);
    assert.notEqual(ownerId, personId, 'administrative principal and Memory person use distinct identifiers');
});

test('uninitialized bootstrap has no Owner and never succeeds without a trusted native provider', () => {
    const empty = { schemaVersion: 1, installationId, bootstrapState: 'uninitialized', ownerPrincipalId: null, ownerEpoch: 0 };
    assert.equal(contracts.validateIdentityDirectory(empty, []).valid, true);
    assert.equal(contracts.validateIdentityDirectory(empty, [owner()]).code, 'owner_exists_before_bootstrap');
    assert.deepEqual(contracts.evaluateOwnerBootstrap(empty, { verified: true, method: 'windows_hello' }),
        { allowed: false, code: 'trusted_bootstrap_provider_unavailable' });
    assert.equal(Object.keys(contracts).some(key => /bootstrap|owner/i.test(key) && /create|issue/i.test(key)), false);
});

test('names, SID-like strings, voice matches, model claims, and tool values cannot grant roles or authenticate', () => {
    const claims = [
        { name: 'Jorge', role: 'owner' }, { sid: 'S-1-5-21-100', role: 'owner' },
        { voiceMatch: true, role: 'owner' }, { model: { principalId: ownerId, role: 'owner' } },
        { toolOutput: { authenticated: true, role: 'owner' } },
    ];
    for (const claim of claims) {
        assert.equal(contracts.validatePrincipalContract(claim).valid, false);
        assert.equal(contracts.evaluateAdministrativeAuthorization(adminRequest(), claim, [owner()]).authorized, false);
    }
    assert.deepEqual(contracts.evaluateAdministrativeAuthorization(adminRequest(), owner(), [owner()]),
        { authorized: false, code: 'trusted_authentication_provider_unavailable' });
});

test('Member and revoked principals cannot be represented as the active Owner', () => {
    assert.equal(contracts.validateIdentityDirectory(activeInstallation(), [member()]).code, 'owner_directory_inconsistent');
    assert.equal(contracts.validateIdentityDirectory(activeInstallation(), [owner({ accountStatus: 'revoked' })]).code,
        'owner_revoked');
    assert.equal(contracts.evaluateAdministrativeAuthorization(adminRequest({ actorPrincipalId: memberId }), member(), [member()]).authorized,
        false);
});

test('account epochs and revocation are explicit contract data; no grant or reusable capability exists', () => {
    const pending = adminRequest({ actorAccountEpoch: 1 });
    const revoked = owner({ accountStatus: 'revoked', accountEpoch: 2 });
    assert.equal(contracts.validateAdministrativeRequest(pending).valid, true);
    assert.equal(contracts.validatePrincipalContract(revoked).valid, true);
    assert.equal(contracts.validateIdentityDirectory(activeInstallation({ ownerEpoch: 2 }), [revoked]).valid, false);
    assert.equal(contracts.evaluateAdministrativeAuthorization(pending, revoked, [revoked]).authorized, false);
    assert.equal(Object.keys(contracts).some(key => /capability|grant|consume|issue/i.test(key)), false);
});

test('pending request binding becomes stale after account revocation/epoch change and never grants authority', () => {
    const request = adminRequest();
    const session = { sessionId: '66666666-6666-4666-8666-666666666666', installationId, principalId: ownerId,
        accountEpoch: 1, deviceId: null, authenticationMethod: 'native_passkey', assuranceLevel: 'strong',
        expiresAt: '2030-01-01T00:05:00.000Z', revokedAt: null };
    assert.deepEqual(contracts.validateAdministrativeRequestBinding(request, session, owner(), activeInstallation()),
        { valid: true, code: 'request_context_consistent_only' });
    const revoked = owner({ accountStatus: 'revoked', accountEpoch: 2 });
    assert.equal(contracts.validateAdministrativeRequestBinding(request, session, revoked, activeInstallation()).code,
        'request_binding_stale');
    assert.equal(contracts.evaluateAdministrativeAuthorization(request, session, [owner()]).authorized, false);
});

test('sessions and devices are bounded data contracts, not authentication proofs', () => {
    const session = { sessionId: '66666666-6666-4666-8666-666666666666', installationId, principalId: ownerId,
        accountEpoch: 1, deviceId: null, authenticationMethod: 'native_passkey', assuranceLevel: 'strong',
        expiresAt: '2030-01-01T00:05:00.000Z', revokedAt: null };
    const device = { deviceId: '77777777-7777-4777-8777-777777777777', installationId, principalId: ownerId,
        status: 'active', createdAt: now, revokedAt: null };
    assert.equal(contracts.validateSessionContract(session), true);
    assert.equal(contracts.validateSessionContract({ ...session, principalId: 'owner' }), false);
    assert.equal(contracts.validateDeviceContract(device), true);
    assert.equal(contracts.validateDeviceContract({ ...device, status: 'suspended' }), true);
    assert.equal(contracts.validateDeviceContract({ ...device, status: 'revoked' }), false);
    assert.equal(contracts.evaluateMemoryScopeAccess(owner(), session, personId, 'private').allowed, false);
});

test('speaker, subject, and contributor are separate fields; a voice signal never authenticates', () => {
    const attribution = { speakerPersonId: personId, subjectPersonId: null, contributorPrincipalId: ownerId, sourceKind: 'direct_user' };
    assert.equal(contracts.validateMemoryAttributionContract(attribution), true);
    assert.equal(contracts.validateMemoryAttributionContract({ ...attribution, subjectPersonId: ownerId }), false);
    assert.equal(contracts.validateSpeakerSignal({ speakerPersonId: personId, method: 'voice_match', confidence: 0.99, observedAt: now }), true);
    assert.deepEqual(contracts.evaluateAdministrativeAuthorization(adminRequest(),
        { speakerPersonId: personId, confidence: 1, role: 'owner' }, [owner()]),
    { authorized: false, code: 'trusted_authentication_provider_unavailable' });
});

test('plain objects, symbols, extra fields, and hostile getters fail exact contract validation', () => {
    const forged = { ...owner(), [Symbol('authenticated')]: true, extra: 'proof' };
    assert.equal(contracts.validatePrincipalContract(forged).valid, false);
    const getter = { ...owner() };
    Object.defineProperty(getter, 'role', { enumerable: true, get() { throw new Error('must not evaluate'); } });
    assert.equal(contracts.validatePrincipalContract(getter).valid, false);
    assert.deepEqual(contracts.evaluateAdministrativeAuthorization(adminRequest(), null, null),
        { authorized: false, code: 'trusted_authentication_provider_unavailable' });
});
