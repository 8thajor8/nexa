import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryContextProvider } from '../src/memory/context-provider.js';
import { validateMemoryStore } from '../src/memory/schema.js';

const stamp = '2026-10-10T12:00:00.000Z';
const self = 'person_00000000-0000-4000-8000-000000000001';
const friend = 'person_00000000-0000-4000-8000-000000000002';
const other = 'person_00000000-0000-4000-8000-000000000003';
const id = (prefix, n) => `${prefix}_${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;

function fixture() {
    const store = { schema_version: 5, store_id: id('store', 1), self_person_id: self, revision: 1,
        created_at: stamp, updated_at: stamp,
        entities: [self, friend, other].map(entityId => ({ id: entityId, type: 'person', created_at: stamp })),
        assertions: [], sources: [], evidence: [], migrations: [], automatic_operations: [] };
    let seq = 1;
    const relevant = new Map();
    function add({ entityId = self, predicate, value, validFrom = null, validTo = null, status = 'active', confidence = 0.85,
        recordedAt = stamp, supersedes = [], relevance = false }) {
        const n = seq++, assertionId = id('mem', n), sourceId = id('src', n);
        store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: entityId },
            predicate, object: { type: 'text', value }, status, valid_from: validFrom, valid_to: validTo,
            recorded_at: recordedAt, supersedes, compatibility: null });
        store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: recordedAt });
        store.evidence.push({ id: id('ev', n), assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: confidence, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null });
        if (relevance) relevant.set(assertionId, { duplicateKey: predicate + '\0' + value });
        return assertionId;
    }
    function relate(a, b, predicate = 'partner_of') {
        const n = seq++, assertionId = id('mem', n), sourceId = id('src', n);
        const [subjectId, objectId] = [a, b].sort();
        store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: subjectId },
            predicate, object: { type: 'entity_reference', entity_type: 'person', id: objectId }, status: 'active',
            valid_from: null, valid_to: null, recorded_at: stamp, supersedes: [], compatibility: null });
        store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: stamp });
        store.evidence.push({ id: id('ev', n), assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: 0.9, learned_at: stamp, last_confirmed_at: null, legacy_ref: null });
        return assertionId;
    }
    function name(entityId, value) {
        const n = seq++, assertionId = id('mem', n), sourceId = id('src', n);
        store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: entityId },
            predicate: 'entity.preferred_name', object: { type: 'text', value }, status: 'active', valid_from: null, valid_to: null,
            recorded_at: stamp, supersedes: [], compatibility: null });
        store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: stamp });
        store.evidence.push({ id: id('ev', n), assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: 1, learned_at: stamp, last_confirmed_at: null, legacy_ref: null });
    }
    name(friend, 'Juan Pérez'); name(other, 'Juan García');
    return { store, relevant, add, relate };
}

function providerFor(data, options = {}) {
    const current = { snapshot: data.store, revision: 1, digest: 'a'.repeat(64) };
    const embeddings = options.embeddings ?? { model: 'synthetic-test-v1', async embedMany(texts) { return texts.map(() => [1, 0]); } };
    return createMemoryContextProvider({ repository: { readSnapshot: async () => current }, now: () => stamp,
        embeddings, authorizeSubject: () => true, authorizeRelationships: () => true, ...options });
}

async function payload(provider, input) {
    const result = await provider.read(input);
    const output = result.items.find(item => item.type === 'function_call_output');
    return output ? JSON.parse(output.output) : null;
}

function metrics(rows, expectedByQuery, k = 5) {
    const precisions = [], recalls = [], reciprocalRanks = [];
    let obsolete = 0, duplicateGroups = 0;
    for (const [name, expected] of expectedByQuery) {
        if (!expected.length) continue;
        const ids = rows.get(name) ?? [];
        const top = ids.slice(0, k);
        const expectedSet = new Set(expected);
        const ranks = top.map((id, index) => expectedSet.has(id) ? index + 1 : null).filter(Boolean);
        precisions.push(top.length ? ranks.length / top.length : 0);
        recalls.push(ranks.length / expectedSet.size);
        reciprocalRanks.push(ranks.length ? 1 / ranks[0] : 0);
        const objectKeys = top.map(id => rows.objects.get(id)).filter(Boolean);
        duplicateGroups += objectKeys.length - new Set(objectKeys).size;
        if (name !== 'historical') obsolete += top.filter(id => rows.statuses.get(id) === 'superseded').length;
    }
    const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return { precisionAt5: average(precisions), recallAt5: average(recalls), mrr: average(reciprocalRanks),
        obsoleteAt5: obsolete, duplicateGroupsAt5: duplicateGroups };
}

function legacyBaselineOrder(items) {
    const confidence = item => Math.max(-1, ...item.evidence.items.map(evidence => evidence.extractionConfidence ?? -1));
    const category = item => item.relevance === 'direct_entity_or_self' ? 0 : item.relevance === 'direct_relation' ? 1 : 2;
    return [...items].sort((a, b) => category(a) - category(b)
        || (a.temporalStatus === 'valid' ? 0 : 1) - (b.temporalStatus === 'valid' ? 0 : 1)
        || confidence(b) - confidence(a)
        || (a.entityId ?? a.subjectEntityId).localeCompare(b.entityId ?? b.subjectEntityId)
        || a.predicate.localeCompare(b.predicate)
        || (b.recordedAt ?? '').localeCompare(a.recordedAt ?? '')
        || a.id.localeCompare(b.id));
}

test('semantic owner search returns a bounded current candidate pool without lexical gating', async () => {
    const data = fixture();
    const note = data.add({ predicate: 'user.note', value: 'Disfruta caminar por el parque los domingos.' });
    const instrument = data.add({ predicate: 'user.hobby', value: 'Toca guitarra acústica desde hace años.' });
    data.add({ predicate: 'user.project', value: 'El proyecto sintético usa Rust y una API local.' });
    const old = data.add({ predicate: 'user.employment', value: 'Trabajó en una biblioteca en 2021.', status: 'superseded' });
    const provider = providerFor(data);
    const result = await provider.search({ query: '¿Qué actividad manual disfruto cuando paseo?' });
    const ids = new Set(result.assertions.map(item => item.id));
    assert.equal(result.status, 'found');
    assert.ok(ids.has(note), 'a paraphrase with no shared topic word remains available to semantic selection');
    assert.ok(ids.has(instrument));
    assert.equal(ids.has(old), false, 'only active candidates are exposed by the approved search contract');
    assert.ok(result.assertions.length <= 12);
    assert.ok(JSON.stringify(result).length <= 6000);
});

test('automatic context does not lexically activate owner memories; model-requested search remains semantic', async () => {
    const data = fixture();
    const note = data.add({ predicate: 'user.note', value: 'Synthetic only fixture value.' });
    data.add({ predicate: 'user.hobby', value: 'Practica escalada en interiores.' });
    const provider = providerFor(data);
    const broad = await payload(provider, { message: '¿Qué sabés de mí?' });
    assert.equal(broad, null, 'the local reader does not guess owner-memory relevance from words');
    const semantic = await provider.search({ query: '¿Qué actividad me entretiene cuando estoy al aire libre?' });
    assert.ok(semantic.assertions.some(item => item.id === note));
    assert.ok(semantic.assertions.some(item => item.object.value === 'Practica escalada en interiores.'));
});

test('semantic candidate ordering stays deterministic when Schema v5 collection order changes', async () => {
    const data = fixture();
    data.add({ predicate: 'user.note', value: 'Disfruta caminar por el parque.' });
    data.add({ predicate: 'user.technology', value: 'Prefiere TypeScript y React.' });
    data.add({ predicate: 'user.hobby', value: 'Toca guitarra acústica.' });
    validateMemoryStore(data.store);
    const original = await providerFor(data).search({ query: 'What do I use with React?' });
    const shuffled = { store: structuredClone(data.store) };
    shuffled.store.assertions.reverse(); shuffled.store.sources.reverse(); shuffled.store.evidence.reverse();
    const reordered = await providerFor(shuffled).search({ query: 'What do I use with React?' });
    assert.deepEqual(reordered.assertions.map(item => item.id), original.assertions.map(item => item.id));
});

test('history search exposes at most twelve screened active or superseded records', async () => {
    const data = fixture();
    for (let index = 0; index < 18; index++) {
        const year = 2020 + index;
        data.add({ predicate: 'user.note', value: `Synthetic historical fact ${index}.`,
            status: index % 2 === 0 ? 'superseded' : 'active',
            recordedAt: `${year}-01-01T00:00:00.000Z` });
    }
    const provider = providerFor(data);
    const current = await provider.search({ query: 'A paráfrasis sin palabras coincidentes', temporal: 'current' });
    const history = await provider.search({ query: 'Qué era cierto antes', temporal: 'history' });
    assert.ok(current.assertions.length <= 12);
    assert.ok(current.assertions.every(item => item.status === 'active'));
    assert.ok(history.assertions.length <= 12);
    assert.ok(history.assertions.some(item => item.status === 'superseded'
        && item.temporalStatus === 'historical'));
    assert.equal(history.candidateScope, 'active_and_superseded_non_sensitive');
});
