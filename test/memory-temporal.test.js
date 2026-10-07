import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyValidity } from '../src/memory/temporal.js';
import { createMemoryRetriever } from '../src/memory/retrieval.js';

const now = '2035-06-10T12:00:00.000Z';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = (prefix, n) => `${prefix}_${uuid(n)}`;
const person = id('person', 1), storeId = id('store', 1);
const T = (value, precision) => ({ value, precision });

function snapshot(assertions = []) {
    return { revision: 9, digest: 'a'.repeat(64), snapshot: { schema_version: 4, store_id: storeId,
        self_person_id: person, entities: [{ id: person, type: 'person', created_at: now }],
        assertions: [], sources: [], evidence: [], migrations: [], ...assertions } };
}
function record(n, { valid_from = null, valid_to = null, status = 'active', recorded_at = now } = {}) {
    const assertionId = id('mem', n), sourceId = id('src', n), evidenceId = id('ev', n);
    return {
        assertion: { id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: person },
            predicate: 'user.note', object: { type: 'text', value: `fact ${n}` }, status, valid_from, valid_to,
            recorded_at, supersedes: [], compatibility: null },
        source: { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at },
        evidence: { id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: null, learned_at: recorded_at, last_confirmed_at: null, legacy_ref: null },
    };
}
function withRecords(records) {
    return snapshot({ assertions: records.map(item => item.assertion), sources: records.map(item => item.source),
        evidence: records.map(item => item.evidence) });
}
const point = value => T(value, 'instant');
const day = value => T(value, 'day');

test('inclusive interval boundaries and before/inside/after dates are deterministic', () => {
    const from = day('2024-05-01'), to = day('2024-05-15');
    assert.equal(classifyValidity(from, to, day('2024-04-30')), 'invalid');
    assert.equal(classifyValidity(from, to, day('2024-05-01')), 'valid');
    assert.equal(classifyValidity(from, to, day('2024-05-10')), 'valid');
    assert.equal(classifyValidity(from, to, day('2024-05-15')), 'valid');
    assert.equal(classifyValidity(from, to, day('2024-05-16')), 'invalid');
});

test('a single open endpoint is unbounded, while two missing dates remain unknown', () => {
    assert.equal(classifyValidity(null, day('2024-05-15'), day('2020-01-01')), 'valid');
    assert.equal(classifyValidity(day('2024-05-01'), null, day('2030-01-01')), 'valid');
    assert.equal(classifyValidity(null, null, day('1990-01-01')), 'indeterminate');
});

test('year and month precision overlapping a finer query stays indeterminate', () => {
    assert.equal(classifyValidity(T('2024', 'year'), null, day('2024-03-10')), 'indeterminate');
    assert.equal(classifyValidity(T('2024', 'year'), null, day('2023-12-31')), 'invalid');
    assert.equal(classifyValidity(T('2024', 'year'), null, day('2025-01-01')), 'valid');
    assert.equal(classifyValidity(T('2024-03', 'month'), null, day('2024-03-10')), 'indeterminate');
    assert.equal(classifyValidity(T('2024-03', 'month'), null, day('2024-04-01')), 'valid');
    assert.equal(classifyValidity(T('2024', 'year'), T('2024', 'year'), T('2024', 'year')), 'indeterminate');
    assert.equal(classifyValidity(T('2024-03', 'month'), T('2024-03', 'month'), T('2024-03', 'month')), 'indeterminate');
});

test('day precision is certain at day granularity and uncertain at instant granularity', () => {
    const start = day('2024-05-01');
    assert.equal(classifyValidity(start, null, day('2024-05-01')), 'valid');
    assert.equal(classifyValidity(start, null, day('2024-04-30')), 'invalid');
    assert.equal(classifyValidity(start, null, point('2024-05-01T12:00:00.000Z')), 'indeterminate');
    assert.equal(classifyValidity(start, null, point('2024-05-02T00:00:00.000Z')), 'valid');
});

test('month/day/instant endpoint combinations preserve precision without inventing dates', () => {
    assert.equal(classifyValidity(T('2024-05', 'month'), null, T('2024-06', 'month')), 'valid');
    assert.equal(classifyValidity(null, T('2024-05', 'month'), day('2024-05-10')), 'indeterminate');
    assert.equal(classifyValidity(null, T('2024-05', 'month'), day('2024-06-01')), 'invalid');
    assert.equal(classifyValidity(point('2024-05-10T12:00:00.000Z'), null,
        point('2024-05-10T12:00:00.000Z')), 'valid');
    assert.equal(classifyValidity(point('2024-05-10T12:00:00.000Z'), null,
        point('2024-05-10T11:59:59.999Z')), 'invalid');
    assert.equal(classifyValidity(day('2024-05-01'), day('2024-05-31'), T('2024-05', 'month')), 'valid');
});

test('currentKnowledge uses injected present time, separates uncertainty and excludes superseded status', async () => {
    const active = record(1, { valid_from: T('2034', 'year') });
    const uncertain = record(2, { valid_from: T('2035-06', 'month') });
    const old = record(3, { status: 'superseded' });
    let reads = 0;
    const retriever = createMemoryRetriever({ readSnapshot: async () => { reads++; return withRecords([active, uncertain, old]); }, now: () => now });
    const result = await retriever.currentKnowledge({ entityIds: [person] });
    assert.deepEqual(result.assertions.map(item => item.record.id), [active.assertion.id]);
    assert.deepEqual(result.indeterminateAssertions.map(item => item.record.id), [uncertain.assertion.id]);
    assert.equal(result.assertions[0].temporalStatus, 'valid');
    assert.equal(result.metadata.validTime.value, now);
    assert.deepEqual(result.trust, { authority: 'data_only' });
    assert.equal(reads, 1);
});

test('active record with both dates absent is current knowledge, but arbitrary valid-at remains indeterminate', async () => {
    const undated = record(1);
    const retriever = createMemoryRetriever({ readSnapshot: async () => withRecords([undated]), now: () => now });
    const current = await retriever.currentKnowledge({ entityIds: [person] });
    const historical = await retriever.knowledgeValidAt({ entityIds: [person] }, day('2020-01-01'));
    assert.deepEqual(current.assertions.map(item => item.record.id), [undated.assertion.id]);
    assert.deepEqual(historical.assertions, []);
    assert.deepEqual(historical.indeterminateAssertions.map(item => item.record.id), [undated.assertion.id]);
});

test('knowledgeValidAt includes known superseded history but reports temporal uncertainty', async () => {
    const prior = record(1, { status: 'superseded', valid_from: day('2020-01-01'), valid_to: null,
        recorded_at: '2035-06-10T12:00:00.000Z' });
    const current = record(2, { valid_from: day('2024-01-01') });
    const retriever = createMemoryRetriever({ readSnapshot: async () => withRecords([current, prior]), now: () => now });
    const past = await retriever.knowledgeValidAt({ entityIds: [person] }, day('2022-04-01'));
    assert.deepEqual(past.assertions.map(item => item.record.id), [prior.assertion.id]);
    assert.deepEqual(past.indeterminateAssertions, []);
    const present = await retriever.knowledgeValidAt({ entityIds: [person] }, day('2025-04-01'));
    assert.deepEqual(present.assertions.map(item => item.record.id), [prior.assertion.id, current.assertion.id]);
});

test('history retains superseded versions without deriving valid_to from recorded_at or supersession', async () => {
    const old = record(1, { status: 'superseded', valid_from: null, valid_to: null,
        recorded_at: '2020-01-01T00:00:00.000Z' });
    const newer = record(2, { valid_from: null, valid_to: null,
        recorded_at: '2030-01-01T00:00:00.000Z' });
    newer.assertion.supersedes = [old.assertion.id];
    const retriever = createMemoryRetriever({ readSnapshot: async () => withRecords([newer, old]), now: () => now });
    const result = await retriever.history({ entityIds: [person], statuses: ['active'] });
    assert.deepEqual(result.assertions.map(item => item.record.id), [old.assertion.id, newer.assertion.id]);
    assert.equal(result.assertions[0].record.valid_to, null);
    assert.equal(result.assertions[0].record.recorded_at, '2020-01-01T00:00:00.000Z');
    assert.equal(result.metadata.historyMeaning, 'known_validity_and_supersession');
    assert.equal(result.metadata.bitemporal, false);
});

test('forget stays physical: forgotten assertion, evidence and source cannot reappear in history', async () => {
    const retained = record(1), forgotten = record(2, { status: 'superseded' });
    const before = withRecords([retained, forgotten]);
    const after = withRecords([retained]);
    const retriever = createMemoryRetriever({ readSnapshot: async () => after, now: () => now });
    const history = await retriever.history({ entityIds: [person] });
    const valid = await retriever.knowledgeValidAt({ entityIds: [person] }, day('2025-01-01'));
    assert.deepEqual(history.assertions.map(item => item.record.id), [retained.assertion.id]);
    assert.ok(!JSON.stringify(valid).includes(forgotten.assertion.id));
    assert.ok(!JSON.stringify(history).includes(forgotten.evidence.id));
    assert.ok(!JSON.stringify(history).includes(forgotten.source.id));
    assert.equal(before.snapshot.assertions.length, 2);
});

test('temporal reads preserve evidence, stable ordering, snapshot metadata and perform no writes', async () => {
    const later = record(2, { valid_from: day('2020-01-01') });
    const earlier = record(1, { valid_from: day('2020-01-01') });
    const current = withRecords([later, earlier]);
    const before = structuredClone(current);
    let reads = 0;
    const retriever = createMemoryRetriever({ readSnapshot: async () => { reads++; return current; }, now: () => now });
    const a = await retriever.knowledgeValidAt({ entityIds: [person] }, day('2025-01-01'));
    const reversed = withRecords([earlier, later]);
    const other = await createMemoryRetriever({ readSnapshot: async () => reversed, now: () => now })
        .knowledgeValidAt({ entityIds: [person] }, day('2025-01-01'));
    assert.deepEqual(a, other);
    assert.equal(a.assertions[0].evidence[0].evidence.assertion_id, earlier.assertion.id);
    assert.equal(a.assertions[0].evidence[0].source.authority, 'data_only');
    assert.equal(a.metadata.revision, 9);
    assert.equal(a.metadata.digest, 'a'.repeat(64));
    assert.deepEqual(a.trust, { authority: 'data_only' });
    assert.equal(Object.hasOwn(a, 'grant'), false);
    assert.deepEqual(current, before);
    assert.equal(reads, 1);
});

test('temporal APIs reject invalid validTime values', async () => {
    const retriever = createMemoryRetriever({ readSnapshot: async () => snapshot(), now: () => now });
    await assert.rejects(retriever.knowledgeValidAt({}, { value: '2024-02-30', precision: 'day' }));
    await assert.rejects(retriever.knowledgeValidAt({}, null));
});
