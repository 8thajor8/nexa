import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../src/config.js';
import { openExistingMemory2Reader } from '../src/memory/read-existing.js';
import { contentDigest } from '../src/memory/repository.js';

const stamp = '2026-10-10T12:00:00.000Z';
const ids = {
    store: 'store_00000000-0000-4000-8000-000000000001',
    person: 'person_00000000-0000-4000-8000-000000000001',
    assertion: 'mem_00000000-0000-4000-8000-000000000001',
    source: 'src_00000000-0000-4000-8000-000000000001',
    evidence: 'ev_00000000-0000-4000-8000-000000000001',
};

function store({ withAssertion = true } = {}) {
    return {
        schema_version: 5, store_id: ids.store, self_person_id: ids.person,
        revision: withAssertion ? 1 : 0, created_at: stamp, updated_at: stamp,
        entities: [{ id: ids.person, type: 'person', created_at: stamp }],
        assertions: withAssertion ? [{ id: ids.assertion, kind: 'fact', subject: { type: 'owner' },
            predicate: 'user.note', object: { type: 'text', value: 'Synthetic reader fixture.' }, status: 'active',
            valid_from: null, valid_to: null, recorded_at: stamp, supersedes: [],
            compatibility: { category: 'user', key: 'read-existing' } }] : [],
        sources: withAssertion ? [{ id: ids.source, kind: 'user_statement', origin_trust: 'user_asserted',
            authority: 'data_only', locator: null, occurred_at: null, recorded_at: stamp }] : [],
        evidence: withAssertion ? [{ id: ids.evidence, assertion_id: ids.assertion, source_id: ids.source,
            derivation: 'explicit', extraction_confidence: 1, learned_at: stamp,
            last_confirmed_at: null, legacy_ref: null }] : [],
        migrations: [], automatic_operations: [],
    };
}

async function withFixture(contents, callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-read-existing-'));
    const storePath = path.join(directory, 'memory-v2.json');
    if (contents !== null) await writeFile(storePath, contents);
    try { await callback({ directory, storePath }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

test('opens an existing v5 store and returns the context-provider structure without changing bytes or creating auxiliaries', async () => {
    const bytes = Buffer.from(JSON.stringify(store(), null, 2) + '\n');
    await withFixture(bytes, async ({ directory, storePath }) => {
        const reader = await openExistingMemory2Reader({ storePath });
        assert.deepEqual(Object.getOwnPropertyNames(reader).sort(), ['close', 'readContext']);
        assert.equal(Object.getPrototypeOf(reader), null);
        const result = await reader.readContext({ message: 'What do I remember?' });
        assert.deepEqual(Object.keys(result), ['revision', 'digest', 'generation', 'items']);
        assert.equal(result.revision, 1);
        assert.match(result.digest, /^[a-f0-9]{64}$/u);
        assert.equal(result.generation, 0);
        assert.equal(result.items[0].type, 'function_call');
        assert.equal(JSON.parse(result.items[1].output).assertions[0].object.value, 'Synthetic reader fixture.');
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
        assert.deepEqual(await readFile(storePath), bytes);
        await reader.close();
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
    });
});

test('reads a valid empty v5 store', async () => {
    await withFixture(JSON.stringify(store({ withAssertion: false })), async ({ storePath }) => {
        const bytes = Buffer.from(JSON.stringify(store({ withAssertion: false })));
        const reader = await openExistingMemory2Reader({ storePath });
        assert.deepEqual(await reader.readContext(), {
            revision: 0,
            digest: contentDigest(bytes),
            generation: 0,
            items: [],
        });
        await reader.close();
    });
});

test('rejects relative, missing, corrupt and incompatible stores without creating files', async () => {
    await assert.rejects(openExistingMemory2Reader({ storePath: 'relative.json' }), { code: 'memory_store_path_invalid' });
    await withFixture(null, async ({ storePath, directory }) => {
        await assert.rejects(openExistingMemory2Reader({ storePath }), { code: 'memory_store_missing' });
        assert.deepEqual(await readdir(directory), []);
    });
    await withFixture('{malformed', async ({ storePath, directory }) => {
        await assert.rejects(openExistingMemory2Reader({ storePath }), { code: 'memory_store_invalid' });
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
    });
    const { automatic_operations, ...v4Store } = store();
    await withFixture(JSON.stringify({ ...v4Store, schema_version: 4 }), async ({ storePath, directory }) => {
        await assert.rejects(openExistingMemory2Reader({ storePath }), { code: 'memory_schema_unsupported' });
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
    });
});

test('detects content changes during an open reader session and fails closed thereafter', async () => {
    await withFixture(JSON.stringify(store()), async ({ storePath }) => {
        const reader = await openExistingMemory2Reader({ storePath });
        await writeFile(storePath, JSON.stringify(store({ withAssertion: false })));
        await assert.rejects(reader.readContext({ message: 'What do I remember?' }), { code: 'memory_store_changed' });
        await assert.rejects(reader.readContext(), { code: 'memory_store_changed' });
        await reader.close();
    });
});

test('closed readers reject new reads and close idempotently', async () => {
    await withFixture(JSON.stringify(store()), async ({ storePath }) => {
        const reader = await openExistingMemory2Reader({ storePath });
        await reader.close();
        await reader.close();
        await assert.rejects(reader.readContext(), { code: 'memory_reader_closed' });
    });
});

test('rejects directories as stores without creating auxiliary files', async () => {
    await withFixture(null, async ({ directory }) => {
        await assert.rejects(openExistingMemory2Reader({ storePath: directory }), { code: 'memory_store_invalid' });
        assert.deepEqual(await readdir(directory), []);
    });
});

test('public errors omit filesystem paths, content, causes and stack traces', async () => {
    await withFixture('{secret fixture content', async ({ storePath }) => {
        await assert.rejects(openExistingMemory2Reader({ storePath }), error => {
            assert.equal(error.name, 'Memory2ExistingReaderError');
            assert.equal(error.code, 'memory_store_invalid');
            assert.equal(error.stack, undefined);
            assert.equal(Object.hasOwn(error, 'cause'), false);
            assert.equal(JSON.stringify(error).includes(storePath), false);
            assert.equal(JSON.stringify(error).includes('secret'), false);
            return true;
        });
    });
});

test('Memory1 remains the configured default and this API does not select a backend', () => {
    assert.equal(process.env.NEXA_MEMORY_BACKEND, undefined);
    assert.equal(config.memoryBackend, 'memory1');
});
