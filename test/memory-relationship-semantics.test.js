import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRelation, queryRelations } from '../src/memory/relationship-semantics.js';

const AS_OF = { value: '2036-01-01T00:00:00.000Z', precision: 'instant' };
const person = n => ({ id: `person_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'person', created_at: '2030-01-01T00:00:00.000Z' });
const relationId = n => `mem_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function relation(n, { subject = person(1), object = person(2), status = 'active',
    validFrom = { value: '2030-01-01', precision: 'day' }, validTo = null,
    scopeLabel = 'synthetic-private-a', kind = 'user_statement', derivation = 'explicit' } = {}) {
    const assertionId = relationId(n);
    const sourceId = `src_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const evidence = { id: `ev_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        assertion_id: assertionId, source_id: sourceId, derivation, extraction_confidence: null,
        learned_at: '2035-01-01T00:00:00.000Z', last_confirmed_at: null, legacy_ref: null };
    const source = { id: sourceId, kind, origin_trust: kind === 'user_statement' ? 'user_asserted' : 'external_untrusted',
        authority: 'data_only', locator: null, occurred_at: { value: '2035-01-01', precision: 'day' },
        recorded_at: '2035-01-01T00:00:00.000Z' };
    const assertion = { id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: subject.id },
        predicate: 'partner_of', object: { type: 'entity_reference', entity_type: 'person', id: object.id },
        status, valid_from: validFrom, valid_to: validTo, recorded_at: '2035-01-01T00:00:00.000Z',
        supersedes: [], compatibility: null };
    return { assertion, subjectEntity: subject, objectEntity: object,
        evidence: [{ evidence, source }], asOf: AS_OF, scopeLabel };
}

function query(records, fromEntityId = person(1).id, toEntityId = null, predicate = null, mode = 'simulate') {
    return queryRelations({ records, fromEntityId, toEntityId, predicate, mode });
}

test('describes a schema-backed relation with endpoints, evidence metadata and no raw content', () => {
    const row = relation(1);
    const before = structuredClone(row);
    const result = describeRelation(row);
    assert.equal(result.subjectEntityId, row.subjectEntity.id);
    assert.equal(result.objectEntityId, row.objectEntity.id);
    assert.equal(result.predicate, 'partner_of');
    assert.equal(result.symmetric, true);
    assert.equal(result.temporalState, 'active');
    assert.equal(result.evidence.status, 'present_unverified');
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
    assert.equal(Object.hasOwn(result, 'object'), false);
    assert.deepEqual(row, before);
});

test('relation direction is preserved; symmetric reverse matching is explicit and no transitive path is inferred', () => {
    const ab = relation(2);
    const bc = relation(3, { subject: person(2), object: person(3) });
    const fromA = query([ab, bc], person(1).id);
    assert.equal(fromA.relations.length, 1);
    assert.equal(fromA.relations[0].matchDirection, 'outgoing');
    const fromB = query([ab, bc], person(2).id);
    assert.deepEqual(fromB.relations.map(item => item.matchDirection), ['symmetric_reverse', 'outgoing']);
    assert.equal(query([ab, bc], person(1).id, person(3).id).relations.length, 0);
    assert.equal(ab.assertion.subject.id, person(1).id);
    assert.equal(ab.assertion.object.id, person(2).id);
});

test('unsupported directed predicates fail closed until Schema v5 defines them explicitly', () => {
    const row = relation(4);
    row.assertion.predicate = 'person.parent_of';
    assert.throws(() => describeRelation(row));
});

test('direct, pairwise and predicate queries have deterministic results independent of input order', () => {
    const rows = [relation(5), relation(6, { subject: person(1), object: person(3) }),
        relation(7, { subject: person(2), object: person(3) })];
    const a = query(rows, person(1).id, null, 'partner_of');
    const b = query([...rows].reverse(), person(1).id, null, 'partner_of');
    assert.deepEqual(a, b);
    assert.deepEqual(a.relations.map(item => item.assertionId), [relationId(5), relationId(6)]);
    assert.equal(query(rows, person(1).id, person(2).id).relations.length, 1);
});

test('superseded relations are historical and future-valid relations are not active', () => {
    const historical = relation(8, { status: 'superseded', validFrom: null, validTo: null });
    const future = relation(9, { validFrom: { value: '2037', precision: 'year' } });
    const result = query([future, historical]);
    assert.deepEqual(result.relations.map(item => item.temporalState), ['historical', 'future']);
});

test('unknown validity and untrusted evidence remain explicitly uncertain', () => {
    const unknown = relation(10, { validFrom: null, validTo: null, kind: 'crm', derivation: 'inferred' });
    const result = describeRelation(unknown);
    assert.equal(result.temporalState, 'unknown');
    assert.ok(result.uncertaintyReasons.includes('relationship_truth_not_independently_verified'));
    assert.deepEqual(result.evidence.originTrust, ['external_untrusted']);
});

test('missing or mismatched evidence and unknown endpoints are rejected', () => {
    const noEvidence = relation(11);
    noEvidence.evidence = [];
    assert.throws(() => describeRelation(noEvidence));
    const mismatch = relation(12);
    mismatch.evidence[0].evidence.assertion_id = relationId(99);
    assert.throws(() => describeRelation(mismatch));
    const unknownEndpoint = relation(13);
    unknownEndpoint.objectEntity = person(4);
    assert.throws(() => describeRelation(unknownEndpoint));
});

test('duplicate assertions and duplicate links are reported without resolving them', () => {
    const first = relation(14);
    const second = relation(15);
    second.assertion.valid_from = { precision: 'day', value: '2030-01-01' };
    const result = query([first, second]);
    assert.deepEqual(result.issues, [{ kind: 'duplicate_relation', assertionIds: [relationId(14), relationId(15)] }]);
    assert.ok(result.relations.every(item => item.duplicate));
    assert.throws(() => query([first, first]), { message: 'memory_relationship_duplicate_assertion' });
});

test('a declared mixture of scopes is rejected and scope labels are not returned as authorization', () => {
    assert.throws(() => query([relation(16), relation(17, { scopeLabel: 'synthetic-shared-b' })]),
        { message: 'memory_relationship_scope_mismatch' });
    const result = query([relation(18)]);
    assert.equal(Object.hasOwn(result, 'scopeLabel'), false);
});

test('one query cannot mix temporal reference snapshots or report duplicates outside its selected subgraph', () => {
    const selected = relation(23);
    const unrelatedFirst = relation(24, { subject: person(4), object: person(5) });
    const unrelatedDuplicate = relation(25, { subject: person(4), object: person(5) });
    const result = query([selected, unrelatedFirst, unrelatedDuplicate], person(1).id);
    assert.deepEqual(result.relations.map(item => item.assertionId), [relationId(23)]);
    assert.deepEqual(result.issues, []);

    const differentSnapshot = relation(26);
    differentSnapshot.asOf = { value: '2037', precision: 'year' };
    assert.throws(() => query([selected, differentSnapshot]),
        { message: 'memory_relationship_reference_time_mismatch' });
    const sameSnapshotDifferentKeyOrder = relation(27);
    sameSnapshotDifferentKeyOrder.asOf = { precision: AS_OF.precision, value: AS_OF.value };
    assert.equal(query([selected, sameSnapshotDifferentKeyOrder]).relations.length, 2);
});

test('relationship direction or entity incompatibility is rejected rather than normalized', () => {
    const mismatch = relation(19);
    mismatch.assertion.subject.id = person(2).id;
    assert.throws(() => describeRelation(mismatch));
    const self = relation(20, { subject: person(1), object: person(1) });
    assert.throws(() => describeRelation(self));
    assert.throws(() => query([relation(21)], person(1).id, null, 'unknown_relation'));
});

test('execution requests always deny and return no relation data', () => {
    const result = query([relation(22)], person(1).id, null, null, 'execute');
    assert.equal(result.decision, 'DENY');
    assert.deepEqual(result.relations, []);
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
    assert.throws(() => queryRelations({ records: [], fromEntityId: person(1).id,
        toEntityId: null, predicate: null, mode: 'simulate', unexpected: true }));
    assert.throws(() => queryRelations({ records: [null], fromEntityId: person(1).id,
        toEntityId: null, predicate: null, mode: 'simulate' }));
});
