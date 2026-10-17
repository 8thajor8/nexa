import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryContextProvider } from '../src/memory/context-provider.js';
import { createMemorySemanticIndex, MEMORY_EMBEDDING_MODEL } from '../src/memory/semantic-index.js';
import { createOpenAIEmbeddingProvider } from '../src/brain/openai.js';

const stamp = '2026-10-16T12:00:00.000Z';
const self = 'person_00000000-0000-4000-8000-000000000001';
const friend = 'person_00000000-0000-4000-8000-000000000002';
const storeId = 'store_00000000-0000-4000-8000-000000000001';
const makeId = (prefix, number) => `${prefix}_00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function fixture() {
    const store = { schema_version: 5, store_id: storeId, self_person_id: self, revision: 1,
        created_at: stamp, updated_at: stamp,
        entities: [self, friend].map(id => ({ id, type: 'person', created_at: stamp })),
        assertions: [], sources: [], evidence: [], migrations: [], automatic_operations: [] };
    let sequence = 1;
    function add({ subjectId = self, predicate = 'personal.fact', value, status = 'active', recordedAt = stamp }) {
        const number = sequence++;
        const assertion = { id: makeId('mem', number), kind: 'fact',
            subject: { type: 'entity', entity_type: 'person', id: subjectId }, predicate,
            object: { type: 'text', value }, status, valid_from: null, valid_to: null,
            recorded_at: recordedAt, supersedes: [], compatibility: null };
        const source = { id: makeId('src', number), kind: 'user_statement', origin_trust: 'user_asserted',
            authority: 'data_only', locator: null, occurred_at: null, recorded_at: recordedAt };
        const evidence = { id: makeId('ev', number), assertion_id: assertion.id, source_id: source.id,
            derivation: 'explicit', extraction_confidence: 1, learned_at: recordedAt,
            last_confirmed_at: null, legacy_ref: null };
        store.assertions.push(assertion); store.sources.push(source); store.evidence.push(evidence);
        return assertion;
    }
    function addName(value) { return add({ subjectId: friend, predicate: 'entity.preferred_name', value }); }
    const repository = { async readSnapshot() { return { snapshot: store, revision: store.revision,
        digest: String(store.revision).padStart(64, '0') }; } };
    return { store, repository, add, addName };
}

function semanticEmbeddings({ queryVector = [1, 0], relevantText = /relevant_old/u,
    irrelevantText = /recent_noise/u, onRequest = null } = {}) {
    return { model: 'synthetic-semantic-v1', async embedMany(texts) {
        onRequest?.(texts);
        return texts.map(text => {
            if (text.includes('What quiet pursuit do I return to?') || text.includes('query: adventure')) return queryVector;
            if (relevantText.test(text)) return [1, 0];
            if (irrelevantText.test(text)) return [0, 1];
            return [0.5, 0.5];
        });
    } };
}

async function withIndex(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory-semantic-'));
    const indexPath = path.join(directory, 'memory.semantic-index.json');
    try { await callback({ directory, indexPath }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

test('semantic search ranks the complete eligible set before applying the result limit', async () => {
    const data = fixture();
    const relevant = data.add({ predicate: 'general.unlisted_topic', value: 'The owner has a long-standing devotion to speleology.',
        recordedAt: '2018-01-01T00:00:00.000Z' });
    for (let index = 0; index < 24; index++) data.add({ value: `recent_noise_${index}: owns a ceramic desk ornament.`,
        recordedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` });
    let embedded = 0;
    const embeddings = { model: 'synthetic-semantic-v1', async embedMany(texts) {
        embedded += texts.length;
        return texts.map(text => text.includes('speleology') || text.includes('query: adventure') ? [1, 0] : [0, 1]);
    } };
    await withIndex(async ({ indexPath }) => {
        const provider = createMemoryContextProvider({ repository: data.repository, embeddings, indexPath,
            maxSearchResults: 1 });
        const result = await provider.search({ query: 'query: adventure' });
        assert.equal(result.status, 'found', JSON.stringify(result));
        assert.deepEqual(result.assertions.map(item => item.id), [relevant.id]);
        assert.equal(result.assertions[0].relevance, 1);
        assert.equal(embedded, 26, 'all 25 records and the query are represented before top-1 is selected');
        const sidecar = JSON.parse(await readFile(indexPath, 'utf8'));
        assert.equal(sidecar.entries.length, 25);
        assert.doesNotMatch(JSON.stringify(sidecar), /speleology|ceramic desk ornament/u,
            'the local index stores vectors and stable bindings, not duplicate record text');
        assert.equal((await data.repository.readSnapshot()).snapshot.assertions.length, 25,
            'search does not mutate the source Store');
    });
});

test('semantic search scopes vectors by subject and rechecks third-party permission', async () => {
    const data = fixture();
    const ownerFact = data.add({ value: 'Owner uses a brass astrolabe.' });
    data.addName('Synthetic person');
    const thirdPartyFact = data.add({ subjectId: friend, value: 'The named person studies marine geology.' });
    let allowed = false;
    let requests = 0;
    const embeddings = semanticEmbeddings({ relevantText: /marine geology/u, onRequest: () => { requests++; } });
    await withIndex(async ({ indexPath }) => {
        const provider = createMemoryContextProvider({ repository: data.repository, embeddings, indexPath,
            authorizeSubject: () => allowed });
        const args = { query: 'What field does this person study?', subjectReference: 'Synthetic person',
            subjectEvidence: ['Synthetic person is mentioned here.'] };
        assert.equal((await provider.search(args)).status, 'subject_not_authorized');
        assert.equal(requests, 0, 'unauthorized third-party text is not embedded');
        allowed = true;
        const result = await provider.search(args);
        assert.equal(result.status, 'found', JSON.stringify(result));
        assert.deepEqual(result.assertions.map(item => item.id), [thirdPartyFact.id]);
        assert.equal(result.assertions.some(item => item.id === ownerFact.id), false);
        allowed = false;
        assert.equal((await provider.search(args)).status, 'subject_not_authorized');
        const sidecar = JSON.parse(await readFile(indexPath, 'utf8'));
        assert.equal(sidecar.entries.some(item => item.subjectId === friend), false,
            'revoked subject vectors are removed from the derived index');
    });
});

test('trusted internal subject selection resolves only an existing authorized person', async () => {
    const data = fixture();
    const ownerFact = data.add({ value: 'The owner repairs antique telescopes.' });
    const friendFact = data.add({ subjectId: friend, predicate: 'general.profession',
        value: 'The named person designs public libraries.' });
    const provider = createMemoryContextProvider({ repository: data.repository,
        embeddings: semanticEmbeddings({ relevantText: /designs public libraries/u }), authorizeSubject: () => true });
    const result = await provider.search({ query: 'What does the named person do?', subjectId: friend });
    assert.equal(result.status, 'found');
    assert.deepEqual(result.assertions.map(item => item.id), [friendFact.id]);
    assert.equal(result.assertions[0].compatibility, null,
        'legacy assertions may be returned without organic compatibility metadata');
    assert.equal(result.assertions.some(item => item.id === ownerFact.id), false);
    assert.equal((await provider.search({ query: 'What is relevant?', subjectId: 'unknown-person' })).status,
        'subject_unresolved');
    assert.equal((await provider.search({ query: 'What is relevant?', subjectId: friend,
        subjectReference: 'Synthetic person', subjectEvidence: ['Synthetic person is mentioned here.'] })).status,
        'invalid_query');
});

test('current and historical searches select the requested temporal scope semantically', async () => {
    const data = fixture();
    const former = data.add({ value: 'Previously, the owner studied celestial navigation.', status: 'superseded',
        recordedAt: '2020-01-01T00:00:00.000Z' });
    const current = data.add({ value: 'The owner now practices botanical illustration.',
        recordedAt: '2026-10-01T00:00:00.000Z' });
    const embeddings = { model: 'synthetic-semantic-v1', async embedMany(texts) {
        return texts.map(text => text.includes('botanical illustration') ? [0, 1]
            : text.includes('celestial navigation') || text.includes('query: previous passion') ? [1, 0] : [0, 1]);
    } };
    const provider = createMemoryContextProvider({ repository: data.repository, embeddings });
    const currentResult = await provider.search({ query: 'query: previous passion', temporal: 'current' });
    assert.deepEqual(currentResult.assertions.map(item => item.id), [current.id]);
    const historyResult = await provider.search({ query: 'query: previous passion', temporal: 'history' });
    assert.ok(historyResult.assertions.some(item => item.id === former.id && item.temporalStatus === 'historical'));
});

test('an active contradiction outside the ranked result limit is still reported as insufficient', async () => {
    const data = fixture();
    const first = data.add({ predicate: 'personal.preference', value: 'The owner prefers a quiet workspace.' });
    const second = data.add({ predicate: 'personal.preference', value: 'The owner prefers a busy workspace.' });
    first.compatibility = { category: 'preference', key: 'workspace' };
    second.compatibility = { category: 'preference', key: 'workspace' };
    const embeddings = { model: 'synthetic-conflict-v1', async embedMany(texts) {
        return texts.map(text => text.includes('quiet workspace') || text.includes('query: workspace') ? [1, 0] : [0, 1]);
    } };
    const provider = createMemoryContextProvider({ repository: data.repository, embeddings, maxSearchResults: 1 });
    const result = await provider.search({ query: 'query: workspace' });
    assert.equal(result.status, 'insufficient');
    assert.deepEqual(result.conflicts, ['personal.preference']);
    assert.equal(result.assertions.length, 1, 'the result cap remains enforced');
});

test('record updates, deletion, sensitive screening, and index clearing stay fail-closed', async () => {
    const data = fixture();
    const record = data.add({ value: 'The owner practices ceramic printmaking.' });
    const seen = [];
    const embeddings = { model: 'synthetic-semantic-v1', async embedMany(texts) {
        seen.push(...texts);
        return texts.map(text => text.includes('printmaking') ? [1, 0] : [0, 1]);
    } };
    await withIndex(async ({ indexPath }) => {
        const provider = createMemoryContextProvider({ repository: data.repository, embeddings, indexPath });
        assert.equal((await provider.search({ query: 'What quiet pursuit do I return to?' })).assertions[0].id, record.id);
        record.object.value = 'The owner now studies botanical illustration.';
        data.store.revision++;
        const updated = await provider.search({ query: 'What quiet pursuit do I return to?' });
        assert.equal(updated.assertions[0].object.value, 'The owner now studies botanical illustration.');
        assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).entries.length, 1);
        data.store.assertions = [];
        data.store.revision++;
        await provider.invalidate();
        assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).entries.length, 0,
            'Store invalidation removes vectors for deleted records without calling embeddings');
        assert.equal((await provider.search({ query: 'What quiet pursuit do I return to?' })).status, 'empty');
        data.add({ value: 'My medication is stored in the kitchen cabinet.' });
        const requestCount = seen.length;
        assert.equal((await provider.search({ query: '¿Qué medicación tomo?' })).status, 'query_not_eligible');
        assert.equal(seen.length, requestCount, 'sensitive queries do not reach the embedding provider');
        assert.equal(seen.some(text => text.includes('medication')), false,
            'sensitive record content is screened before embedding');
        await provider.clearSemanticIndex();
        await assert.rejects(readFile(indexPath), { code: 'ENOENT' });
    });
});

test('embedding errors do not mutate Memory2 or return unranked candidates', async () => {
    const data = fixture();
    data.add({ value: 'The owner studies a rare form of printmaking.' });
    const embeddings = { model: 'synthetic-semantic-v1', async embedMany() { throw new Error('synthetic provider failure'); } };
    const before = structuredClone(data.store);
    const provider = createMemoryContextProvider({ repository: data.repository, embeddings });
    const result = await provider.search({ query: 'Which creative pursuit matters to me?' });
    assert.equal(result.status, 'semantic_index_incomplete');
    assert.deepEqual(data.store, before);
    assert.deepEqual(result.assertions, []);
});

test('OpenAI embedding adapter uses the configured embeddings endpoint and sorts by input index', async () => {
    const calls = [];
    const adapter = createOpenAIEmbeddingProvider({ model: MEMORY_EMBEDDING_MODEL, clientFactory: () => ({ embeddings: {
        async create(request) { calls.push(request); return { data: [
            { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
        ] }; },
    } }) });
    assert.deepEqual(await adapter.embedMany(['synthetic one', 'synthetic two']), [[1, 0], [0, 1]]);
    assert.deepEqual(calls, [{ model: MEMORY_EMBEDDING_MODEL, input: ['synthetic one', 'synthetic two'],
        encoding_format: 'float' }]);
});

test('semantic index ranks vectors by cosine similarity and applies its limit last', async () => {
    const vectors = new Map([['old', [1, 0]], ['noise-a', [0, 1]], ['noise-b', [0.2, 0.8]]]);
    const index = createMemorySemanticIndex({ storeId, embeddingProvider: { model: 'test',
        async embedMany(texts) { return texts.map(text => vectors.get(text)); } } });
    await index.synchronize([
        { assertionId: 'old', subjectId: self, status: 'active', fingerprint: '1', text: 'old' },
        { assertionId: 'noise-a', subjectId: self, status: 'active', fingerprint: '2', text: 'noise-a' },
        { assertionId: 'noise-b', subjectId: self, status: 'active', fingerprint: '3', text: 'noise-b' },
    ], { subjectId: self });
    assert.deepEqual(await index.rank([1, 0], { subjectId: self, limit: 1 }), [{ assertionId: 'old', score: 1 }]);
});
