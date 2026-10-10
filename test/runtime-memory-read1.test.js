import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';
import { resolveMemoryBackend } from '../src/config.js';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { validateMemoryStore } from '../src/memory/schema.js';

const timestamp = '2026-10-10T12:00:00.000Z';
const ids = {
    store: 'store_00000000-0000-4000-8000-000000000001',
    person: 'person_00000000-0000-4000-8000-000000000001',
    assertion: 'mem_00000000-0000-4000-8000-000000000001',
    source: 'src_00000000-0000-4000-8000-000000000001',
    evidence: 'ev_00000000-0000-4000-8000-000000000001',
};

function fixtureStore({ withAssertion = true } = {}) {
    const store = {
        schema_version: 5,
        store_id: ids.store,
        self_person_id: ids.person,
        revision: withAssertion ? 1 : 0,
        created_at: timestamp,
        updated_at: timestamp,
        entities: [{ id: ids.person, type: 'person', created_at: timestamp }],
        assertions: withAssertion ? [{ id: ids.assertion, kind: 'fact', subject: { type: 'owner' },
            predicate: 'user.note', object: { type: 'text', value: 'Synthetic read-only fixture.' },
            status: 'active', valid_from: null, valid_to: null, recorded_at: timestamp,
            supersedes: [], compatibility: { category: 'user', key: 'read-only-fixture' } }] : [],
        sources: withAssertion ? [{ id: ids.source, kind: 'user_statement', origin_trust: 'user_asserted',
            authority: 'data_only', locator: null, occurred_at: null, recorded_at: timestamp }] : [],
        evidence: withAssertion ? [{ id: ids.evidence, assertion_id: ids.assertion, source_id: ids.source,
            derivation: 'explicit', extraction_confidence: 1, learned_at: timestamp,
            last_confirmed_at: null, legacy_ref: null }] : [],
        migrations: [],
        automatic_operations: [],
    };
    validateMemoryStore(store);
    return store;
}

function createRepository(store, { readError } = {}) {
    let reads = 0, commits = 0, closes = 0;
    const repository = {
        async open() {},
        async readSnapshot() {
            reads++;
            if (readError) throw readError;
            return { snapshot: structuredClone(store), revision: store.revision, digest: 'a'.repeat(64) };
        },
        async commit() { commits++; throw new Error('fixture commit must not be called'); },
        async close() { closes++; },
    };
    return { repository, counts: () => ({ reads, commits, closes }) };
}

function finalResponse(text = 'Fixture answer.') {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

async function makeAgent({ memoryBackend = 'memory2', repository, load, logger = () => {} } = {}) {
    const requests = [];
    const agent = await createAgent({
        memoryBackend,
        ...(repository ? { memory2Repository: repository } : {}),
        ask: async request => { requests.push(structuredClone(request)); return finalResponse(); },
        load: load ?? (async () => ({ user: {}, preferences: {}, facts: [] })),
        save: async () => {},
        getTools: () => [],
        logger,
    });
    return { agent, requests };
}

test('Memory1 stays the default and retains its existing prompt path', async () => {
    assert.equal(resolveMemoryBackend(undefined), 'memory1');
    const requests = [];
    const agent = await createAgent({
        memoryBackend: 'memory1',
        load: async () => ({ user: { name: 'Fixture user' }, preferences: {}, facts: ['Memory1 fixture'] }),
        save: async () => {}, getTools: () => [],
        ask: async request => { requests.push(structuredClone(request)); return finalResponse(); },
    });

    assert.equal(agent.memoryBackend, 'memory1');
    await agent.run('Hello.');
    assert.equal(requests.length, 1);
    assert.match(requests[0].instructions, /Memory1 fixture/u);
    assert.equal(requests[0].input.some(item => item?.name === 'memory_context_snapshot'), false);
    await agent.close();
});

test('isolated Memory2 context reaches the model and uses recent turns for continuity', async () => {
    const store = fixtureStore();
    const original = structuredClone(store);
    const { repository, counts } = createRepository(store);
    const { agent, requests } = await makeAgent({ repository });

    await agent.run('Yo recuerdo la ficha.');
    await agent.run('Algo relacionado con eso.');

    assert.equal(requests.length, 2);
    const contextCall = requests[1].input.find(item => item?.type === 'function_call'
        && item.name === 'memory_context_snapshot');
    const contextOutput = requests[1].input.find(item => item?.type === 'function_call_output'
        && item.call_id === contextCall?.call_id);
    assert.ok(contextCall);
    assert.deepEqual(JSON.parse(contextOutput.output).assertions.map(item => item.object.value),
        ['Synthetic read-only fixture.']);
    assert.ok(requests[1].input.some(item => item?.role === 'user' && item.content === 'Yo recuerdo la ficha.'));
    assert.ok(requests[1].input.some(item => item?.role === 'user' && item.content === 'Algo relacionado con eso.'));
    assert.deepEqual(counts(), { reads: 2, commits: 0, closes: 0 });
    assert.deepEqual(store, original);

    await agent.close();
    assert.equal(counts().closes, 0, 'the read-only facade does not close its caller-owned repository');
    await repository.close();
    assert.equal(counts().closes, 1);
});

test('Memory2 reads leave the isolated store file unchanged and invoke no mutator', async () => {
    const testRoot = await realpath(process.cwd());
    const fixtureDirectory = await mkdtemp(path.join(testRoot, '.runtime-memory-read1-'));
    assert.equal(path.dirname(fixtureDirectory), testRoot);
    const fixturePath = path.join(fixtureDirectory, 'fixture.json');
    const store = fixtureStore();
    const beforeBytes = Buffer.from(JSON.stringify(store, null, 2) + '\n');
    await writeFile(fixturePath, beforeBytes);

    const baseRepository = createJsonMemoryRepository({ storePath: fixturePath });
    let commits = 0, closes = 0;
    const repository = {
        open: (...args) => baseRepository.open(...args),
        readSnapshot: (...args) => baseRepository.readSnapshot(...args),
        commit: (...args) => { commits++; return baseRepository.commit(...args); },
        close: (...args) => { closes++; return baseRepository.close(...args); },
    };

    try {
        await repository.open();
        const { agent } = await makeAgent({ repository });
        await agent.run('Yo recuerdo la ficha.');
        const afterBytes = await readFile(fixturePath);
        assert.deepEqual(afterBytes, beforeBytes);
        await access(fixturePath);
        assert.equal(commits, 0);
        await agent.close();
        assert.equal(closes, 0, 'Runtime closes the facade, not the caller-owned repository');
        await repository.close();
        assert.equal(closes, 1);
        assert.deepEqual(await readFile(fixturePath), beforeBytes);
        await access(fixturePath);
    } finally {
        if (closes === 0) await repository.close();
        assert.equal(path.dirname(fixtureDirectory), testRoot, 'cleanup target must remain inside this checkout');
        await rm(fixtureDirectory, { recursive: true, force: true });
    }
});

test('empty Memory2 context continues the model request without synthetic context items', async () => {
    const { repository, counts } = createRepository(fixtureStore({ withAssertion: false }));
    const { agent, requests } = await makeAgent({ repository });

    assert.equal(await agent.run('Hola.'), 'Fixture answer.');
    assert.deepEqual(requests[0].input, [{ role: 'user', content: 'Hola.' }]);
    assert.deepEqual(counts(), { reads: 1, commits: 0, closes: 0 });
    await agent.close();
    await repository.close();
});

test('read failures remain sanitized and do not fall back to Memory1', async () => {
    let legacyLoads = 0;
    const privateError = new Error('secret content at C:\\private\\memory-v2.json');
    privateError.code = 'EPERM';
    const { repository, counts } = createRepository(fixtureStore(), { readError: privateError });
    const { agent, requests } = await makeAgent({ repository, load: async () => {
        legacyLoads++;
        return { user: {}, preferences: {}, facts: [] };
    } });

    await assert.rejects(agent.run('What do I remember?'), error => {
        assert.equal(error.name, 'Memory2ReadOnlyError');
        assert.equal(error.code, 'memory_read_failed');
        assert.equal(error.message, 'Memory 2 context could not be read.');
        assert.equal(error.stack, undefined);
        assert.equal(JSON.stringify(error).includes('private'), false);
        return true;
    });
    assert.equal(agent.memoryBackend, 'memory2');
    assert.equal(legacyLoads, 0);
    assert.equal(requests.length, 0);
    assert.deepEqual(counts(), { reads: 1, commits: 0, closes: 0 });
    await agent.close();
    await repository.close();
});

test('closing Runtime closes its facade but leaves the injected repository with its owner', async () => {
    const { repository, counts } = createRepository(fixtureStore());
    const { agent, requests } = await makeAgent({ repository });
    await agent.close();

    await assert.rejects(agent.run('A later turn.'), error => error.code === 'memory_facade_closed');
    assert.equal(requests.length, 0);
    assert.deepEqual(counts(), { reads: 0, commits: 0, closes: 0 });
    await repository.close();
    assert.equal(counts().closes, 1);
});

test('the normal CLI does not inject the experimental repository consumer', async () => {
    const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(source, /createCliAgent\(\)/u);
    assert.doesNotMatch(source, /memory2Repository|createMemory2ReadOnly/u);
    const composition = await readFile(new URL('../src/core/cli-agent.js', import.meta.url), 'utf8');
    assert.match(composition, /memoryMode = config\.cliMemoryMode/u);
    assert.match(composition, /automaticMemoryDetector: createAutomaticMemoryDetector\(\),\s*enableAutomaticMemoryAssessment: false/u);
    assert.equal(resolveMemoryBackend(undefined), 'memory1');
});
