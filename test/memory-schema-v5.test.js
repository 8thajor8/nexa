import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMemoryStore, MemorySchemaError } from '../src/memory/schema.js';

const time = '2030-04-10T09:00:00.000Z';
const id = (prefix, n = 1) => `${prefix}_${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
function storeV5() {
    const assertion = { id: id('mem'), kind: 'fact', subject: { type: 'unspecified' }, predicate: 'fixture.fact',
        object: { type: 'text', value: 'Synthetic fixture only.' }, status: 'active', valid_from: null, valid_to: null,
        recorded_at: time, supersedes: [], compatibility: { category: 'fact', key: 'fixture' } };
    return { schema_version: 5, store_id: id('store'), self_person_id: id('person'), revision: 1, created_at: time, updated_at: time,
        entities: [{ id: id('person'), type: 'person', created_at: time }], assertions: [assertion],
        sources: [{ id: id('src'), kind: 'inference', origin_trust: 'derived_untrusted', authority: 'data_only', locator: null, occurred_at: null, recorded_at: time }],
        evidence: [{ id: id('ev'), assertion_id: assertion.id, source_id: id('src'), derivation: 'inferred', extraction_confidence: 0.5,
            learned_at: time, last_confirmed_at: null, legacy_ref: null }], migrations: [], automatic_operations: [] };
}
function receipt(overrides = {}) {
    return { operation_key: 'a'.repeat(64), operation_fingerprint_sha256: 'b'.repeat(64), operation_kind: 'ADD', status: 'applied',
        authorization_request_id: 'req_00000001-1111-4111-8111-111111111111', expected_revision: 0, expected_digest: 'c'.repeat(64),
        result_revision: 1, result_assertion_id: id('mem'), target_assertion_id: null, result_code: null, recorded_at: time, ...overrides };
}
function rejects(store) { assert.throws(() => validateMemoryStore(store), MemorySchemaError); }

test('Schema v5 accepts its exact collection and a valid applied receipt', () => {
    const store = storeV5(); store.automatic_operations.push(receipt());
    assert.equal(validateMemoryStore(store), store);
});

test('v5 operation receipts enforce states, exact fields, IDs, hashes and revision links', () => {
    const invalid = [
        receipt({ operation_key: 'not-a-hash' }),
        receipt({ operation_fingerprint_sha256: 'not-a-fingerprint' }),
        receipt({ operation_kind: 'DELETE' }),
        receipt({ status: 'unknown' }),
        receipt({ authorization_request_id: 'capability-reusable' }),
        receipt({ expected_revision: 1, result_revision: 1 }),
        receipt({ result_revision: 2 }),
        receipt({ result_assertion_id: null }),
        receipt({ target_assertion_id: id('mem') }),
        receipt({ authorization_capability: 'fake' }),
        receipt({ evidence_text: 'synthetic private text' }),
    ];
    for (const item of invalid) { const store = storeV5(); store.automatic_operations.push(item); rejects(store); }
    const store = storeV5(); store.automatic_operations.push(receipt({ result_revision: 2 })); rejects(store);
});

test('rejected terminal receipts carry no result assertion and only safe result codes', () => {
    const store = storeV5();
    store.automatic_operations.push(receipt({ status: 'rejected_terminal', result_assertion_id: null,
        result_code: 'policy_rejected' }));
    validateMemoryStore(store);
    for (const result_code of [null, 'private error: secret', 'anything']) {
        const invalidStore = storeV5();
        invalidStore.automatic_operations.push(receipt({ status: 'rejected_terminal', result_assertion_id: null, result_code }));
        rejects(invalidStore);
    }
});

test('operation keys and fingerprints are unique; replace receipt binds exact supersession target', () => {
    const duplicateKey = storeV5(); duplicateKey.automatic_operations.push(receipt(), receipt({ operation_fingerprint_sha256: 'd'.repeat(64) })); rejects(duplicateKey);
    const duplicateFingerprint = storeV5(); duplicateFingerprint.automatic_operations.push(receipt(), receipt({ operation_key: 'd'.repeat(64) })); rejects(duplicateFingerprint);
    const replace = storeV5();
    replace.automatic_operations.push(receipt({ operation_kind: 'REPLACE', target_assertion_id: id('mem', 77) }));
    rejects(replace);
    const validReplace = storeV5(); const previous = validReplace.assertions[0]; previous.status = 'superseded';
    const next = { ...structuredClone(previous), id: id('mem', 2), status: 'active', supersedes: [previous.id],
        object: { type: 'text', value: 'Synthetic replacement.' } };
    validReplace.assertions.push(next);
    validReplace.evidence.push({ ...structuredClone(validReplace.evidence[0]), id: id('ev', 2), assertion_id: next.id });
    validReplace.automatic_operations.push(receipt({ operation_key: 'd'.repeat(64), operation_fingerprint_sha256: 'e'.repeat(64),
        operation_kind: 'REPLACE', target_assertion_id: previous.id, result_assertion_id: next.id }));
    assert.equal(validateMemoryStore(validReplace), validReplace);
});
