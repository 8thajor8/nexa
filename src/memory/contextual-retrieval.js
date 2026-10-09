import { assertDenseArray, assertExactObject, validateId, validateTemporal } from './schema.js';
import { describeTemporalRecord } from './temporal-semantics.js';
import { queryRelations } from './relationship-semantics.js';
import { evaluateAssertionSet } from './contradiction-semantics.js';
import { evaluateConsolidation } from './consolidation-semantics.js';
import { getRelationPredicate } from './relation-predicates.js';

const MAX_RECORDS = 100;
const MAX_RESULTS = 20;
const MAX_RELATIONS = 10;
const TEMPORAL = new Set(['any', 'current', 'history', 'future', 'uncertain']);

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
}

function safeReason(reason) {
    return typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(reason);
}

function temporalMatch(state, requested) {
    if (requested === 'any') return true;
    if (requested === 'current') return state === 'current';
    if (requested === 'history') return state === 'historical';
    if (requested === 'future') return state === 'planned' || state === 'future_fact';
    return state === 'unknown';
}

function validateInput(input) {
    assertExactObject(input, ['mode', 'records', 'query', 'asOf', 'restrictionSnapshot'], 'input');
    if (input.mode !== 'simulate' && input.mode !== 'execute') throw new TypeError('memory_context_mode_invalid');
    assertDenseArray(input.records, 'records');
    if (input.records.length > MAX_RECORDS) throw new TypeError('memory_context_record_limit');
    assertExactObject(input.query, ['subject', 'entityIds', 'predicates', 'relationPredicates', 'temporal', 'limit'], 'query');
    assertDenseArray(input.query.entityIds, 'query.entityIds');
    assertDenseArray(input.query.predicates, 'query.predicates');
    assertDenseArray(input.query.relationPredicates, 'query.relationPredicates');
    if (input.query.subject !== null) {
        const subject = input.query.subject;
        if (!subject || typeof subject !== 'object') throw new TypeError('memory_context_query_invalid');
        if (subject.type === 'entity') {
            assertExactObject(subject, ['type', 'entity_type', 'id'], 'query.subject');
            validateId(subject.id, subject.entity_type, 'query.subject.id');
        } else {
            assertExactObject(subject, ['type'], 'query.subject');
            if (!['owner', 'unspecified'].includes(subject.type)) throw new TypeError('memory_context_query_invalid');
        }
    }
    for (const id of input.query.entityIds) validateId(id, 'entities', 'query.entityIds');
    for (const predicate of [...input.query.predicates, ...input.query.relationPredicates]) {
        if (typeof predicate !== 'string' || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(predicate))
            throw new TypeError('memory_context_query_invalid');
    }
    for (const predicate of input.query.relationPredicates) {
        if (!getRelationPredicate(predicate)) throw new TypeError('memory_context_relation_predicate_invalid');
    }
    if (!TEMPORAL.has(input.query.temporal) || !Number.isInteger(input.query.limit)
        || input.query.limit < 1 || input.query.limit > MAX_RESULTS) throw new TypeError('memory_context_query_invalid');
    if (input.restrictionSnapshot !== null) {
        assertExactObject(input.restrictionSnapshot, ['fixtureOnly', 'entries'], 'restrictionSnapshot');
        if (input.restrictionSnapshot.fixtureOnly !== true) throw new TypeError('memory_context_restriction_snapshot_invalid');
        assertDenseArray(input.restrictionSnapshot.entries, 'restrictionSnapshot.entries');
        for (const entry of input.restrictionSnapshot.entries) {
            assertExactObject(entry, ['assertionId', 'restrictionKinds'], 'restriction');
            validateId(entry.assertionId, 'assertions', 'restriction.assertionId');
            assertDenseArray(entry.restrictionKinds, 'restriction.restrictionKinds');
            if (entry.restrictionKinds.some(kind => !['retrieval', 'context', 'learning', 'sharing'].includes(kind)))
                throw new TypeError('memory_context_restriction_invalid');
            if (new Set(entry.restrictionKinds).size !== entry.restrictionKinds.length)
                throw new TypeError('memory_context_restriction_duplicate');
        }
    }
    if (new Set(input.query.entityIds).size !== input.query.entityIds.length
        || new Set(input.query.predicates).size !== input.query.predicates.length
        || new Set(input.query.relationPredicates).size !== input.query.relationPredicates.length)
        throw new TypeError('memory_context_query_duplicate');
    if (input.mode === 'execute') return;
    if (input.asOf === null) throw new TypeError('memory_context_reference_time_invalid');
    validateTemporal(input.asOf, 'asOf');
    const records = input.records;
    const ids = new Set();
    const evidenceIds = new Set();
    const sourceSignatures = new Map();
    const scopes = new Set();
    const times = new Set();
    for (const row of records) {
        assertExactObject(row, ['assertion', 'evidence', 'asOf', 'intent', 'scopeLabel', 'subjectEntity', 'objectEntity'], 'record');
        const relation = row.subjectEntity !== null || row.objectEntity !== null;
        if (relation) {
            if (row.intent !== 'fact' || row.subjectEntity === null || row.objectEntity === null)
                throw new TypeError('memory_context_relation_invalid');
            recordTemporal(row);
        } else {
            recordTemporal(row);
            evaluateConsolidation({ records: [{ assertion: row.assertion, evidence: row.evidence,
                asOf: row.asOf, intent: row.intent, scopeLabel: row.scopeLabel,
                subjectEntity: null, objectEntity: null }], equivalenceCatalog: null,
            contradictionCatalog: null, mode: 'simulate' });
        }
        if (typeof row.scopeLabel !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(row.scopeLabel))
            throw new TypeError('memory_context_scope_invalid');
        scopes.add(row.scopeLabel);
        times.add(canonical(row.asOf));
        if (ids.has(row.assertion.id)) throw new TypeError('memory_context_duplicate_assertion');
        ids.add(row.assertion.id);
        for (const pair of row.evidence) {
            if (evidenceIds.has(pair.evidence.id)) throw new TypeError('memory_context_duplicate_evidence');
            evidenceIds.add(pair.evidence.id);
            const signature = canonical(pair.source);
            const previous = sourceSignatures.get(pair.source.id);
            if (previous !== undefined && previous !== signature) throw new TypeError('memory_context_source_inconsistent');
            sourceSignatures.set(pair.source.id, signature);
        }
        if (canonical(row.asOf) !== canonical(input.asOf)) throw new TypeError('memory_context_reference_time_mismatch');
    }
    if (scopes.size > 1) throw new TypeError('memory_context_scope_mismatch');
    if (times.size > 1) throw new TypeError('memory_context_reference_time_mismatch');
    if (input.restrictionSnapshot && new Set(input.restrictionSnapshot.entries.map(item => item.assertionId)).size
        !== input.restrictionSnapshot.entries.length) throw new TypeError('memory_context_restriction_duplicate');
}

function recordTemporal(row) {
    if (row.subjectEntity !== null || row.objectEntity !== null) {
        const result = queryRelations({ records: [relationRecord(row)], fromEntityId: row.assertion.subject.id,
            toEntityId: null, predicate: row.assertion.predicate, mode: 'simulate' });
        const relation = result.relations[0];
        if (!relation) throw new TypeError('memory_context_relation_invalid');
        return { state: ({ active: 'current', future: 'future_fact' })[relation.temporalState]
            ?? relation.temporalState, reason: relation.temporalReason };
    }
    const result = describeTemporalRecord({ assertion: row.assertion, source: row.evidence[0]?.source,
        evidence: row.evidence[0]?.evidence, asOf: row.asOf, intent: row.intent });
    return { state: result.state, reason: result.reason };
}

function relationRecord(row) {
    return { assertion: row.assertion, subjectEntity: row.subjectEntity, objectEntity: row.objectEntity,
        evidence: row.evidence, asOf: row.asOf, scopeLabel: row.scopeLabel };
}

/**
 * D.6 read-only retrieval over a bounded, caller-filtered dataset. Labels and
 * IDs are structural selectors only; this module cannot authenticate or authorize them.
 */
export function retrieveContext(input) {
    validateInput(input);
    if (input.mode === 'execute') return Object.freeze({ decision: 'DENY', results: Object.freeze([]),
        relations: Object.freeze([]), conflicts: Object.freeze([]), comparisons: Object.freeze([]), duplicates: Object.freeze([]),
        exclusions: Object.freeze([]), executable: false, persistencePerformed: false });

    const restrictionMap = new Map((input.restrictionSnapshot?.entries ?? [])
        .map(item => [item.assertionId, new Set(item.restrictionKinds)]));
    const excluded = [];
    const candidates = [];
    for (const row of input.records) {
        const temporal = recordTemporal(row);
        const subjectMatch = input.query.subject === null || canonical(row.assertion.subject) === canonical(input.query.subject);
        const endpointMatch = input.query.entityIds.length === 0 || input.query.entityIds.some(id =>
            row.assertion.subject.id === id || row.assertion.object?.id === id);
        const relation = row.subjectEntity !== null || row.objectEntity !== null;
        const predicateMatch = relation
            ? (input.query.relationPredicates.length === 0 || input.query.relationPredicates.includes(row.assertion.predicate))
            : (input.query.predicates.length === 0 || input.query.predicates.includes(row.assertion.predicate));
        if (!subjectMatch || !endpointMatch || !predicateMatch || !temporalMatch(temporal.state, input.query.temporal)) continue;
        const restricted = restrictionMap.get(row.assertion.id);
        if (restricted?.has('retrieval') || restricted?.has('context') || restricted?.has('sharing')) {
            excluded.push(Object.freeze({ assertionId: row.assertion.id, reasonCode: 'restricted_from_retrieval' }));
            continue;
        }
        const reasons = [];
        if (subjectMatch) reasons.push('subject_match');
        if (endpointMatch) reasons.push('entity_endpoint_match');
        if (predicateMatch) reasons.push('predicate_match');
        reasons.push(`temporal_${temporal.state}`);
        candidates.push({ row, temporal, reasons, relation,
            score: temporal.state === 'current' ? 10 : 0 });
    }

    const selectedCandidates = candidates.sort((a, b) => b.score - a.score
        || a.row.assertion.id.localeCompare(b.row.assertion.id)).slice(0, input.query.limit);

    // D.3 and D.4 operate only on facts sharing one exact subject, scope and as-of.
    const facts = selectedCandidates.filter(item => !item.relation);
    const groups = new Map();
    for (const item of facts) {
        const key = canonical(item.row.assertion.subject);
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
    }
    const comparisons = [];
    const duplicates = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const contradiction = evaluateAssertionSet({ records: group.map(item => ({ assertion: item.row.assertion,
            source: item.row.evidence[0].source, evidence: item.row.evidence[0].evidence,
            asOf: item.row.asOf, intent: item.row.intent })), scopeLabels: group.map(item => item.row.scopeLabel),
        syntheticCatalog: null, mode: 'simulate' });
        for (const comparison of contradiction.comparisons) {
            if (comparison.classification !== 'compatible') comparisons.push(Object.freeze({
                assertionIds: comparison.assertionIds, classification: comparison.classification,
                reasonCode: comparison.reasonCode }));
        }
        const consolidationRecords = group.map(item => ({ assertion: item.row.assertion,
            evidence: item.row.evidence, asOf: item.row.asOf, intent: item.row.intent,
            scopeLabel: item.row.scopeLabel, subjectEntity: null, objectEntity: null }));
        const consolidation = evaluateConsolidation({ records: consolidationRecords,
            equivalenceCatalog: null, contradictionCatalog: null, mode: 'simulate' });
        for (const comparison of consolidation.comparisons) {
            if (comparison.classification === 'exact_duplicate' || comparison.classification === 'equivalent_by_explicit_rule')
                duplicates.push(Object.freeze({ assertionIds: comparison.assertionIds,
                    classification: comparison.classification, reasonCode: comparison.reasonCode }));
        }
    }
    comparisons.sort((a, b) => a.assertionIds[0].localeCompare(b.assertionIds[0]) || a.assertionIds[1].localeCompare(b.assertionIds[1]));
    duplicates.sort((a, b) => a.assertionIds[0].localeCompare(b.assertionIds[0]) || a.assertionIds[1].localeCompare(b.assertionIds[1]));

    const comparisonClasses = new Map();
    for (const item of comparisons) for (const id of item.assertionIds) {
        const classes = comparisonClasses.get(id) ?? new Set();
        classes.add(item.classification);
        comparisonClasses.set(id, classes);
    }
    const conflictIds = new Set(comparisons.filter(item => item.classification === 'potential_conflict')
        .flatMap(item => item.assertionIds));
    const duplicateIds = new Set(duplicates.flatMap(item => item.assertionIds));
    const results = selectedCandidates.map(item => Object.freeze({ assertionId: item.row.assertion.id,
            predicate: item.row.assertion.predicate, subject: structuredClone(item.row.assertion.subject),
            objectReference: item.relation ? structuredClone(item.row.assertion.object) : null,
            temporalState: item.temporal.state, temporalReason: item.temporal.reason,
            score: item.score, scoreMeaning: 'structural_relevance_not_truth_confidence',
            reasonCodes: Object.freeze(item.reasons.sort()),
            evidenceIds: Object.freeze(item.row.evidence.map(pair => pair.evidence.id).sort()),
            reviewFlags: Object.freeze([...(conflictIds.has(item.row.assertion.id) ? ['potential_conflict'] : []),
                ...[...(comparisonClasses.get(item.row.assertion.id) ?? [])]
                    .filter(kind => kind !== 'potential_conflict').map(kind => `comparison_${kind}`),
                ...(duplicateIds.has(item.row.assertion.id) ? ['duplicate_candidate'] : [])].sort()) }));

    const directRelations = selectedCandidates.filter(item => item.relation).flatMap(item => queryRelations({
        records: [relationRecord(item.row)], fromEntityId: item.row.assertion.subject.id,
        toEntityId: null, predicate: item.row.assertion.predicate, mode: 'simulate' }).relations)
        .sort((a, b) => a.assertionId.localeCompare(b.assertionId)).slice(0, MAX_RELATIONS);
    return freeze({ decision: 'SIMULATED', results, relations: directRelations,
        conflicts: comparisons.filter(item => item.classification === 'potential_conflict'),
        comparisons, duplicates, exclusions: excluded.sort((a, b) => a.assertionId.localeCompare(b.assertionId)),
        limits: Object.freeze({ inputRecords: MAX_RECORDS, results: input.query.limit, relations: MAX_RELATIONS }),
        executable: false, persistencePerformed: false });
}
