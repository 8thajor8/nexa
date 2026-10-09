import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulateSelectiveMemoryAssessment } from '../src/memory/automatic/selective-simulation.js';
import { createSimulatedMemoryConfirmationProposal, evaluateSimulatedMemoryConfirmationBatch } from '../src/memory/automatic/conversation-confirmation.js';

const now = '2030-01-01T00:10:00.000Z';
const expiry = '2030-01-01T01:00:00.000Z';
const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const session = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const installation = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const principal = 'principal_11111111-1111-4111-8111-111111111111';

function c6(text, overrides = {}) {
    const candidate = { candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference', value_text: text,
        mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95, assertion_mode: 'asserted',
        temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact', sensitivity: 'none',
        suggested_disposition: 'auto_save', evidence_quote: text, ...overrides };
    const result = simulateSelectiveMemoryAssessment({ text, proposal: { candidates: [candidate] }, sourceId: 'user:direct',
        consentScenario: { state: 'granted', messageOptOut: false }, conversationOptOut: false, identityStatus: 'unverified' });
    assert.equal(result.candidates.length, 1);
    return result.candidates[0];
}
function makeProposal({ id = idA, assessmentId = idC, text = 'Prefiero respuestas breves.', scope = 'personal',
    sensitivity = 'none', createdAt = now, expiresAt = expiry, sessionId = session, installationId = installation,
    principalId = principal, operation, targetReference = null } = {}) {
    const assessment = c6(text, sensitivity === 'none' ? {} : { candidate_type: 'situation', predicate: 'user.situation',
        sensitivity, suggested_disposition: 'ask' });
    const plannedOperation = operation ?? assessment.plannerOperation;
    const result = createSimulatedMemoryConfirmationProposal({ proposalId: id, assessmentId, candidateAssessment: assessment,
        candidateFingerprint: (text.includes('café') ? 'b' : text.includes('viajes') ? 'c' : 'a').repeat(64),
        operation: plannedOperation, summary: sensitivity === 'none' ? `Resumen sintético ${id[0]}` : null, suggestedScope: scope,
        confirmationReason: sensitivity === 'none' ? 'planner_review' : 'sensitive_information', sensitivity,
        targetReference, linkage: { sessionId, principalId, installationId, turnId: 'source-turn-1' },
        createdAt, expiresAt, revision: 1 });
    assert.equal(result.success, true, JSON.stringify(result));
    return result.proposal;
}
function answer(proposal, intent = 'affirm', reference = { kind: 'proposal_id', proposalId: proposal.proposalId }, overrides = {}) {
    return { reference, assessmentId: proposal.candidateReference.assessmentId,
        candidateIndex: proposal.candidateReference.candidateIndex, candidateFingerprint: proposal.candidateReference.fingerprint,
        operation: proposal.operation, targetReference: proposal.targetReference, intent, sourceLabel: 'synthetic_direct_user',
        principalId: proposal.linkage.principalId, sessionId: proposal.linkage.sessionId,
        installationId: proposal.linkage.installationId, responseTurnId: 'answer-turn-2', requestedScope: null, ...overrides };
}
function orderedIds(proposals) {
    return [...proposals].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.proposalId.localeCompare(right.proposalId)).map(proposal => proposal.proposalId);
}
function batch(proposals, responses = [], overrides = {}) {
    return evaluateSimulatedMemoryConfirmationBatch({ proposals, responses,
        currentRevisions: proposals.map(proposal => ({ proposalId: proposal.proposalId, revision: proposal.revision })),
        evaluatedAt: now, optOut: false, consentRevoked: false, cancelBatch: false, executionRequested: false,
        presentedProposalIds: orderedIds(proposals), ...overrides });
}
function decision(result, proposal) { return result.decisions.find(item => item.proposalId === proposal.proposalId); }
function assertNoExecution(result) {
    assert.equal(result.authorization?.granted, false);
    assert.equal(result.authorization?.executable, false);
    assert.equal(result.writeReady, false);
    assert.equal(result.persistence?.performed, false);
    for (const item of result.decisions ?? []) {
        assert.equal(item.authorization.granted, false);
        assert.equal(item.authorization.executable, false);
        assert.equal(item.writeReady, false);
        assert.equal(item.persistence.performed, false);
        assert.equal(item.proposal.executable, false);
    }
}

const first = () => makeProposal({ id: idA, text: 'Prefiero respuestas breves.' });
const second = () => makeProposal({ id: idB, text: 'Prefiero planificar viajes con tiempo.' });

test('two proposals can be confirmed independently; one affirmative never confirms the other', () => {
    const a = first(), b = second();
    const result = batch([a, b], [answer(a), answer(b)]);
    assert.equal(result.success, true);
    assert.equal(decision(result, a).responseOutcome, 'confirmed_hypothetically');
    assert.equal(decision(result, b).responseOutcome, 'confirmed_hypothetically');
    assertNoExecution(result);

    const onlyA = batch([a, b], [answer(a)]);
    assert.equal(decision(onlyA, a).proposal.status, 'confirmed_hypothetically');
    assert.equal(decision(onlyA, b).responseOutcome, 'pending');
    assert.equal(decision(onlyA, b).proposal.status, 'pending');
    assertNoExecution(onlyA);
});

test('one response may confirm one proposal and reject another', () => {
    const a = first(), b = second();
    const result = batch([a, b], [answer(a, 'affirm'), answer(b, 'reject')]);
    assert.equal(decision(result, a).responseOutcome, 'confirmed_hypothetically');
    assert.equal(decision(result, b).proposal.status, 'rejected');
    assertNoExecution(result);
});

test('a structured clarification request leaves its proposal in review', () => {
    const a = first();
    const result = batch([a], [answer(a, 'request_clarification')]);
    assert.equal(decision(result, a).responseOutcome, 'needs_clarification');
    assert.equal(decision(result, a).proposal.status, 'needs_clarification');
    assert.equal(decision(result, a).reasonCodes[0], 'clarification_requested');
    assertNoExecution(result);
});

test('ordinal references use stable creation-time and proposal-ID ordering', () => {
    const a = first(), b = second();
    const expectedFirst = [a, b].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.proposalId.localeCompare(right.proposalId))[0];
    const response = answer(expectedFirst, 'affirm', { kind: 'ordinal', ordinal: 1 });
    const result = batch([b, a], [response]);
    assert.equal(result.orderedProposalIds[0], expectedFirst.proposalId);
    assert.equal(decision(result, expectedFirst).responseOutcome, 'confirmed_hypothetically');
    assert.equal(decision(result, expectedFirst === a ? b : a).responseOutcome, 'pending');
    assertNoExecution(result);
});

test('a presentation order changed before the response is rejected rather than retargeting an ordinal', () => {
    const a = first(), b = second();
    const displayed = batch([a, b]).orderedProposalIds;
    const changedDisplay = [...displayed].reverse();
    const result = batch([a, b], [answer(a, 'affirm', { kind: 'ordinal', ordinal: 1 })],
        { presentedProposalIds: changedDisplay });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'confirmation_batch_presentation_snapshot_mismatch');
    assertNoExecution(result);
});

test('invalid ordinals and duplicate response references are rejected without choosing arbitrarily', () => {
    const a = first(), b = second();
    const invalidOrdinal = batch([a, b], [answer(a, 'affirm', { kind: 'ordinal', ordinal: 3 })]);
    assert.ok(invalidOrdinal.issues.includes('confirmation_batch_reference_invalid_or_ambiguous'));
    assert.equal(decision(invalidOrdinal, a).proposal.status, 'pending');
    const duplicated = batch([a], [answer(a), answer(a, 'reject')]);
    assert.equal(decision(duplicated, a).responseOutcome, 'denied');
    assert.equal(decision(duplicated, a).reasonCodes[0], 'confirmation_batch_duplicate_reference');
    assert.equal(decision(duplicated, a).proposal.status, 'pending');
    assertNoExecution(invalidOrdinal);
    assertNoExecution(duplicated);
});

test('duplicate proposal IDs, duplicate candidate references and mixed identity context fail closed', () => {
    const a = first(), b = second();
    assert.equal(batch([a, a]).error.code, 'confirmation_batch_duplicate_proposal_id');
    const sameCandidate = Object.freeze({ ...b, candidateReference: Object.freeze({ ...a.candidateReference }) });
    assert.equal(batch([a, sameCandidate]).error.code, 'confirmation_batch_duplicate_candidate_reference');
    const mixed = Object.freeze({ ...b, linkage: Object.freeze({ ...b.linkage, installationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }) });
    assert.equal(batch([a, mixed]).error.code, 'confirmation_batch_identity_context_mismatch');
});

test('crossed candidate fingerprint and identity fields cannot confirm another proposal', () => {
    const a = first(), b = second();
    const crossed = batch([a, b], [answer(a, 'affirm', undefined, { candidateFingerprint: b.candidateReference.fingerprint })]);
    assert.equal(decision(crossed, a).responseOutcome, 'denied');
    assert.equal(decision(crossed, a).proposal.status, 'pending');
    const wrongInstall = batch([a], [answer(a, 'affirm', undefined, { installationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })]);
    assert.equal(decision(wrongInstall, a).responseOutcome, 'denied');
    assertNoExecution(crossed);
    assertNoExecution(wrongInstall);
});

test('a response reference from another batch is unresolved and stale revisions cannot be applied', () => {
    const a = first(), other = second();
    const foreignReference = batch([a], [answer(other)]);
    assert.ok(foreignReference.issues.includes('confirmation_batch_reference_invalid_or_ambiguous'));
    assert.equal(decision(foreignReference, a).proposal.status, 'pending');
    const stale = batch([a], [answer(a)], {
        currentRevisions: [{ proposalId: a.proposalId, revision: a.revision + 1 }],
    });
    assert.equal(decision(stale, a).responseOutcome, 'denied');
    assert.equal(decision(stale, a).reasonCodes[0], 'confirmation_proposal_revision_stale');
    assertNoExecution(foreignReference);
    assertNoExecution(stale);
});

test('correction, scope restriction and sharing require review and never rewrite or broaden', () => {
    const a = first();
    const correction = batch([a], [answer(a, 'correct')]);
    assert.equal(decision(correction, a).proposal.requiresNewProposal, true);
    const oldFact = decision(correction, a).proposal;
    const affirmOld = batch([oldFact], [answer(oldFact)]);
    assert.equal(decision(affirmOld, oldFact).responseOutcome, 'denied');
    assert.equal(decision(affirmOld, oldFact).reasonCodes[0], 'confirmation_new_proposal_required');

    const project = makeProposal({ id: idB, text: 'Prefiero planificar viajes con tiempo.', scope: 'project' });
    const restricted = batch([project], [answer(project, 'restrict_scope', undefined, { requestedScope: 'personal' })]);
    assert.equal(decision(restricted, project).proposal.suggestedScope, 'personal');
    assert.equal(decision(restricted, project).proposal.requiresNewProposal, true);
    const shared = batch([a], [answer(a, 'request_share')]);
    assert.equal(decision(shared, a).proposal.suggestedScope, 'personal');
    assert.equal(decision(shared, a).proposal.requiresNewProposal, true);
    assertNoExecution(correction);
    assertNoExecution(affirmOld);
    assertNoExecution(restricted);
    assertNoExecution(shared);
});

test('batch cancel, expiration, revocation, and opt-out take precedence over answers', () => {
    const a = first(), b = second();
    const cancelled = batch([a, b], [answer(a)], { cancelBatch: true });
    assert.equal(decision(cancelled, a).proposal.status, 'rejected');
    assert.equal(decision(cancelled, b).proposal.status, 'rejected');
    const expired = batch([a], [answer(a)], { evaluatedAt: '2030-01-01T02:00:00.000Z' });
    assert.equal(expired.decisions[0].proposal.status, 'expired');
    const revoked = batch([a], [answer(a)], { consentRevoked: true });
    assert.equal(decision(revoked, a).proposal.status, 'revoked');
    const optOut = batch([a], [answer(a)], { optOut: true });
    assert.equal(decision(optOut, a).proposal.status, 'revoked');
    for (const result of [cancelled, expired, revoked, optOut]) assertNoExecution(result);
});

test('sensitive candidates cannot be affirm-confirmed and keep their summaries hidden', () => {
    const sensitive = makeProposal({ text: 'Tengo un diagnóstico sintético.', sensitivity: 'health' });
    const result = batch([sensitive], [answer(sensitive)]);
    assert.equal(decision(result, sensitive).proposal.summary, null);
    assert.equal(decision(result, sensitive).proposal.status, 'needs_clarification');
    assertNoExecution(result);
});

test('updated state rejects replay while an old snapshot can only replay a non-executable hypothetical result', () => {
    const a = first();
    const accepted = batch([a], [answer(a)]);
    const updated = decision(accepted, a).proposal;
    const replayUpdated = batch([updated], [answer(updated)]);
    assert.equal(decision(replayUpdated, updated).responseOutcome, 'denied');
    const replayOld = batch([a], [answer(a)]);
    assert.equal(decision(replayOld, a).responseOutcome, 'confirmed_hypothetically');
    assertNoExecution(accepted);
    assertNoExecution(replayUpdated);
    assertNoExecution(replayOld);
});

test('execution requests fail closed and the batch module has no production writer or network route', async () => {
    const a = first();
    const result = batch([a], [answer(a)], { executionRequested: true });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'confirmation_batch_execution_not_supported');
    assertNoExecution(result);
    const source = await readFile(new URL('../src/memory/automatic/conversation-confirmation.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"].*(?:agent|openai|repository|service|authorization-coordinator|proposal-queue)/u);
    assert.doesNotMatch(source, /console\.(?:log|error)\s*\(|\b(?:writeFile|appendFile|fetch)\s*\(/u);
});
