import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveContext } from '../src/memory/contextual-retrieval.js';

const AS_OF = { value: '2036-01-01T00:00:00.000Z', precision: 'instant' };
const TIME = '2035-01-01T00:00:00.000Z';
const id = (prefix, n) => `${prefix}_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = n => ({ id: id('person', n), type: 'person', created_at: TIME });

function fact(n, { value = `fictional-${n}`, predicate = 'user.preference', subject = { type: 'owner' },
    status = 'active', validFrom = { value: '2030-01-01', precision: 'day' }, scopeLabel = 'fixture-private-a' } = {}) {
    const assertionId = id('mem', n), sourceId = id('src', n);
    const assertion = { id: assertionId, kind: 'preference', subject, predicate, object: { type: 'text', value }, status,
        valid_from: validFrom, valid_to: null, recorded_at: TIME,
        supersedes: status === 'superseded' && n > 1 ? [id('mem', n - 1)] : [],
        compatibility: { category: 'user', key: 'preferred-tool' } };
    const source = { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
        locator: null, occurred_at: null, recorded_at: TIME };
    const evidence = { id: id('ev', n), assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
        extraction_confidence: null, learned_at: TIME, last_confirmed_at: null, legacy_ref: null };
    return { assertion, evidence: [{ evidence, source }], asOf: AS_OF, intent: 'fact', scopeLabel,
        subjectEntity: null, objectEntity: null };
}

function relation(n, from = 1, to = 2) {
    const subjectEntity = person(from), objectEntity = person(to);
    const row = fact(n, { predicate: 'partner_of', subject: { type: 'entity', entity_type: 'person', id: subjectEntity.id } });
    row.assertion.kind = 'fact';
    row.assertion.compatibility = null;
    row.assertion.object = { type: 'entity_reference', entity_type: 'person', id: objectEntity.id };
    row.subjectEntity = subjectEntity;
    row.objectEntity = objectEntity;
    return row;
}

const query = overrides => ({ subject: null, entityIds: [], predicates: [], relationPredicates: [],
    temporal: 'any', limit: 20, ...overrides });
const run = (records, overrides = {}) => retrieveContext({ mode: 'simulate', records, query: query(overrides), asOf: AS_OF,
    restrictionSnapshot: null });

test('retrieves sanitized structured facts with stable explainable ranking and no payload values', () => {
    const a = fact(1), b = fact(2, { predicate: 'user.preference', validFrom: null });
    const output = run([b, a], { predicates: ['user.preference'], temporal: 'current' });
    assert.deepEqual(output.results.map(row => row.assertionId), [a.assertion.id]);
    assert.equal(output.results[0].score, 10);
    assert.equal(output.results[0].scoreMeaning, 'structural_relevance_not_truth_confidence');
    assert.ok(output.results[0].reasonCodes.includes('temporal_current'));
    assert.equal(JSON.stringify(output).includes('fictional-1'), false);
    assert.equal(output.executable, false);
    assert.equal(output.persistencePerformed, false);
});

test('keeps plans distinct from completed events and supports history or uncertainty filters', () => {
    const plan = fact(3, { validFrom: { value: '2037', precision: 'year' } });
    plan.intent = 'plan';
    assert.equal(run([plan], { temporal: 'future' }).results[0].temporalState, 'planned');
    assert.equal(run([plan], { temporal: 'current' }).results.length, 0);
    const unknown = fact(4, { validFrom: null });
    assert.equal(run([unknown], { temporal: 'uncertain' }).results[0].temporalState, 'unknown');
    const old = fact(32, { status: 'superseded', validFrom: null });
    assert.equal(run([old], { temporal: 'history' }).results[0].temporalState, 'historical');
    const due = fact(33, { validFrom: { value: '2034', precision: 'year' } });
    due.intent = 'plan';
    assert.equal(run([due], { temporal: 'uncertain' }).results[0].temporalState, 'unknown');
});

test('reports conflicts and exact duplicate candidates without choosing, merging, or hiding assertions', () => {
    const a = fact(5, { value: 'synthetic value A' });
    const b = fact(6, { value: 'synthetic value B' });
    const conflict = run([a, b]);
    assert.equal(conflict.results.length, 2);
    assert.deepEqual(conflict.conflicts, []);
    assert.equal(conflict.comparisons[0].classification, 'insufficient_information');
    assert.ok(conflict.results.every(row => row.reviewFlags.includes('comparison_insufficient_information')));
    assert.equal(conflict.results.some(row => Object.hasOwn(row, 'object')), false);
    const c = fact(7, { value: 'same synthetic value' });
    const d = structuredClone(c);
    d.assertion.id = id('mem', 8);
    d.evidence[0].evidence.id = id('ev', 8);
    d.evidence[0].evidence.assertion_id = d.assertion.id;
    assert.equal(run([c, d]).duplicates[0].classification, 'exact_duplicate');
});

test('uses only direct relationships and never follows a second edge', () => {
    const ab = relation(9, 1, 2), bc = relation(10, 2, 3);
    const output = run([ab, bc], { entityIds: [person(1).id], relationPredicates: ['partner_of'] });
    assert.deepEqual(output.results.map(row => row.assertionId), [ab.assertion.id]);
    assert.equal(output.relations.length, 1);
    assert.equal(output.relations[0].objectEntityId, person(2).id);
    assert.equal(output.relations[0].executable, false);
    assert.equal(run([ab], { entityIds: [person(1).id], temporal: 'current' }).results.length, 1);
    const future = relation(17, 1, 3);
    future.assertion.valid_from = { value: '2037', precision: 'year' };
    assert.equal(run([future], { entityIds: [person(1).id], temporal: 'future' }).results.length, 1);
});

test('applies result bounds before emitting conflict metadata and keeps ordering stable', () => {
    const a = fact(18, { value: 'conflicting A' }), b = fact(19, { value: 'conflicting B' });
    const bounded = run([a, b], { limit: 1 });
    assert.equal(bounded.results.length, 1);
    assert.deepEqual(bounded.conflicts, []);
    const forward = run([a, b]);
    const reverse = run([b, a]);
    assert.deepEqual(forward.results.map(item => item.assertionId), reverse.results.map(item => item.assertionId));
    assert.deepEqual(forward.conflicts, reverse.conflicts);
});

test('sensitive predicates receive no ranking boost and D.5 context restrictions exclude them', () => {
    const sensitive = fact(30, { predicate: 'user.health', value: 'fictional sensitive value' });
    const ordinary = fact(31, { predicate: 'user.preference', value: 'fictional ordinary value' });
    const output = run([sensitive, ordinary]);
    assert.equal(output.results.find(item => item.assertionId === sensitive.assertion.id).score,
        output.results.find(item => item.assertionId === ordinary.assertion.id).score);
    assert.equal(JSON.stringify(output).includes('fictional sensitive value'), false);
    const restricted = retrieveContext({ mode: 'simulate', records: [sensitive], query: query({}), asOf: AS_OF,
        restrictionSnapshot: { fixtureOnly: true, entries: [{ assertionId: sensitive.assertion.id, restrictionKinds: ['context'] }] } });
    assert.deepEqual(restricted.results, []);
});

test('rejects unknown relation predicates rather than silently returning no matches', () => {
    assert.throws(() => run([relation(20)], { relationPredicates: ['person.unknown_link'] }),
        /relation_predicate_invalid/);
});

test('applies only exact fixture restrictions and omits restricted content from results', () => {
    const a = fact(11), b = fact(12);
    const output = retrieveContext({ mode: 'simulate', records: [a, b], query: query({}), asOf: AS_OF,
        restrictionSnapshot: { fixtureOnly: true, entries: [{ assertionId: a.assertion.id, restrictionKinds: ['context'] }] } });
    assert.deepEqual(output.results.map(row => row.assertionId), [b.assertion.id]);
    assert.deepEqual(output.exclusions, [{ assertionId: a.assertion.id, reasonCode: 'restricted_from_retrieval' }]);
    const sharing = retrieveContext({ mode: 'simulate', records: [a], query: query({}), asOf: AS_OF,
        restrictionSnapshot: { fixtureOnly: true, entries: [{ assertionId: a.assertion.id, restrictionKinds: ['sharing'] }] } });
    assert.deepEqual(sharing.results, []);
});

test('rejects mixed partitions, mismatched time, and duplicate assertion ids', () => {
    const a = fact(13), b = fact(14, { scopeLabel: 'fixture-private-b' });
    assert.throws(() => run([a, b]), /scope_mismatch/);
    const c = fact(15); c.asOf = { value: '2035-01-01T00:00:00.000Z', precision: 'instant' };
    assert.throws(() => run([a, c]), /reference_time_mismatch/);
    assert.throws(() => run([a, structuredClone(a)]), /duplicate_assertion/);
});

test('subject selection is exact and malformed records fail closed without resolving Self', () => {
    const ownerFact = fact(34);
    const otherSubject = fact(35, { subject: { type: 'entity', entity_type: 'person', id: person(8).id } });
    const selected = run([ownerFact, otherSubject], { subject: otherSubject.assertion.subject });
    assert.deepEqual(selected.results.map(item => item.assertionId), [otherSubject.assertion.id]);
    const malformed = fact(36); malformed.evidence = [];
    assert.throws(() => run([malformed]));
});

test('execution mode is always denied and returns no data', () => {
    const output = retrieveContext({ mode: 'execute', records: [], query: query({}), asOf: AS_OF, restrictionSnapshot: null });
    assert.equal(output.decision, 'DENY');
    assert.equal(output.executable, false);
    assert.equal(output.persistencePerformed, false);
    assert.deepEqual(output.results, []);
    assert.deepEqual(output.comparisons, []);
});

test('input fixtures are never mutated', () => {
    const input = fact(16), before = structuredClone(input);
    run([input]);
    assert.deepEqual(input, before);
});
