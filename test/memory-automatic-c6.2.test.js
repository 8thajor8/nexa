import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateHypotheticalAutomaticMemoryGate, isHypotheticalAutomaticMemoryGateDecision } from '../src/memory/automatic/authorization-gate.js';
import { simulateSelectiveMemoryAssessment } from '../src/memory/automatic/selective-simulation.js';

const installId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'principal_22222222-2222-4222-8222-222222222222';
const memberId = 'principal_33333333-3333-4333-8333-333333333333';
const ownerPerson = 'person_44444444-4444-4444-8444-444444444444';
const memberPerson = 'person_55555555-5555-4555-8555-555555555555';
const ownerAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const memberAccountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deviceId = '77777777-7777-4777-8777-777777777777';
const sessionId = '66666666-6666-4666-8666-666666666666';
const turnId = 'turn-synthetic-01';
const now = '2030-01-01T00:00:00.000Z';
const later = '2030-01-01T01:00:00.000Z';
const textHash = 'a'.repeat(64);
const evidenceHash = 'b'.repeat(64);

function candidate(overrides = {}) {
    return { classification: 'auto_save_candidate', operation: 'ADD', sensitivity: 'none', conflict: false,
        candidateType: 'preference', updateIntent: 'new_fact', subjectPersonId: memberPerson, mentionedPersonText: null,
        turnId, sourceTextSha256: textHash, evidenceSha256: evidenceHash, ...overrides };
}
function principals() {
    return [
        { principalId: ownerId, accountStatus: 'active', role: 'owner', authenticationState: 'authenticated',
            assuranceLevel: 'strong', authenticationMethod: 'native_passkey', memoryPersonId: ownerPerson, accountEpoch: 4 },
        { principalId: memberId, accountStatus: 'active', role: 'member', authenticationState: 'authenticated',
            assuranceLevel: 'standard', authenticationMethod: 'native_passkey', memoryPersonId: memberPerson, accountEpoch: 2 },
    ];
}
function device(overrides = {}) {
    return { deviceId, installationId: installId, accountId: memberAccountId, principalId: memberId,
        clientType: 'ios_mobile', displayName: 'Synthetic iPhone', status: 'active', trustLevel: 'unverified',
        createdAt: now, linkedAt: now, revokedAt: null, revision: 2, ...overrides };
}
function lifecycleSession(overrides = {}) {
    return { sessionId, installationId: installId, accountId: memberAccountId, principalId: memberId,
        deviceId, status: 'active', createdAt: now, expiresAt: '2030-01-01T02:00:00.000Z', revokedAt: null,
        accountEpoch: 2, installationEpoch: 1, deviceRevision: 2, revision: 1, supersedesSessionId: null,
        authenticationEvidence: { method: 'passkey', observedAt: now, verificationStatus: 'unverified', source: 'synthetic_fixture' },
        ...overrides };
}
function deviceSnapshot(overrides = {}) {
    return { schemaVersion: 1,
        installation: { schemaVersion: 1, installationId: installId, bootstrapState: 'active', ownerPrincipalId: ownerId, ownerEpoch: 1 },
        installationEpoch: 1, revision: 7, evaluatedAt: now,
        accounts: [{ accountId: ownerAccountId, principalId: ownerId, status: 'active', epoch: 4 },
            { accountId: memberAccountId, principalId: memberId, status: 'active', epoch: 2 }],
        principals: principals(), devices: [device()], sessions: [lifecycleSession()], linkRequests: [], ...overrides };
}
function permissionGrant(scope = 'own') {
    return { grantId: '88888888-8888-4888-8888-888888888888', installationId: installId,
        principalId: memberId, principalEpoch: 2, permission: 'memory.write', resourcePattern: 'memory.automatic.*',
        scope, issuedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z', revokedAt: null,
        grantedByPrincipalId: ownerId };
}
function authorizationInput(scope = 'own') {
    const principalValues = principals();
    const request = { action: 'write', resource: 'memory.automatic.add', scope, toolName: null,
        deviceRequired: false, subjectPrincipalId: memberId, subjectConsent: null,
        requirements: [{ permission: 'memory.write', action: 'write', resource: 'memory.automatic.add', scope }],
        independentConfirmation: false };
    return { mode: 'hypothetical', installation: deviceSnapshot().installation, principals: principalValues,
        principalId: memberId, session: { sessionId, installationId: installId, principalId: memberId,
            accountEpoch: 2, deviceId, authenticationMethod: 'native_passkey', assuranceLevel: 'standard',
            expiresAt: '2030-01-01T02:00:00.000Z', revokedAt: null },
        device: { deviceId, installationId: installId, principalId: memberId, status: 'active', createdAt: now, revokedAt: null },
        grants: [permissionGrant(scope)], request, risk: 'normal', evaluatedAt: now, expectedRevision: 7, currentRevision: 7 };
}
function consent(overrides = {}) {
    return { fixtureOnly: true, consentId: '99999999-9999-4999-8999-999999999999', principalId: memberId,
        subjectPersonId: memberPerson, installationId: installId, principalEpoch: 2, installationEpoch: 1,
        purpose: 'automatic_memory_autosave', scope: 'private', recipientPrincipalIds: [],
        candidateType: 'preference', grantedAt: now,
        expiresAt: '2031-01-01T00:00:00.000Z', revokedAt: null, revision: 7, ...overrides };
}
function input(overrides = {}) {
    return { mode: 'hypothetical', candidate: candidate(),
        provenance: { status: 'synthetic_verified', sourceKind: 'direct_user', turnId, sourceTextSha256: textHash,
            evidenceSha256: evidenceHash, sessionId, principalId: memberId, fixtureOnly: true },
        identity: { fixtureOnly: true, status: 'synthetic_verified', principalId: memberId, memoryPersonId: memberPerson,
            principalEpoch: 2, installationId: installId, installationEpoch: 1, sessionId, selfBindingStatus: 'linked' },
        consent: consent(), scope: { kind: 'private', installationId: installId, ownerPrincipalId: memberId,
            subjectPersonId: memberPerson, recipientPrincipalIds: [] }, authorizationInput: authorizationInput(),
        deviceSnapshot: deviceSnapshot(), sessionId, evaluatedAt: now,
        expectedRevisions: { authorization: { expected: 7, current: 7 }, consent: { expected: 7, current: 7 },
            deviceSnapshot: { expected: 7, current: 7 }, principalEpoch: { expected: 2, current: 2 },
            installationEpoch: { expected: 1, current: 1 } }, optOut: false, executionRequested: false, ...overrides };
}

test('coherent synthetic low-risk private ADD is only hypothetically eligible', () => {
    const result = evaluateHypotheticalAutomaticMemoryGate(input());
    assert.equal(result.decision, 'ELIGIBLE_HYPOTHETICAL');
    assert.equal(result.executable, false);
    assert.deepEqual(result.reasonCodes, ['hypothetical_requirements_satisfied_no_authority_issued']);
});

test('identity, Self, consent, opt-out, and lifecycle failures fail closed or require review', () => {
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ identity: null })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ consent: null })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ provenance: null })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ consent: consent({ expiresAt: now }) })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ consent: consent({ revokedAt: now }) })).reasonCodes[0], 'consent_revoked');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ optOut: true })).reasonCodes[0], 'automatic_memory_opt_out');
    const revokedDevice = device({ status: 'revoked', revokedAt: now, revision: 3 });
    const revokedSession = lifecycleSession({ status: 'revoked', revokedAt: now, deviceRevision: 2 });
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ deviceSnapshot: deviceSnapshot({ revision: 8,
        evaluatedAt: later, devices: [revokedDevice], sessions: [revokedSession] }), evaluatedAt: later,
        expectedRevisions: { authorization: { expected: 7, current: 7 }, consent: { expected: 7, current: 7 },
            deviceSnapshot: { expected: 8, current: 8 }, principalEpoch: { expected: 2, current: 2 },
            installationEpoch: { expected: 1, current: 1 } } })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ expectedRevisions: { ...input().expectedRevisions,
        authorization: { expected: 6, current: 7 } } })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ subjectPersonId: ownerPerson }) })).decision, 'DENY');
});

test('private isolation, shared authorization, sensitivity, replacement, and conflict rules are conservative', () => {
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ scope: { ...input().scope, ownerPrincipalId: ownerId,
        subjectPersonId: ownerPerson }, candidate: candidate({ subjectPersonId: ownerPerson }) })).decision, 'DENY');
    const sharedScope = { kind: 'shared', installationId: installId, ownerPrincipalId: memberId,
        subjectPersonId: memberPerson, recipientPrincipalIds: [ownerId] };
    const sharedConsent = consent({ scope: 'shared', recipientPrincipalIds: [ownerId] });
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ scope: sharedScope, consent: sharedConsent,
        authorizationInput: authorizationInput('shared') })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ scope: { ...sharedScope,
        recipientPrincipalIds: ['principal_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }, consent: sharedConsent,
        authorizationInput: authorizationInput('shared') })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ scope: sharedScope, consent: sharedConsent,
        authorizationInput: authorizationInput('own') })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ authorizationInput: { ...authorizationInput(), grants: [] } })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ sensitivity: 'health' }) })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ mentionedPersonText: 'Coti' }) })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ operation: 'REPLACE' }) })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ conflict: true }) })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ candidateType: 'decision' }) })).decision, 'ASK');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ candidateType: 'learning_activity' }) })).decision, 'DENY');
});

test('external sources, execution requests, and attempts to reuse a hypothetical result cannot authorize writes', () => {
    const externalAsk = input({ candidate: candidate({ classification: 'ask', operation: 'ASK' }),
        provenance: { ...input().provenance, sourceKind: 'tool_output', status: 'external' } });
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(externalAsk).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ mode: 'execution' })).decision, 'DENY');
    const executionRequest = evaluateHypotheticalAutomaticMemoryGate(input({ executionRequested: true }));
    assert.equal(executionRequest.decision, 'DENY');
    assert.equal(executionRequest.executable, false);
    assert.equal(isHypotheticalAutomaticMemoryGateDecision(executionRequest), false);
    const forgedAsAuthorization = evaluateHypotheticalAutomaticMemoryGate(input({ authorizationInput: executionRequest }));
    assert.notEqual(forgedAsAuthorization.decision, 'ELIGIBLE_HYPOTHETICAL');
    assert.equal(forgedAsAuthorization.executable, false);
});

test('C.6.1 simulation remains disconnected and passes only untrusted provenance to the gate', () => {
    const text = 'Prefiero respuestas breves.';
    const proposal = { candidates: [{ candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference',
        value_text: text, mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact',
        sensitivity: 'none', suggested_disposition: 'auto_save', evidence_quote: text }] };
    const simulated = simulateSelectiveMemoryAssessment({ text, proposal, sourceId: 'user:direct',
        consentScenario: { state: 'granted', messageOptOut: false }, conversationOptOut: false, identityStatus: 'unverified' });
    assert.equal(simulated.candidates[0].authorizationGate.decision, 'ASK');
    assert.equal(simulated.candidates[0].authorizationGate.executable, false);
    assert.equal(simulated.authorization.granted, false);
    assert.equal(simulated.persistence.performed, false);
});

test('all candidate gate results are non-executable and module has no writer or model client', async () => {
    for (const decision of ['ELIGIBLE_HYPOTHETICAL', 'ASK', 'DENY']) {
        const result = evaluateHypotheticalAutomaticMemoryGate(input({ candidate: candidate({ classification:
            decision === 'DENY' ? 'ignore' : decision === 'ASK' ? 'ask' : 'auto_save_candidate',
            operation: decision === 'DENY' ? 'IGNORE' : decision === 'ASK' ? 'ASK' : 'ADD' }) }));
        assert.equal(result.executable, false);
    }
    const source = await readFile(new URL('../src/memory/automatic/authorization-gate.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /MemoryService|json-repository|repository\.commit|openai|authorization-coordinator/u);
});

test('analysis-only consent cannot authorize the distinct autosave purpose', () => {
    const analysisConsent = consent({ purpose: 'automatic_memory_assessment' });
    const result = evaluateHypotheticalAutomaticMemoryGate(input({ consent: analysisConsent }));
    assert.notEqual(result.decision, 'ELIGIBLE_HYPOTHETICAL');
    assert.equal(result.executable, false);
});

test('principal and installation mismatches, suspended lifecycle, and renewed sessions fail closed', () => {
    const differentPrincipal = 'principal_99999999-9999-4999-8999-999999999999';
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ identity: {
        ...input().identity, principalId: differentPrincipal,
    } })).decision, 'DENY');
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ identity: {
        ...input().identity, installationId: '22222222-2222-4222-8222-222222222222',
    } })).decision, 'DENY');
    const suspendedDevice = device({ status: 'suspended' });
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ deviceSnapshot: deviceSnapshot({ devices: [suspendedDevice] }) })).decision, 'DENY');

    const prior = lifecycleSession({ status: 'revoked', revokedAt: later, revision: 1 });
    const renewed = lifecycleSession({ sessionId: '66666666-6666-4666-8666-666666666667',
        supersedesSessionId: sessionId, revision: 2 });
    const renewedSnapshot = deviceSnapshot({ sessions: [prior, renewed] });
    const staleAuthorization = { ...authorizationInput(), session: authorizationInput().session };
    assert.equal(evaluateHypotheticalAutomaticMemoryGate(input({ deviceSnapshot: renewedSnapshot,
        authorizationInput: staleAuthorization })).decision, 'DENY');
});

test('an eligible hypothetical result cannot be replayed as execution authority', () => {
    const hypothetical = evaluateHypotheticalAutomaticMemoryGate(input());
    assert.equal(hypothetical.decision, 'ELIGIBLE_HYPOTHETICAL');
    const execution = evaluateHypotheticalAutomaticMemoryGate(input({ mode: 'execution', executionRequested: true }));
    assert.equal(execution.decision, 'DENY');
    assert.equal(execution.executable, false);
    assert.notEqual(execution, hypothetical);
});

test('multiple simulated candidates retain independent gate outcomes', () => {
    const preference = 'Prefiero respuestas breves.';
    const health = 'Tengo migrañas.';
    const proposal = { candidates: [
        { candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference', value_text: preference,
            mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95, assertion_mode: 'asserted',
            temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact', sensitivity: 'none',
            suggested_disposition: 'auto_save', evidence_quote: preference },
        { candidate_type: 'situation', subject_text: 'user', predicate: 'user.situation', value_text: 'migrañas',
            mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95, assertion_mode: 'asserted',
            temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact', sensitivity: 'health',
            suggested_disposition: 'ask', evidence_quote: health },
    ] };
    const result = simulateSelectiveMemoryAssessment({ text: `${preference} ${health}`, proposal, sourceId: 'user:direct',
        consentScenario: { state: 'granted', messageOptOut: false }, conversationOptOut: false, identityStatus: 'unverified' });
    assert.equal(result.candidates.length, 2);
    assert.notDeepEqual(result.candidates[0].authorizationGate.reasonCodes,
        result.candidates[1].authorizationGate.reasonCodes);
    assert.ok(result.candidates.every(item => item.authorizationGate.executable === false));
    assert.equal(result.persistence.performed, false);
});
