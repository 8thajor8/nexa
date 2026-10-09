import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulateSelectiveMemoryAssessment } from '../src/memory/automatic/selective-simulation.js';
import { createSimulatedMemoryConfirmationProposal, evaluateSimulatedMemoryConfirmationBatch } from '../src/memory/automatic/conversation-confirmation.js';

const now = '2031-05-10T12:00:00.000Z';
const expiry = '2031-05-10T13:00:00.000Z';
const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const installationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const principalId = 'principal_11111111-1111-4111-8111-111111111111';
const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'ffffffff-ffff-4fff-8fff-ffffffffffff'];

function candidate(text, overrides = {}) {
    return { candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference', value_text: text,
        mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95, assertion_mode: 'asserted',
        temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact', sensitivity: 'none',
        suggested_disposition: 'auto_save', evidence_quote: text, ...overrides };
}

function assess(text, options = {}) {
    return simulateSelectiveMemoryAssessment({ text, proposal: { candidates: [candidate(text, options.candidate)] },
        sourceId: options.sourceId ?? 'user:direct', consentScenario: options.consentScenario ?? { state: 'granted', messageOptOut: false },
        conversationOptOut: options.conversationOptOut ?? false, identityStatus: 'unverified' });
}

function makeProposal(text, { index = 0, id = ids[index], assessmentId = ids[(index + 1) % ids.length],
    sensitivity = 'none', scope = 'personal', createdAt = now, expiresAt = expiry } = {}) {
    const result = assess(text, sensitivity === 'none' ? {} : { candidate: { candidate_type: 'situation', predicate: 'user.situation',
        sensitivity, suggested_disposition: 'ask' } });
    assert.equal(result.success, true);
    assert.equal(result.candidates.length, 1);
    const candidateAssessment = result.candidates[0];
    const proposalResult = createSimulatedMemoryConfirmationProposal({ proposalId: id, assessmentId, candidateAssessment,
        candidateFingerprint: `${String(index + 1).repeat(64)}`, operation: candidateAssessment.plannerOperation,
        summary: sensitivity === 'none' ? `Dato sintético ${index + 1}` : null, suggestedScope: scope,
        confirmationReason: sensitivity === 'none' ? 'planner_review' : 'sensitive_information', sensitivity,
        targetReference: null, linkage: { sessionId, principalId, installationId, turnId: `synthetic-turn-${index + 1}` },
        createdAt, expiresAt, revision: 0 });
    assert.equal(proposalResult.success, true, JSON.stringify(proposalResult));
    return { assessment: result, proposal: proposalResult.proposal };
}

function orderedIds(proposals) {
    return [...proposals].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
        || a.proposalId.localeCompare(b.proposalId)).map(item => item.proposalId);
}

function response(proposal, intent = 'affirm', reference = { kind: 'proposal_id', proposalId: proposal.proposalId }, overrides = {}) {
    return { reference, assessmentId: proposal.candidateReference.assessmentId,
        candidateIndex: proposal.candidateReference.candidateIndex, candidateFingerprint: proposal.candidateReference.fingerprint,
        operation: proposal.operation, targetReference: proposal.targetReference, intent,
        sourceLabel: 'synthetic_direct_user', principalId: proposal.linkage.principalId,
        sessionId: proposal.linkage.sessionId, installationId: proposal.linkage.installationId,
        responseTurnId: 'synthetic-response-turn', requestedScope: null, ...overrides };
}

function evaluate(proposals, responses = [], overrides = {}) {
    return evaluateSimulatedMemoryConfirmationBatch({ proposals, responses,
        currentRevisions: proposals.map(proposal => ({ proposalId: proposal.proposalId, revision: proposal.revision })),
        evaluatedAt: now, optOut: false, consentRevoked: false, cancelBatch: false, executionRequested: false,
        presentedProposalIds: responses.length ? orderedIds(proposals) : null, ...overrides });
}

function assertNoExecution(result) {
    assert.equal(result.authorization?.granted, false);
    assert.equal(result.authorization?.executable, false);
    if (Object.hasOwn(result, 'writeReady')) assert.equal(result.writeReady, false);
    assert.equal(result.persistence?.performed, false);
    for (const item of result.decisions ?? result.candidates ?? []) {
        if (item.authorization) {
            assert.equal(item.authorization.granted, false);
            assert.equal(item.authorization.executable, false);
        }
        if (Object.hasOwn(item, 'writeReady')) assert.equal(item.writeReady, false);
        if (item.persistence) assert.equal(item.persistence.performed, false);
        if (item.proposal) assert.equal(item.proposal.executable, false);
        if (item.authorizationGate) assert.equal(item.authorizationGate.executable, false);
    }
}

function decision(result, proposal) { return result.decisions.find(item => item.proposalId === proposal.proposalId); }

test('C.7 end-to-end: C.6 candidate → proposal presentation → explicit hypothetical confirmation', () => {
    const { assessment, proposal } = makeProposal('Prefiero respuestas breves.');
    assert.equal(assessment.candidates[0].authorizationGate.decision, 'ASK');
    assert.equal(proposal.status, 'pending');
    const presentation = evaluate([proposal]);
    const result = evaluate([proposal], [response(proposal)], { presentedProposalIds: presentation.orderedProposalIds });
    assert.equal(decision(result, proposal).responseIntent, 'affirm');
    assert.equal(decision(result, proposal).responseOutcome, 'confirmed_hypothetically');
    assert.equal(decision(result, proposal).proposal.status, 'confirmed_hypothetically');
    assertNoExecution(assessment);
    assertNoExecution(presentation);
    assertNoExecution(result);
    assert.doesNotMatch(JSON.stringify({ assessment, proposal, result }), /Prefiero respuestas breves/u);
});

test('multiple candidates stay independent across confirmation, rejection, and partial response', () => {
    const a = makeProposal('Prefiero respuestas breves.', { index: 0 });
    const b = makeProposal('Uso una tableta sintética para dibujar.', { index: 1,
        assessmentId: ids[3] });
    const confirmedAndRejected = evaluate([a.proposal, b.proposal], [response(a.proposal), response(b.proposal, 'reject')]);
    assert.equal(decision(confirmedAndRejected, a.proposal).proposal.status, 'confirmed_hypothetically');
    assert.equal(decision(confirmedAndRejected, b.proposal).proposal.status, 'rejected');
    const partial = evaluate([a.proposal, b.proposal], [response(a.proposal)]);
    assert.equal(decision(partial, a.proposal).proposal.status, 'confirmed_hypothetically');
    assert.equal(decision(partial, b.proposal).proposal.status, 'pending');
    assertNoExecution(confirmedAndRejected);
    assertNoExecution(partial);
});

test('ordinal presentation mismatch, foreign identity, and incompatible revision are denied', () => {
    const a = makeProposal('Prefiero respuestas breves.', { index: 0 });
    const b = makeProposal('Uso una tableta sintética para dibujar.', { index: 1, assessmentId: ids[3] });
    const changedOrder = evaluate([a.proposal, b.proposal], [response(a.proposal, 'affirm', { kind: 'ordinal', ordinal: 1 })],
        { presentedProposalIds: [...orderedIds([a.proposal, b.proposal])].reverse() });
    assert.equal(changedOrder.success, false);
    const wrongIdentity = evaluate([a.proposal], [response(a.proposal, 'affirm', undefined,
        { installationId: ids[3], principalId: null })]);
    assert.equal(decision(wrongIdentity, a.proposal).responseOutcome, 'denied');
    const staleRevision = evaluate([a.proposal], [response(a.proposal)], {
        currentRevisions: [{ proposalId: a.proposal.proposalId, revision: a.proposal.revision + 1 }],
    });
    assert.equal(decision(staleRevision, a.proposal).reasonCodes[0], 'confirmation_proposal_revision_stale');
    assertNoExecution(changedOrder);
    assertNoExecution(wrongIdentity);
    assertNoExecution(staleRevision);
});

test('expired, revoked, opted-out and sensitive proposals never become confirmations', () => {
    const normal = makeProposal('Prefiero respuestas breves.', { index: 0 });
    const expired = evaluate([normal.proposal], [response(normal.proposal)], { evaluatedAt: '2031-05-10T14:00:00.000Z' });
    const revoked = evaluate([normal.proposal], [response(normal.proposal)], { consentRevoked: true });
    const optedOut = evaluate([normal.proposal], [response(normal.proposal)], { optOut: true });
    const health = makeProposal('Tengo una condición médica sintética.', { index: 1, assessmentId: ids[3], sensitivity: 'health' });
    const sensitive = evaluate([health.proposal], [response(health.proposal)]);
    assert.equal(decision(expired, normal.proposal).proposal.status, 'expired');
    assert.equal(decision(revoked, normal.proposal).proposal.status, 'revoked');
    assert.equal(decision(optedOut, normal.proposal).proposal.status, 'revoked');
    assert.equal(decision(sensitive, health.proposal).proposal.summary, null);
    assert.equal(decision(sensitive, health.proposal).proposal.status, 'needs_clarification');
    for (const result of [expired, revoked, optedOut, sensitive]) assertNoExecution(result);
});

test('a correction requires a newly assessed proposal and cannot confirm the old candidate', () => {
    const original = makeProposal('Prefiero respuestas breves.', { index: 0 });
    const corrected = evaluate([original.proposal], [response(original.proposal, 'correct')]);
    const updatedOldProposal = decision(corrected, original.proposal).proposal;
    const replayOld = evaluate([updatedOldProposal], [response(updatedOldProposal)]);
    assert.equal(decision(replayOld, updatedOldProposal).responseOutcome, 'denied');
    const newCandidate = makeProposal('Prefiero respuestas detalladas.', { index: 1, assessmentId: ids[3] });
    const newResult = evaluate([newCandidate.proposal], [response(newCandidate.proposal)]);
    assert.equal(decision(newResult, newCandidate.proposal).proposal.status, 'confirmed_hypothetically');
    assertNoExecution(corrected);
    assertNoExecution(replayOld);
    assertNoExecution(newResult);
});

test('analysis consent is only a synthetic C.6 precondition and does not authorize proposal persistence', () => {
    const noConsent = assess('Prefiero respuestas breves.', { consentScenario: { state: 'missing', messageOptOut: false } });
    const external = assess('Prefiero respuestas breves.', { sourceId: 'api:lifeguard' });
    const optOut = assess('Prefiero respuestas breves.', { conversationOptOut: true });
    assert.deepEqual(noConsent.candidates, []);
    assert.deepEqual(external.candidates, []);
    assert.deepEqual(optOut.candidates, []);
    for (const result of [noConsent, external, optOut]) assertNoExecution(result);
});

test('old proposal snapshots can only replay hypothetical results and execution is always rejected', () => {
    const { proposal } = makeProposal('Prefiero respuestas breves.', { index: 0 });
    const accepted = evaluate([proposal], [response(proposal)]);
    const replayOld = evaluate([proposal], [response(proposal)]);
    const execution = evaluate([proposal], [response(proposal)], { executionRequested: true });
    assert.equal(decision(accepted, proposal).proposal.status, 'confirmed_hypothetically');
    assert.equal(decision(replayOld, proposal).proposal.status, 'confirmed_hypothetically');
    assert.equal(execution.success, false);
    assert.equal(execution.error.code, 'confirmation_batch_execution_not_supported');
    assertNoExecution(accepted);
    assertNoExecution(replayOld);
    assertNoExecution(execution);
});

test('invalid free-text intent is not copied into the trace', () => {
    const { proposal } = makeProposal('Prefiero respuestas breves.', { index: 0 });
    const secretSentinel = 'SyntheticPrivateIntentShouldNotEcho-742!';
    const result = evaluate([proposal], [response(proposal, secretSentinel)]);
    assert.equal(decision(result, proposal).responseOutcome, 'denied');
    assert.equal(decision(result, proposal).responseIntent, null);
    assert.doesNotMatch(JSON.stringify(result), /SyntheticPrivateIntentShouldNotEcho-742/u);
    assertNoExecution(result);
});

test('C.7 simulation dependencies remain disconnected from agents, live extractor, and writers', async () => {
    const source = await readFile(new URL('../src/memory/automatic/conversation-confirmation.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"].*(?:agent|openai|detector|repository|service|authorization-coordinator|proposal-queue)/u);
    assert.doesNotMatch(source, /console\.(?:log|error)\s*\(|\b(?:writeFile|appendFile|fetch)\s*\(/u);
});
