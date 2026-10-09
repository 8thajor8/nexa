import { assertDenseArray, validateId, validateMemoryRecord, validateTemporal } from './schema.js';
import { getRelationPredicate } from './relation-predicates.js';
import { describeTemporalRecord } from './temporal-semantics.js';

function exactObject(value, keys, code = 'memory_relationship_invalid') {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
        throw new TypeError(code);
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key)))
        throw new TypeError(code);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
            throw new TypeError(code);
    }
    return value;
}

function validateScopeLabel(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128
        || !/^[A-Za-z0-9._:-]+$/u.test(value)) throw new TypeError('memory_relationship_scope_invalid');
}

function temporalState(record) {
    if (record.state === 'current') return 'active';
    if (record.state === 'historical') return 'historical';
    if (record.state === 'future_fact') return 'future';
    return 'unknown';
}

/**
 * Validates one persisted relation and projects only its endpoints, evidence
 * metadata, and D.1 temporal interpretation. It does not authenticate scope.
 */
export function describeRelation(input) {
    exactObject(input, ['assertion', 'subjectEntity', 'objectEntity', 'evidence', 'asOf', 'scopeLabel']);
    validateScopeLabel(input.scopeLabel);
    validateMemoryRecord('assertions', input.assertion);
    validateMemoryRecord('entities', input.subjectEntity);
    validateMemoryRecord('entities', input.objectEntity);
    validateTemporal(input.asOf, 'asOf');
    assertDenseArray(input.evidence, 'evidence');
    const definition = getRelationPredicate(input.assertion.predicate);
    if (!definition || input.assertion.subject.type !== 'entity'
        || input.assertion.subject.id !== input.subjectEntity.id
        || input.assertion.subject.entity_type !== input.subjectEntity.type
        || input.assertion.object.type !== 'entity_reference'
        || input.assertion.object.id !== input.objectEntity.id
        || input.assertion.object.entity_type !== input.objectEntity.type
        || !definition.subjectTypes.includes(input.subjectEntity.type)
        || !definition.objectTypes.includes(input.objectEntity.type)
        || input.evidence.length === 0)
        throw new TypeError('memory_relationship_invalid');

    const evidenceIds = new Set();
    const derivations = new Set(), sourceKinds = new Set(), trustLabels = new Set();
    for (const pair of input.evidence) {
        exactObject(pair, ['evidence', 'source']);
        validateMemoryRecord('evidence', pair.evidence);
        validateMemoryRecord('sources', pair.source);
        if (pair.evidence.assertion_id !== input.assertion.id
            || pair.evidence.source_id !== pair.source.id || evidenceIds.has(pair.evidence.id))
            throw new TypeError('memory_relationship_evidence_invalid');
        evidenceIds.add(pair.evidence.id);
        derivations.add(pair.evidence.derivation);
        sourceKinds.add(pair.source.kind);
        trustLabels.add(pair.source.origin_trust);
    }

    const temporal = describeTemporalRecord({ assertion: input.assertion,
        source: input.evidence[0].source, evidence: input.evidence[0].evidence,
        asOf: input.asOf, intent: 'fact' });
    return Object.freeze({
        assertionId: input.assertion.id,
        subjectEntityId: input.subjectEntity.id,
        predicate: input.assertion.predicate,
        objectEntityId: input.objectEntity.id,
        symmetric: definition.symmetric,
        assertionStatus: input.assertion.status,
        temporalState: temporalState(temporal),
        temporalReason: temporal.reason,
        validFrom: structuredClone(input.assertion.valid_from),
        validTo: structuredClone(input.assertion.valid_to),
        recordedAt: input.assertion.recorded_at,
        evidence: Object.freeze({ count: evidenceIds.size,
            derivations: Object.freeze([...derivations].sort()),
            sourceKinds: Object.freeze([...sourceKinds].sort()),
            originTrust: Object.freeze([...trustLabels].sort()),
            status: 'present_unverified' }),
        uncertaintyReasons: Object.freeze(['relationship_truth_not_independently_verified',
            ...(temporal.state === 'unknown' || temporal.state === 'future_fact' ? [temporal.reason] : [])]),
        executable: false,
        persistencePerformed: false,
    });
}

function duplicateKey(relation) {
    const endpoints = relation.symmetric
        ? [relation.subjectEntityId, relation.objectEntityId].sort()
        : [relation.subjectEntityId, relation.objectEntityId];
    const temporalKey = value => value === null ? null : [value.precision, value.value];
    return JSON.stringify([relation.predicate, endpoints, temporalKey(relation.validFrom), temporalKey(relation.validTo)]);
}

/**
 * Queries one already-authorized, single-scope fixture set. Scope labels only
 * detect declared mixing; they are not proof of authorization or isolation.
 */
export function queryRelations(input) {
    exactObject(input, ['records', 'fromEntityId', 'toEntityId', 'predicate', 'mode']);
    assertDenseArray(input.records, 'records');
    if (input.fromEntityId !== null) validateId(input.fromEntityId, 'entities', 'fromEntityId');
    if (input.toEntityId !== null) validateId(input.toEntityId, 'entities', 'toEntityId');
    if (input.predicate !== null && !getRelationPredicate(input.predicate))
        throw new TypeError('memory_relationship_predicate_invalid');
    if (!['simulate', 'execute'].includes(input.mode)) throw new TypeError('memory_relationship_mode_invalid');
    if (input.mode === 'execute') return Object.freeze({ decision: 'DENY', relations: Object.freeze([]),
        issues: Object.freeze([]), executable: false, persistencePerformed: false });
    if (input.fromEntityId === null) throw new TypeError('memory_relationship_query_invalid');

    const prepared = input.records.map(record => ({ relation: describeRelation(record), scopeLabel: record.scopeLabel }));
    if (new Set(prepared.map(item => item.scopeLabel)).size > 1)
        throw new TypeError('memory_relationship_scope_mismatch');
    if (new Set(input.records.map(record => `${record.asOf.precision}\u0000${record.asOf.value}`)).size > 1)
        throw new TypeError('memory_relationship_reference_time_mismatch');
    const relations = prepared.map(item => item.relation);
    if (new Set(relations.map(item => item.assertionId)).size !== relations.length)
        throw new TypeError('memory_relationship_duplicate_assertion');

    const matched = relations.filter(relation => {
        if (input.predicate !== null && relation.predicate !== input.predicate) return false;
        if (input.toEntityId === null)
            return relation.subjectEntityId === input.fromEntityId || relation.objectEntityId === input.fromEntityId;
        if (relation.subjectEntityId === input.fromEntityId && relation.objectEntityId === input.toEntityId) return true;
        return relation.symmetric && relation.subjectEntityId === input.toEntityId
            && relation.objectEntityId === input.fromEntityId;
    });
    const duplicateGroups = new Map();
    for (const relation of matched) {
        const key = duplicateKey(relation);
        const ids = duplicateGroups.get(key) ?? [];
        ids.push(relation.assertionId);
        duplicateGroups.set(key, ids);
    }
    const duplicateIds = new Set([...duplicateGroups.values()].filter(ids => ids.length > 1).flat());
    const issues = [...duplicateGroups.values()].filter(ids => ids.length > 1)
        .map(assertionIds => Object.freeze({ kind: 'duplicate_relation', assertionIds: Object.freeze(assertionIds.sort()) }))
        .sort((a, b) => a.assertionIds[0].localeCompare(b.assertionIds[0]));

    const selected = matched.map(relation => {
        let matchDirection = 'outgoing';
        if (relation.subjectEntityId !== input.fromEntityId) matchDirection = relation.symmetric
            ? 'symmetric_reverse' : 'incoming';
        return Object.freeze({ ...relation, matchDirection,
            duplicate: duplicateIds.has(relation.assertionId) });
    }).sort((a, b) => a.assertionId.localeCompare(b.assertionId));

    return Object.freeze({ decision: 'SIMULATED', relations: Object.freeze(selected),
        issues: Object.freeze(issues), executable: false, persistencePerformed: false });
}
