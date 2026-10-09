import { createHash } from 'node:crypto';
import { assertDenseArray, assertExactObject, validateMemoryRecord, COMPATIBILITY_CATEGORIES } from './schema.js';
import { getRelationPredicate } from './relation-predicates.js';
import { describeTemporalRecord } from './temporal-semantics.js';
import { compareAssertionPair, compareRelationPair } from './contradiction-semantics.js';
import { describeRelation } from './relationship-semantics.js';

const MODES = new Set(['simulate', 'execute']);
const SCOPE_LABEL = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function objectFingerprint(value) {
    return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function safePair(leftId, rightId, classification, reasonCode, proposal = null) {
    return Object.freeze({
        assertionIds: Object.freeze([leftId, rightId].sort()),
        classification,
        reasonCode,
        proposal,
        executable: false,
        persistencePerformed: false,
    });
}

function validateMode(mode) {
    if (!MODES.has(mode)) throw new TypeError('memory_consolidation_mode_invalid');
}

function validateScopeLabel(value) {
    if (typeof value !== 'string' || !SCOPE_LABEL.test(value))
        throw new TypeError('memory_consolidation_scope_invalid');
}

function validateEvidence(record) {
    assertDenseArray(record.evidence, 'record.evidence');
    if (record.evidence.length === 0) throw new TypeError('memory_consolidation_evidence_missing');
    const ids = new Set();
    for (const pair of record.evidence) {
        assertExactObject(pair, ['evidence', 'source'], 'record.evidencePair');
        validateMemoryRecord('evidence', pair.evidence);
        validateMemoryRecord('sources', pair.source);
        if (pair.evidence.assertion_id !== record.assertion.id || pair.evidence.source_id !== pair.source.id
            || ids.has(pair.evidence.id)) throw new TypeError('memory_consolidation_evidence_invalid');
        ids.add(pair.evidence.id);
    }
}

function prepareRecord(record) {
    assertExactObject(record, ['assertion', 'evidence', 'asOf', 'intent', 'scopeLabel',
        'subjectEntity', 'objectEntity'], 'record');
    validateMemoryRecord('assertions', record.assertion);
    validateScopeLabel(record.scopeLabel);
    validateEvidence(record);
    const relation = Boolean(getRelationPredicate(record.assertion.predicate));
    if (relation) {
        if (record.intent !== 'fact' || record.subjectEntity === null || record.objectEntity === null)
            throw new TypeError('memory_consolidation_relation_context_invalid');
        const temporal = describeRelation({
            assertion: record.assertion, subjectEntity: record.subjectEntity, objectEntity: record.objectEntity,
            evidence: record.evidence, asOf: record.asOf, scopeLabel: record.scopeLabel,
        });
        return { record, relation, temporal };
    }
    if (record.subjectEntity !== null || record.objectEntity !== null)
        throw new TypeError('memory_consolidation_relation_context_invalid');
    const temporal = describeTemporalRecord({
        assertion: record.assertion,
        source: record.evidence[0].source,
        evidence: record.evidence[0].evidence,
        asOf: record.asOf,
        intent: record.intent,
    });
    return { record, relation, temporal };
}

function validateRuleCatalog(catalog, name) {
    if (catalog === null) return [];
    assertExactObject(catalog, ['kind', 'rules'], name);
    if (catalog.kind !== 'synthetic_test_only') throw new TypeError('memory_consolidation_catalog_invalid');
    assertDenseArray(catalog.rules, name + '.rules');
    const seenIds = new Set(), seenKeys = new Set();
    return catalog.rules.map(rule => {
        assertExactObject(rule, ['id', 'predicate', 'compatibility', 'objectFingerprints'], name + '.rule');
        if (typeof rule.id !== 'string' || !/^test_[a-z][a-z0-9_]{0,62}$/u.test(rule.id)
            || typeof rule.predicate !== 'string'
            || !/^test\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(rule.predicate))
            throw new TypeError('memory_consolidation_catalog_invalid');
        if (seenIds.has(rule.id)) throw new TypeError('memory_consolidation_catalog_duplicate_rule');
        seenIds.add(rule.id);
        assertExactObject(rule.compatibility, ['category', 'key'], name + '.rule.compatibility');
        if (!COMPATIBILITY_CATEGORIES.includes(rule.compatibility.category)
            || typeof rule.compatibility.key !== 'string' || rule.compatibility.key.length < 1
            || rule.compatibility.key.length > 128)
            throw new TypeError('memory_consolidation_catalog_invalid');
        assertDenseArray(rule.objectFingerprints, name + '.rule.objectFingerprints');
        if (rule.objectFingerprints.length < 2
            || rule.objectFingerprints.some(value => typeof value !== 'string' || !SHA256.test(value))
            || new Set(rule.objectFingerprints).size !== rule.objectFingerprints.length)
            throw new TypeError('memory_consolidation_catalog_invalid');
        const key = rule.predicate + '\u0000' + rule.compatibility.category + '\u0000' + rule.compatibility.key;
        if (seenKeys.has(key)) throw new TypeError('memory_consolidation_catalog_duplicate_rule');
        seenKeys.add(key);
        return rule;
    });
}

function validateContradictionCatalog(catalog) {
    if (catalog === null) return null;
    assertExactObject(catalog, ['kind', 'rules'], 'contradictionCatalog');
    if (catalog.kind !== 'synthetic_test_only') throw new TypeError('memory_consolidation_catalog_invalid');
    assertDenseArray(catalog.rules, 'contradictionCatalog.rules');
    const ids = new Set(), slots = new Set();
    for (const rule of catalog.rules) {
        assertExactObject(rule, ['id', 'predicate', 'compatibility', 'semantic'], 'contradictionCatalog.rule');
        if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(rule.id)
            || typeof rule.predicate !== 'string'
            || !/^test\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(rule.predicate)
            || rule.semantic !== 'exclusive_values')
            throw new TypeError('memory_consolidation_catalog_invalid');
        if (ids.has(rule.id)) throw new TypeError('memory_consolidation_catalog_duplicate_rule');
        ids.add(rule.id);
        assertExactObject(rule.compatibility, ['category', 'key'], 'contradictionCatalog.rule.compatibility');
        if (!COMPATIBILITY_CATEGORIES.includes(rule.compatibility.category)
            || typeof rule.compatibility.key !== 'string' || rule.compatibility.key.length < 1
            || rule.compatibility.key.length > 128)
            throw new TypeError('memory_consolidation_catalog_invalid');
        const slot = rule.predicate + '\u0000' + rule.compatibility.category + '\u0000' + rule.compatibility.key;
        if (slots.has(slot)) throw new TypeError('memory_consolidation_catalog_duplicate_rule');
        slots.add(slot);
    }
    return catalog;
}

function assertionSignature(assertion) {
    const { id, recorded_at, ...semanticFields } = assertion;
    return canonical(semanticFields);
}

function assertionBaseWithoutObject(assertion) {
    const { id, recorded_at, object, ...semanticFields } = assertion;
    return canonical(semanticFields);
}

function evidenceSignature(record) {
    return record.record.evidence.map(({ evidence, source }) => {
        const { id: sourceId, recorded_at: sourceRecordedAt, ...sourceFields } = source;
        const { id, assertion_id, source_id, ...evidenceFields } = evidence;
        return canonical({ source: sourceFields, evidence: evidenceFields });
    }).sort();
}

function sameEvidence(records) {
    const [left, right] = records;
    return canonical(evidenceSignature(left)) === canonical(evidenceSignature(right))
        && canonical(left.record.evidence.map(item => item.source.id).sort())
            === canonical(right.record.evidence.map(item => item.source.id).sort());
}

function referencesToPreserve(records) {
    return Object.freeze(records.map(({ record }) => Object.freeze({
        assertionId: record.assertion.id,
        evidence: Object.freeze(record.evidence.map(pair => Object.freeze({
            evidenceId: pair.evidence.id,
            sourceId: pair.source.id,
        })).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))),
    })).sort((a, b) => a.assertionId.localeCompare(b.assertionId)));
}

function proposal(records, redundancyType, reasonCode, risks) {
    const ids = records.map(item => item.record.assertion.id).sort();
    return Object.freeze({
        assertionIds: Object.freeze(ids),
        redundancyType,
        reasonCodes: Object.freeze([reasonCode]),
        evidenceToPreserve: referencesToPreserve(records),
        historyAssertionIdsToPreserve: Object.freeze([...ids]),
        risks: Object.freeze([...risks].sort()),
        reviewRequired: true,
        executable: false,
        persistencePerformed: false,
    });
}

function relationFieldsEqual(left, right) {
    const a = left.record.assertion, b = right.record.assertion;
    return a.predicate === b.predicate && a.subject.id === b.subject.id && a.object.id === b.object.id;
}

function intervalEqual(left, right) {
    const a = left.record.assertion, b = right.record.assertion;
    return canonical([a.valid_from, a.valid_to]) === canonical([b.valid_from, b.valid_to]);
}

function matchingEquivalenceRule(left, right, rules) {
    const a = left.record.assertion, b = right.record.assertion;
    if (a.predicate !== b.predicate || !a.predicate.startsWith('test.')
        || canonical(a.compatibility) !== canonical(b.compatibility)) return false;
    if (assertionBaseWithoutObject(a) !== assertionBaseWithoutObject(b)) return false;
    if (left.record.intent !== 'fact' || right.record.intent !== 'fact'
        || left.temporal.state !== 'current' || right.temporal.state !== 'current') return false;
    const leftFingerprint = objectFingerprint(a.object), rightFingerprint = objectFingerprint(b.object);
    return rules.some(rule => rule.predicate === a.predicate
        && canonical(rule.compatibility) === canonical(a.compatibility)
        && rule.objectFingerprints.includes(leftFingerprint) && rule.objectFingerprints.includes(rightFingerprint));
}

function d3Comparison(left, right, contradictionCatalog) {
    if (left.relation || right.relation) {
        if (!left.relation || !right.relation) return null;
        const projectRelation = item => ({
            assertion: item.record.assertion,
            subjectEntity: item.record.subjectEntity,
            objectEntity: item.record.objectEntity,
            evidence: item.record.evidence,
            asOf: item.record.asOf,
            scopeLabel: item.record.scopeLabel,
        });
        return compareRelationPair({ left: projectRelation(left), right: projectRelation(right),
            mode: 'simulate' }).comparisons[0];
    }
    const a = left.record, b = right.record;
    return compareAssertionPair({
        left: { assertion: a.assertion, source: a.evidence[0].source, evidence: a.evidence[0].evidence,
            asOf: a.asOf, intent: a.intent },
        right: { assertion: b.assertion, source: b.evidence[0].source, evidence: b.evidence[0].evidence,
            asOf: b.asOf, intent: b.intent },
        leftScopeLabel: a.scopeLabel, rightScopeLabel: b.scopeLabel,
        leftTransitionPreview: null, rightTransitionPreview: null,
        syntheticCatalog: contradictionCatalog, mode: 'simulate',
    }).comparisons[0];
}

function compareRecords(left, right, equivalenceRules, contradictionCatalog) {
    const a = left.record.assertion, b = right.record.assertion;
    if (a.status !== 'active' || b.status !== 'active')
        return safePair(a.id, b.id, 'insufficient_information', 'historical_assertions_must_remain_distinct');
    if (left.record.intent !== right.record.intent)
        return safePair(a.id, b.id, 'insufficient_information', 'plan_fact_intent_mismatch');

    const contradiction = d3Comparison(left, right, contradictionCatalog);
    if ((left.relation || right.relation) && (!left.relation || !right.relation))
        return safePair(a.id, b.id, 'insufficient_information', 'relationship_and_fact_not_equivalent');
    if (contradiction?.classification === 'potential_conflict')
        return safePair(a.id, b.id, 'potential_conflict', 'D3_explicit_exclusivity_rule');
    if (contradiction?.classification === 'temporal_change')
        return safePair(a.id, b.id, 'temporal_distinction', 'D3_disjoint_validity_intervals');
    if (!intervalEqual(left, right))
        return safePair(a.id, b.id, 'temporal_distinction', 'validity_intervals_differ');

    if (left.relation) {
        if (!relationFieldsEqual(left, right))
            return safePair(a.id, b.id, 'related_not_equivalent', 'relationship_endpoints_or_predicate_differ');
        const sameAssertion = assertionSignature(a) === assertionSignature(b);
        if (!sameAssertion)
            return safePair(a.id, b.id, 'insufficient_information', 'relationship_assertions_not_identical');
        const evidenceMatches = sameEvidence([left, right]);
        const type = evidenceMatches ? 'exact_duplicate' : 'additional_evidence';
        return safePair(a.id, b.id, type, evidenceMatches ? 'duplicate_direct_relationship' : 'same_relationship_distinct_evidence',
            proposal([left, right], type, evidenceMatches ? 'duplicate_direct_relationship' : 'same_relationship_distinct_evidence',
                ['relationship_truth_not_independently_verified', 'source_identity_not_authenticated',
                    'external_history_references_must_be_checked', 'history_must_be_preserved',
                    ...(evidenceMatches ? [] : ['all_evidence_references_must_be_retained'])]));
    }

    const sameAssertion = assertionSignature(a) === assertionSignature(b);
    if (sameAssertion && contradiction?.classification === 'compatible') {
        const evidenceMatches = sameEvidence([left, right]);
        const type = evidenceMatches ? 'exact_duplicate' : 'additional_evidence';
        const reason = evidenceMatches ? 'same_assertion_and_evidence' : 'same_assertion_distinct_evidence';
        return safePair(a.id, b.id, type, reason,
            proposal([left, right], type, reason, ['assertion_truth_not_independently_verified',
                'source_identity_not_authenticated', 'external_history_references_must_be_checked',
                'history_must_be_preserved', ...(evidenceMatches ? [] : ['all_evidence_references_must_be_retained'])]));
    }
    if (matchingEquivalenceRule(left, right, equivalenceRules)) {
        const reason = 'explicit_synthetic_equivalence_rule';
        return safePair(a.id, b.id, 'equivalent_by_explicit_rule', reason,
            proposal([left, right], 'equivalent_by_explicit_rule', reason,
                ['synthetic_rule_only', 'equivalence_requires_human_review',
                    'external_history_references_must_be_checked', 'history_must_be_preserved']));
    }
    if (a.predicate === b.predicate && canonical(a.subject) === canonical(b.subject)
        && canonical(a.object) !== canonical(b.object))
        return safePair(a.id, b.id, 'insufficient_information', 'different_values_without_equivalence_rule');
    if (a.predicate !== b.predicate)
        return safePair(a.id, b.id, 'related_not_equivalent', 'different_predicates_not_consolidated');
    return safePair(a.id, b.id, 'insufficient_information', 'equivalence_not_established');
}

/**
 * Evaluates a bounded, pre-authorized, single-subject/single-scope fixture set.
 * It returns pairwise review previews only and never changes a record or store.
 */
export function evaluateConsolidation(input) {
    assertExactObject(input, ['records', 'equivalenceCatalog', 'contradictionCatalog', 'mode'], 'input');
    validateMode(input.mode);
    if (input.mode === 'execute') return Object.freeze({ decision: 'DENY', comparisons: Object.freeze([]),
        executable: false, persistencePerformed: false });
    assertDenseArray(input.records, 'records');
    if (input.records.length > 100) throw new TypeError('memory_consolidation_record_limit');
    const equivalenceRules = validateRuleCatalog(input.equivalenceCatalog, 'equivalenceCatalog');
    const contradictionCatalog = validateContradictionCatalog(input.contradictionCatalog);
    const prepared = input.records.map(prepareRecord);
    const ids = prepared.map(item => item.record.assertion.id);
    if (new Set(ids).size !== ids.length) throw new TypeError('memory_consolidation_duplicate_assertion');
    const evidenceIds = new Set(), sources = new Map();
    for (const item of prepared) {
        for (const pair of item.record.evidence) {
            if (evidenceIds.has(pair.evidence.id))
                throw new TypeError('memory_consolidation_duplicate_evidence');
            evidenceIds.add(pair.evidence.id);
            const sourceSignature = canonical(pair.source);
            const prior = sources.get(pair.source.id);
            if (prior !== undefined && prior !== sourceSignature)
                throw new TypeError('memory_consolidation_source_inconsistent');
            sources.set(pair.source.id, sourceSignature);
        }
    }
    if (prepared.length > 1) {
        const first = prepared[0].record;
        if (prepared.some(item => canonical(item.record.assertion.subject) !== canonical(first.assertion.subject)))
            throw new TypeError('memory_consolidation_subject_mismatch');
        if (prepared.some(item => item.record.scopeLabel !== first.scopeLabel))
            throw new TypeError('memory_consolidation_scope_mismatch');
        if (prepared.some(item => canonical(item.record.asOf) !== canonical(first.asOf)))
            throw new TypeError('memory_consolidation_reference_time_mismatch');
    }
    const sorted = [...prepared].sort((a, b) => a.record.assertion.id.localeCompare(b.record.assertion.id));
    const comparisons = [];
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            comparisons.push(compareRecords(sorted[i], sorted[j], equivalenceRules, contradictionCatalog));
        }
    }
    comparisons.sort((a, b) => a.assertionIds[0].localeCompare(b.assertionIds[0])
        || a.assertionIds[1].localeCompare(b.assertionIds[1]));
    return Object.freeze({ decision: 'SIMULATED', comparisons: Object.freeze(comparisons),
        executable: false, persistencePerformed: false });
}
