import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryContextProvider } from '../src/memory/context-provider.js';
import { createMemoryRetriever } from '../src/memory/retrieval.js';
import { validateMemoryStore } from '../src/memory/schema.js';

const now = '2026-10-10T12:00:00.000Z';
const self = 'person_00000000-0000-4000-8000-000000000001';
const dana = 'person_00000000-0000-4000-8000-000000000002';
const daria = 'person_00000000-0000-4000-8000-000000000003';
const id = (prefix, n) => `${prefix}_${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;

function fixture({ includeNotes = false } = {}) {
    const store = { schema_version: 5, store_id: id('store', 2), self_person_id: self, revision: 1,
        created_at: now, updated_at: now,
        entities: [self, dana, daria].map(entityId => ({ id: entityId, type: 'person', created_at: now })),
        assertions: [], sources: [], evidence: [], migrations: [], automatic_operations: [] };
    let seq = 1;
    const ids = {};
    function add(key, { entityId = self, predicate, value, validFrom = null, validTo = null, status = 'active', confidence = 0.8 }) {
        const n = seq++, assertionId = id('mem', n), sourceId = id('src', n);
        store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: entityId },
            predicate, object: { type: 'text', value }, status, valid_from: validFrom, valid_to: validTo,
            recorded_at: now, supersedes: [], compatibility: null });
        store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: now });
        store.evidence.push({ id: id('ev', n), assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: confidence, learned_at: now, last_confirmed_at: null, legacy_ref: null });
        ids[key] = assertionId;
        return assertionId;
    }
    add('danaName', { entityId: dana, predicate: 'entity.preferred_name', value: 'Dana', confidence: 1 });
    add('dariaName', { entityId: daria, predicate: 'entity.preferred_name', value: 'Daria', confidence: 1 });
    add('choice', { predicate: 'user.plan_choice', value: 'Eligió Aurora para el equipo de demostración.' });
    add('subscriptionCost', { predicate: 'user.subscription_cost', value: 'La suscripción Aurora costaba 24 euros al mes.' });
    add('subscriptionStatus', { predicate: 'user.subscription_status', value: 'La suscripción Aurora continúa activa.', confidence: 1 });
    add('travelCost', { predicate: 'user.travel_cost', value: 'El viaje de invierno costó 780 euros.' });
    add('demoDate', { predicate: 'user.demo_date', value: 'La demostración de TypeScript fue el 18 de abril de 2025.',
        validFrom: { value: '2025-04-18', precision: 'day' } });
    add('danaDinnerCost', { predicate: 'user.dinner_cost', value: 'La cena de Dana costó 60 euros.', entityId: dana });
    add('hobby', { predicate: 'user.hobby', value: 'Practica guitarra acústica los fines de semana.' });
    if (includeNotes) {
        add('selfNote', { predicate: 'user.note', value: 'Nota sintética sobre el calendario del proyecto.',
            validFrom: { value: '2025', precision: 'year' } });
        add('danaNote', { entityId: dana, predicate: 'user.note', value: 'Nota sintética privada de Dana.' });
    }
    validateMemoryStore(store);
    const snapshot = { snapshot: store, revision: 1, digest: 'b'.repeat(64) };
    const repository = { readSnapshot: async () => snapshot };
    const provider = createMemoryContextProvider({ repository, now: () => now });
    return { store, ids, snapshot, provider };
}

async function resultFor(provider, input) {
    const result = await provider.read(input);
    const item = result.items.find(entry => entry.type === 'function_call_output');
    return item ? JSON.parse(item.output) : null;
}

function selectedIds(payload) {
    return payload ? [...payload.assertions.map(item => item.id), ...payload.relations.map(item => item.id)] : [];
}

function rankingMetrics(cases, outputs, k = 5) {
    let precision = 0, recall = 0, reciprocalRank = 0, contamination = 0, count = 0;
    for (const item of cases) {
        if (!item.expected.length) {
            if ((outputs.get(item.name) ?? []).length) contamination++;
            continue;
        }
        const top = (outputs.get(item.name) ?? []).slice(0, k);
        const expected = new Set(item.expected);
        const hits = top.map((value, index) => expected.has(value) ? index + 1 : 0).filter(Boolean);
        precision += hits.length / k;
        recall += hits.length / expected.size;
        reciprocalRank += hits.length ? 1 / hits[0] : 0;
        if (top.length && !expected.has(top[0])) contamination++;
        count++;
    }
    return { precisionAt5: count ? precision / count : 0, recallAt5: count ? recall / count : 0,
        mrr: count ? reciprocalRank / count : 0, incorrectContextCases: contamination };
}

function quality1Baseline(data, cases) {
    // Reproduce QUALITY1's ranking over this fixture's bounded candidate set:
    // no conversational anaphora and exact token overlap only, followed by
    // the pre-existing category/temporal/confidence/stable-order signals.
    const retriever = createMemoryRetriever({ readSnapshot: async () => data.snapshot, now: () => now });
    const confidence = record => Math.max(-1, ...data.store.evidence.filter(entry => entry.assertion_id === record.id)
        .map(entry => entry.extraction_confidence));
    const lexical = (record, query) => {
        const words = text => new Set(text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
        const queryTokens = words(query), recordTokens = new Set([...words(record.predicate), ...words(record.object.value)]);
        return [...queryTokens].filter(token => recordTokens.has(token)).length;
    };
    const compare = (a, b, query) => lexical(b, query) - lexical(a, query)
        || confidence(b) - confidence(a) || (a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return Promise.all(cases.map(async item => {
        // The former provider declined these short anaphoric forms; this is
        // the observable baseline for the multturn cases in this benchmark.
        if (item.followUp) return [item.name, []];
        const candidates = await retriever.currentKnowledge({ entityIds: [], includeSelf: true,
            predicates: [...new Set(data.store.assertions.map(record => record.predicate))], relationPredicates: [],
            relevanceText: item.input.message, limits: { maxSeedEntities: 5, maxRelationDepth: 0, maxNeighborsPerEntity: 8,
                maxRelations: 0, maxAssertions: 20, maxPerEntityPredicate: 3 } });
        return [item.name, candidates.assertions.map(item => item.record).sort((a, b) => compare(a, b, item.input.message)).map(record => record.id)];
    }));
}

test('conversational retrieval resolves bounded lexical equivalents and user-turn follow-ups', async () => {
    const data = fixture();
    const cases = [
        { name: 'indirect-price', input: { message: '¿Qué precio tenía mi suscripción Aurora?' },
            expected: [data.ids.subscriptionCost], followUp: false, forbidden: [data.ids.travelCost, data.ids.hobby] },
        { name: 'indirect-choice', input: { message: '¿Cuál habíamos elegido yo?' },
            expected: [data.ids.choice], followUp: false, forbidden: [data.ids.travelCost, data.ids.hobby, data.ids.danaDinnerCost] },
        { name: 'follow-up-price', input: { message: '¿Y cuánto costaba?', recentUserMessages: ['¿Qué suscripción elegí yo?'] },
            expected: [data.ids.subscriptionCost], followUp: true, forbidden: [data.ids.travelCost, data.ids.demoDate, data.ids.hobby, data.ids.danaDinnerCost] },
        { name: 'follow-up-choice', input: { message: '¿Cuál habíamos elegido?', recentUserMessages: ['¿Qué plan elegí yo para el equipo?'] },
            expected: [data.ids.choice], followUp: true, forbidden: [data.ids.travelCost, data.ids.demoDate, data.ids.hobby, data.ids.danaDinnerCost] },
        { name: 'follow-up-date', input: { message: '¿Cuándo fue eso?', recentUserMessages: ['¿Cuándo fue mi demostración de TypeScript?'] },
            expected: [data.ids.demoDate], followUp: true, forbidden: [data.ids.travelCost, data.ids.subscriptionCost, data.ids.hobby, data.ids.danaDinnerCost] },
        { name: 'follow-up-dana', input: { message: '¿Y cuánto costó?', recentUserMessages: ['¿Cuánto costó la cena de Dana?'] },
            expected: [data.ids.danaDinnerCost], followUp: true, forbidden: [data.ids.travelCost, data.ids.demoDate, data.ids.hobby, data.ids.subscriptionCost] },
        { name: 'topic-change', input: { message: '¿Qué novedades hay en el trabajo?', recentUserMessages: ['¿Qué suscripción elegí yo?'] },
            expected: [], followUp: false },
        { name: 'broken-chain', input: { message: '¿Y cuánto costaba?', recentUserMessages: ['¿Qué suscripción elegí yo?', 'Cambiemos de tema: hablemos de otra cosa.'] },
            expected: [], followUp: true },
        { name: 'ambiguous-anchor', input: { message: '¿Y cuánto costaba?', recentUserMessages: ['¿Cuánto costó la cena de Dana y Daria?'] },
            expected: [], followUp: true },
        { name: 'unanchored-follow-up', input: { message: '¿Cuánto costaba la suscripción?' }, expected: [], followUp: true },
    ];
    const actualRows = new Map();
    for (const item of cases) {
        const output = await resultFor(data.provider, item.input);
        const ids = selectedIds(output);
        actualRows.set(item.name, ids);
        assert.equal(ids.some(id => item.forbidden?.includes(id)), false,
            `${item.name} must not include unrelated-topic records; selected=${ids.join(',')}`);
        if (item.expected.length) {
            assert.ok(ids.includes(item.expected[0]), `${item.name} should retrieve its independently labeled fact`);
            assert.equal(output.authority, 'data_only');
        } else assert.deepEqual(ids, [], `${item.name} must not leak context from an earlier topic`);
    }
    const baselineRows = new Map(await quality1Baseline(data, cases));
    const baseline = rankingMetrics(cases, baselineRows);
    const after = rankingMetrics(cases, actualRows);
    console.log('MEMORY_CONTEXT_QUALITY_METRICS', JSON.stringify({ baseline, after }));
    assert.ok(after.recallAt5 > baseline.recallAt5);
    assert.ok(after.mrr > baseline.mrr);
    assert.ok(after.incorrectContextCases < baseline.incorrectContextCases);
});

test('lexical equivalents do not override direct identity, temporal filters, or Memory2 trust labels', async () => {
    const data = fixture();
    const price = await resultFor(data.provider, { message: '¿Cuánto costaba mi suscripción?' });
    assert.equal(price.authority, 'data_only');
    assert.equal(price.trust.authority, 'data_only');
    assert.ok(price.assertions.some(item => item.id === data.ids.subscriptionCost));
    assert.equal(price.assertions.some(item => item.id === data.ids.danaDinnerCost), false);

    const historical = await resultFor(data.provider, { message: '¿Dónde fue mi demostración en 2025?' });
    assert.ok(historical);
    assert.equal(historical.temporal.mode, 'valid_at');
    assert.ok(historical.assertions.every(item => item.temporalStatus === 'valid' || item.temporalStatus === 'indeterminate'));
});

test('nota and note equivalence supports precise direct and conversational retrieval', async () => {
    const data = fixture({ includeNotes: true });
    const directInput = { message: '¿Qué contiene mi nota?' };
    const direct = await resultFor(data.provider, directInput);
    const directIds = selectedIds(direct);
    assert.deepEqual(directIds, [data.ids.selfNote]);
    assert.equal(direct.authority, 'data_only');
    assert.equal(direct.trust.authority, 'data_only');
    assert.deepEqual(selectedIds(await resultFor(data.provider, directInput)), directIds,
        'the same query must produce stable results');

    const followUp = await resultFor(data.provider, {
        message: '¿Cuál era?', recentUserMessages: ['¿Qué contiene mi nota?'],
    });
    assert.deepEqual(selectedIds(followUp), [data.ids.selfNote]);
    assert.equal(followUp.authority, 'data_only');

    const changedTopic = await resultFor(data.provider, {
        message: '¿Cuánto costaba el viaje de invierno?', recentUserMessages: ['¿Qué contiene mi nota?'],
    });
    assert.ok(selectedIds(changedTopic).includes(data.ids.travelCost));
    assert.equal(selectedIds(changedTopic).includes(data.ids.selfNote), false,
        'a direct query on a competing topic must not retain the prior note');

    const historical = await resultFor(data.provider, {
        message: '¿Qué contenía mi nota en 2024?',
    });
    assert.equal(historical.temporal.mode, 'valid_at');
    assert.equal(selectedIds(historical).includes(data.ids.selfNote), false,
        'the note is not valid in the requested historical period');
});
