import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveMemoryBackend } from '../src/config.js';
import { initializeEmptyMemoryStore, openMemoryBackend } from '../src/memory/backend.js';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';

async function withTemp(t, operation) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-memory-backend-'));
    t.after(async () => {
        const relative = path.relative(os.tmpdir(), directory);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(directory, { recursive: true, force: true });
    });
    await operation(directory);
}

test('backend configuration defaults to Memory 1 and accepts only explicit known selections', () => {
    assert.equal(resolveMemoryBackend(undefined), 'memory1');
    assert.equal(resolveMemoryBackend('memory1'), 'memory1');
    assert.equal(resolveMemoryBackend('memory2'), 'memory2');
    for (const value of ['', 'Memory2', 'memory3', true, {}, null]) {
        assert.throws(() => resolveMemoryBackend(value), /NEXA_MEMORY_BACKEND/);
    }
});

test('Memory 2 initializes only a missing temporary store, then opens and closes cleanly', async t => {
    await withTemp(t, async directory => {
        const storePath = path.join(directory, 'memory-v2.json');
        const first = await openMemoryBackend({ backend: 'memory2', storePath, now: () => '2026-01-02T03:04:05.000Z' });
        assert.equal(first.backend, 'memory2');
        assert.equal((await first.repository.readSnapshot()).snapshot.revision, 0);
        const context = await first.contextProvider.read();
        assert.deepEqual(context.items, []);
        await first.close();
        const original = await fs.readFile(storePath);
        const second = await initializeEmptyMemoryStore({ storePath, now: () => { throw new Error('must not rewrite'); } });
        assert.equal(second.created, false);
        assert.deepEqual(await fs.readFile(storePath), original);
        const reopened = createJsonMemoryRepository({ storePath });
        await reopened.open();
        assert.equal((await reopened.readSnapshot()).snapshot.revision, 0);
        await reopened.close();
    });
});

test('Memory 1 never initializes Memory 2', async t => {
    await withTemp(t, async directory => {
        const storePath = path.join(directory, 'memory-v2.json');
        let loads = 0;
        const backend = await openMemoryBackend({ backend: 'memory1', storePath,
            loadLegacy: async () => { loads++; return { user: { name: 'synthetic' }, preferences: {}, facts: [] }; } });
        assert.equal(backend.memory.user.name, 'synthetic');
        assert.equal(loads, 1);
        await backend.close();
        await assert.rejects(fs.access(storePath), { code: 'ENOENT' });
    });
});

test('existing corrupt or incompatible Memory 2 stores fail closed without fallback or mutation', async t => {
    await withTemp(t, async directory => {
        for (const [name, bytes, code] of [
            ['corrupt.json', Buffer.from('{bad'), 'memory_store_corrupt'],
            ['unsupported.json', Buffer.from(JSON.stringify({ schema_version: 99,
                store_id: 'store_00000000-0000-4000-8000-000000000000', revision: 0,
                created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-01-02T03:04:05.000Z',
                assertions: [], sources: [], evidence: [], migrations: [] })), 'memory_schema_unsupported'],
        ]) {
            const storePath = path.join(directory, name);
            await fs.writeFile(storePath, bytes);
            let legacyLoads = 0;
            await assert.rejects(openMemoryBackend({ backend: 'memory2', storePath,
                loadLegacy: async () => { legacyLoads++; return {}; } }), error => {
                assert.equal(error.name, 'MemoryBackendStartupError');
                assert.equal(error.code, code);
                assert.match(error.message, /No fallback/);
                return true;
            });
            assert.equal(legacyLoads, 0);
            assert.deepEqual(await fs.readFile(storePath), bytes);
            await assert.rejects(fs.access(storePath + '.lock'), { code: 'ENOENT' });
        }
    });
});

test('repository lock or read failure never selects Memory 1', async t => {
    await withTemp(t, async directory => {
        const storePath = path.join(directory, 'memory-v2.json');
        await initializeEmptyMemoryStore({ storePath });
        let legacyLoads = 0;
        await assert.rejects(openMemoryBackend({ backend: 'memory2', storePath,
            loadLegacy: async () => { legacyLoads++; return {}; },
            repositoryFactory: () => ({ open: async () => { const error = new Error('private detail'); error.code = 'memory_store_locked'; throw error; },
                close: async () => {} }) }), error => error.code === 'memory_store_locked' && !error.message.includes('private detail'));
        assert.equal(legacyLoads, 0);
    });
});
