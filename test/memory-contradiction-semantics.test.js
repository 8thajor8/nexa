import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAssertionPair, compareRelationPair, evaluateAssertionSet } from '../src/memory/contradiction-semantics.js';
import { planTemporalTransition } from '../src/memory/temporal-semantics.js';

const AS_OF = { value: '2036-06-01T00:00:00.000Z', precision: 'instant' };
const TIME = '2035-06-01T00:00:00.000Z';
const SELF = { type: 'owner' };
const personId = n => `person_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const assertionId = n => `mem_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceId = n => `src_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const evidenceId = n => `ev_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const slot = key => ({ category: 'user', key });

function fact(n, { value = `synthetic-${n}`, subject = SELF, predicate = 'user.location',
    compatibility = slot('home'), status = 'active', supersedes = [],
    validFrom = { value: '2030-01-01', precision: 'day' }, validTo = null,
    intent = 'fact', sourceKind = 'user_statement' } = {}) {
    const id = assertionId(n), srcId = sourceId(n);
    return { assertion: { id, kind: 'fact', subject, predicate, object: { type: 'text', value }, status,
        valid_from: validFrom, valid_to: validTo, recorded_at: TIME, supersedes, compatibility },
    source: { id: srcId, kind: sourceKind,
        origin_trust: sourceKind === 'user_statement' ? 'user_asserted' : sourceKind === 'inference' ? 'derived_untrusted' : 'external_untrusted',
        authority: 'data_only', locator: null, occurred_at: { value: '2035-05-01', precision: 'day' }, recorded_at: TIME },
    evidence: { id: evidenceId(n), assertion_id: id, source_id: srcId,
        derivation: sourceKind === 'inference' ? 'inferred' : 'explicit', extraction_confidence: null,
        learned_at: TIME, last_confirmed_at: null, legacy_ref: null }, asOf: AS_OF, intent };
}

function pair(left, right, overrides = {}) {
    return compareAssertionPair({ left, right, leftScopeLabel: 'synthetic-private-a',
        rightScopeLabel: 'synthetic-private-a', leftTransitionPreview: null,
        rightTransitionPreview: null, syntheticCatalog: null, mode: 'simulate', ...overrides });
}

const syntheticExclusiveCatalog = { kind: 'synthetic_test_only', rules: [
    { id: 'test_location_exclusive', predicate: 'test.synthetic_location',
        compatibility: slot('test-only-location'), semantic: 'exclusive_values' },
] };

function entity(n) { return { id: personId(n), type: 'person', created_at: '2030-01-01T00:00:00.000Z' }; }
function relation(n, to, { from = 1, scopeLabel = 'synthetic-private-a', status = 'active', supersedes = [] } = {}) {
    const assertion = { id: assertionId(n), kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: personId(from) },
        predicate: 'partner_of', object: { type: 'entity_reference', entity_type: 'person', id: personId(to) },
        status, valid_from: { value: '2030-01-01', precision: 'day' }, valid_to: null,
        recorded_at: TIME, supersedes, compatibility: null };
    const src = { id: sourceId(n), kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
        locator: null, occurred_at: { value: '2035-05-01', precision: 'day' }, recorded_at: TIME };
    const evidence = { id: evidenceId(n), assertion_id: assertion.id, source_id: src.id, derivation: 'explicit',
        extraction_confidence: null, learned_at: TIME, last_confirmed_at: null, legacy_ref: null };
    return { assertion, subjectEntity: entity(from), objectEntity: entity(to), evidence: [{ evidence, source: src }],
        asOf: AS_OF, scopeLabel };
}

test('same value is compatible without inventing an exclusivity rule; values stay out of the projection', () => {
    const left = fact(1, { value: 'SYNTHETIC_PRIVATE_VALUE' });
    const right = fact(2, { value: 'SYNTHETIC_PRIVATE_VALUE' });
    const before = structuredClone([left, right]);
    const result = pair(left, right);
    assert.equal(result.comparisons[0].classification, 'compatible');
    assert.equal(result.comparisons[0].reasonCode, 'same_asserted_value');
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_VALUE'), false);
    assert.deepEqual([left, right], before);
});

test('different values without the same explicit compatibility slot remain insufficient, not contradictory', () => {
    const result = pair(fact(3, { value: 'synthetic A', compatibility: null }),
        fact(4, { value: 'synthetic B', compatibility: null }));
    assert.equal(result.comparisons[0].classification, 'insufficient_information');
    assert.equal(result.comparisons[0].reasonCode, 'no_shared_explicit_compatibility_slot');
});

test('an unknown scalar predicate never gains semantics from its name or matching slot', () => {
    const left = fact(44, { predicate: 'person.unregistered_fact', value: 'synthetic one' });
    const right = fact(45, { predicate: 'person.unregistered_fact', value: 'synthetic two' });
    assert.equal(pair(left, right).comparisons[0].classification, 'insufficient_information');
    assert.equal(pair(left, right).comparisons[0].reasonCode, 'no_applicable_exclusivity_rule');
});

test('different current values in the same explicit slot are only a potential conflict and request clarification', () => {
    const left = fact(5, { predicate: 'test.synthetic_location', compatibility: slot('test-only-location'), value: 'synthetic west' });
    const right = fact(6, { predicate: 'test.synthetic_location', compatibility: slot('test-only-location'), value: 'synthetic east' });
    const result = pair(left, right, { syntheticCatalog: syntheticExclusiveCatalog });
    assert.equal(result.comparisons[0].classification, 'potential_conflict');
    assert.equal(result.comparisons[0].clarificationRequired, true);
    assert.equal(result.comparisons[0].uncertaintyReasons.includes('conflict_not_adjudicated'), true);
});

test('equivalent interval objects with different property order are not treated as a temporal change', () => {
    const left = fact(48, { predicate: 'test.synthetic_location', compatibility: slot('test-only-location'),
        value: 'synthetic west', validFrom: { value: '2030-01-01', precision: 'day' } });
    const right = fact(49, { predicate: 'test.synthetic_location', compatibility: slot('test-only-location'),
        value: 'synthetic east', validFrom: { precision: 'day', value: '2030-01-01' } });
    const catalog = { kind: 'synthetic_test_only', rules: [{ id: 'test_location_exclusive',
        predicate: 'test.synthetic_location', compatibility: { key: 'test-only-location', category: 'user' },
        semantic: 'exclusive_values' }] };
    const result = pair(left, right, { syntheticCatalog: catalog });
    assert.equal(result.comparisons[0].classification, 'potential_conflict');
    assert.notEqual(result.comparisons[0].classification, 'temporal_change');
});

test('definitely disjoint validity intervals describe a temporal change without selecting a winner', () => {
    const former = fact(7, { value: 'synthetic old', validFrom: { value: '2030', precision: 'year' },
        validTo: { value: '2034', precision: 'year' } });
    const later = fact(8, { value: 'synthetic newer', validFrom: { value: '2035-01-01', precision: 'day' } });
    const result = pair(former, later);
    assert.equal(result.comparisons[0].classification, 'temporal_change');
    assert.equal(result.comparisons[0].reasonCode, 'explicit_non_overlapping_validity_intervals');
    assert.equal(result.comparisons[0].uncertaintyReasons.includes('intervals_do_not_establish_real_world_change'), true);
});

test('overlapping or partial intervals do not become a temporal change', () => {
    const left = fact(9, { value: 'synthetic former', validFrom: { value: '2030', precision: 'year' },
        validTo: { value: '2035', precision: 'year' } });
    const right = fact(10, { value: 'synthetic later', validFrom: { value: '2035-06', precision: 'month' } });
    const result = pair(left, right);
    assert.equal(result.comparisons[0].classification, 'insufficient_information');
    assert.equal(result.comparisons[0].reasonCode, 'temporal_overlap_or_validity_unknown');
});

test('explicit supersession lineage is reported without changing either record', () => {
    const old = fact(11, { value: 'synthetic old', status: 'superseded' });
    const next = fact(12, { predicate: 'user.employer', value: 'synthetic new', supersedes: [old.assertion.id] });
    const result = pair(old, next);
    assert.equal(result.comparisons[0].classification, 'superseded');
    assert.equal(result.comparisons[0].reasonCode, 'explicit_supersession_lineage');
    assert.equal(old.assertion.status, 'superseded');
});

test('a future plan is not treated as completion; a cancellation preview is not persisted state', () => {
    const plan = fact(13, { value: 'synthetic planned location', intent: 'plan',
        validFrom: { value: '2037', precision: 'year' } });
    const current = fact(14, { value: 'synthetic current location' });
    assert.equal(pair(plan, current).comparisons[0].classification, 'compatible');
    const preview = planTemporalTransition({ record: plan, action: 'cancel_plan', effectiveAt: AS_OF });
    assert.equal(preview.toState, 'cancelled');
    const result = pair(plan, current, { leftTransitionPreview: preview });
    assert.equal(result.comparisons[0].classification, 'insufficient_information');
    assert.equal(result.comparisons[0].reasonCode, 'cancellation_preview_not_persisted');
    const secondPlan = fact(41, { value: 'synthetic alternate plan', intent: 'plan',
        validFrom: { value: '2038', precision: 'year' } });
    assert.equal(pair(plan, secondPlan).comparisons[0].classification, 'insufficient_information');
    assert.equal(pair(plan, secondPlan).comparisons[0].reasonCode, 'multiple_future_plans_not_resolved');
});

test('an expired plan remains unresolved and is never treated as a completed fact', () => {
    const expiredPlan = fact(50, { value: 'synthetic planned location', intent: 'plan',
        validFrom: { value: '2030', precision: 'year' }, validTo: { value: '2034', precision: 'year' } });
    const current = fact(51, { value: 'synthetic current location' });
    const result = pair(expiredPlan, current);
    assert.equal(result.comparisons[0].classification, 'insufficient_information');
    assert.equal(result.comparisons[0].reasonCode, 'plan_outcome_unconfirmed');
    assert.equal(result.comparisons[0].clarificationRequired, true);
    assert.equal(result.comparisons[0].executable, false);
    assert.equal(result.comparisons[0].persistencePerformed, false);
});

test('unverified source differences are not treated as contradictory evidence', () => {
    const direct = fact(15, { value: 'synthetic claim' });
    const external = fact(16, { value: 'synthetic other claim', sourceKind: 'email' });
    assert.equal(pair(direct, external).comparisons[0].classification, 'insufficient_information');
    assert.equal(pair(direct, external).comparisons[0].reasonCode, 'no_applicable_exclusivity_rule');
});

test('a caller must explicitly inject a synthetic rule; the real predicate catalog is unchanged', () => {
    const left = fact(39, { predicate: 'test.synthetic_location', compatibility: slot('test-only-location'), value: 'synthetic west' });
    const right = fact(40, { predicate: 'test.synthetic_location', compatibility: slot('test-only-location'), value: 'synthetic east' });
    assert.equal(pair(left, right).comparisons[0].classification, 'insufficient_information');
    assert.equal(pair(left, right, { syntheticCatalog: syntheticExclusiveCatalog }).comparisons[0].classification, 'potential_conflict');
    assert.throws(() => pair(left, right, { syntheticCatalog: { kind: 'production', rules: syntheticExclusiveCatalog.rules } }),
        { message: 'memory_contradiction_catalog_invalid' });
    const realPredicateRule = { kind: 'synthetic_test_only', rules: [{ ...syntheticExclusiveCatalog.rules[0],
        predicate: 'user.location' }] };
    assert.throws(() => pair(fact(42), fact(43), { syntheticCatalog: realPredicateRule }),
        { message: 'memory_contradiction_catalog_invalid' });
    const duplicateId = { kind: 'synthetic_test_only', rules: [
        syntheticExclusiveCatalog.rules[0],
        { ...syntheticExclusiveCatalog.rules[0], predicate: 'test.synthetic_other' },
    ] };
    assert.throws(() => pair(left, right, { syntheticCatalog: duplicateId }),
        { message: 'memory_contradiction_catalog_duplicate_rule' });
    assert.throws(() => pair(left, right, { syntheticCatalog: { kind: 'synthetic_test_only',
        rules: [{ ...syntheticExclusiveCatalog.rules[0], semantic: 'exclusive_by_default' }] } }),
    { message: 'memory_contradiction_catalog_invalid' });
});

test('relation semantics reuse D.2: same edge is duplicate-compatible, partner_of allows many, and no transitivity is inferred', () => {
    const same = compareRelationPair({ left: relation(17, 2), right: relation(18, 2), mode: 'simulate' });
    assert.equal(same.comparisons[0].classification, 'compatible');
    assert.equal(same.comparisons[0].reasonCode, 'duplicate_relationship_candidate');
    const distinct = compareRelationPair({ left: relation(19, 2), right: relation(20, 3), mode: 'simulate' });
    assert.equal(distinct.comparisons[0].classification, 'compatible');
    assert.equal(distinct.comparisons[0].reasonCode, 'catalog_allows_multiple_relationships');
    assert.equal(JSON.stringify(distinct).includes(personId(2)), false);
    const ab = relation(46, 2, { from: 1 });
    const bc = relation(47, 3, { from: 2 });
    assert.throws(() => compareRelationPair({ left: ab, right: bc, mode: 'simulate' }),
        { message: 'memory_contradiction_subject_mismatch' });
});

test('relation comparisons reject mixed scope, mismatched reference times and unknown predicates', () => {
    const one = relation(21, 2), two = relation(22, 3, { scopeLabel: 'synthetic-private-b' });
    assert.throws(() => compareRelationPair({ left: one, right: two, mode: 'simulate' }),
        { message: 'memory_contradiction_scope_mismatch' });
    two.scopeLabel = one.scopeLabel;
    two.asOf = { value: '2037', precision: 'year' };
    assert.throws(() => compareRelationPair({ left: one, right: two, mode: 'simulate' }),
        { message: 'memory_contradiction_reference_time_mismatch' });
    const unknown = structuredClone(one);
    unknown.assertion.predicate = 'person.synthetic_relation';
    assert.throws(() => compareRelationPair({ left: unknown, right: one, mode: 'simulate' }));
});

test('a cancelled plan preview bound to another target is rejected', () => {
    const plan = fact(23, { intent: 'plan', validFrom: { value: '2037', precision: 'year' } });
    const other = fact(24);
    const preview = planTemporalTransition({ record: plan, action: 'cancel_plan', effectiveAt: AS_OF });
    assert.throws(() => pair(plan, other, { leftTransitionPreview: { ...preview, targetAssertionId: other.assertion.id } }),
        { message: 'memory_contradiction_transition_invalid' });
});

test('set evaluation is deterministic under input reordering and rejects mixed subjects, scopes, duplicate IDs and times', () => {
    const records = [fact(25, { value: 'synthetic a' }), fact(26, { value: 'synthetic b' }), fact(27, { predicate: 'user.favorite_color', value: 'synthetic blue' })];
    const a = evaluateAssertionSet({ records, scopeLabels: records.map(() => 'synthetic-private-a'), syntheticCatalog: null, mode: 'simulate' });
    const b = evaluateAssertionSet({ records: [...records].reverse(), scopeLabels: records.map(() => 'synthetic-private-a'), syntheticCatalog: null, mode: 'simulate' });
    assert.deepEqual(a, b);
    assert.equal(a.comparisons.length, 3);
    const otherSubject = fact(28, { subject: { type: 'entity', entity_type: 'person', id: personId(28) } });
    assert.throws(() => evaluateAssertionSet({ records: [records[0], otherSubject], scopeLabels: ['synthetic-private-a', 'synthetic-private-a'], syntheticCatalog: null, mode: 'simulate' }),
        { message: 'memory_contradiction_subject_mismatch' });
    assert.throws(() => evaluateAssertionSet({ records: [records[0], structuredClone(records[0])], scopeLabels: ['synthetic-private-a', 'synthetic-private-a'], syntheticCatalog: null, mode: 'simulate' }),
        { message: 'memory_contradiction_duplicate_assertion' });
    const differentTime = fact(29); differentTime.asOf = { value: '2037', precision: 'year' };
    assert.throws(() => evaluateAssertionSet({ records: [records[0], differentTime], scopeLabels: ['synthetic-private-a', 'synthetic-private-a'], syntheticCatalog: null, mode: 'simulate' }),
        { message: 'memory_contradiction_reference_time_mismatch' });
    assert.throws(() => evaluateAssertionSet({ records: [records[0], records[1]], scopeLabels: ['synthetic-private-a', 'synthetic-shared'], syntheticCatalog: null, mode: 'simulate' }),
        { message: 'memory_contradiction_scope_mismatch' });
});

test('scope mismatch and malformed intervals fail closed', () => {
    assert.throws(() => pair(fact(30), fact(31), { rightScopeLabel: 'synthetic-shared' }),
        { message: 'memory_contradiction_scope_mismatch' });
    const invalid = fact(32, { validFrom: { value: '2036', precision: 'year' }, validTo: { value: '2035', precision: 'year' } });
    assert.throws(() => pair(invalid, fact(33)));
});

test('execution mode always denies and produces no comparison or persistence signal', () => {
    const result = pair(fact(34), fact(35), { mode: 'execute', left: null, right: null,
        leftScopeLabel: 'invalid', rightScopeLabel: 'different', syntheticCatalog: { invalid: true } });
    assert.deepEqual(result, { decision: 'DENY', comparisons: [], executable: false, persistencePerformed: false });
    const batch = evaluateAssertionSet({ records: null, scopeLabels: ['mismatch'], syntheticCatalog: { invalid: true }, mode: 'execute' });
    assert.equal(batch.decision, 'DENY');
    const relationResult = compareRelationPair({ left: null, right: null, mode: 'execute' });
    assert.equal(relationResult.decision, 'DENY');
});

test('every public D.3 projection stays non-executable, non-persistent and omits candidate content', () => {
    const secret = 'SYNTHETIC_SENSITIVE_EVIDENCE_PAYLOAD';
    const left = fact(52, { value: secret });
    const right = fact(53);
    const relationLeft = relation(54, 2);
    const relationRight = relation(55, 3);
    const outputs = [
        pair(left, right),
        compareRelationPair({ left: relationLeft, right: relationRight, mode: 'simulate' }),
        evaluateAssertionSet({ records: [left, right],
            scopeLabels: ['synthetic-private-a', 'synthetic-private-a'], syntheticCatalog: null, mode: 'simulate' }),
        pair(left, right, { mode: 'execute' }),
        compareRelationPair({ left: relationLeft, right: relationRight, mode: 'execute' }),
        evaluateAssertionSet({ records: [left, right],
            scopeLabels: ['synthetic-private-a', 'synthetic-private-a'], syntheticCatalog: null, mode: 'execute' }),
    ];
    for (const output of outputs) {
        assert.equal(output.executable, false);
        assert.equal(output.persistencePerformed, false);
        for (const comparison of output.comparisons ?? []) {
            assert.equal(comparison.executable, false);
            assert.equal(comparison.persistencePerformed, false);
        }
    }
    assert.equal(JSON.stringify(outputs).includes(secret), false);
});
