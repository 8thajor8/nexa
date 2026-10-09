import { assertDenseArray, assertExactObject, COMPATIBILITY_CATEGORIES } from './schema.js';
import { getRelationPredicate } from './relation-predicates.js';
import { compareTemporal } from './temporal.js';
import { describeTemporalRecord } from './temporal-semantics.js';
import { describeRelation } from './relationship-semantics.js';

const MODES = new Set(['simulate', 'execute']);
const SCOPE_LABEL = /^[A-Za-z0-9._:-]{1,128}$/u;

function validateMode(mode) {
    if (!MODES.has(mode)) throw new TypeError('memory_contradiction_mode_invalid');
}

function validateScopePair(left, right) {
    if (typeof left !== 'string' || !SCOPE_LABEL.test(left)
        || typeof right !== 'string' || !SCOPE_LABEL.test(right))
        throw new TypeError('memory_contradiction_scope_invalid');
    if (left !== right) throw new TypeError('memory_contradiction_scope_mismatch');
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function safePair(leftId, rightId, classification, reasonCode, uncertaintyReasons = [], clarificationRequired = false) {
    const uncertaintyLevel = classification === 'potential_conflict' || classification === 'insufficient_information'
        ? 'high' : uncertaintyReasons.length ? 'medium' : 'low';
    return Object.freeze({ assertionIds: Object.freeze([leftId, rightId].sort()), classification,
        reasonCode, uncertaintyReasons: Object.freeze([...new Set(uncertaintyReasons)].sort()),
        uncertaintyLevel, evidenceStatus: 'structurally_linked_unverified', clarificationRequired,
        executable: false, persistencePerformed: false });
}

function intervalChange(left, right) {
    const a = left.assertion, b = right.assertion;
    if (a.valid_to !== null && b.valid_from !== null
        && compareTemporal(a.valid_to, b.valid_from) === 'before') return true;
    return b.valid_to !== null && a.valid_from !== null
        && compareTemporal(b.valid_to, a.valid_from) === 'before';
}

function hasSameExplicitSlot(left, right) {
    const a = left.assertion.compatibility, b = right.assertion.compatibility;
    return a !== null && b !== null && a.category === b.category && a.key === b.key;
}

function validateSyntheticCatalog(catalog) {
    if (catalog === null) return [];
    assertExactObject(catalog, ['kind', 'rules'], 'syntheticCatalog');
    if (catalog.kind !== 'synthetic_test_only') throw new TypeError('memory_contradiction_catalog_invalid');
    assertDenseArray(catalog.rules, 'syntheticCatalog.rules');
    const seen = new Set(), seenIds = new Set();
    return catalog.rules.map(rule => {
        assertExactObject(rule, ['id', 'predicate', 'compatibility', 'semantic'], 'syntheticRule');
        if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(rule.id)
            || typeof rule.predicate !== 'string' || !/^test\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(rule.predicate)
            || rule.semantic !== 'exclusive_values') throw new TypeError('memory_contradiction_catalog_invalid');
        if (seenIds.has(rule.id)) throw new TypeError('memory_contradiction_catalog_duplicate_rule');
        seenIds.add(rule.id);
        assertExactObject(rule.compatibility, ['category', 'key'], 'syntheticRule.compatibility');
        if (!COMPATIBILITY_CATEGORIES.includes(rule.compatibility.category)
            || typeof rule.compatibility.key !== 'string' || rule.compatibility.key.length < 1
            || rule.compatibility.key.length > 128) throw new TypeError('memory_contradiction_catalog_invalid');
        const key = `${rule.predicate}\u0000${rule.compatibility.category}\u0000${rule.compatibility.key}`;
        if (seen.has(key)) throw new TypeError('memory_contradiction_catalog_duplicate_rule');
        seen.add(key);
        return rule;
    });
}

function hasApplicableRule(left, right, rules) {
    return rules.some(rule => rule.predicate === left.assertion.predicate
        && rule.predicate === right.assertion.predicate
        && canonical(rule.compatibility) === canonical(left.assertion.compatibility)
        && canonical(rule.compatibility) === canonical(right.assertion.compatibility));
}

function supersessionPair(left, right) {
    const a = left.assertion, b = right.assertion;
    if (a.status === 'superseded' && b.status === 'active' && b.supersedes.includes(a.id)) return true;
    return b.status === 'superseded' && a.status === 'active' && a.supersedes.includes(b.id);
}

function validateTransitionPreview(preview, target) {
    if (preview === null) return null;
    assertExactObject(preview, ['success', 'action', 'targetAssertionId', 'fromState', 'toState',
        'effectiveAt', 'reason', 'executable', 'persistencePerformed'], 'transitionPreview');
    if (target.intent !== 'plan' || preview.success !== true || preview.action !== 'cancel_plan'
        || preview.targetAssertionId !== target.assertion.id || preview.fromState !== 'planned'
        || preview.toState !== 'cancelled' || preview.reason !== 'hypothetical_cancellation_only'
        || preview.executable !== false || preview.persistencePerformed !== false)
        throw new TypeError('memory_contradiction_transition_invalid');
    return preview;
}

function prepareFact(input) {
    const temporal = describeTemporalRecord(input);
    if (getRelationPredicate(input.assertion.predicate)) return { temporal, assertion: input.assertion, relation: true };
    if (input.assertion.object.type !== 'text') throw new TypeError('memory_contradiction_record_invalid');
    return { temporal, assertion: input.assertion, relation: false };
}

function compareFacts(left, right, leftPreview, rightPreview, rules = []) {
    const a = left.assertion, b = right.assertion;
    if (canonical(a.subject) !== canonical(b.subject)) throw new TypeError('memory_contradiction_subject_mismatch');
    if (a.id === b.id) throw new TypeError('memory_contradiction_duplicate_assertion');
    if (supersessionPair(left, right))
        return safePair(a.id, b.id, 'superseded', 'explicit_supersession_lineage');
    if (a.predicate !== b.predicate) return safePair(a.id, b.id, 'insufficient_information',
        'different_predicates_not_semantically_compared', ['predicate_semantics_not_declared']);
    if (canonical(a.object) === canonical(b.object))
        return safePair(a.id, b.id, 'compatible', 'same_asserted_value', ['assertion_truth_not_independently_verified']);
    if (a.compatibility === null || b.compatibility === null || !hasSameExplicitSlot(left, right))
        return safePair(a.id, b.id, 'insufficient_information', 'no_shared_explicit_compatibility_slot',
            ['incompatibility_rule_not_established']);
    if (leftPreview || rightPreview)
        return safePair(a.id, b.id, 'insufficient_information', 'cancellation_preview_not_persisted',
            ['plan_cancellation_is_hypothetical']);
    const leftPlan = left.temporal.intent === 'plan';
    const rightPlan = right.temporal.intent === 'plan';
    if ((leftPlan && left.temporal.state !== 'planned') || (rightPlan && right.temporal.state !== 'planned'))
        return safePair(a.id, b.id, 'insufficient_information', 'plan_outcome_unconfirmed',
            ['plan_window_or_completion_unconfirmed'], true);
    if (leftPlan && rightPlan) return safePair(a.id, b.id, 'insufficient_information', 'multiple_future_plans_not_resolved',
        ['plan_compatibility_not_established'], true);
    if (leftPlan || rightPlan) return safePair(a.id, b.id, 'compatible', 'future_plan_is_not_completion_evidence',
        ['plan_outcome_unconfirmed']);
    if (left.temporal.state === 'future_fact' || right.temporal.state === 'future_fact')
        return safePair(a.id, b.id, 'insufficient_information', 'future_validity_is_not_event_evidence',
            ['future_fact_not_confirmed']);

    if (intervalChange(left, right))
        return safePair(a.id, b.id, 'temporal_change', 'explicit_non_overlapping_validity_intervals',
            ['intervals_do_not_establish_real_world_change']);
    if (left.temporal.state === 'current' && right.temporal.state === 'current'
        && hasApplicableRule(left, right, rules))
        return safePair(a.id, b.id, 'potential_conflict', 'different_values_in_same_explicit_slot',
            ['conflict_not_adjudicated', 'assertion_truth_not_independently_verified'], true);
    if (left.temporal.state === 'current' && right.temporal.state === 'current')
        return safePair(a.id, b.id, 'insufficient_information', 'no_applicable_exclusivity_rule',
            ['different_values_do_not_imply_incompatibility']);
    return safePair(a.id, b.id, 'insufficient_information', 'temporal_overlap_or_validity_unknown',
        ['no_winner_selected', 'temporal_evidence_incomplete'], true);
}

/**
 * Compares two validated assertion records. This is a semantic preview only:
 * it does not establish truth, identity, authorization, or persistence.
 */
export function compareAssertionPair(input) {
    assertExactObject(input, ['left', 'right', 'leftScopeLabel', 'rightScopeLabel',
        'leftTransitionPreview', 'rightTransitionPreview', 'syntheticCatalog', 'mode'], 'input');
    validateMode(input.mode);
    if (input.mode === 'execute') return Object.freeze({ decision: 'DENY', comparisons: Object.freeze([]),
        executable: false, persistencePerformed: false });
    validateScopePair(input.leftScopeLabel, input.rightScopeLabel);
    const rules = validateSyntheticCatalog(input.syntheticCatalog);
    const left = prepareFact(input.left), right = prepareFact(input.right);
    if (left.relation || right.relation) throw new TypeError('memory_contradiction_relationship_requires_context');
    const leftPreview = validateTransitionPreview(input.leftTransitionPreview, input.left);
    const rightPreview = validateTransitionPreview(input.rightTransitionPreview, input.right);
    if (!canonical(input.left.asOf) || canonical(input.left.asOf) !== canonical(input.right.asOf))
        throw new TypeError('memory_contradiction_reference_time_mismatch');
    return Object.freeze({ decision: 'SIMULATED', comparisons: Object.freeze([
        compareFacts(left, right, leftPreview, rightPreview, rules)]), executable: false, persistencePerformed: false });
}

function compareRelations(left, right) {
    const a = left.assertion, b = right.assertion;
    if (a.id === b.id) throw new TypeError('memory_contradiction_duplicate_assertion');
    if (left.subjectEntityId !== right.subjectEntityId)
        throw new TypeError('memory_contradiction_subject_mismatch');
    const definitionA = getRelationPredicate(a.predicate), definitionB = getRelationPredicate(b.predicate);
    if (a.predicate !== b.predicate || !definitionA || definitionA !== definitionB)
        return safePair(a.id, b.id, 'insufficient_information', 'relationship_rules_not_comparable',
            ['relationship_semantics_not_declared']);
    if (supersessionPair(left, right)) return safePair(a.id, b.id, 'superseded', 'explicit_supersession_lineage');
    if (left.temporalState === 'future' || right.temporalState === 'future'
        || left.temporalState === 'unknown' || right.temporalState === 'unknown')
        return safePair(a.id, b.id, 'insufficient_information', 'relationship_temporal_state_unresolved',
            ['relationship_not_established_as_current']);
    if (intervalChange(left, right))
        return safePair(a.id, b.id, 'temporal_change', 'explicit_non_overlapping_validity_intervals',
            ['intervals_do_not_establish_real_world_change']);
    const sameEdge = a.subject.id === b.subject.id && a.object.id === b.object.id;
    if (sameEdge) return safePair(a.id, b.id, 'compatible', 'duplicate_relationship_candidate',
        ['relationship_truth_not_independently_verified']);
    if (definitionA.cardinality === 'many') return safePair(a.id, b.id, 'compatible',
        'catalog_allows_multiple_relationships', ['relationship_truth_not_independently_verified']);
    return safePair(a.id, b.id, 'insufficient_information', 'relationship_exclusivity_not_established',
        ['relationship_rule_requires_review'], true);
}

/** Uses D.2's validated, direct relationship projection; no graph traversal is performed. */
export function compareRelationPair(input) {
    assertExactObject(input, ['left', 'right', 'mode'], 'input');
    validateMode(input.mode);
    if (input.mode === 'execute') return Object.freeze({ decision: 'DENY', comparisons: Object.freeze([]),
        executable: false, persistencePerformed: false });
    const left = describeRelation(input.left), right = describeRelation(input.right);
    if (input.left.scopeLabel !== input.right.scopeLabel)
        throw new TypeError('memory_contradiction_scope_mismatch');
    if (canonical(input.left.asOf) !== canonical(input.right.asOf))
        throw new TypeError('memory_contradiction_reference_time_mismatch');
    const comparison = compareRelations({ ...left, assertion: input.left.assertion },
        { ...right, assertion: input.right.assertion });
    return Object.freeze({ decision: 'SIMULATED', comparisons: Object.freeze([comparison]),
        executable: false, persistencePerformed: false });
}

/**
 * Evaluates a bounded, pre-filtered set for one subject, scope, and reference
 * time. It reports pairwise uncertainty and never selects a winning value.
 */
export function evaluateAssertionSet(input) {
    assertExactObject(input, ['records', 'scopeLabels', 'syntheticCatalog', 'mode'], 'input');
    validateMode(input.mode);
    if (input.mode === 'execute') return Object.freeze({ decision: 'DENY', comparisons: Object.freeze([]),
        executable: false, persistencePerformed: false });
    assertDenseArray(input.records, 'records');
    assertDenseArray(input.scopeLabels, 'scopeLabels');
    if (input.scopeLabels.length !== input.records.length) throw new TypeError('memory_contradiction_scope_invalid');
    for (const scope of input.scopeLabels) {
        if (typeof scope !== 'string' || !SCOPE_LABEL.test(scope)) throw new TypeError('memory_contradiction_scope_invalid');
    }
    if (new Set(input.scopeLabels).size > 1) throw new TypeError('memory_contradiction_scope_mismatch');
    if (input.records.length > 100) throw new TypeError('memory_contradiction_record_limit');
    const rules = validateSyntheticCatalog(input.syntheticCatalog);
    const records = input.records.map(prepareFact);
    if (records.some(record => record.relation))
        throw new TypeError('memory_contradiction_relationship_requires_context');
    const ids = records.map(record => record.assertion.id);
    if (new Set(ids).size !== ids.length) throw new TypeError('memory_contradiction_duplicate_assertion');
    if (records.length) {
        const subjects = new Set(records.map(record => canonical(record.temporal.subject)));
        const times = new Set(records.map(record => canonical(record.temporal.asOf)));
        if (subjects.size !== 1) throw new TypeError('memory_contradiction_subject_mismatch');
        if (times.size !== 1) throw new TypeError('memory_contradiction_reference_time_mismatch');
    }
    const sorted = [...records].sort((a, b) => a.assertion.id.localeCompare(b.assertion.id));
    const comparisons = [];
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
        const left = sorted[i], right = sorted[j];
        comparisons.push(compareFacts(left, right, null, null, rules));
    }
    comparisons.sort((a, b) => a.assertionIds[0].localeCompare(b.assertionIds[0])
        || a.assertionIds[1].localeCompare(b.assertionIds[1]));
    return Object.freeze({ decision: 'SIMULATED', comparisons: Object.freeze(comparisons),
        executable: false, persistencePerformed: false });
}
