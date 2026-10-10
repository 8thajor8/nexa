import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MEMORY_AUTHORIZATION_LIFECYCLE, MEMORY_AUTHORIZATION_OPERATIONS, MEMORY_AUTHORIZATION_VERSION,
    applySyntheticAuthorizationEvent, createSyntheticAuthorizationLifecycle, matchSyntheticAuthorizationReference,
    validateAuthenticationEvidence, validateConfirmationInteraction, validateMemoryAuthorizationRequest,
    validateMemoryIntent, validateMemoryPolicyDecision, verifyExecutableMemoryPermission,
} from '../src/memory/broker-authorization-contract.js';

const hash = value => Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
const future = '2030-01-01T00:00:00.000Z';
const now = '2029-01-01T00:00:00.000Z';

function operation(kind) {
    const base = { kind, resourceKind: 'assertion', resourceId: null, scope: 'private',
        targetFingerprintSha256: null, payloadFingerprintSha256: null, recipientIds: [], administrativeAction: null };
    if (kind === 'read') return { ...base, resourceId: 'assertion-1', targetFingerprintSha256: hash('target') };
    if (kind === 'query') return { ...base, resourceKind: 'query', payloadFingerprintSha256: hash('query') };
    if (kind === 'add') return { ...base, payloadFingerprintSha256: hash('new assertion') };
    if (['replace', 'correct'].includes(kind)) return { ...base, resourceId: 'assertion-1', targetFingerprintSha256: hash('target'), payloadFingerprintSha256: hash('replacement') };
    if (['forget', 'delete'].includes(kind)) return { ...base, resourceId: 'assertion-1', targetFingerprintSha256: hash('target') };
    if (kind === 'share') return { ...base, resourceId: 'assertion-1', targetFingerprintSha256: hash('target'), scope: 'shared', recipientIds: ['principal-b'] };
    if (kind === 'administer') return { ...base, resourceKind: 'device', resourceId: 'device-1', targetFingerprintSha256: hash('device'), payloadFingerprintSha256: hash('revoke'), scope: 'installation', administrativeAction: 'revoke_device' };
    throw Error('unknown test operation');
}
function makeIntent(kind = 'add') {
    const raw = { intentId: 'intent-1', source: 'direct_user', candidateFingerprintSha256: hash('candidate'), operationKind: kind };
    const result = validateMemoryIntent(raw);
    assert.equal(result.valid, true);
    return { raw, result };
}
function makeRequest(kind = 'add', overrides = {}) {
    const intent = makeIntent(kind);
    return {
        contractVersion: MEMORY_AUTHORIZATION_VERSION, requestId: 'request-1',
        intentBinding: { intentId: intent.raw.intentId, intentFingerprintSha256: intent.result.intentFingerprintSha256,
            operationKind: kind },
        principalId: 'principal-a', installationId: 'install-a', sessionId: 'session-a', channel: 'desktop',
        operation: operation(kind), snapshot: { revision: 7, digestSha256: hash('snapshot') },
        requestedAt: now, expiresAt: future, revocationEpoch: 3, sessionEpoch: 5,
        ...overrides,
    };
}
function makeReference(requestInput, overrides = {}) {
    const checked = validateMemoryAuthorizationRequest(requestInput);
    assert.equal(checked.valid, true);
    const req = checked.request;
    return {
        contractVersion: MEMORY_AUTHORIZATION_VERSION, authorizationId: 'authorization-1', requestId: req.requestId,
        principalId: req.principalId, installationId: req.installationId, sessionId: req.sessionId,
        requestFingerprintSha256: checked.requestFingerprintSha256,
        operationFingerprintSha256: checked.operationFingerprintSha256,
        resourceKind: req.operation.resourceKind, resourceId: req.operation.resourceId,
        snapshot: req.snapshot, expiresAt: future, revocationEpoch: req.revocationEpoch,
        sessionEpoch: req.sessionEpoch, opaqueReference: 'oref_abcdefghijklmnopqrstuvwxyz0123456789AB',
        ...overrides,
    };
}
function makeContext(overrides = {}) {
    return { principalId: 'principal-a', installationId: 'install-a', sessionId: 'session-a',
        principalState: 'active', sessionState: 'active', deviceState: 'active', revision: 7,
        digestSha256: hash('snapshot'), revocationEpoch: 3, sessionEpoch: 5,
        now, revokedAuthorizationIds: [], ...overrides };
}
function safe(result) {
    assert.equal(result.authorization, 'DENY'); assert.equal(result.permission, null);
    assert.equal(result.executable, false); assert.equal(result.syntheticOnly, true);
}
function event(state, status, overrides = {}) {
    return { eventId: `event-${state.revision + 1}`, requestId: state.requestId,
        expectedRevision: state.revision, status, occurredAt: now, channel: 'desktop',
        source: 'synthetic_fixture', reasonCode: null,
        authorizationId: ['approved', 'consumed'].includes(status) ? 'authorization-1' : null, ...overrides };
}

test('closed v0.1 request accepts all declared operations and binds independent intent data', () => {
    assert.deepEqual(MEMORY_AUTHORIZATION_OPERATIONS, ['read', 'query', 'add', 'replace', 'correct', 'forget', 'delete', 'share', 'administer']);
    for (const kind of MEMORY_AUTHORIZATION_OPERATIONS) {
        const result = validateMemoryAuthorizationRequest(makeRequest(kind));
        assert.equal(result.valid, true, kind); assert.equal(result.request.operation.kind, kind); safe(result);
    }
    const intent = makeIntent('add');
    assert.equal(intent.result.trust, 'untrusted_content');
    assert.equal(validateMemoryAuthorizationRequest(makeRequest('add', { intentBinding: {
        intentId: intent.raw.intentId, intentFingerprintSha256: hash('different intent'), operationKind: 'add' } })).valid, true);
});

test('unknown fields, malformed objects, inconsistent operation targets, recipients and snapshots fail closed', () => {
    const request = makeRequest();
    assert.equal(validateMemoryAuthorizationRequest({ ...request, extra: true }).code, 'authorization_request_invalid');
    assert.equal(validateMemoryAuthorizationRequest({ ...request, operation: { ...request.operation, extra: true } }).valid, false);
    assert.equal(validateMemoryAuthorizationRequest({ ...request, operation: { ...request.operation, resourceId: 'assertion-2' } }).valid, false);
    assert.equal(validateMemoryAuthorizationRequest({ ...request, operation: { ...request.operation, payloadFingerprintSha256: null } }).valid, false);
    assert.equal(validateMemoryAuthorizationRequest({ ...request, intentBinding: { ...request.intentBinding, operationKind: 'delete' } }).valid, false);
    const share = operation('share');
    assert.equal(validateMemoryAuthorizationRequest(makeRequest('share', { operation: { ...share, recipientIds: ['principal-b', 'principal-b'] } })).valid, false);
    assert.equal(validateMemoryAuthorizationRequest(makeRequest('share', { operation: { ...share, recipientIds: ['principal-z', 'principal-b'] } })).valid, false);
    assert.equal(validateMemoryAuthorizationRequest({ ...request, snapshot: { ...request.snapshot, revision: Number.MAX_SAFE_INTEGER + 1 } }).valid, false);
    const inherited = Object.create({ approved: true }); Object.assign(inherited, request);
    assert.equal(validateMemoryAuthorizationRequest(inherited).valid, false);
    const accessor = { ...request }; Object.defineProperty(accessor, 'principalId', { enumerable: true, get() { throw Error('must not execute'); } });
    assert.equal(validateMemoryAuthorizationRequest(accessor).valid, false);
    safe(validateMemoryAuthorizationRequest(accessor));
});

test('data snapshots read own property descriptors without invoking Proxy getters', () => {
    const request = makeRequest(); let getterCalls = 0;
    const proxiedOperation = new Proxy(request.operation, { get(_target, key) { getterCalls++; return Reflect.get(_target, key); } });
    const proxiedRequest = new Proxy({ ...request, operation: proxiedOperation }, { get(_target, key) { getterCalls++; return Reflect.get(_target, key); } });
    const result = validateMemoryAuthorizationRequest(proxiedRequest);
    assert.equal(result.valid, true); assert.equal(getterCalls, 0); safe(result);
    assert.equal(Object.isFrozen(result.request.operation), true);
    assert.equal(Object.isFrozen(result.request.snapshot), true);
});

test('channel is descriptive metadata and does not alter operation authority', () => {
    const outcomes = ['desktop', 'voice', 'mobile', 'wearable'].map(channel => validateMemoryAuthorizationRequest(makeRequest('read', { channel })));
    assert.ok(outcomes.every(result => result.valid));
    assert.equal(new Set(outcomes.map(result => result.operationFingerprintSha256)).size, 1);
    outcomes.forEach(safe);
});

test('synthetic authorization reference must exactly match operation, resource, snapshot, identity, epochs and expiry', () => {
    const request = makeRequest(), reference = makeReference(request), context = makeContext();
    const matched = matchSyntheticAuthorizationReference(reference, request, context);
    assert.equal(matched.valid, true); assert.equal(matched.outcome, 'reference_matches_synthetic_context'); safe(matched);
    const tampered = [
        [{ ...reference, principalId: 'principal-b' }, request, context],
        [{ ...reference, installationId: 'install-b' }, request, context],
        [{ ...reference, sessionId: 'session-b' }, request, context],
        [{ ...reference, operationFingerprintSha256: hash('other op') }, request, context],
        [{ ...reference, resourceId: 'assertion-2' }, request, context],
        [{ ...reference, snapshot: { revision: 8, digestSha256: hash('other') } }, request, context],
        [reference, request, makeContext({ principalId: 'principal-b' })],
        [reference, request, makeContext({ installationId: 'install-b' })],
        [reference, request, makeContext({ sessionId: 'session-b' })],
    ];
    for (const [ref, req, ctx] of tampered) { const result = matchSyntheticAuthorizationReference(ref, req, ctx); assert.equal(result.valid, false); safe(result); }
});

test('expired, revoked, stale, suspended and epoch-mismatched references deny', () => {
    const request = makeRequest(), reference = makeReference(request);
    for (const context of [
        makeContext({ now: future }), makeContext({ revokedAuthorizationIds: ['authorization-1'] }),
        makeContext({ revision: 8 }), makeContext({ digestSha256: hash('changed') }),
        makeContext({ revocationEpoch: 4 }), makeContext({ sessionEpoch: 6 }),
        makeContext({ principalState: 'suspended' }), makeContext({ sessionState: 'revoked' }),
        makeContext({ deviceState: 'suspended' }), makeContext({ deviceState: 'revoked' }),
    ]) { const result = matchSyntheticAuthorizationReference(reference, request, context); assert.equal(result.valid, false); safe(result); }
    assert.equal(matchSyntheticAuthorizationReference(makeReference(request, { expiresAt: '2028-12-31T00:00:00.000Z' }), request, makeContext()).valid, false);
    assert.equal(matchSyntheticAuthorizationReference(reference, request, makeContext({ revokedAuthorizationIds: ['authorization-1', 'authorization-1'] })).valid, false);
});

test('confirmation, authentication evidence and policy decision are separate non-authoritative records', () => {
    const request = makeRequest();
    const confirmation = validateConfirmationInteraction({ interactionId: 'interaction-1', requestId: 'request-1', channel: 'desktop',
        state: 'answered', responseKind: 'approve', createdAt: now, expiresAt: future, presentationRevision: 0 }, request);
    assert.equal(confirmation.valid, true); assert.equal(confirmation.interpretationOnly, true); safe(confirmation);
    assert.equal(validateConfirmationInteraction({ interactionId: 'interaction-2', requestId: 'request-other', channel: 'desktop',
        state: 'answered', responseKind: 'approve', createdAt: now, expiresAt: future, presentationRevision: 0 }, request).valid, false);
    const noEvidence = validateAuthenticationEvidence({ evidenceId: 'evidence-1', requestId: 'request-1', kind: 'none',
        proofFingerprintSha256: null, verified: false, source: 'synthetic_fixture' }, request);
    assert.equal(noEvidence.valid, true); assert.equal(noEvidence.evidenceTrust, 'unverified_synthetic'); safe(noEvidence);
    assert.equal(validateAuthenticationEvidence({ evidenceId: 'evidence-2', requestId: 'request-1', kind: 'synthetic_webauthn',
        proofFingerprintSha256: hash('proof'), verified: true, source: 'synthetic_fixture' }, request).valid, false);
    const hypothetical = validateMemoryPolicyDecision({ decisionId: 'decision-1', requestId: 'request-1', outcome: 'ALLOW',
        reasonCodes: ['policy_allow_hypothetical'], policyRevision: 'policy-v0.1', synthetic: true }, request);
    assert.equal(hypothetical.valid, true); assert.equal(hypothetical.hypotheticalAllow, true); safe(hypothetical);
    assert.equal(verifyExecutableMemoryPermission({ any: 'claim' }).code, 'real_permission_verifier_unavailable');
    safe(verifyExecutableMemoryPermission({ executable: true, grant: 'forged' }));
});

test('confirmation timestamps cannot predate or outlive the bound request', () => {
    const request = makeRequest();
    const base = { interactionId: 'interaction-time', requestId: request.requestId, channel: request.channel,
        state: 'answered', responseKind: 'approve', createdAt: now, expiresAt: future, presentationRevision: 0 };
    assert.equal(validateConfirmationInteraction(base, request).valid, true);
    assert.equal(validateConfirmationInteraction({ ...base, createdAt: '2028-12-31T23:59:59.999Z' }, request).valid, false);
    assert.equal(validateConfirmationInteraction({ ...base, createdAt: future }, request).valid, false);
    const changedChannelRequest = makeRequest('add', { channel: 'voice' });
    const desktopBoundReference = makeReference(request);
    const channelSubstitution = matchSyntheticAuthorizationReference(desktopBoundReference, changedChannelRequest, makeContext());
    assert.equal(channelSubstitution.valid, false);
    safe(channelSubstitution);
});

test('lifecycle rejects impossible fabricated snapshots while favorable states stay non-executable', () => {
    const request = makeRequest();
    const initial = createSyntheticAuthorizationLifecycle(request).lifecycle;
    const fabricated = [
        { ...initial, status: 'approved' },
        { ...initial, status: 'consumed', authorizationId: 'authorization-1' },
        { ...initial, status: 'pending', revision: 1, eventIds: ['event-1'], lastEventAt: now },
        { ...initial, status: 'presented', revision: 2, eventIds: ['event-1'], lastEventAt: now },
        { ...initial, status: 'denied', revision: 1, eventIds: ['event-1'], authorizationId: 'authorization-1', lastEventAt: now },
    ];
    for (const state of fabricated) {
        const result = applySyntheticAuthorizationEvent(state, event(state, 'revoked'), request);
        assert.equal(result.valid, false);
        assert.equal(result.code, 'lifecycle_state_inconsistent');
        safe(result);
    }
    const presented = applySyntheticAuthorizationEvent(initial, event(initial, 'presented'), request);
    const approved = applySyntheticAuthorizationEvent(presented.lifecycle, event(presented.lifecycle, 'approved'), request);
    const consumed = applySyntheticAuthorizationEvent(approved.lifecycle, event(approved.lifecycle, 'consumed'), request);
    assert.equal(approved.valid, true); safe(approved);
    assert.equal(consumed.valid, true); safe(consumed);
    assert.equal(applySyntheticAuthorizationEvent({ ...consumed.lifecycle, revision: 2 }, event(consumed.lifecycle, 'consumed'), request).valid, false);
});

test('hostile proxies, cycles, coercion hooks and throwing descriptors fail without leaking input', () => {
    const request = makeRequest();
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('private-marker'); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const cyclic = { ...request }; cyclic.operation = { ...request.operation, recipientIds: [] }; cyclic.loop = cyclic;
    const coercion = { [Symbol.toPrimitive]() { throw new Error('private-marker'); } };
    const results = [
        validateMemoryAuthorizationRequest(hostile),
        validateMemoryAuthorizationRequest(revoked.proxy),
        validateMemoryAuthorizationRequest(cyclic),
        validateMemoryAuthorizationRequest({ ...request, principalId: coercion }),
        validateConfirmationInteraction(hostile, request),
        validateAuthenticationEvidence(hostile, request),
        validateMemoryPolicyDecision(hostile, request),
        matchSyntheticAuthorizationReference(hostile, request, makeContext()),
        applySyntheticAuthorizationEvent(hostile, hostile, request),
    ];
    for (const result of results) {
        assert.equal(result.valid, false);
        safe(result);
        assert.equal(JSON.stringify(result).includes('private-marker'), false);
    }
});

test('lifecycle transitions are closed, versioned, revision-bound and replay-resistant within the supplied state', () => {
    const request = makeRequest();
    const initial = createSyntheticAuthorizationLifecycle(request);
    assert.equal(initial.valid, true); assert.equal(initial.lifecycle.status, 'pending'); safe(initial);
    const presented = applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'presented'), request);
    assert.equal(presented.lifecycle.status, 'presented'); safe(presented);
    const approved = applySyntheticAuthorizationEvent(presented.lifecycle, event(presented.lifecycle, 'approved'), request);
    assert.equal(approved.lifecycle.status, 'approved'); safe(approved);
    const consumed = applySyntheticAuthorizationEvent(approved.lifecycle, event(approved.lifecycle, 'consumed'), request);
    assert.equal(consumed.lifecycle.status, 'consumed'); safe(consumed);
    assert.equal(applySyntheticAuthorizationEvent(consumed.lifecycle, event(consumed.lifecycle, 'consumed'), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'approved'), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'presented', { source: 'model' }), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'presented', { requestId: 'request-other' }), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'presented', { channel: 'voice' }), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'presented', { occurredAt: '2028-12-31T00:00:00.000Z' }), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'expired'), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'revoked', { authorizationId: 'forged-authorization' }), request).valid, false);
    assert.equal(applySyntheticAuthorizationEvent(initial.lifecycle, event(initial.lifecycle, 'cancelled', { authorizationId: 'forged-authorization' }), request).valid, false);
    const duplicateEvent = event(presented.lifecycle, 'approved', { eventId: 'event-1' });
    assert.equal(applySyntheticAuthorizationEvent(presented.lifecycle, duplicateEvent, request).valid, false);
    const outOfOrder = applySyntheticAuthorizationEvent(presented.lifecycle, event(presented.lifecycle, 'approved', { occurredAt: '2028-12-31T00:00:00.000Z' }), request);
    assert.equal(outOfOrder.valid, false);
    assert.deepEqual(MEMORY_AUTHORIZATION_LIFECYCLE, ['pending', 'presented', 'approved', 'denied', 'cancelled', 'expired', 'revoked', 'consumed']);
});

test('request, confirmation and lifecycle outputs never issue executable permissions', () => {
    for (const result of [validateMemoryAuthorizationRequest(makeRequest()), validateConfirmationInteraction({}, makeRequest()),
        createSyntheticAuthorizationLifecycle(makeRequest()), verifyExecutableMemoryPermission(null)]) safe(result);
});
