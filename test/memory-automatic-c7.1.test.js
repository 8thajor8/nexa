import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulateSelectiveMemoryAssessment } from '../src/memory/automatic/selective-simulation.js';
import { createSimulatedMemoryConfirmationProposal, evaluateSimulatedMemoryConfirmation } from '../src/memory/automatic/conversation-confirmation.js';

const NOW = '2030-01-01T00:10:00.000Z';
const EXPIRY = '2030-01-01T01:00:00.000Z';
const UUIDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
const PRINCIPAL = 'principal_11111111-1111-4111-8111-111111111111';
const OTHER_PRINCIPAL = 'principal_22222222-2222-4222-8222-222222222222';
const FINGERPRINT = 'a'.repeat(64);
const TARGET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function candidate(text, overrides = {}) {
    return { candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference', value_text: text,
        mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95, assertion_mode: 'asserted',
        temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact', sensitivity: 'none',
        suggested_disposition: 'auto_save', evidence_quote: text, ...overrides };
}
function assessment(text = 'Prefiero respuestas breves.', overrides = {}) {
    const result = simulateSelectiveMemoryAssessment({ text, proposal: { candidates: [candidate(text)] }, sourceId: 'user:direct',
        consentScenario: { state: 'granted', messageOptOut: false }, conversationOptOut: false,
        identityStatus: 'unverified', ...overrides });
    assert.equal(result.candidates.length, 1);
    return result.candidates[0];
}
function makeProposal({ id = UUIDS[0], assessId = UUIDS[1], item = assessment(), operation = item.plannerOperation,
    scope = 'personal', sensitivity = 'none', summary = sensitivity === 'none' ? 'Preferencia de formato de respuesta' : null,
    reason = sensitivity === 'none' ? 'planner_review' : 'sensitive_information', target = operation === 'REPLACE' ? TARGET : null,
    principalId = PRINCIPAL, sessionId = UUIDS[2], turnId = 'turn-source-1', revision = 1 } = {}) {
    const result = createSimulatedMemoryConfirmationProposal({ proposalId: id, assessmentId: assessId,
        candidateAssessment: item, candidateFingerprint: FINGERPRINT, operation, summary, suggestedScope: scope,
        confirmationReason: reason, sensitivity, targetReference: target,
        linkage: { sessionId, principalId, installationId: UUIDS[3], turnId }, createdAt: NOW, expiresAt: EXPIRY, revision });
    assert.equal(result.success, true, JSON.stringify(result));
    return result.proposal;
}
function response(proposal, intent = 'affirm', overrides = {}) {
    return { proposalId: proposal.proposalId, assessmentId: proposal.candidateReference.assessmentId,
        candidateIndex: proposal.candidateReference.candidateIndex, candidateFingerprint: proposal.candidateReference.fingerprint,
        operation: proposal.operation, targetReference: proposal.targetReference, intent, sourceLabel: 'synthetic_direct_user',
        principalId: proposal.linkage.principalId, sessionId: proposal.linkage.sessionId,
        installationId: proposal.linkage.installationId,
        responseTurnId: 'turn-answer-2', requestedScope: null, ...overrides };
}
function evaluate(proposal, answer = response(proposal), overrides = {}) {
    return evaluateSimulatedMemoryConfirmation({ proposal, response: answer, evaluatedAt: NOW,
        currentRevision: proposal.revision, optOut: false, consentRevoked: false, ...overrides });
}
function assertNoExecution(result) {
    assert.equal(result.authorization?.granted, false);
    assert.equal(result.authorization?.executable, false);
    assert.equal(result.writeReady, false);
    assert.equal(result.persistence?.performed, false);
    if (result.proposal) assert.equal(result.proposal.executable, false);
}
function makeReplaceAssessment() {
    const item = { ...assessment(), plannerOperation: 'REPLACE' };
    return item;
}
function makeSensitiveAssessment() {
    const text = 'Tengo migrañas.';
    const result = simulateSelectiveMemoryAssessment({ text, proposal: { candidates: [candidate(text, {
        candidate_type: 'situation', predicate: 'user.situation', value_text: 'migrañas', sensitivity: 'health',
        suggested_disposition: 'ask' })] }, sourceId: 'user:direct', consentScenario: { state: 'granted', messageOptOut: false },
        conversationOptOut: false, identityStatus: 'unverified' });
    return result.candidates[0];
}

test('affirmation confirms only one matching proposal hypothetically and never authorizes a write', () => {
    const proposal = makeProposal();
    const result = evaluate(proposal);
    assert.equal(result.responseOutcome, 'confirmed_hypothetically');
    assert.equal(result.proposal.status, 'confirmed_hypothetically');
    assert.equal(result.proposal.revision, proposal.revision + 1);
    assert.equal(result.authorization.granted, false);
    assertNoExecution(result);
});

test('explicit rejection and cancellation close only their matching proposal', () => {
    for (const [intent, status] of [['reject', 'rejected'], ['cancel', 'rejected']]) {
        const proposal = makeProposal();
        const result = evaluate(proposal, response(proposal, intent));
        assert.equal(result.proposal.status, status);
        assert.equal(result.responseOutcome, status);
        assertNoExecution(result);
    }
});

test('correction creates no edited fact and requires a new proposal', () => {
    const proposal = makeProposal();
    const result = evaluate(proposal, response(proposal, 'correct'));
    assert.equal(result.proposal.status, 'needs_clarification');
    assert.equal(result.proposal.requiresNewProposal, true);
    assert.equal(result.proposal.summary, proposal.summary);
    assert.equal(result.reasonCodes[0], 'correction_requires_new_proposal');
    assertNoExecution(result);
});

test('scope restriction never broadens scope and requires a new proposal', () => {
    const project = makeProposal({ scope: 'project', reason: 'project_identity' });
    const narrower = evaluate(project, response(project, 'restrict_scope', { requestedScope: 'personal' }));
    assert.equal(narrower.proposal.suggestedScope, 'personal');
    assert.equal(narrower.proposal.status, 'needs_clarification');
    assert.equal(narrower.proposal.requiresNewProposal, true);
    const broadening = evaluate(project, response(project, 'restrict_scope', { requestedScope: 'shared' }));
    assert.equal(broadening.proposal.suggestedScope, 'project');
    assert.equal(broadening.proposal.requiresNewProposal, true);
    assertNoExecution(narrower);
    assertNoExecution(broadening);
});

test('sharing request needs specific new proposal and does not change scope', () => {
    const proposal = makeProposal();
    const result = evaluate(proposal, response(proposal, 'request_share'));
    assert.equal(result.proposal.suggestedScope, 'personal');
    assert.equal(result.proposal.status, 'needs_clarification');
    assert.equal(result.proposal.requiresNewProposal, true);
    assert.equal(result.reasonCodes[0], 'sharing_requires_specific_recipient_consent');
    assertNoExecution(result);
});

test('ambiguous and unrelated answers remain unresolved', () => {
    for (const intent of ['ambiguous', 'unrelated']) {
        const proposal = makeProposal();
        const result = evaluate(proposal, response(proposal, intent));
        assert.equal(result.responseOutcome, 'needs_clarification');
        assert.equal(result.proposal.status, 'needs_clarification');
        assert.notEqual(result.proposal.status, 'confirmed_hypothetically');
        assertNoExecution(result);
    }
});

test('two pending proposals are independent and a response cannot cross-bind them', () => {
    const first = makeProposal({ id: UUIDS[0], assessId: UUIDS[1] });
    const second = makeProposal({ id: UUIDS[3], assessId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    const result = evaluate(first, response(first));
    const crossed = evaluate(second, response(first));
    assert.equal(result.proposal.status, 'confirmed_hypothetically');
    assert.equal(second.status, 'pending');
    assert.equal(crossed.responseOutcome, 'denied');
    assert.equal(crossed.reasonCodes[0], 'confirmation_response_binding_mismatch');
    assert.equal(second.status, 'pending');
    assertNoExecution(result);
    assertNoExecution(crossed);
});

test('different principal, session or installation is rejected', () => {
    const proposal = makeProposal();
    for (const overrides of [{ principalId: OTHER_PRINCIPAL }, { sessionId: UUIDS[1] }, { installationId: UUIDS[0] }]) {
        const result = evaluate(proposal, response(proposal, 'affirm', overrides));
        assert.equal(result.responseOutcome, 'denied');
        assert.equal(result.reasonCodes[0], 'confirmation_response_principal_session_or_installation_mismatch');
        assertNoExecution(result);
    }
});

test('expired, stale, revoked, opted-out and consent-revoked proposals cannot confirm', () => {
    const proposal = makeProposal();
    const expired = evaluate(proposal, response(proposal), { evaluatedAt: '2030-01-01T02:00:00.000Z' });
    assert.equal(expired.proposal.status, 'expired');
    assert.equal(expired.responseOutcome, 'expired');
    const stale = evaluate(proposal, response(proposal), { currentRevision: proposal.revision + 1 });
    assert.equal(stale.reasonCodes[0], 'confirmation_proposal_revision_stale');
    const optedOut = evaluate(proposal, response(proposal), { optOut: true });
    assert.equal(optedOut.proposal.status, 'revoked');
    assert.equal(optedOut.reasonCodes[0], 'automatic_memory_opt_out');
    const consentRevoked = evaluate(proposal, response(proposal), { consentRevoked: true });
    assert.equal(consentRevoked.proposal.status, 'revoked');
    assert.equal(consentRevoked.reasonCodes[0], 'analysis_consent_revoked');
    const revoked = evaluate(optedOut.proposal, response(proposal));
    assert.equal(revoked.reasonCodes[0], 'confirmation_proposal_already_resolved');
    for (const result of [expired, stale, optedOut, consentRevoked, revoked]) assertNoExecution(result);
});

test('sensitive candidates omit summary and affirmative answers cannot confirm them', () => {
    const proposal = makeProposal({ item: makeSensitiveAssessment(), operation: 'ASK', sensitivity: 'health',
        summary: null, reason: 'sensitive_information' });
    const result = evaluate(proposal);
    assert.equal(result.responseOutcome, 'needs_clarification');
    assert.equal(result.proposal.status, 'needs_clarification');
    assert.equal(result.proposal.summary, null);
    assert.equal(result.proposal.requiresNewProposal, true);
    assertNoExecution(result);
});

test('fingerprint, operation and REPLACE target must match exactly', () => {
    const proposal = makeProposal({ item: makeReplaceAssessment(), operation: 'REPLACE', reason: 'replace_target_confirmation' });
    const mismatches = [
        response(proposal, 'affirm', { candidateFingerprint: 'b'.repeat(64) }),
        response(proposal, 'affirm', { operation: 'ADD' }),
        response(proposal, 'affirm', { targetReference: UUIDS[3] }),
    ].map(answer => evaluate(proposal, answer));
    const matching = evaluate(proposal);
    assert.equal(matching.proposal.targetReference, TARGET);
    assert.equal(matching.responseOutcome, 'confirmed_hypothetically');
    for (const mismatch of mismatches) {
        assert.equal(mismatch.responseOutcome, 'denied');
        assert.equal(mismatch.reasonCodes[0], 'confirmation_response_binding_mismatch');
        assertNoExecution(mismatch);
    }
    assertNoExecution(matching);
});

test('a resolved proposal cannot reuse the same answer, and raw text is not part of the API', () => {
    const proposal = makeProposal();
    const first = evaluate(proposal);
    const replay = evaluate(first.proposal, response(first.proposal), { currentRevision: first.proposal.revision });
    assert.equal(replay.responseOutcome, 'denied');
    assert.equal(replay.reasonCodes[0], 'confirmation_proposal_already_resolved');
    const rawText = response(proposal, 'affirm', { text: 'sí, guarda todos mis recuerdos' });
    assert.equal(evaluate(proposal, rawText).responseOutcome, 'denied');
    assertNoExecution(first);
    assertNoExecution(replay);
});

test('a corrected proposal cannot be affirmed as-is, while replaying an old copy remains non-executable', () => {
    const pending = makeProposal();
    const corrected = evaluate(pending, response(pending, 'correct'));
    const oldFactAffirmation = evaluate(corrected.proposal, response(corrected.proposal),
        { currentRevision: corrected.proposal.revision });
    assert.equal(oldFactAffirmation.responseOutcome, 'denied');
    assert.equal(oldFactAffirmation.reasonCodes[0], 'confirmation_new_proposal_required');

    // A pure function has no authoritative replay ledger: the stale copy can yield
    // another hypothetical result, but it must never be confused with authority.
    const oldCopyReplay = evaluate(pending, response(pending));
    assert.equal(oldCopyReplay.responseOutcome, 'confirmed_hypothetically');
    assertNoExecution(oldCopyReplay);
});

test('execution-shaped inputs and forged trust labels do not create authorization', () => {
    const proposal = makeProposal();
    const forged = evaluate(proposal, response(proposal, 'affirm', { sourceLabel: 'verified_user' }));
    const execution = evaluateSimulatedMemoryConfirmation({ proposal, response: response(proposal), evaluatedAt: NOW,
        currentRevision: proposal.revision, optOut: false, consentRevoked: false, executable: true });
    assert.equal(forged.responseOutcome, 'denied');
    assert.equal(execution.success, false);
    assertNoExecution(forged);
    assertNoExecution(execution);
});

test('module is disconnected from agent, writers, persistence, network and logging', async () => {
    const source = await readFile(new URL('../src/memory/automatic/conversation-confirmation.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"].*(?:agent|openai|repository|service|authorization-coordinator|proposal-queue)/u);
    assert.doesNotMatch(source, /console\.(?:log|error)\s*\(|\b(?:writeFile|appendFile|fetch)\s*\(/u);
});
