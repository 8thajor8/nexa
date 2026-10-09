import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTemporal } from '../src/memory/temporal.js';
import { describeTemporalRecord, orderTemporalHistory, planTemporalTransition,
    previewTemporalEntry, summarizeTemporalState } from '../src/memory/temporal-semantics.js';

const AS_OF = { value: '2035-06-01T00:00:00.000Z', precision: 'instant' };
const TIME = '2035-06-01T00:00:00.000Z';
const SELF = { type: 'owner' };
const person = id => ({ type: 'entity', entity_type: 'person', id: `person_00000000-0000-4000-8000-${String(id).padStart(12, '0')}` });

function record(n, { value = `synthetic-${n}`, subject = SELF, predicate = 'user.location', status = 'active',
    validFrom = { value: '2030-01-01', precision: 'day' }, validTo = null, recordedAt = `2035-06-${String(n).padStart(2, '0')}T00:00:00.000Z`,
    sourceOccurredAt = { value: '2029-12-01', precision: 'day' }, receivedAt = recordedAt, intent = 'fact' } = {}) {
    const assertionId = `mem_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const sourceId = `src_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    return {
        assertion: { id: assertionId, kind: 'fact', subject, predicate, object: { type: 'text', value }, status,
            valid_from: validFrom, valid_to: validTo, recorded_at: recordedAt,
            supersedes: status === 'superseded' && n > 1 ? [`mem_00000000-0000-4000-8000-${String(n - 1).padStart(12, '0')}`] : [], compatibility: null },
        source: { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only', locator: null,
            occurred_at: sourceOccurredAt, recorded_at: recordedAt },
        evidence: { id: `ev_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            assertion_id: assertionId, source_id: sourceId, derivation: 'explicit', extraction_confidence: null,
            learned_at: receivedAt, last_confirmed_at: null, legacy_ref: null },
        asOf: AS_OF, intent,
    };
}

test('precision comparison preserves overlapping coarse dates instead of inventing a day', () => {
    assert.equal(compareTemporal({ value: '2035', precision: 'year' }, { value: '2035-06-01', precision: 'day' }), 'overlap');
    assert.equal(compareTemporal({ value: '2034', precision: 'year' }, { value: '2035-06-01', precision: 'day' }), 'before');
    assert.equal(compareTemporal({ value: '2036', precision: 'year' }, { value: '2035-06-01', precision: 'day' }), 'after');
});

test('Schema v5 compares instants in canonical UTC only and rejects unnormalized offsets', () => {
    assert.equal(compareTemporal({ value: '2035-06-01T12:00:00.000Z', precision: 'instant' },
        { value: '2035-06-01T12:00:00Z', precision: 'instant' }), 'equal');
    assert.throws(() => compareTemporal({ value: '2035-06-01T14:00:00+02:00', precision: 'instant' },
        { value: '2035-06-01T12:00:00Z', precision: 'instant' }));
});

test('record view separates validity, source event time, learned/received time, and recording time', () => {
    const input = record(1, { recordedAt: '2035-06-02T00:00:00.000Z', receivedAt: '2035-06-01T12:00:00.000Z' });
    const result = describeTemporalRecord(input);
    assert.equal(result.state, 'current');
    assert.deepEqual(result.validFrom, { value: '2030-01-01', precision: 'day' });
    assert.equal(result.eventOccurredAt, null);
    assert.equal(result.eventTimeStatus, 'not_recorded_on_assertion');
    assert.deepEqual(result.sourceOccurredAt, input.source.occurred_at);
    assert.equal(result.receivedAt, '2035-06-01T12:00:00.000Z');
    assert.equal(result.recordedAt, '2035-06-02T00:00:00.000Z');
    assert.notEqual(result.receivedAt, result.recordedAt);
});

test('superseded fact is historical and does not infer validity from recording date', () => {
    const input = record(2, { status: 'superseded', value: 'synthetic old job', validFrom: null, validTo: null });
    const result = describeTemporalRecord(input);
    assert.equal(result.state, 'historical');
    assert.equal(result.reason, 'assertion_superseded');
    assert.equal(result.validTo, null);
});

test('explicit future plan remains planned and is never treated as completed when due', () => {
    const future = record(3, { validFrom: { value: '2036', precision: 'year' }, intent: 'plan' });
    assert.equal(describeTemporalRecord(future).state, 'planned');
    const due = record(4, { validFrom: { value: '2034', precision: 'year' }, intent: 'plan' });
    assert.equal(describeTemporalRecord(due).state, 'unknown');
    assert.equal(describeTemporalRecord(due).reason, 'plan_due_not_completion_evidence');
    const expired = record(22, { validFrom: { value: '2030-01-01', precision: 'day' },
        validTo: { value: '2032-01-01', precision: 'day' }, intent: 'plan' });
    assert.equal(describeTemporalRecord(expired).state, 'unknown');
    assert.equal(describeTemporalRecord(expired).reason, 'plan_window_elapsed_unconfirmed');
});

test('future validity alone is not inferred to be a plan', () => {
    const future = record(5, { validFrom: { value: '2036', precision: 'year' } });
    assert.equal(describeTemporalRecord(future).state, 'future_fact');
});

test('plan cancellation is a target-bound hypothetical preview and leaves the input unchanged', () => {
    const plan = record(6, { validFrom: { value: '2036', precision: 'year' }, intent: 'plan' });
    const before = structuredClone(plan);
    const result = planTemporalTransition({ record: plan, action: 'cancel_plan', effectiveAt: AS_OF });
    assert.equal(result.success, true);
    assert.equal(result.toState, 'cancelled');
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
    assert.deepEqual(plan, before);
    assert.equal(describeTemporalRecord(plan).state, 'planned');
    assert.equal(planTemporalTransition({ record: plan, action: 'cancel_plan',
        effectiveAt: { value: '2037', precision: 'year' } }).success, false);
});

test('replacement preview targets one active assertion and never mutates it', () => {
    const item = record(7);
    const before = structuredClone(item);
    const result = planTemporalTransition({ record: item, action: 'replace', effectiveAt: AS_OF });
    assert.equal(result.targetAssertionId, item.assertion.id);
    assert.equal(result.toState, 'historical');
    assert.equal(result.executable, false);
    assert.deepEqual(item, before);
    const old = record(8, { status: 'superseded' });
    assert.equal(planTemporalTransition({ record: old, action: 'replace', effectiveAt: AS_OF }).success, false);
});

test('temporal preview retains unknown dates and separates a future plan from occurrence', () => {
    const entry = previewTemporalEntry({ validFrom: { value: '2036-01', precision: 'month' }, validTo: null,
        eventOccurredAt: null, receivedAt: '2035-06-01T12:00:00.000Z', recordedAt: '2035-06-02T00:00:00.000Z',
        asOf: AS_OF, intent: 'plan' });
    assert.equal(entry.state, 'planned');
    assert.equal(entry.eventOccurredAt, null);
    assert.equal(entry.executable, false);
    const unknown = previewTemporalEntry({ validFrom: null, validTo: null, eventOccurredAt: null,
        receivedAt: null, recordedAt: TIME, asOf: AS_OF, intent: 'fact' });
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.reason, 'validity_not_established');
});

test('invalid intervals, mismatched evidence, and unsupported lifecycle annotations fail closed', () => {
    const input = record(9);
    assert.throws(() => previewTemporalEntry({ validFrom: { value: '2036', precision: 'year' },
        validTo: { value: '2035', precision: 'year' }, eventOccurredAt: null, receivedAt: null,
        recordedAt: TIME, asOf: AS_OF, intent: 'fact' }));
    assert.throws(() => describeTemporalRecord({ ...input, evidence: { ...input.evidence, assertion_id: 'mem_00000000-0000-4000-8000-000000000010' } }));
    assert.throws(() => describeTemporalRecord({ ...input, intent: 'cancelled' }));
});

test('compatible time intervals coexist; distinct overlapping values are reported ambiguous, not resolved', () => {
    const old = record(10, { value: 'old address', validFrom: { value: '2030', precision: 'year' },
        validTo: { value: '2034', precision: 'year' } });
    const current = record(11, { value: 'new address', validFrom: { value: '2035-01-01', precision: 'day' } });
    const separatePeriods = summarizeTemporalState({ records: [old, current] });
    assert.deepEqual(separatePeriods.currentAssertionIds, [current.assertion.id]);
    assert.equal(separatePeriods.ambiguousSlotCount, 0);
    const conflict = record(12, { value: 'conflicting address', validFrom: { value: '2035-03', precision: 'month' } });
    const ambiguous = summarizeTemporalState({ records: [current, conflict] });
    assert.equal(ambiguous.ambiguousSlotCount, 1);
    assert.deepEqual(ambiguous.ambiguousAssertionIds, [current.assertion.id, conflict.assertion.id].sort());
    assert.equal(ambiguous.executable, false);
    assert.equal(ambiguous.persistencePerformed, false);
});

test('a temporal summary rejects records evaluated at different reference times', () => {
    const a = record(20);
    const b = record(21, { validFrom: { value: '2030-01-01', precision: 'day' } });
    b.asOf = { value: '2036', precision: 'year' };
    assert.throws(() => summarizeTemporalState({ records: [a, b] }), { message: 'memory_temporal_reference_time_mismatch' });
});

test('a synthetic employment change preserves the prior period and identifies the new period at the reference time', () => {
    const former = record(18, { predicate: 'person.employer', value: 'Example North', status: 'superseded',
        validFrom: { value: '2028', precision: 'year' }, validTo: { value: '2033', precision: 'year' } });
    const current = record(19, { predicate: 'person.employer', value: 'Example South',
        validFrom: { value: '2034-01-01', precision: 'day' } });
    const state = summarizeTemporalState({ records: [former, current] });
    assert.deepEqual(state.historicalAssertionIds, [former.assertion.id]);
    assert.deepEqual(state.currentAssertionIds, [current.assertion.id]);
    assert.equal(state.ambiguousSlotCount, 0);
});

test('state grouping keeps different canonical subjects separate and processes each supplied scope independently', () => {
    const one = record(13, { subject: person(13), value: 'employed at Example' });
    const two = record(14, { subject: person(14), value: 'not employed at Example' });
    const firstScope = summarizeTemporalState({ records: [one] });
    const secondScope = summarizeTemporalState({ records: [two] });
    assert.deepEqual(firstScope.currentAssertionIds, [one.assertion.id]);
    assert.deepEqual(secondScope.currentAssertionIds, [two.assertion.id]);
    assert.equal(firstScope.ambiguousSlotCount, 0);
    assert.equal(secondScope.ambiguousSlotCount, 0);
    assert.throws(() => summarizeTemporalState({ records: [one, two] }),
        { message: 'memory_temporal_subject_mismatch' });
    assert.throws(() => orderTemporalHistory({ records: [one, two] }),
        { message: 'memory_temporal_subject_mismatch' });
});

test('duplicate assertion IDs are rejected in summaries and histories', () => {
    const item = record(23);
    assert.throws(() => summarizeTemporalState({ records: [item, structuredClone(item)] }),
        { message: 'memory_temporal_duplicate_assertion' });
    assert.throws(() => orderTemporalHistory({ records: [item, structuredClone(item)] }),
        { message: 'memory_temporal_duplicate_assertion' });
});

test('history projection orders by recorded time then stable assertion ID', () => {
    const later = record(15, { recordedAt: '2035-06-03T00:00:00.000Z' });
    const earlier = record(16, { recordedAt: '2035-06-01T00:00:00.000Z' });
    const tied = record(17, { recordedAt: '2035-06-01T00:00:00.000Z' });
    assert.deepEqual(orderTemporalHistory({ records: [later, tied, earlier] }).map(item => item.assertionId),
        [earlier.assertion.id, tied.assertion.id, later.assertion.id]);
});

test('a receipt timestamp cannot precede the time the information was learned', () => {
    assert.throws(() => previewTemporalEntry({ validFrom: null, validTo: null, eventOccurredAt: null,
        receivedAt: '2035-06-02T00:00:00.000Z', recordedAt: '2035-06-01T00:00:00.000Z',
        asOf: AS_OF, intent: 'fact' }), { message: 'memory_temporal_order_invalid' });
});
