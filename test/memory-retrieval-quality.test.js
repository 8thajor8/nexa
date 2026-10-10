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
    return createMemoryContextProvider({ repository: { readSnapshot: async () => current }, now: () => stamp, ...options });
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

test('retrieval-quality synthetic benchmark: direct topics, follow-up, history, mixed topics and ambiguous mention', async () => {
    const data = fixture();
    data.add({ predicate: 'user.note', value: 'Disfruta caminar por el parque los domingos.' });
    data.add({ predicate: 'user.preference', value: 'Prefiere café de filtro por la mañana.' });
    data.add({ predicate: 'user.technology', value: 'Está aprendiendo TypeScript y prefiere React para proyectos personales.', confidence: 0.15, relevance: true });
    data.add({ predicate: 'user.technology', value: 'Está aprendiendo TypeScript y prefiere React para proyectos personales.', confidence: 0.15, relevance: true });
    data.add({ predicate: 'user.note', value: 'Le gustan las novelas de misterio.' });
    data.add({ predicate: 'user.project', value: 'El proyecto sintético usa Rust y una API local.' });
    data.add({ predicate: 'user.hobby', value: 'Toca guitarra acústica desde hace años.' , relevance: true });
    const old = data.add({ predicate: 'user.employment', value: 'Trabajó en una biblioteca en 2021.',
        validFrom: { value: '2021', precision: 'year' }, validTo: { value: '2022', precision: 'year' }, status: 'superseded' });
    const history = data.add({ predicate: 'user.employment', value: 'Trabajaba en una biblioteca en 2021.',
        validFrom: { value: '2021', precision: 'year' }, validTo: { value: '2022', precision: 'year' }, relevance: true });
    const currentEmployment = data.add({ predicate: 'user.employment', value: 'Ahora trabaja en un estudio de diseño.',
        validFrom: { value: '2023', precision: 'year' }, supersedes: [old], relevance: true });
    data.add({ predicate: 'user.preference', value: 'No comparte datos de proyectos con terceros.' });
    data.add({ entityId: friend, predicate: 'user.project', value: 'El proyecto de Coti usa React Native.' });
    const relation = data.relate(self, friend);
    validateMemoryStore(data.store);
    const typeScript = [...data.relevant].find(([assertionId]) => data.store.assertions.find(item => item.id === assertionId).object.value.includes('TypeScript'))[0];
    const guitar = [...data.relevant].find(([assertionId]) => data.store.assertions.find(item => item.id === assertionId).object.value.includes('guitarra'))[0];
    const duplicateIds = [...data.relevant].filter(([assertionId]) => data.store.assertions.find(item => item.id === assertionId).object.value.includes('TypeScript')).map(([assertionId]) => assertionId);
    const provider = providerFor(data);
    const cases = [
        ['topic-programming', { message: 'What do I use for TypeScript and React?' }, [typeScript]],
        ['topic-hobby', { message: '¿Qué instrumento practico yo?' }, [guitar]],
        ['historical', { message: '¿Dónde trabajaba yo en 2021?' }, [history]],
        ['current', { message: '¿Dónde trabajo yo actualmente?' }, [currentEmployment]],
        ['mixed', { message: 'Compara mi aprendizaje de TypeScript con mi afición musical.' }, [typeScript, guitar]],
        ['follow-up', { message: 'Algo relacionado con eso.', recentUserMessages: ['¿Qué instrumento practico yo?'] }, [guitar]],
        ['relationship', { message: 'Who is my partner Juan?' }, [relation]],
        ['ambiguous', { message: '¿Qué proyectos tiene Juan?' }, []],
    ];
    const rows = new Map(), baselineRows = new Map(), outputs = new Map();
    for (const [name, input, expected] of cases) {
        const result = await payload(provider, input);
        const items = result?.assertions ?? [];
        const selected = [...items, ...(result?.relations ?? [])];
        rows.set(name, selected.map(item => item.id));
        outputs.set(name, result);
        const baselineItems = [...items];
        for (const record of data.store.assertions) {
            if (items.some(item => item.id === record.id)) continue;
            const duplicateOf = items.find(item => item.entityId === record.subject.id && item.predicate === record.predicate
                && JSON.stringify(item.object) === JSON.stringify(record.object) && item.status === record.status
                && JSON.stringify(item.validFrom) === JSON.stringify(record.valid_from)
                && JSON.stringify(item.validTo) === JSON.stringify(record.valid_to));
            if (duplicateOf) baselineItems.push({ ...structuredClone(duplicateOf), id: record.id });
        }
        baselineRows.set(name, legacyBaselineOrder([...baselineItems, ...(result?.relations ?? [])]).map(item => item.id));
        for (const item of selected) {
            rows.objects ??= new Map(); rows.statuses ??= new Map();
            rows.objects.set(item.id, item.predicate + '\0' + JSON.stringify(item.object ?? [item.subjectEntityId, item.objectEntityId]));
            rows.statuses.set(item.id, item.status);
        }
        if (name === 'historical') assert.ok(rows.get(name).includes(old));
        if (name === 'ambiguous') assert.deepEqual(rows.get(name), []);
        if (expected.length) assert.ok(rows.get(name).length, `${name} returned no context`);
    }
    baselineRows.objects = rows.objects; baselineRows.statuses = rows.statuses;
    for (const record of data.store.assertions) {
        baselineRows.objects.set(record.id, record.predicate + '\0' + JSON.stringify(record.object));
        baselineRows.statuses.set(record.id, record.status);
    }
    const baseline = metrics(baselineRows, cases.map(([name, , expected]) => [name, expected]));
    const result = metrics(rows, cases.map(([name, , expected]) => [name, expected]));
    console.log('RETRIEVAL_QUALITY_METRICS', JSON.stringify({ baseline, after: result }));
    assert.ok(result.precisionAt5 > baseline.precisionAt5);
    assert.ok(result.recallAt5 > baseline.recallAt5);
    assert.ok(result.mrr > baseline.mrr);
    assert.equal(result.duplicateGroupsAt5, 0, 'exact duplicate facts should not occupy multiple context slots');
    assert.equal(result.obsoleteAt5, 0, 'current/historical ranking must not leak replaced facts into current queries');
    assert.equal(duplicateIds.length, 2);
    const programming = outputs.get('topic-programming');
    assert.equal(programming.assertions.filter(item => item.predicate === 'user.technology').length, 1);
    assert.equal(programming.assertions.find(item => item.predicate === 'user.technology').evidence.items.length, 2);
});

test('lexical ranking stays deterministic when Schema v5 collection order changes', async () => {
    const data = fixture();
    data.add({ predicate: 'user.note', value: 'Disfruta caminar por el parque.' });
    data.add({ predicate: 'user.technology', value: 'Prefiere TypeScript y React.' });
    data.add({ predicate: 'user.hobby', value: 'Toca guitarra acústica.' });
    validateMemoryStore(data.store);
    const original = await payload(providerFor(data), { message: 'What do I use with React?' });
    const shuffled = { store: structuredClone(data.store) };
    shuffled.store.assertions.reverse(); shuffled.store.sources.reverse(); shuffled.store.evidence.reverse();
    const reordered = await payload(providerFor(shuffled), { message: 'What do I use with React?' });
    assert.deepEqual(reordered.assertions.map(item => item.id), original.assertions.map(item => item.id));
});
