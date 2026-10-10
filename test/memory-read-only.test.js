import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemoryStore } from '../src/memory/schema.js';
import { createMemory2ReadOnly } from '../src/memory/read-only.js';

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

function injectedRepository(store, { readError } = {}) {
    let reads = 0, commits = 0, closes = 0;
    const repository = {
        async readSnapshot() {
            reads++;
            if (readError) throw readError;
            return { snapshot: structuredClone(store), revision: store.revision, digest: 'a'.repeat(64) };
        },
        async commit() { commits++; throw new Error('write must not be called'); },
        async close() { closes++; },
    };
    return { repository, counts: () => ({ reads, commits, closes }) };
}

test('reads and returns the Context Provider structure and item types unchanged', async () => {
    const store = fixtureStore();
    const { repository, counts } = injectedRepository(store);
    const facade = createMemory2ReadOnly({ repository });
    const result = await facade.readContext({ message: 'What do I remember?' });

    assert.deepEqual(Object.keys(result), ['revision', 'digest', 'generation', 'items']);
    assert.equal(result.revision, 1);
    assert.equal(result.digest, 'a'.repeat(64));
    assert.equal(result.generation, 0);
    assert.deepEqual(result.items.map(item => item.type), ['function_call', 'function_call_output']);
    assert.equal(JSON.parse(result.items[1].output).assertions[0].object.value, 'Synthetic read-only fixture.');
    assert.deepEqual(counts(), { reads: 1, commits: 0, closes: 0 });
    assert.equal(store.revision, 1);
    assert.equal(store.assertions.length, 1);
});

test('empty context preserves metadata and returns an empty items array', async () => {
    const { repository } = injectedRepository(fixtureStore({ withAssertion: false }));
    const result = await createMemory2ReadOnly({ repository }).readContext();
    assert.deepEqual(result, { revision: 0, digest: 'a'.repeat(64), generation: 0, items: [] });
});

test('public facade exposes only readContext and close, without repository or mutation methods', () => {
    const { repository } = injectedRepository(fixtureStore());
    const facade = createMemory2ReadOnly({ repository });
    assert.deepEqual(Object.keys(facade).sort(), ['close', 'readContext']);
    assert.deepEqual(Object.getOwnPropertyNames(facade).sort(), ['close', 'readContext']);
    assert.equal(Object.getPrototypeOf(facade), null);
    for (const name of ['repository', 'commit', 'remember', 'forget', 'initialize', 'service', 'invalidate']) {
        assert.equal(name in facade, false);
    }
});

test('read failures are replaced with stable sanitized errors', async () => {
    const internal = new Error('secret content at C:\\private\\memory-v2.json');
    internal.code = 'EPERM';
    const { repository } = injectedRepository(fixtureStore(), { readError: internal });
    const facade = createMemory2ReadOnly({ repository });

    await assert.rejects(facade.readContext(), error => {
        assert.equal(error.name, 'Memory2ReadOnlyError');
        assert.equal(error.code, 'memory_read_failed');
        assert.equal(error.message, 'Memory 2 context could not be read.');
        assert.equal(error.stack, undefined);
        assert.equal(Object.hasOwn(error, 'cause'), false);
        assert.equal(JSON.stringify(error), JSON.stringify({ code: 'memory_read_failed', message: error.message }));
        assert.equal(JSON.stringify(error).includes('private'), false);
        return true;
    });
});

test('hostile read options are sanitized without exposing provider or system errors', async () => {
    const { repository } = injectedRepository(fixtureStore());
    const facade = createMemory2ReadOnly({ repository });
    const hostileOptions = Object.defineProperty({}, 'message', { enumerable: true, get() {
        throw new Error('private path and memory content');
    } });
    await assert.rejects(facade.readContext(hostileOptions), error => {
        assert.equal(error.code, 'memory_read_failed');
        assert.equal(error.message, 'Memory 2 context could not be read.');
        assert.equal(error.stack, undefined);
        return true;
    });
});

test('close is idempotent, never closes the injected repository, and rejects later reads safely', async () => {
    const { repository, counts } = injectedRepository(fixtureStore());
    const facade = createMemory2ReadOnly({ repository });
    await facade.close();
    await facade.close();
    assert.deepEqual(counts(), { reads: 0, commits: 0, closes: 0 });
    await assert.rejects(facade.readContext(), error => {
        assert.equal(error.code, 'memory_facade_closed');
        assert.equal(error.message, 'The Memory 2 read-only facade is closed.');
        assert.equal(error.stack, undefined);
        return true;
    });
    assert.deepEqual(counts(), { reads: 0, commits: 0, closes: 0 });
});
