import { assertDenseArray, assertExactObject, validateId, validateMemoryRecord, validateTemporal } from './schema.js';
import { describeTemporalRecord } from './temporal-semantics.js';
import { compareAssertionPair } from './contradiction-semantics.js';
import { getRelationPredicate } from './relation-predicates.js';

const OPERATIONS = new Set(['correct', 'restrict', 'forget', 'delete', 'revoke_consent']);
const RESTRICTIONS = new Set(['retrieval', 'context', 'learning', 'sharing']);
const CONSENT_PURPOSES = new Set(['analysis', 'learning', 'storage', 'sharing']);
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARTITION = /^partition_[A-Za-z0-9._:-]{1,120}$/u;
const SCOPE = /^[A-Za-z0-9._:-]{1,128}$/u;

function exact(value, keys, code) {
    assertExactObject(value, keys, code);
    return value;
}

function denseStrings(value, code, pattern = null) {
    assertDenseArray(value, code);
    if (value.some(item => typeof item !== 'string' || (pattern && !pattern.test(item)))
        || new Set(value).size !== value.length) throw new TypeError(code);
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function validateIdentity(identity) {
    exact(identity, ['principalId', 'role', 'fixtureOnly'], 'memory_privacy_identity_invalid');
    if (typeof identity.principalId !== 'string' || !PRINCIPAL.test(identity.principalId)
        || !['Owner', 'Member'].includes(identity.role) || identity.fixtureOnly !== true)
        throw new TypeError('memory_privacy_identity_unverified');
}

function validatePartition(partition) {
    exact(partition, ['partitionId', 'kind', 'ownerPrincipalId', 'scopeLabel', 'recipientPrincipalIds'],
        'memory_privacy_partition_invalid');
    if (typeof partition.partitionId !== 'string' || !PARTITION.test(partition.partitionId)
        || !['private', 'shared'].includes(partition.kind)
        || typeof partition.ownerPrincipalId !== 'string' || !PRINCIPAL.test(partition.ownerPrincipalId)
        || typeof partition.scopeLabel !== 'string' || !SCOPE.test(partition.scopeLabel))
        throw new TypeError('memory_privacy_partition_invalid');
    denseStrings(partition.recipientPrincipalIds, 'memory_privacy_partition_invalid', PRINCIPAL);
    if (partition.kind === 'private' && partition.recipientPrincipalIds.length !== 0)
        throw new TypeError('memory_privacy_partition_invalid');
}

function validateRecord(record, partition) {
    exact(record, ['assertion', 'evidencePairs', 'intent', 'partitionId', 'ownerPrincipalId', 'scopeKind',
        'sharedRecipientPrincipalIds', 'derivedFromAssertionIds'], 'memory_privacy_record_invalid');
    validateMemoryRecord('assertions', record.assertion);
    if (!['fact', 'plan'].includes(record.intent)) throw new TypeError('memory_privacy_record_invalid');
    if (record.partitionId !== partition.partitionId || record.ownerPrincipalId !== partition.ownerPrincipalId
        || record.scopeKind !== partition.kind) throw new TypeError('memory_privacy_partition_mismatch');
    denseStrings(record.sharedRecipientPrincipalIds, 'memory_privacy_record_invalid', PRINCIPAL);
    denseStrings(record.derivedFromAssertionIds, 'memory_privacy_record_invalid');
    for (const id of record.derivedFromAssertionIds) validateId(id, 'assertions', 'derivedFromAssertionId');
    if (canonical(record.sharedRecipientPrincipalIds) !== canonical(partition.recipientPrincipalIds))
        throw new TypeError('memory_privacy_partition_mismatch');
    assertDenseArray(record.evidencePairs, 'memory_privacy_evidence_invalid');
    if (record.evidencePairs.length === 0) throw new TypeError('memory_privacy_evidence_invalid');
    const evidenceIds = new Set();
    for (const pair of record.evidencePairs) {
        exact(pair, ['evidence', 'source'], 'memory_privacy_evidence_invalid');
        validateMemoryRecord('evidence', pair.evidence);
        validateMemoryRecord('sources', pair.source);
        if (pair.evidence.assertion_id !== record.assertion.id || pair.evidence.source_id !== pair.source.id
            || evidenceIds.has(pair.evidence.id)) throw new TypeError('memory_privacy_evidence_invalid');
        evidenceIds.add(pair.evidence.id);
    }
}

function validateRequest(request) {
    exact(request, ['operation', 'targetAssertionId', 'proposedRecord', 'restrictionKinds', 'consentId',
        'consentPurpose', 'consentStatus'], 'memory_privacy_request_invalid');
    if (!OPERATIONS.has(request.operation)) throw new TypeError('memory_privacy_operation_invalid');
    if (request.targetAssertionId !== null) validateId(request.targetAssertionId, 'assertions', 'targetAssertionId');
    if (request.proposedRecord !== null && (!request.proposedRecord || typeof request.proposedRecord !== 'object'))
        throw new TypeError('memory_privacy_request_invalid');
    assertDenseArray(request.restrictionKinds, 'memory_privacy_request_invalid');
    if (request.restrictionKinds.some(item => !RESTRICTIONS.has(item))
        || new Set(request.restrictionKinds).size !== request.restrictionKinds.length)
        throw new TypeError('memory_privacy_request_invalid');
    if (request.operation === 'revoke_consent') {
        if (typeof request.consentId !== 'string' || request.consentId.length < 1 || request.consentId.length > 128
            || !CONSENT_PURPOSES.has(request.consentPurpose)
            || !['active', 'expired', 'revoked', 'unknown'].includes(request.consentStatus)
            || request.targetAssertionId !== null || request.proposedRecord !== null)
            throw new TypeError('memory_privacy_request_invalid');
    } else if (request.consentId !== null || request.consentPurpose !== null || request.consentStatus !== null
        ) throw new TypeError('memory_privacy_request_invalid');
    if (request.operation === 'restrict' && request.restrictionKinds.length === 0)
        throw new TypeError('memory_privacy_request_invalid');
    if (request.operation !== 'restrict' && request.restrictionKinds.length !== 0)
        throw new TypeError('memory_privacy_request_invalid');
    if (request.operation === 'correct' && request.proposedRecord === null)
        throw new TypeError('memory_privacy_request_invalid');
    if (request.operation !== 'correct' && request.proposedRecord !== null)
        throw new TypeError('memory_privacy_request_invalid');
    if (request.operation !== 'revoke_consent' && request.targetAssertionId === null)
        throw new TypeError('memory_privacy_request_invalid');
}

function validatePendingSnapshot(snapshot) {
    if (snapshot === null) return;
    exact(snapshot, ['revision', 'operations'], 'memory_privacy_pending_snapshot_invalid');
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
        throw new TypeError('memory_privacy_pending_snapshot_invalid');
    assertDenseArray(snapshot.operations, 'memory_privacy_pending_snapshot_invalid');
    const ids = new Set();
    for (const item of snapshot.operations) {
        exact(item, ['operationId', 'consentId', 'status'], 'memory_privacy_pending_snapshot_invalid');
        if (typeof item.operationId !== 'string' || item.operationId.length < 1 || item.operationId.length > 128
            || typeof item.consentId !== 'string' || item.consentId.length < 1 || item.consentId.length > 128
            || !['pending', 'applied', 'rejected', 'expired'].includes(item.status) || ids.has(item.operationId))
            throw new TypeError('memory_privacy_pending_snapshot_invalid');
        ids.add(item.operationId);
    }
}

function freezeDeepResult(result) {
    const freeze = value => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
        for (const child of Object.values(value)) freeze(child);
        return Object.freeze(value);
    };
    return freeze(result);
}

function denied(operation, reasonCode) {
    return freezeDeepResult({ decision: 'DENY', operation, reasonCodes: [reasonCode], targetAssertionIds: [],
        dependencies: { assertionIds: [], evidenceIds: [], sourceIds: [], unverifiedReferenceIds: [], completeness: 'not_evaluated' },
        unverifiable: [], authorizationRequirements: ['trusted_identity_and_operation_specific_authorization'],
        executable: false, persistencePerformed: false });
}

function dependencyProjection(target, records) {
    const dependents = records.filter(item => item.assertion.id !== target.assertion.id
        && (item.assertion.supersedes.includes(target.assertion.id)
            || item.derivedFromAssertionIds.includes(target.assertion.id)));
    const affected = [target, ...dependents];
    const suppliedIds = new Set(records.map(item => item.assertion.id));
    const unverifiedReferenceIds = affected.flatMap(item => [
        ...item.assertion.supersedes, ...item.derivedFromAssertionIds,
    ]).filter(id => !suppliedIds.has(id));
    return {
        assertionIds: [...new Set([target.assertion.id, ...dependents.map(item => item.assertion.id)])].sort(),
        evidenceIds: [...new Set(affected.flatMap(item => item.evidencePairs.map(pair => pair.evidence.id)))].sort(),
        sourceIds: [...new Set(affected.flatMap(item => item.evidencePairs.map(pair => pair.source.id)))].sort(),
        unverifiedReferenceIds: [...new Set(unverifiedReferenceIds)].sort(),
        completeness: 'provided_partition_snapshot_only',
    };
}

function sharedReviewRequirements(partition) {
    return partition.kind === 'shared' ? ['all_shared_recipients_must_be_reviewed'] : [];
}

function analyzeCorrection(target, proposed, asOf, scopeLabel) {
    if (target.assertion.status !== 'active') return { reason: 'correction_target_not_active', classification: 'unresolved' };
    if (proposed.assertion.status !== 'active' || proposed.assertion.id === target.assertion.id
        || canonical(proposed.assertion.subject) !== canonical(target.assertion.subject)
        || proposed.assertion.kind !== target.assertion.kind
        || proposed.assertion.predicate !== target.assertion.predicate
        || canonical(proposed.assertion.compatibility) !== canonical(target.assertion.compatibility))
        return { reason: 'correction_target_binding_mismatch', classification: 'unresolved' };
    if (getRelationPredicate(target.assertion.predicate)) return { reason: 'relationship_correction_requires_dedicated_review',
        classification: 'unresolved' };
    if (target.intent !== proposed.intent) return { reason: 'plan_fact_intent_mismatch', classification: 'unresolved' };
    const leftPair = target.evidencePairs[0], rightPair = proposed.evidencePairs[0];
    const leftTemporal = describeTemporalRecord({ assertion: target.assertion, source: leftPair.source,
        evidence: leftPair.evidence, asOf, intent: target.intent });
    const rightTemporal = describeTemporalRecord({ assertion: proposed.assertion, source: rightPair.source,
        evidence: rightPair.evidence, asOf, intent: proposed.intent });
    const comparison = compareAssertionPair({
        left: { assertion: target.assertion, source: leftPair.source, evidence: leftPair.evidence, asOf, intent: target.intent },
        right: { assertion: proposed.assertion, source: rightPair.source, evidence: rightPair.evidence, asOf, intent: proposed.intent },
        leftScopeLabel: scopeLabel, rightScopeLabel: scopeLabel,
        leftTransitionPreview: null, rightTransitionPreview: null, syntheticCatalog: null, mode: 'simulate',
    }).comparisons[0];
    if (comparison.classification === 'temporal_change') return { reason: 'temporal_change_not_error_correction',
        classification: 'temporal_change', temporalStates: [leftTemporal.state, rightTemporal.state] };
    if (comparison.classification === 'superseded') return { reason: 'existing_supersession_lineage_requires_review',
        classification: 'unresolved' };
    return { reason: 'truth_and_source_conflict_not_adjudicated', classification: 'correction_unresolved',
        temporalStates: [leftTemporal.state, rightTemporal.state] };
}

/**
 * D.5 pure preview over a caller-filtered, synthetic partition snapshot.
 * It never authenticates the supplied fixture identity or invokes persistence.
 */
export function evaluatePrivacyOperation(input) {
    const mode = Object.getOwnPropertyDescriptor(input ?? {}, 'mode')?.value;
    if (mode === 'execute') return denied('unknown', 'trusted_privacy_operation_unavailable');
    exact(input, ['mode', 'operation', 'request', 'identity', 'partition', 'records', 'asOf',
        'pendingOperationsSnapshot'],
        'memory_privacy_input_invalid');
    if (input.mode !== 'simulate') throw new TypeError('memory_privacy_mode_invalid');
    validateRequest(input.request);
    validateIdentity(input.identity);
    validatePartition(input.partition);
    validateTemporal(input.asOf, 'asOf');
    validatePendingSnapshot(input.pendingOperationsSnapshot);
    if ((input.request.operation === 'revoke_consent') !== (input.pendingOperationsSnapshot !== null))
        throw new TypeError('memory_privacy_pending_snapshot_invalid');
    assertDenseArray(input.records, 'memory_privacy_records_invalid');
    if (input.records.length > 200) throw new TypeError('memory_privacy_record_limit');
    const records = input.records;
    records.forEach(item => validateRecord(item, input.partition));
    const assertionIds = records.map(item => item.assertion.id);
    const evidenceIds = records.flatMap(item => item.evidencePairs.map(pair => pair.evidence.id));
    const sources = new Map();
    for (const item of records) for (const pair of item.evidencePairs) {
        const signature = canonical(pair.source), previous = sources.get(pair.source.id);
        if (previous !== undefined && previous !== signature)
            throw new TypeError('memory_privacy_source_reference_inconsistent');
        sources.set(pair.source.id, signature);
    }
    if (new Set(assertionIds).size !== assertionIds.length || new Set(evidenceIds).size !== evidenceIds.length)
        throw new TypeError('memory_privacy_duplicate_reference');
    if (records.length > 1 && records.some(item => canonical(item.assertion.subject) !== canonical(records[0].assertion.subject)))
        throw new TypeError('memory_privacy_subject_mismatch');
    if (records.some(item => input.partition.kind === 'private'
        ? item.sharedRecipientPrincipalIds.length !== 0
        : item.sharedRecipientPrincipalIds.length === 0)) throw new TypeError('memory_privacy_partition_mismatch');
    if (input.operation !== input.request.operation) throw new TypeError('memory_privacy_operation_mismatch');

    const { identity, partition, request } = input;
    const actorIsOwner = identity.principalId === partition.ownerPrincipalId;
    const actorIsRecipient = partition.kind === 'shared' && partition.recipientPrincipalIds.includes(identity.principalId);
    if (partition.kind === 'private' && !actorIsOwner)
        return denied(request.operation, 'private_partition_owner_mismatch');
    if (partition.kind === 'shared' && !actorIsOwner && !actorIsRecipient)
        return denied(request.operation, 'shared_partition_recipient_mismatch');
    if (request.operation !== 'revoke_consent' && partition.kind === 'shared' && !actorIsOwner)
        return denied(request.operation, 'shared_change_requires_owner_and_recipient_review');

    const target = request.targetAssertionId === null ? null : records.find(item => item.assertion.id === request.targetAssertionId);
    if (request.operation !== 'revoke_consent' && !target)
        return denied(request.operation, 'target_not_in_supplied_partition_snapshot');
    if (request.operation === 'correct') {
        validateRecord(request.proposedRecord, partition);
        if (assertionIds.includes(request.proposedRecord.assertion.id))
            throw new TypeError('memory_privacy_proposed_assertion_id_collision');
        const existingEvidenceIds = new Set(evidenceIds);
        if (request.proposedRecord.evidencePairs.some(pair => existingEvidenceIds.has(pair.evidence.id)))
            throw new TypeError('memory_privacy_proposed_reference_collision');
        const analysis = analyzeCorrection(target, request.proposedRecord, input.asOf, partition.scopeLabel);
        return freezeDeepResult({ decision: 'ASK', operation: request.operation,
            reasonCodes: [analysis.reason], classification: analysis.classification,
            temporalStates: analysis.temporalStates ?? [], targetAssertionIds: [target.assertion.id],
            proposedAssertionId: request.proposedRecord.assertion.id,
            dependencies: dependencyProjection(target, records),
            unverifiable: ['source_truth', 'external_supersession_references', 'backups_and_external_derivatives'],
            authorizationRequirements: ['trusted_identity', 'target_specific_correction_confirmation',
                'authoritative_snapshot_recheck', 'preserve_original_evidence_and_history',
                ...sharedReviewRequirements(partition)],
            executable: false, persistencePerformed: false });
    }
    if (request.operation === 'delete') return freezeDeepResult({ decision: 'DENY', operation: 'delete',
        reasonCodes: ['complete_deletion_capability_unavailable'], targetAssertionIds: [target.assertion.id],
        dependencies: dependencyProjection(target, records),
        unverifiable: ['backup_retention', 'logs', 'external_providers', 'derived_indexes', 'shared_projections',
            'references_outside_supplied_partition_snapshot'],
        authorizationRequirements: ['complete_dependency_inventory', 'storage_specific_erasure_and_verification',
            'trusted_identity', 'explicit_deletion_authorization'],
        executable: false, persistencePerformed: false });
    if (request.operation === 'revoke_consent') {
        if (!actorIsOwner || request.consentStatus !== 'active') return denied('revoke_consent',
            !actorIsOwner ? 'consent_subject_mismatch' : `consent_${request.consentStatus}`);
        return freezeDeepResult({ decision: 'ASK', operation: 'revoke_consent',
            reasonCodes: ['revocation_requires_trusted_confirmation'], targetAssertionIds: [],
            consentPurpose: request.consentPurpose,
            pendingOperationsSnapshotRevision: input.pendingOperationsSnapshot.revision,
            pendingOperationIds: input.pendingOperationsSnapshot.operations
                .filter(item => item.consentId === request.consentId && item.status === 'pending')
                .map(item => item.operationId).sort(),
            pendingOperationsEffect: 'would_be_invalidated_hypothetically',
            dependencies: { assertionIds: [], evidenceIds: [], sourceIds: [], unverifiedReferenceIds: [],
                completeness: 'provided_pending_ids_only' },
            unverifiable: ['pending_snapshot_freshness', 'other_consent_stores', 'operations_outside_supplied_snapshot'],
            authorizationRequirements: ['consent_subject_identity', 'explicit_revocation_action',
                'authoritative_pending_operation_invalidation'], executable: false, persistencePerformed: false });
    }
    if (request.operation === 'forget') return freezeDeepResult({ decision: 'ASK', operation: 'forget',
        reasonCodes: ['retrieval_and_context_exclusion_requires_authorized_change'],
        targetAssertionIds: [target.assertion.id], hypotheticalEffect: ['exclude_from_retrieval', 'exclude_from_agent_context'],
        dependencies: dependencyProjection(target, records),
        unverifiable: ['backups', 'logs', 'external_providers', 'derived_indexes', 'shared_projections',
            'references_outside_supplied_partition_snapshot'],
        authorizationRequirements: ['trusted_identity', 'target_specific_forget_confirmation',
            'authoritative_snapshot_recheck', 'invalidate_pending_learning', ...sharedReviewRequirements(partition)],
        executable: false, persistencePerformed: false });
    return freezeDeepResult({ decision: 'ASK', operation: 'restrict',
        reasonCodes: ['use_restriction_requires_authorized_change'], targetAssertionIds: [target.assertion.id],
        requestedRestrictions: [...request.restrictionKinds].sort(),
        dependencies: dependencyProjection(target, records),
        unverifiable: ['consumers_not_in_supplied_inventory', 'external_providers', 'derived_indexes'],
        authorizationRequirements: ['trusted_identity', 'scope_specific_restriction_confirmation',
            'authoritative_consumer_inventory', 'invalidate_pending_learning', ...sharedReviewRequirements(partition)], executable: false,
        persistencePerformed: false });
}
