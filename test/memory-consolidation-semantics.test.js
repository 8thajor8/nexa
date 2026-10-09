import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evaluateConsolidation } from '../src/memory/consolidation-semantics.js';

const AS_OF = { value: '2036-06-01T00:00:00.000Z', precision: 'instant' };
const RECORDED = '2035-06-01T00:00:00.000Z';
const personId = n => `person_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const assertionId = n => `mem_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceId = n => `src_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const evidenceId = n => `ev_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const slot = key => ({ category: 'user', key });

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function fingerprint(value) {
    return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function record(n, { value = `synthetic-value-${n}`, predicate = 'user.preference',
    compatibility = slot('preferred-tool'), validFrom = { value: '2030-01-01', precision: 'day' },
    validTo = null, intent = 'fact', sourceKind = 'user_statement', subject = { type: 'owner' },
    status = 'active', supersedes = [] } = {}) {
    const id = assertionId(n), srcId = sourceId(n);
    const source = { id: srcId, kind: sourceKind,
        origin_trust: sourceKind === 'user_statement' ? 'user_asserted' : 'external_untrusted',
        authority: 'data_only', locator: null, occurred_at: { value: '2035-05-01', precision: 'day' },
        recorded_at: RECORDED };
    const evidence = { id: evidenceId(n), assertion_id: id, source_id: srcId, derivation: 'explicit',
        extraction_confidence: null, learned_at: RECORDED, last_confirmed_at: null, legacy_ref: null };
    return { assertion: { id, kind: 'preference', subject, predicate, object: { type: 'text', value },
        status, valid_from: validFrom, valid_to: validTo, recorded_at: RECORDED, supersedes, compatibility },
    evidence: [{ evidence, source }], asOf: AS_OF, intent, scopeLabel: 'synthetic-private-a',
    subjectEntity: null, objectEntity: null };
}

function duplicateOf(original, n, { sourceKind = null } = {}) {
    const copy = structuredClone(original);
    copy.assertion.id = assertionId(n);
    copy.assertion.recorded_at = '2036-01-01T00:00:00.000Z';
    copy.evidence = copy.evidence.map((pair, index) => {
        const nextSourceId = sourceKind ? sourceId(n + 100) : pair.source.id;
        const nextSource = { ...pair.source, id: nextSourceId };
        if (sourceKind) {
            nextSource.kind = sourceKind;
            nextSource.origin_trust = sourceKind === 'user_statement' ? 'user_asserted' : 'external_untrusted';
        }
        return {
            source: nextSource,
            evidence: { ...pair.evidence, id: evidenceId(n + index), assertion_id: assertionId(n),
                source_id: nextSourceId },
        };
    });
    return copy;
}

function evaluate(records, overrides = {}) {
    return evaluateConsolidation({ records, equivalenceCatalog: null, contradictionCatalog: null,
        mode: 'simulate', ...overrides });
}

function entity(n) { return { id: personId(n), type: 'person', created_at: '2030-01-01T00:00:00.000Z' }; }
function relationRecord(n, to, { from = 1 } = {}) {
    const id = assertionId(n), srcId = sourceId(n);
    const source = { id: srcId, kind: 'user_statement', origin_trust: 'user_asserted',
        authority: 'data_only', locator: null, occurred_at: { value: '2035-05-01', precision: 'day' },
        recorded_at: RECORDED };
    const evidence = { id: evidenceId(n), assertion_id: id, source_id: srcId, derivation: 'explicit',
        extraction_confidence: null, learned_at: RECORDED, last_confirmed_at: null, legacy_ref: null };
    return { assertion: { id, kind: 'fact',
        subject: { type: 'entity', entity_type: 'person', id: personId(from) },
        predicate: 'partner_of', object: { type: 'entity_reference', entity_type: 'person', id: personId(to) },
        status: 'active', valid_from: { value: '2030-01-01', precision: 'day' }, valid_to: null,
        recorded_at: RECORDED, supersedes: [], compatibility: null },
    evidence: [{ evidence, source }], asOf: AS_OF, intent: 'fact', scopeLabel: 'synthetic-private-a',
    subjectEntity: entity(from), objectEntity: entity(to) };
}

test('exact duplicate assertions produce a review-only preview retaining every evidence and history reference', () => {
    const first = record(1, { value: 'SYNTHETIC_PRIVATE_VALUE' });
    const second = duplicateOf(first, 2);
    const before = structuredClone([first, second]);
    const result = evaluate([first, second]);
    const comparison = result.comparisons[0];
    assert.equal(comparison.classification, 'exact_duplicate');
    assert.equal(comparison.proposal.redundancyType, 'exact_duplicate');
    assert.deepEqual(comparison.proposal.assertionIds, [assertionId(1), assertionId(2)]);
    assert.deepEqual(comparison.proposal.historyAssertionIdsToPreserve, [assertionId(1), assertionId(2)]);
    assert.equal(comparison.proposal.evidenceToPreserve.length, 2);
    assert.equal(comparison.proposal.reviewRequired, true);
    assert.equal(comparison.executable, false);
    assert.equal(comparison.persistencePerformed, false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_VALUE'), false);
    assert.deepEqual([first, second], before);
});

test('same asserted fact with distinct provenance is only an additional-evidence candidate', () => {
    const first = record(3, { value: 'synthetic stable preference' });
    const second = duplicateOf(first, 4, { sourceKind: 'email' });
    const comparison = evaluate([first, second]).comparisons[0];
    assert.equal(comparison.classification, 'additional_evidence');
    assert.equal(comparison.proposal.evidenceToPreserve.length, 2);
    assert.ok(comparison.proposal.risks.includes('all_evidence_references_must_be_retained'));
    assert.equal(comparison.executable, false);
});

test('explicit equivalence is accepted only through a synthetic test rule; text resemblance is ignored', () => {
    const left = record(5, { predicate: 'test.synthetic_tool', value: 'TypeScript' });
    const right = duplicateOf(left, 6);
    right.assertion.object.value = 'ts';
    const fingerprints = [fingerprint(left.assertion.object), fingerprint(right.assertion.object)].sort();
    const equivalenceCatalog = { kind: 'synthetic_test_only', rules: [{
        id: 'test_tool_alias', predicate: 'test.synthetic_tool', compatibility: slot('preferred-tool'),
        objectFingerprints: fingerprints,
    }] };
    assert.equal(evaluate([left, right]).comparisons[0].classification, 'insufficient_information');
    const comparison = evaluate([left, right], { equivalenceCatalog }).comparisons[0];
    assert.equal(comparison.classification, 'equivalent_by_explicit_rule');
    assert.equal(comparison.proposal.reviewRequired, true);
    assert.ok(comparison.proposal.risks.includes('synthetic_rule_only'));
    assert.equal(JSON.stringify(comparison).includes('TypeScript'), false);
    const realPredicateCatalog = structuredClone(equivalenceCatalog);
    realPredicateCatalog.rules[0].predicate = 'user.preference';
    assert.throws(() => evaluate([record(7), record(8)], { equivalenceCatalog: realPredicateCatalog }),
        { message: 'memory_consolidation_catalog_invalid' });
});

test('separate pairwise equivalence rules do not create transitive equivalence across evaluations', () => {
    const a = record(35, { predicate: 'test.synthetic_alias', value: 'A' });
    const b = duplicateOf(a, 36);
    b.assertion.object.value = 'B';
    const c = duplicateOf(a, 37);
    c.assertion.object.value = 'C';
    const ruleForAB = { kind: 'synthetic_test_only', rules: [{ id: 'test_alias_ab',
        predicate: 'test.synthetic_alias', compatibility: a.assertion.compatibility,
        objectFingerprints: [fingerprint(a.assertion.object), fingerprint(b.assertion.object)].sort() }] };
    const ruleForBC = { kind: 'synthetic_test_only', rules: [{ id: 'test_alias_bc',
        predicate: 'test.synthetic_alias', compatibility: a.assertion.compatibility,
        objectFingerprints: [fingerprint(b.assertion.object), fingerprint(c.assertion.object)].sort() }] };
    assert.equal(evaluate([a, b], { equivalenceCatalog: ruleForAB }).comparisons[0].classification,
        'equivalent_by_explicit_rule');
    assert.equal(evaluate([b, c], { equivalenceCatalog: ruleForBC }).comparisons[0].classification,
        'equivalent_by_explicit_rule');
    const ac = evaluate([a, c], { equivalenceCatalog: ruleForAB }).comparisons[0];
    assert.equal(ac.classification, 'insufficient_information');
    assert.equal(ac.proposal, null);
});

test('different validity periods remain separate even when their values are identical', () => {
    const earlier = record(9, { value: 'synthetic residence', validFrom: { value: '2030', precision: 'year' },
        validTo: { value: '2034', precision: 'year' } });
    const later = duplicateOf(earlier, 10);
    later.assertion.valid_from = { value: '2035-01-01', precision: 'day' };
    later.assertion.valid_to = null;
    const comparison = evaluate([earlier, later]).comparisons[0];
    assert.equal(comparison.classification, 'temporal_distinction');
    assert.equal(comparison.proposal, null);
});

test('plans and facts are not consolidated as the same occurrence', () => {
    const plan = record(11, { value: 'synthetic move', intent: 'plan',
        validFrom: { value: '2037', precision: 'year' } });
    const factRecord = duplicateOf(plan, 12);
    factRecord.intent = 'fact';
    const comparison = evaluate([plan, factRecord]).comparisons[0];
    assert.equal(comparison.classification, 'insufficient_information');
    assert.equal(comparison.reasonCode, 'plan_fact_intent_mismatch');
    assert.equal(comparison.proposal, null);
});

test('D.3 potential conflicts are reported but never become consolidation proposals', () => {
    const left = record(13, { predicate: 'test.synthetic_exclusive', value: 'synthetic west',
        compatibility: slot('synthetic-exclusive') });
    const right = duplicateOf(left, 14);
    right.assertion.object.value = 'synthetic east';
    const contradictionCatalog = { kind: 'synthetic_test_only', rules: [{
        id: 'test_exclusive_rule', predicate: 'test.synthetic_exclusive',
        compatibility: slot('synthetic-exclusive'), semantic: 'exclusive_values',
    }] };
    const comparison = evaluate([left, right], { contradictionCatalog }).comparisons[0];
    assert.equal(comparison.classification, 'potential_conflict');
    assert.equal(comparison.proposal, null);
});

test('different subjects, scopes, reference times and duplicate assertion IDs are rejected', () => {
    const first = record(15), second = duplicateOf(first, 16);
    const otherSubject = duplicateOf(first, 17);
    otherSubject.assertion.subject = { type: 'entity', entity_type: 'person', id: personId(17) };
    assert.throws(() => evaluate([first, otherSubject]), { message: 'memory_consolidation_subject_mismatch' });
    const otherScope = duplicateOf(first, 18);
    otherScope.scopeLabel = 'synthetic-shared';
    assert.throws(() => evaluate([first, otherScope]), { message: 'memory_consolidation_scope_mismatch' });
    const otherTime = duplicateOf(first, 19);
    otherTime.asOf = { value: '2037', precision: 'year' };
    assert.throws(() => evaluate([first, otherTime]), { message: 'memory_consolidation_reference_time_mismatch' });
    assert.throws(() => evaluate([first, structuredClone(first)]), { message: 'memory_consolidation_duplicate_assertion' });
});

test('relationships with different endpoints stay separate; matching direct edges can only be reviewed', () => {
    const one = relationRecord(20, 2), two = relationRecord(21, 3);
    const different = evaluate([one, two]).comparisons[0];
    assert.equal(different.classification, 'related_not_equivalent');
    assert.equal(different.proposal, null);
    const sameEdge = relationRecord(22, 2);
    sameEdge.evidence[0].source.kind = 'email';
    sameEdge.evidence[0].source.origin_trust = 'external_untrusted';
    const duplicate = evaluate([one, sameEdge]).comparisons[0];
    assert.equal(duplicate.classification, 'additional_evidence');
    assert.equal(duplicate.proposal.reviewRequired, true);
    assert.equal(duplicate.executable, false);
});

test('superseded history, malformed records, and missing evidence cannot produce proposals', () => {
    const active = record(23);
    const historical = duplicateOf(active, 24);
    historical.assertion.status = 'superseded';
    assert.equal(evaluate([active, historical]).comparisons[0].reasonCode, 'historical_assertions_must_remain_distinct');
    assert.throws(() => evaluate([{ ...active, evidence: [] }]),
        { message: 'memory_consolidation_evidence_missing' });
    assert.throws(() => evaluate([{ ...active, assertion: { ...active.assertion, object: { type: 'text', value: '' } } }]));
});

test('external supersession references are called out but are never claimed as verified or preserved', () => {
    const first = record(38);
    first.assertion.supersedes = [assertionId(390)];
    const second = duplicateOf(first, 39);
    const proposal = evaluate([first, second]).comparisons[0].proposal;
    assert.ok(proposal.risks.includes('external_history_references_must_be_checked'));
    assert.deepEqual(proposal.historyAssertionIdsToPreserve, [assertionId(38), assertionId(39)]);
    assert.equal(proposal.historyAssertionIdsToPreserve.includes(assertionId(390)), false);
});

test('different temporal precision is not silently normalized into an equivalence', () => {
    const coarse = record(40, { validFrom: { value: '2030', precision: 'year' } });
    const precise = duplicateOf(coarse, 41);
    precise.assertion.valid_from = { value: '2030-01-01', precision: 'day' };
    const comparison = evaluate([coarse, precise]).comparisons[0];
    assert.equal(comparison.classification, 'temporal_distinction');
    assert.equal(comparison.proposal, null);
});

test('cross-record duplicate evidence IDs and conflicting source metadata fail closed', () => {
    const first = record(30);
    const duplicateEvidence = duplicateOf(first, 31);
    duplicateEvidence.evidence[0].evidence.id = first.evidence[0].evidence.id;
    assert.throws(() => evaluate([first, duplicateEvidence]),
        { message: 'memory_consolidation_duplicate_evidence' });

    const conflictingSource = duplicateOf(first, 32);
    conflictingSource.evidence[0].source.id = first.evidence[0].source.id;
    conflictingSource.evidence[0].source.kind = 'email';
    conflictingSource.evidence[0].source.origin_trust = 'external_untrusted';
    conflictingSource.evidence[0].evidence.source_id = first.evidence[0].source.id;
    assert.throws(() => evaluate([first, conflictingSource]),
        { message: 'memory_consolidation_source_inconsistent' });
});

test('synthetic equivalence catalogs reject duplicate or malformed rules', () => {
    const first = record(25, { predicate: 'test.synthetic_value', value: 'a' });
    const second = duplicateOf(first, 26);
    const rule = { id: 'test_rule', predicate: 'test.synthetic_value', compatibility: slot('preferred-tool'),
        objectFingerprints: [fingerprint(first.assertion.object), fingerprint({ type: 'text', value: 'b' })] };
    assert.throws(() => evaluate([first, second], { equivalenceCatalog: { kind: 'synthetic_test_only',
        rules: [rule, { ...rule, predicate: 'test.another_value' }] } }),
    { message: 'memory_consolidation_catalog_duplicate_rule' });
    assert.throws(() => evaluate([first, second], { equivalenceCatalog: { kind: 'synthetic_test_only',
        rules: [{ ...rule, objectFingerprints: ['not-a-sha256', fingerprint(first.assertion.object)] }] } }),
    { message: 'memory_consolidation_catalog_invalid' });
});

test('pair ordering is deterministic and every projection denies execution without mutating inputs', () => {
    const records = [record(27, { value: 'synthetic A' }), record(28, { value: 'synthetic B' }),
        record(29, { predicate: 'user.routine', compatibility: slot('morning'), value: 'synthetic C' })];
    const before = structuredClone(records);
    const forward = evaluate(records);
    const reverse = evaluate([...records].reverse());
    assert.deepEqual(forward, reverse);
    assert.deepEqual(records, before);
    for (const comparison of forward.comparisons) {
        assert.equal(comparison.executable, false);
        assert.equal(comparison.persistencePerformed, false);
        if (comparison.proposal) {
            assert.equal(comparison.proposal.executable, false);
            assert.equal(comparison.proposal.persistencePerformed, false);
        }
    }
    assert.deepEqual(evaluate(null, { mode: 'execute' }), {
        decision: 'DENY', comparisons: [], executable: false, persistencePerformed: false,
    });
});

test('similar-looking facts with different predicates are not considered equivalent', () => {
    const preference = record(33, { predicate: 'user.preference', value: 'synthetic concise answers' });
    const routine = duplicateOf(preference, 34);
    routine.assertion.predicate = 'user.routine';
    const comparison = evaluate([preference, routine]).comparisons[0];
    assert.equal(comparison.classification, 'related_not_equivalent');
    assert.equal(comparison.proposal, null);
});
