import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { defaultPermissionPolicy, toolPermissions } from '../src/tools/permissions.js';
import {
    evaluateAuthorizationPolicy,
    validatePermissionGrantContract,
} from '../src/core/authorization-engine.js';

const installationId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'principal_22222222-2222-4222-8222-222222222222';
const memberId = 'principal_33333333-3333-4333-8333-333333333333';
const ownerPerson = 'person_44444444-4444-4444-8444-444444444444';
const memberPerson = 'person_55555555-5555-4555-8555-555555555555';
const evaluatedAt = '2030-01-01T00:00:00.000Z';

function owner(overrides = {}) {
    return { principalId: ownerId, accountStatus: 'active', role: 'owner', authenticationState: 'authenticated',
        assuranceLevel: 'strong', authenticationMethod: 'native_passkey', memoryPersonId: ownerPerson, accountEpoch: 4, ...overrides };
}
function member(overrides = {}) {
    return { principalId: memberId, accountStatus: 'active', role: 'member', authenticationState: 'authenticated',
        assuranceLevel: 'standard', authenticationMethod: 'native_passkey', memoryPersonId: memberPerson, accountEpoch: 2, ...overrides };
}
function installation() {
    return { schemaVersion: 1, installationId, bootstrapState: 'active', ownerPrincipalId: ownerId, ownerEpoch: 1 };
}
function session(principal = owner(), overrides = {}) {
    return { sessionId: '66666666-6666-4666-8666-666666666666', installationId,
        principalId: principal.principalId, accountEpoch: principal.accountEpoch, deviceId: null,
        authenticationMethod: principal.authenticationMethod, assuranceLevel: principal.assuranceLevel,
        expiresAt: '2030-01-01T01:00:00.000Z', revokedAt: null, ...overrides };
}
function grant(principal, permission, resourcePattern, scope, overrides = {}) {
    return { grantId: overrides.grantId ?? '77777777-7777-4777-8777-777777777777', installationId,
        principalId: principal.principalId, principalEpoch: principal.accountEpoch, permission, resourcePattern,
        scope, issuedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z',
        revokedAt: null, grantedByPrincipalId: ownerId, ...overrides };
}
function requirement(permission, resource, scope) {
    const action = permission === 'tool.execute' ? 'execute'
        : permission === 'data.write' || permission === 'memory.write' ? 'write'
            : permission.startsWith('admin.') ? 'administer'
                : permission === 'external.action' ? 'external_action'
                    : permission === 'automation.manage' ? 'automate' : 'read';
    return { permission, action, resource, scope };
}
function input({ principal = owner(), requirements = [requirement('data.read', 'email.message', 'own')],
    requestOverrides = {}, grants = [], otherPrincipals = [], overrides = {} } = {}) {
    const request = { action: 'read', resource: requirements[0].resource, scope: requirements[0].scope,
        toolName: null, deviceRequired: false, subjectPrincipalId: null, subjectConsent: null, requirements,
        independentConfirmation: false, ...requestOverrides };
    const principals = principal.role === 'owner'
        ? [principal, ...otherPrincipals]
        : [owner(), principal, ...otherPrincipals.filter(item => item.principalId !== principal.principalId
            && item.principalId !== ownerId)];
    return { mode: 'hypothetical', installation: installation(), principals,
        principalId: principal.principalId, session: session(principal), device: null, grants, request, risk: 'normal',
        evaluatedAt, expectedRevision: 7, currentRevision: 7, ...overrides };
}
function consent(subjectId, recipientId) {
    return { consentId: '88888888-8888-4888-8888-888888888888', subjectPrincipalId: subjectId,
        grantedToPrincipalId: recipientId, grantedAt: '2029-01-01T00:00:00.000Z',
        expiresAt: '2031-01-01T00:00:00.000Z', revokedAt: null };
}

test('unauthenticated, suspended, revoked, stale, or malformed principals and sessions deny', () => {
    const requirementValue = requirement('data.read', 'email.message', 'own');
    const allowedGrant = grant(owner(), 'data.read', 'email.message', 'own');
    assert.equal(evaluateAuthorizationPolicy(input({ principal: owner({ authenticationState: 'unauthenticated',
        assuranceLevel: 'none', authenticationMethod: null }), requirements: [requirementValue], grants: [allowedGrant] })).reasonCode,
    'principal_not_verified');
    assert.equal(evaluateAuthorizationPolicy(input({ principal: member({ accountStatus: 'suspended' }),
        requirements: [requirementValue], grants: [grant(member(), 'data.read', 'email.message', 'own')] })).reasonCode,
    'principal_inactive_or_missing');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [requirementValue], grants: [allowedGrant],
        overrides: { session: session(owner(), { revokedAt: '2029-12-31T00:00:00.000Z' }) } })).reasonCode,
    'session_invalid_or_stale');
});

test('execution mode always denies despite Owner-shaped identity, grants, or model claims', () => {
    const request = input({ requirements: [requirement('admin.users', 'admin.user', 'installation')],
        requestOverrides: { action: 'administer', resource: 'admin.user', scope: 'installation' },
        grants: [grant(owner(), 'admin.users', 'admin.user', 'installation')] });
    assert.deepEqual(evaluateAuthorizationPolicy({ ...request, mode: 'execution', modelClaim: { role: 'owner' } }), {
        decision: 'DENY', mode: 'execution', executable: false, reasonCode: 'trusted_authentication_unavailable',
        additionalRequirements: ['native_authenticated_principal', 'trusted_session', 'trusted_grant_registry',
            'request_bound_capability'],
        audit: { policyVersion: 'c5g2-v1', principalId: null, action: null, resource: null },
    });
    assert.equal(evaluateAuthorizationPolicy({ ...request, mode: 'hypothetical' }).executable, false);
});

test('Member cannot administer even with a synthetic Owner-issued admin grant', () => {
    const syntheticMember = member();
    const adminRequirement = requirement('admin.users', 'admin.user', 'installation');
    const result = evaluateAuthorizationPolicy(input({ principal: syntheticMember, otherPrincipals: [syntheticMember],
        requirements: [adminRequirement], requestOverrides: { action: 'administer', resource: 'admin.user', scope: 'installation' },
        grants: [grant(syntheticMember, 'admin.users', 'admin.user', 'installation')] }));
    assert.equal(result.decision, 'DENY');
    assert.equal(result.reasonCode, 'owner_role_required');
});

test('Owner administration requires strong assurance and a separate explicit scoped grant', () => {
    const adminRequirement = requirement('admin.users', 'admin.user', 'installation');
    const requestOverrides = { action: 'administer', resource: 'admin.user', scope: 'installation' };
    const noGrant = evaluateAuthorizationPolicy(input({ requirements: [adminRequirement], requestOverrides }));
    assert.equal(noGrant.reasonCode, 'explicit_permission_missing_or_out_of_scope');
    const weakOwner = owner({ assuranceLevel: 'standard' });
    const weakResult = evaluateAuthorizationPolicy(input({ principal: weakOwner, requirements: [adminRequirement],
        requestOverrides, grants: [grant(weakOwner, 'admin.users', 'admin.user', 'installation')] }));
    assert.equal(weakResult.reasonCode, 'strong_authentication_required');
    const good = evaluateAuthorizationPolicy(input({ requirements: [adminRequirement], requestOverrides,
        grants: [grant(owner(), 'admin.users', 'admin.user', 'installation')] }));
    assert.equal(good.decision, 'ALLOW');
    assert.equal(good.mode, 'hypothetical');
    assert.equal(good.executable, false);
});

test('Owner has no implicit access to another user private memory; consent must be subject-specific', () => {
    const privateRequirement = requirement('memory.private.read', 'memory.private.profile', 'private');
    const memoryGrant = grant(owner(), 'memory.private.read', 'memory.private.*', 'private');
    const requestOverrides = { resource: 'memory.private.profile', scope: 'private', subjectPrincipalId: memberId };
    const denied = evaluateAuthorizationPolicy(input({ otherPrincipals: [member()], requirements: [privateRequirement], requestOverrides,
        grants: [memoryGrant] }));
    assert.equal(denied.reasonCode, 'private_subject_consent_required');
    const consented = evaluateAuthorizationPolicy(input({ otherPrincipals: [member()], requirements: [privateRequirement], requestOverrides: {
        ...requestOverrides, subjectConsent: consent(memberId, ownerId) }, grants: [memoryGrant] }));
    assert.equal(consented.decision, 'ALLOW');
    assert.equal(consented.executable, false);
});

test('permissions are bound to principal, installation, epoch, action, resource and scope', () => {
    const r = requirement('data.read', 'email.message', 'own');
    const ownerGrant = grant(owner(), 'data.read', 'email.message', 'own');
    const success = evaluateAuthorizationPolicy(input({ requirements: [r], grants: [ownerGrant] }));
    assert.equal(success.decision, 'ALLOW');
    assert.equal(success.executable, false);
    assert.equal(success.audit.resource, 'email');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], requestOverrides: { subjectPrincipalId: memberId },
        grants: [ownerGrant] })).reasonCode, 'own_scope_subject_mismatch');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [grant(owner(), 'data.read', 'spotify.track', 'own')] })).decision,
        'DENY');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [grant(owner(), 'data.read', 'email.message', 'shared')] })).decision,
        'DENY');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [grant(owner(), 'data.read', 'email.message', 'own', {
        expiresAt: '2029-12-31T00:00:00.000Z' })] })).reasonCode, 'explicit_permission_missing_or_out_of_scope');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [grant(owner(), 'data.read', 'email.message', 'own', {
        revokedAt: '2029-12-31T00:00:00.000Z' })] })).reasonCode, 'explicit_permission_missing_or_out_of_scope');
    for (const requestOverrides of [
        { resource: 'file.secret' },
        { scope: 'private' },
        { action: 'write' },
        { resource: 'file.secret', scope: 'private' },
    ]) {
        assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], requestOverrides, grants: [ownerGrant] })).decision,
            'DENY');
    }
    assert.equal(validatePermissionGrantContract(grant(owner(), 'data.read', 'email.message', 'installation')), false);
    assert.equal(validatePermissionGrantContract(grant(owner(), 'data.read', 'tool.*', 'own')), false);
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [
        grant(owner(), 'data.read', 'file.*', 'own'),
    ] })).reasonCode, 'explicit_permission_missing_or_out_of_scope');
    const contradictoryRequirements = [r, requirement('data.write', 'email.message', 'own')];
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: contradictoryRequirements,
        grants: [grant(owner(), 'data.read', 'email.message', 'own'),
            grant(owner(), 'data.write', 'email.message', 'own', { grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })] })).reasonCode,
    'authorization_input_invalid');
});

test('tool permission does not confer data permission and Spotify grants do not cover email', () => {
    const reqs = [requirement('tool.execute', 'tool.read_email', 'installation'),
        requirement('data.read', 'email.message', 'own')];
    const reqOverrides = { action: 'execute', toolName: 'read_email', resource: 'tool.read_email', scope: 'installation' };
    const toolOnly = evaluateAuthorizationPolicy(input({ requirements: reqs, requestOverrides: reqOverrides,
        grants: [grant(owner(), 'tool.execute', 'tool.read_email', 'installation')] }));
    assert.equal(toolOnly.reasonCode, 'explicit_permission_missing_or_out_of_scope');
    const spotifyGrant = grant(owner(), 'tool.execute', 'tool.spotify_play', 'installation');
    const emailTool = evaluateAuthorizationPolicy(input({ requirements: reqs, requestOverrides: reqOverrides,
        grants: [spotifyGrant] }));
    assert.equal(emailTool.reasonCode, 'explicit_permission_missing_or_out_of_scope');
});

test('stale snapshots, revoked devices, and critical operations without step-up deny', () => {
    const r = requirement('data.read', 'email.message', 'own');
    const g = grant(owner(), 'data.read', 'email.message', 'own');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: { currentRevision: 8 } })).reasonCode,
        'authorization_snapshot_stale');
    const revokedDevice = { deviceId: '99999999-9999-4999-8999-999999999999', installationId, principalId: ownerId,
        status: 'revoked', createdAt: '2029-01-01T00:00:00.000Z', revokedAt: '2029-12-31T00:00:00.000Z' };
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: {
        request: { action: 'read', resource: r.resource, scope: r.scope, toolName: null, deviceRequired: true,
            subjectPrincipalId: null, subjectConsent: null, requirements: [r], independentConfirmation: false },
        device: revokedDevice, session: session(owner(), { deviceId: revokedDevice.deviceId }) } })).reasonCode,
    'device_invalid_or_revoked');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: {
        request: { action: 'read', resource: r.resource, scope: r.scope, toolName: null, deviceRequired: true,
            subjectPrincipalId: null, subjectConsent: null, requirements: [r], independentConfirmation: false },
    } })).reasonCode, 'device_required');
    const boundSession = session(owner(), { deviceId: revokedDevice.deviceId });
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: {
        session: boundSession,
    } })).reasonCode, 'device_required');
    const activeDevice = { ...revokedDevice, status: 'active', revokedAt: null };
    const boundRequest = { action: 'read', resource: r.resource, scope: r.scope, toolName: null,
        deviceRequired: false, subjectPrincipalId: null, subjectConsent: null, requirements: [r], independentConfirmation: false };
    const evaluateBoundDevice = (device, sessionValue = session(owner(), { deviceId: activeDevice.deviceId })) =>
        evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: {
            request: boundRequest, session: sessionValue, device,
        } }));
    assert.equal(evaluateBoundDevice(activeDevice).decision, 'ALLOW');
    assert.equal(evaluateBoundDevice({ ...activeDevice, principalId: memberId }).reasonCode, 'device_invalid_or_revoked');
    assert.equal(evaluateBoundDevice({ ...activeDevice, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).reasonCode,
        'device_invalid_or_revoked');
    assert.equal(evaluateBoundDevice(activeDevice, session(owner())).reasonCode, 'device_invalid_or_revoked');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: {
        session: session(owner(), { installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    } })).reasonCode, 'session_invalid_or_stale');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: {
        session: session(owner(), { accountEpoch: owner().accountEpoch + 1 }),
    } })).reasonCode, 'session_invalid_or_stale');
    const critical = evaluateAuthorizationPolicy(input({ requirements: [r], grants: [g], overrides: { risk: 'critical' } }));
    assert.equal(critical.reasonCode, 'independent_confirmation_required');
});

test('two synthetic users remain isolated and an unauthorised grantor cannot grant permissions', () => {
    const syntheticMember = member();
    const r = requirement('data.read', 'email.message', 'own');
    const ownerGrant = grant(owner(), 'data.read', 'email.message', 'own');
    const memberGrant = grant(syntheticMember, 'data.read', 'email.message', 'own', { grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const memberEvaluation = evaluateAuthorizationPolicy(input({ principal: syntheticMember,
        requirements: [r], grants: [ownerGrant] }));
    assert.equal(memberEvaluation.reasonCode, 'explicit_permission_missing_or_out_of_scope');
    assert.equal(evaluateAuthorizationPolicy(input({ principal: syntheticMember,
        requirements: [r], grants: [grant(syntheticMember, 'data.read', 'email.message', 'own', {
            grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', grantedByPrincipalId: memberId })] })).decision, 'DENY');
    assert.equal(evaluateAuthorizationPolicy(input({ principal: syntheticMember,
        requirements: [r], grants: [memberGrant] })).decision, 'ALLOW');
});

test('invalid grant fields, hostile model claims, and extra authorization input fail closed', () => {
    const malformed = grant(owner(), 'data.read', '*', 'own');
    assert.equal(validatePermissionGrantContract(malformed), false);
    const valid = grant(owner(), 'data.read', 'email.message', 'own');
    const claim = { ...input({ requirements: [requirement('data.read', 'email.message', 'own')], grants: [valid] }),
        modelClaim: { role: 'owner', permission: '*' } };
    assert.equal(evaluateAuthorizationPolicy(claim).decision, 'DENY');
    assert.equal(evaluateAuthorizationPolicy({ mode: 'execution', role: 'owner' }).decision, 'DENY');
    assert.equal(evaluateAuthorizationPolicy({ mode: 'hypothetical' }).decision, 'DENY');
    const incomplete = input({ requirements: [requirement('data.read', 'email.message', 'own')],
        grants: [grant(owner(), 'data.read', 'email.message', 'own')] });
    incomplete.request.requirements = [];
    assert.equal(evaluateAuthorizationPolicy(incomplete).decision, 'DENY');
    const permissionActionMismatch = input({ requirements: [{ permission: 'data.write', action: 'read',
        resource: 'email.message', scope: 'own' }], grants: [grant(owner(), 'data.write', 'email.message', 'own')] });
    assert.equal(evaluateAuthorizationPolicy(permissionActionMismatch).decision, 'DENY');
    const scopeMismatch = input({ requirements: [requirement('memory.private.read', 'memory.private.profile', 'own')],
        grants: [grant(owner(), 'memory.private.read', 'memory.private.profile', 'own')] });
    assert.equal(evaluateAuthorizationPolicy(scopeMismatch).decision, 'DENY');
    const duplicate = grant(owner(), 'data.read', 'email.message', 'own');
    assert.equal(evaluateAuthorizationPolicy(input({ requirements: [requirement('data.read', 'email.message', 'own')],
        grants: [duplicate, { ...duplicate, grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] })).reasonCode,
    'authorization_input_invalid');
});

test('engine remains disconnected from production and current global tool permissions are unchanged', async () => {
    const root = new URL('../', import.meta.url);
    const paths = ['src/index.js', 'src/core/agent.js', 'src/tools/permissions.js', 'src/memory/json-repository.js'];
    const tools = await readdir(new URL('src/tools/', root));
    paths.push(...tools.filter(file => file.endsWith('.js')).map(file => `src/tools/${file}`));
    for (const path of paths) {
        const source = await readFile(new URL(path, root), 'utf8');
        assert.doesNotMatch(source, /authorization-engine/u, path);
    }
    assert.deepEqual(defaultPermissionPolicy, { read: true, external_read: true, write: true, action: true, destructive: false });
    assert.equal(toolPermissions.recall, 'read');
    assert.equal(toolPermissions.remember, 'write');
});
