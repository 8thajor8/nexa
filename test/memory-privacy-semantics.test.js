import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrivacyOperation } from '../src/memory/privacy-semantics.js';

const ownerId = 'principal_00000000-0000-4000-8000-000000000001';
const otherId = 'principal_00000000-0000-4000-8000-000000000002';
const partitionId = 'partition_synthetic-private';
const asOf = { value: '2036-06-01T00:00:00.000Z', precision: 'instant' };
const timestamp = '2035-06-01T00:00:00.000Z';
const personId = n => `person_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const assertionId = n => `mem_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceId = n => `src_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const evidenceId = n => `ev_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function record(n, { value = `synthetic fact ${n}`, subject = { type: 'owner' }, intent = 'fact',
    validFrom = { value: '2030-01-01', precision: 'day' }, validTo = null,
    supersedes = [], derivedFromAssertionIds = [], scopeKind = 'private',
    sharedRecipientPrincipalIds = [] } = {}) {
    const id = assertionId(n), srcId = sourceId(n);
    const source = { id: srcId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
        locator: null, occurred_at: { value: '2035-05-01', precision: 'day' }, recorded_at: timestamp };
    const evidence = { id: evidenceId(n), assertion_id: id, source_id: srcId, derivation: 'explicit',
        extraction_confidence: null, learned_at: timestamp, last_confirmed_at: null, legacy_ref: null };
    return { assertion: { id, kind: 'fact', subject, predicate: 'user.preference', object: { type: 'text', value },
        status: 'active', valid_from: validFrom, valid_to: validTo, recorded_at: timestamp, supersedes,
        compatibility: { category: 'user', key: 'test-slot' } },
    evidencePairs: [{ evidence, source }], intent, partitionId, ownerPrincipalId: ownerId, scopeKind,
    sharedRecipientPrincipalIds, derivedFromAssertionIds };
}

const partition = (overrides = {}) => ({ partitionId, kind: 'private', ownerPrincipalId: ownerId,
    scopeLabel: 'synthetic-private-one', recipientPrincipalIds: [], ...overrides });
const identity = (overrides = {}) => ({ principalId: ownerId, role: 'Member', fixtureOnly: true, ...overrides });
const request = (operation, overrides = {}) => ({ operation, targetAssertionId: assertionId(1), proposedRecord: null,
    restrictionKinds: [], consentId: null, consentPurpose: null, consentStatus: null, ...overrides });
function evaluate(operation, { records = [record(1)], requestOverrides = {}, partitionOverrides = {}, identityOverrides = {},
    mode = 'simulate', asOf: evaluatedAt = asOf, pendingOperationsSnapshot = null } = {}) {
    return evaluatePrivacyOperation({ mode, operation, request: request(operation, requestOverrides), identity: identity(identityOverrides),
        partition: partition(partitionOverrides), records, asOf: evaluatedAt, pendingOperationsSnapshot });
}

function proposalRecord(target, n, { value = 'synthetic corrected fact', validFrom = target.assertion.valid_from,
    validTo = target.assertion.valid_to, subject = target.assertion.subject, intent = target.intent,
    status = 'active' } = {}) {
    const proposed = record(n, { value, validFrom, validTo, subject, intent });
    proposed.assertion.status = status;
    return proposed;
}

test('correct distinguishes unresolved correction from an evidence-backed temporal change without choosing truth', () => {
    const target = record(1, { value: 'SYNTHETIC_SENSITIVE_VALUE' });
    const proposed = proposalRecord(target, 2);
    const correction = evaluate('correct', { records: [target], requestOverrides: { proposedRecord: proposed } });
    assert.equal(correction.decision, 'ASK');
    assert.equal(correction.classification, 'correction_unresolved');
    assert.ok(correction.authorizationRequirements.includes('target_specific_correction_confirmation'));
    assert.equal(JSON.stringify(correction).includes('SYNTHETIC_SENSITIVE_VALUE'), false);

    const earlier = record(3, { value: 'synthetic old state', validFrom: { value: '2030-01-01', precision: 'day' },
        validTo: { value: '2034-12-31', precision: 'day' } });
    const later = proposalRecord(earlier, 4, { value: 'synthetic later state',
        validFrom: { value: '2035-01-01', precision: 'day' }, validTo: null });
    const change = evaluate('correct', { records: [earlier], requestOverrides: { targetAssertionId: assertionId(3), proposedRecord: later } });
    assert.equal(change.classification, 'temporal_change');
    assert.ok(change.reasonCodes.includes('temporal_change_not_error_correction'));
    assert.equal(change.executable, false);

    const plan = record(5, { value: 'synthetic plan', intent: 'plan', validFrom: { value: '2037', precision: 'year' } });
    const fact = proposalRecord(plan, 6, { value: 'synthetic completed event', intent: 'fact' });
    const intentMismatch = evaluate('correct', { records: [plan], requestOverrides: {
        targetAssertionId: assertionId(5), proposedRecord: fact,
    } });
    assert.equal(intentMismatch.reasonCodes[0], 'plan_fact_intent_mismatch');
});

test('forget is a retrieval/context exclusion preview and is distinct from physical deletion', () => {
    const target = record(1);
    const forget = evaluate('forget', { records: [target] });
    assert.deepEqual(forget.hypotheticalEffect, ['exclude_from_retrieval', 'exclude_from_agent_context']);
    assert.equal(forget.persistencePerformed, false);
    const deletion = evaluate('delete', { records: [target] });
    assert.equal(deletion.decision, 'DENY');
    assert.ok(deletion.reasonCodes.includes('complete_deletion_capability_unavailable'));
    assert.ok(deletion.unverifiable.includes('backup_retention'));
});

test('restrict applies only the explicitly requested future-use dimensions', () => {
    const result = evaluate('restrict', { requestOverrides: { restrictionKinds: ['retrieval', 'learning'] } });
    assert.deepEqual(result.requestedRestrictions, ['learning', 'retrieval']);
    assert.ok(result.authorizationRequirements.includes('authoritative_consumer_inventory'));
    assert.equal(result.executable, false);
});

test('consent revocation is purpose-specific and only hypothetically invalidates supplied pending IDs', () => {
    const result = evaluate('revoke_consent', { requestOverrides: { targetAssertionId: null, consentId: 'consent-synthetic-1',
        consentPurpose: 'learning', consentStatus: 'active' }, pendingOperationsSnapshot: { revision: 3,
        operations: [{ operationId: 'op-b', consentId: 'consent-synthetic-1', status: 'pending' },
            { operationId: 'op-a', consentId: 'consent-synthetic-1', status: 'pending' },
            { operationId: 'op-external', consentId: 'other-consent', status: 'pending' },
            { operationId: 'op-done', consentId: 'consent-synthetic-1', status: 'applied' }] } });
    assert.equal(result.decision, 'ASK');
    assert.equal(result.consentPurpose, 'learning');
    assert.equal(result.pendingOperationsSnapshotRevision, 3);
    assert.deepEqual(result.pendingOperationIds, ['op-a', 'op-b']);
    assert.equal(result.pendingOperationsEffect, 'would_be_invalidated_hypothetically');
    const revoked = evaluate('revoke_consent', { requestOverrides: { targetAssertionId: null, consentId: 'consent-synthetic-1',
        consentPurpose: 'analysis', consentStatus: 'revoked' }, pendingOperationsSnapshot: { revision: 4, operations: [] } });
    assert.equal(revoked.decision, 'DENY');
    const expired = evaluate('revoke_consent', { requestOverrides: { targetAssertionId: null, consentId: 'consent-synthetic-1',
        consentPurpose: 'analysis', consentStatus: 'expired' }, pendingOperationsSnapshot: { revision: 5, operations: [] } });
    assert.equal(expired.decision, 'DENY');
});

test('revocation and correction previews expose only known in-partition dependencies', () => {
    const first = record(1);
    const dependant = record(2, { supersedes: [assertionId(1)], derivedFromAssertionIds: [assertionId(1)] });
    const result = evaluate('forget', { records: [first, dependant] });
    assert.deepEqual(result.dependencies.assertionIds, [assertionId(1), assertionId(2)]);
    assert.deepEqual(result.dependencies.evidenceIds, [evidenceId(1), evidenceId(2)]);
    assert.equal(result.dependencies.completeness, 'provided_partition_snapshot_only');
    assert.equal(JSON.stringify(result).includes('synthetic fact'), false);
    const withExternalHistory = record(3, { supersedes: [assertionId(399)] });
    const historyPreview = evaluate('forget', { records: [withExternalHistory], requestOverrides: {
        targetAssertionId: assertionId(3),
    } });
    assert.deepEqual(historyPreview.dependencies.unverifiedReferenceIds, [assertionId(399)]);
});

test('Owner role does not permit access to another user private partition', () => {
    const target = record(1);
    const foreignPartition = partition({ ownerPrincipalId: otherId });
    const foreignRecord = { ...target, ownerPrincipalId: otherId };
    const result = evaluatePrivacyOperation({ mode: 'simulate', operation: 'forget', request: request('forget'),
        identity: identity({ principalId: ownerId, role: 'Owner' }), partition: foreignPartition,
        records: [foreignRecord], asOf, pendingOperationsSnapshot: null });
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(result.targetAssertionIds, []);
});

test('shared partitions require explicit membership and non-owner changes fail closed', () => {
    const recipient = 'principal_00000000-0000-4000-8000-000000000003';
    const shared = partition({ partitionId: 'partition_shared-one', kind: 'shared',
        recipientPrincipalIds: [recipient] });
    const target = record(1, { scopeKind: 'shared', sharedRecipientPrincipalIds: [recipient] });
    target.partitionId = shared.partitionId;
    const result = evaluatePrivacyOperation({ mode: 'simulate', operation: 'forget', request: request('forget'),
        identity: identity({ principalId: recipient }), partition: shared, records: [target], asOf,
        pendingOperationsSnapshot: null });
    assert.equal(result.decision, 'DENY');
    const ownerPreview = evaluatePrivacyOperation({ mode: 'simulate', operation: 'forget', request: request('forget'),
        identity: identity(), partition: shared, records: [target], asOf, pendingOperationsSnapshot: null });
    assert.equal(ownerPreview.decision, 'ASK');
    assert.ok(ownerPreview.authorizationRequirements.includes('all_shared_recipients_must_be_reviewed'));
});

test('mixed subjects, partitions, duplicate references, and inconsistent source metadata fail closed', () => {
    const first = record(1), second = record(2, { subject: { type: 'entity', entity_type: 'person', id: personId(9) } });
    assert.throws(() => evaluate('forget', { records: [first, second] }), { message: 'memory_privacy_subject_mismatch' });
    const cross = record(2); cross.partitionId = 'partition_other';
    assert.throws(() => evaluate('forget', { records: [first, cross] }), { message: 'memory_privacy_partition_mismatch' });
    const duplicate = structuredClone(first); duplicate.assertion.id = assertionId(2);
    duplicate.evidencePairs[0].evidence.assertion_id = assertionId(2);
    assert.throws(() => evaluate('forget', { records: [first, duplicate] }), { message: 'memory_privacy_duplicate_reference' });
    const inconsistent = structuredClone(first); inconsistent.assertion.id = assertionId(3);
    inconsistent.evidencePairs[0].evidence.id = evidenceId(3);
    inconsistent.evidencePairs[0].evidence.assertion_id = assertionId(3);
    inconsistent.evidencePairs[0].source.kind = 'email';
    inconsistent.evidencePairs[0].source.origin_trust = 'external_untrusted';
    assert.throws(() => evaluate('forget', { records: [first, inconsistent] }),
        { message: 'memory_privacy_source_reference_inconsistent' });
});

test('unverified identity fixtures never produce authorization and malformed requests are rejected', () => {
    assert.throws(() => evaluate('forget', { identityOverrides: { fixtureOnly: false } }),
        { message: 'memory_privacy_identity_unverified' });
    const result = evaluate('forget');
    assert.ok(result.authorizationRequirements.includes('trusted_identity'));
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
    assert.throws(() => evaluate('restrict', { requestOverrides: { restrictionKinds: ['unknown'] } }),
        { message: 'memory_privacy_request_invalid' });
    const target = record(1);
    const collided = proposalRecord(target, 2);
    collided.evidencePairs[0].evidence.id = evidenceId(1);
    assert.throws(() => evaluate('correct', { records: [target], requestOverrides: { proposedRecord: collided } }),
        { message: 'memory_privacy_proposed_reference_collision' });
    assert.throws(() => evaluate('revoke_consent', { requestOverrides: { targetAssertionId: null,
        consentId: 'consent-synthetic-1', consentPurpose: 'learning', consentStatus: 'active' },
    pendingOperationsSnapshot: { revision: 1, operations: [
        { operationId: 'duplicate', consentId: 'consent-synthetic-1', status: 'pending' },
        { operationId: 'duplicate', consentId: 'consent-synthetic-1', status: 'pending' },
    ] } }), { message: 'memory_privacy_pending_snapshot_invalid' });
});

test('results are deterministic, redacted, immutable in effect, and execution always denies', () => {
    const records = [record(1, { value: 'SENSITIVE_FIXTURE_SECRET' }), record(2, { value: 'synthetic other' })];
    const before = structuredClone(records);
    const first = evaluate('forget', { records });
    const second = evaluate('forget', { records: [...records].reverse() });
    assert.deepEqual(first, second);
    assert.deepEqual(records, before);
    assert.equal(JSON.stringify(first).includes('SENSITIVE_FIXTURE_SECRET'), false);
    assert.equal(first.executable, false);
    assert.equal(first.persistencePerformed, false);
    assert.deepEqual(evaluatePrivacyOperation({ mode: 'execute' }).decision, 'DENY');
});
