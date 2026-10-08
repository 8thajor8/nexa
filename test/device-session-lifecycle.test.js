import test from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluateHypotheticalSession,
    transitionHypotheticalDeviceSession,
    validateDeviceSessionSnapshot,
} from '../src/core/device-session-lifecycle.js';
import { evaluateAuthorizationPolicy } from '../src/core/authorization-engine.js';

const installId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'principal_22222222-2222-4222-8222-222222222222';
const memberId = 'principal_33333333-3333-4333-8333-333333333333';
const ownerAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const memberAccountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deviceId = '77777777-7777-4777-8777-777777777777';
const sessionId = '66666666-6666-4666-8666-666666666666';
const now = '2030-01-01T00:00:00.000Z';
const later = '2030-01-01T00:01:00.000Z';

function principals() {
    return [
        { principalId: ownerId, accountStatus: 'active', role: 'owner', authenticationState: 'authenticated',
            assuranceLevel: 'strong', authenticationMethod: 'native_passkey', memoryPersonId: null, accountEpoch: 2 },
        { principalId: memberId, accountStatus: 'active', role: 'member', authenticationState: 'unauthenticated',
            assuranceLevel: 'none', authenticationMethod: null, memoryPersonId: null, accountEpoch: 3 },
    ];
}
function installation() {
    return { schemaVersion: 1, installationId: installId, bootstrapState: 'active', ownerPrincipalId: ownerId, ownerEpoch: 1 };
}
function device(overrides = {}) {
    return { deviceId, installationId: installId, accountId: memberAccountId, principalId: memberId,
        clientType: 'ios_mobile', displayName: 'Synthetic iPhone', status: 'active', trustLevel: 'unverified',
        createdAt: now, linkedAt: now, revokedAt: null, revision: 2, ...overrides };
}
function session(overrides = {}) {
    return { sessionId, installationId: installId, accountId: memberAccountId, principalId: memberId,
        deviceId, status: 'active', createdAt: now, expiresAt: '2030-01-01T01:00:00.000Z', revokedAt: null,
        accountEpoch: 3, installationEpoch: 1, deviceRevision: 2, revision: 1, supersedesSessionId: null,
        authenticationEvidence: { method: 'passkey', observedAt: now, verificationStatus: 'unverified', source: 'synthetic_fixture' },
        ...overrides };
}
function snapshot(overrides = {}) {
    return { schemaVersion: 1, installation: installation(), installationEpoch: 1, revision: 4, evaluatedAt: now,
        accounts: [{ accountId: ownerAccountId, principalId: ownerId, status: 'active', epoch: 2 },
            { accountId: memberAccountId, principalId: memberId, status: 'active', epoch: 3 }],
        principals: principals(), devices: [device()], sessions: [session()], linkRequests: [], ...overrides };
}
function transition(state, action, extra = {}, at = now) {
    return transitionHypotheticalDeviceSession({ mode: 'hypothetical', action, snapshot: state,
        expectedRevision: state.revision, at, ...extra });
}
function adminAuthorization(state, device, action, at = now) {
    const permissionAction = action === 'bind' ? 'bind' : action;
    const resource = `admin.device.${permissionAction}.device_${device.deviceId}`;
    const installationValue = state.installation;
    const owner = state.principals[0];
    return {
        mode: 'hypothetical', installation: installationValue, principals: state.principals, principalId: ownerId,
        session: { sessionId: '88888888-8888-4888-8888-888888888888', installationId: installId,
            principalId: ownerId, accountEpoch: 2, deviceId: null, authenticationMethod: 'native_passkey',
            assuranceLevel: 'strong', expiresAt: '2030-01-01T01:00:00.000Z', revokedAt: null },
        device: null,
        grants: [{ grantId: '99999999-9999-4999-8999-999999999999', installationId: installId,
            principalId: ownerId, principalEpoch: owner.accountEpoch, permission: 'admin.devices', resourcePattern: 'admin.*',
            scope: 'installation', issuedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z',
            revokedAt: null, grantedByPrincipalId: ownerId }],
        request: { action: 'administer', resource, scope: 'installation', toolName: null, deviceRequired: false,
            subjectPrincipalId: null, subjectConsent: null,
            requirements: [{ permission: 'admin.devices', action: 'administer', resource, scope: 'installation' }],
            independentConfirmation: true },
        risk: 'critical', evaluatedAt: at, expectedRevision: state.revision, currentRevision: state.revision,
    };
}

test('a correctly associated device and session are structurally valid but explicitly unverified', () => {
    const state = snapshot();
    assert.deepEqual(validateDeviceSessionSnapshot(state), { valid: true, code: 'valid_contract' });
    assert.deepEqual(evaluateHypotheticalSession({ mode: 'hypothetical', snapshot: state, sessionId,
        principalId: memberId, installationId: installId, evaluatedAt: now }), {
        decision: 'ALLOW', mode: 'hypothetical', executable: false,
        reasonCode: 'session_structure_consistent_unverified', nextSnapshot: null,
    });
    assert.equal(state.sessions[0].authenticationEvidence.verificationStatus, 'unverified');
});

test('cross-account, cross-installation, pending, suspended, or revoked devices invalidate active sessions', () => {
    for (const altered of [
        device({ principalId: ownerId, accountId: ownerAccountId }),
        device({ installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        device({ status: 'pending', linkedAt: null }),
        device({ status: 'suspended' }),
        device({ status: 'revoked', revokedAt: later }),
    ]) assert.equal(validateDeviceSessionSnapshot(snapshot({ devices: [altered] })).valid, false);
});

test('expired sessions, mismatched device, wrong principal and stale epochs are denied', () => {
    const base = snapshot();
    assert.equal(evaluateHypotheticalSession({ mode: 'hypothetical', snapshot: base, sessionId, principalId: ownerId,
        installationId: installId, evaluatedAt: now }).decision, 'DENY');
    const expired = snapshot({ evaluatedAt: later, sessions: [session({ status: 'expired', expiresAt: now })] });
    assert.equal(evaluateHypotheticalSession({ mode: 'hypothetical', snapshot: expired, sessionId, principalId: memberId,
        installationId: installId, evaluatedAt: later }).decision, 'DENY');
    assert.equal(validateDeviceSessionSnapshot(snapshot({ sessions: [session({ deviceId: null, deviceRevision: null })] })).valid, true);
    assert.equal(validateDeviceSessionSnapshot(snapshot({ sessions: [session({ deviceRevision: 1 })] })).valid, false);
    assert.equal(validateDeviceSessionSnapshot(snapshot({ sessions: [session({
        deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceRevision: 1,
    })] })).valid, false);
    assert.equal(validateDeviceSessionSnapshot(snapshot({ sessions: [session({ accountEpoch: 2 })] })).valid, false);
    assert.equal(evaluateHypotheticalSession({ mode: 'execution', snapshot: base, sessionId,
        principalId: memberId, installationId: installId, evaluatedAt: now }).decision, 'DENY');
});

test('link request is pending until explicitly approved by Owner policy and remains hypothetical', () => {
    const pending = transition(snapshot({ devices: [], sessions: [] }), 'request_device_link', {
        actorPrincipalId: memberId, deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', clientType: 'smartwatch', displayName: 'Synthetic watch',
        expiresAt: '2030-01-01T00:10:00.000Z',
    });
    assert.equal(pending.decision, 'ALLOW');
    assert.equal(pending.executable, false);
    assert.equal(pending.nextSnapshot.devices[0].status, 'pending');
    const target = pending.nextSnapshot.devices[0];
    const noPermission = transition(pending.nextSnapshot, 'approve_device_link', {
        actorPrincipalId: ownerId, requestId: pending.nextSnapshot.linkRequests[0].requestId,
        authorizationInput: { mode: 'execution' },
    });
    assert.equal(noPermission.decision, 'DENY');
    const approved = transition(pending.nextSnapshot, 'approve_device_link', {
        actorPrincipalId: ownerId, requestId: pending.nextSnapshot.linkRequests[0].requestId,
        authorizationInput: adminAuthorization(pending.nextSnapshot, target, 'bind'),
    });
    assert.equal(approved.decision, 'ALLOW');
    assert.equal(approved.executable, false);
    assert.equal(approved.nextSnapshot.devices[0].status, 'active');
    assert.equal(validateDeviceSessionSnapshot(approved.nextSnapshot).valid, true);
});

test('device revocation invalidates its active sessions and historical approval remains consistent', () => {
    const state = snapshot({ linkRequests: [{ requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: installId, accountId: memberAccountId, principalId: memberId, deviceId, status: 'approved',
        requestedAt: now, expiresAt: '2030-01-01T00:10:00.000Z', approvedByPrincipalId: ownerId,
        approvedAt: now, revision: 3 }] });
    assert.equal(validateDeviceSessionSnapshot(state).valid, true);
    const authorizationInput = adminAuthorization(state, state.devices[0], 'revoke', later);
    assert.equal(evaluateAuthorizationPolicy(authorizationInput).decision, 'ALLOW',
        evaluateAuthorizationPolicy(authorizationInput).reasonCode);
    const revoked = transition(state, 'revoke_device', { actorPrincipalId: ownerId, deviceId,
        authorizationInput }, later);
    assert.equal(revoked.decision, 'ALLOW', revoked.reasonCode);
    assert.equal(revoked.nextSnapshot.devices[0].status, 'revoked');
    assert.equal(revoked.nextSnapshot.sessions[0].status, 'revoked');
    assert.equal(validateDeviceSessionSnapshot(revoked.nextSnapshot).valid, true);
    assert.equal(evaluateHypotheticalSession({ mode: 'hypothetical', snapshot: revoked.nextSnapshot, sessionId,
        principalId: memberId, installationId: installId, evaluatedAt: later }).decision, 'DENY');
});

test('renewal rotates a session, rejects stale revision and cannot reuse a revoked session', () => {
    const state = snapshot();
    const args = { principalId: memberId, sessionId, newSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expiresAt: '2030-01-01T02:00:00.000Z', authenticationEvidence: session().authenticationEvidence };
    const renewed = transition(state, 'renew_session', args, later);
    assert.equal(renewed.decision, 'ALLOW');
    assert.equal(renewed.nextSnapshot.sessions[0].status, 'revoked');
    assert.equal(renewed.nextSnapshot.sessions[1].supersedesSessionId, sessionId);
    assert.equal(validateDeviceSessionSnapshot(renewed.nextSnapshot).valid, true);
    assert.equal(transitionHypotheticalDeviceSession({ mode: 'hypothetical', action: 'renew_session', snapshot: state,
        expectedRevision: state.revision - 1, at: later, ...args }).decision, 'DENY');
    assert.equal(transition(renewed.nextSnapshot, 'renew_session', { ...args, sessionId }, '2030-01-01T00:02:00.000Z').decision, 'DENY');
    assert.equal(validateDeviceSessionSnapshot(snapshot({ sessions: [session({ supersedesSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })] })).valid, false);
    const fork = snapshot({ evaluatedAt: later, revision: 5, sessions: [session({ status: 'revoked', revokedAt: later }),
        session({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'active',
            supersedesSessionId: sessionId, createdAt: later }),
        session({ sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'active',
            supersedesSessionId: sessionId, createdAt: later })] });
    assert.equal(validateDeviceSessionSnapshot(fork).valid, false);
});

test('historical approvals cannot be replayed and malformed dates, epochs, and administrative requests fail closed', () => {
    const historical = snapshot({ linkRequests: [{ requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: installId, accountId: memberAccountId, principalId: memberId, deviceId, status: 'approved',
        requestedAt: now, expiresAt: '2030-01-01T00:10:00.000Z', approvedByPrincipalId: ownerId,
        approvedAt: now, revision: 3 }] });
    const replay = transition(historical, 'approve_device_link', { actorPrincipalId: ownerId,
        requestId: historical.linkRequests[0].requestId,
        authorizationInput: adminAuthorization(historical, historical.devices[0], 'bind') });
    assert.equal(replay.decision, 'DENY');
    assert.equal(validateDeviceSessionSnapshot(snapshot({ sessions: [session({ createdAt: '2030-01-01T02:00:00.000Z' })] })).valid, false);
    assert.equal(validateDeviceSessionSnapshot(snapshot({ sessions: [session({
        authenticationEvidence: { ...session().authenticationEvidence, observedAt: '2030-01-01T00:00:01.000Z' },
    })] })).valid, false);
    assert.equal(validateDeviceSessionSnapshot(snapshot({ installationEpoch: 2 })).valid, false);
    assert.equal(validateDeviceSessionSnapshot(snapshot({ accounts: [snapshot().accounts[0],
        { ...snapshot().accounts[1], status: 'suspended' }], principals: [principals()[0], principals()[1]],
    })).valid, false);
    const partialApproval = snapshot({ devices: [device({ status: 'revoked', revokedAt: later })], sessions: [], evaluatedAt: later,
        linkRequests: [{ requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', installationId: installId,
            accountId: memberAccountId, principalId: memberId, deviceId, status: 'expired', requestedAt: now,
            expiresAt: now, approvedByPrincipalId: ownerId, approvedAt: null, revision: 3 }] });
    assert.equal(validateDeviceSessionSnapshot(partialApproval).valid, false);
    const denied = transition(snapshot(), 'suspend_device', { actorPrincipalId: ownerId, deviceId,
        authorizationInput: { ...adminAuthorization(snapshot(), device(), 'suspend'), grants: [] } });
    assert.equal(denied.decision, 'DENY');
});

test('competing transitions from one revision are proposals only, not concurrency protection', () => {
    const state = snapshot({ devices: [], sessions: [] });
    const request = (newDeviceId, requestId) => transition(state, 'request_device_link', {
        actorPrincipalId: memberId, deviceId: newDeviceId, requestId, clientType: 'ios_mobile',
        displayName: 'Synthetic client', expiresAt: '2030-01-01T00:10:00.000Z',
    });
    const first = request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const second = request('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.equal(first.decision, 'ALLOW');
    assert.equal(second.decision, 'ALLOW');
    assert.equal(first.executable, false);
    assert.equal(second.executable, false);
    assert.equal(first.nextSnapshot.revision, second.nextSnapshot.revision);
});

test('expiry and execution requests fail closed; Owner role alone is not a bypass', () => {
    const expiresSoon = '2030-01-01T00:00:30.000Z';
    const expired = transition(snapshot({ sessions: [session({ expiresAt: expiresSoon })] }), 'expire_sessions', {}, later);
    assert.equal(expired.decision, 'ALLOW');
    assert.equal(expired.executable, false);
    assert.equal(expired.nextSnapshot.sessions[0].status, 'expired');
    const execution = transitionHypotheticalDeviceSession({ mode: 'execution', action: 'revoke_device', snapshot: snapshot() });
    assert.deepEqual(execution, { decision: 'DENY', mode: 'execution', executable: false,
        reasonCode: 'trusted_authentication_unavailable', nextSnapshot: null });
    const state = snapshot({ devices: [device({ principalId: ownerId, accountId: ownerAccountId })], sessions: [] });
    const denied = transition(state, 'revoke_device', { actorPrincipalId: ownerId, deviceId,
        authorizationInput: { ...adminAuthorization(state, state.devices[0], 'revoke'), grants: [] } });
    assert.equal(denied.decision, 'DENY');
    assert.equal(evaluateAuthorizationPolicy({ mode: 'execution' }).decision, 'DENY');
});
