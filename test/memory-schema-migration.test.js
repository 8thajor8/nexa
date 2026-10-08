import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { validateMemoryStore } from '../src/memory/schema.js';
import { migrateMemoryStoreV4ToV5, planMemorySchemaV4ToV5 } from '../src/memory/schema-migration.js';

const time = '2030-04-10T09:00:00.000Z';
const later = '2030-04-10T09:01:00.000Z';
const id = (prefix, n = 1) => `${prefix}_${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
function v4Store() {
    const firstId = id('mem'); const secondId = id('mem', 2);
    return { schema_version: 4, store_id: id('store'), self_person_id: id('person'), revision: 7, created_at: time, updated_at: time,
        entities: [{ id: id('person'), type: 'person', created_at: '2000-01-01T00:00:00.000Z' }],
        assertions: [
            { id: firstId, kind: 'fact', subject: { type: 'unspecified' }, predicate: 'legacy.fact', object: { type: 'text', value: 'Fictional preserved value.' },
                status: 'superseded', valid_from: { value: '2028', precision: 'year' }, valid_to: null, recorded_at: time, supersedes: [], compatibility: { category: 'fact', key: 'synthetic' } },
            { id: secondId, kind: 'fact', subject: { type: 'unspecified' }, predicate: 'legacy.fact', object: { type: 'text', value: 'Fictional updated value.' },
                status: 'active', valid_from: { value: '2029', precision: 'year' }, valid_to: null, recorded_at: later, supersedes: [firstId], compatibility: { category: 'fact', key: 'synthetic' } },
        ],
        sources: [{ id: id('src'), kind: 'legacy_memory_1', origin_trust: 'unknown', authority: 'data_only', locator: null,
            occurred_at: null, recorded_at: time }],
        evidence: [
            { id: id('ev'), assertion_id: firstId, source_id: id('src'), derivation: 'unknown', extraction_confidence: null,
                learned_at: null, last_confirmed_at: null, legacy_ref: { category: 'facts', key: 'synthetic', index: 0 } },
            { id: id('ev', 2), assertion_id: secondId, source_id: id('src'), derivation: 'explicit', extraction_confidence: 0.7,
                learned_at: later, last_confirmed_at: later, legacy_ref: null },
        ],
        migrations: [{ source_sha256: 'a'.repeat(64), conversion_version: 1, applied_at: time, source_entry_count: 2, created_assertion_count: 2 }],
    };
}
async function setup(t, data = v4Store(), fileSystem = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-schema-v5-'));
    const storePath = path.join(directory, 'fixture.json');
    const repos = [];
    t.after(async () => { for (const repo of repos) await repo.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
    await fs.writeFile(storePath, JSON.stringify(data, null, 2) + '\n');
    return { directory, storePath, create() { const repo = createJsonMemoryRepository({ storePath }); repos.push(repo); return repo; }, fileSystem };
}

test('pure v4→v5 plan preserves every v4 collection and increments revision once', () => {
    const source = v4Store(); const result = planMemorySchemaV4ToV5({ store: source, now: () => later });
    assert.equal(result.success, true);
    const migrated = result.candidate;
    assert.equal(migrated.schema_version, 5); assert.equal(migrated.revision, source.revision + 1);
    assert.equal(migrated.updated_at, later); assert.deepEqual(migrated.automatic_operations, []);
    for (const key of ['store_id', 'self_person_id', 'created_at', 'entities', 'assertions', 'sources', 'evidence', 'migrations']) {
        assert.deepEqual(migrated[key], source[key]);
    }
    assert.equal(source.schema_version, 4); validateMemoryStore(migrated);
});

test('explicit file migration creates an exact backup and repeat is idempotent', async t => {
    const f = await setup(t); const originalBytes = await fs.readFile(f.storePath);
    const first = await migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later });
    assert.equal(first.outcome, 'migrated'); assert.equal(first.revision, 8);
    assert.deepEqual(await fs.readFile(first.backupPath), originalBytes);
    const migratedBytes = await fs.readFile(f.storePath); const migrated = JSON.parse(migratedBytes);
    validateMemoryStore(migrated); assert.equal(migrated.schema_version, 5); assert.deepEqual(migrated.automatic_operations, []);
    const second = await migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => '2031-01-01T00:00:00.000Z' });
    assert.equal(second.outcome, 'already_v5'); assert.equal(second.revision, 8);
    assert.deepEqual(await fs.readFile(f.storePath), migratedBytes);
});

test('v4 repositories remain readable and writable without implicit migration', async t => {
    const f = await setup(t); const repo = f.create();
    const opened = await repo.open(); assert.equal(opened.snapshot.schema_version, 4);
    await repo.close(); assert.equal(JSON.parse(await fs.readFile(f.storePath, 'utf8')).schema_version, 4);
});

test('corrupt source and existing backup fail closed without changing source bytes', async t => {
    const f = await setup(t); const before = await fs.readFile(f.storePath);
    await fs.writeFile(f.storePath, '{broken');
    const corrupt = await fs.readFile(f.storePath);
    await assert.rejects(migrateMemoryStoreV4ToV5({ storePath: f.storePath }), { code: 'memory_schema_migration_corrupt' });
    assert.deepEqual(await fs.readFile(f.storePath), corrupt);
    await fs.writeFile(f.storePath, before);
    await fs.writeFile(f.storePath + '.v4.bak', 'existing backup');
    await assert.rejects(migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later }), { code: 'memory_schema_migration_backup_exists' });
    assert.deepEqual(await fs.readFile(f.storePath), before);
});

test('simulated rename failure keeps v4 source unchanged and leaves recovery backup', async t => {
    const f = await setup(t); const before = await fs.readFile(f.storePath);
    await assert.rejects(migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later,
        fileSystem: { rename: async () => { throw Object.assign(new Error('synthetic failure'), { code: 'EIO' }); } } }),
    { code: 'memory_schema_migration_failed' });
    assert.deepEqual(await fs.readFile(f.storePath), before);
    assert.deepEqual(await fs.readFile(f.storePath + '.v4.bak'), before);
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('backup write and sync failures clean only their owned partial and permit retry', async t => {
    for (const phase of ['backup-write', 'backup-sync']) {
        const f = await setup(t); const before = await fs.readFile(f.storePath);
        const fileSystem = { open: async (target, flags, mode) => {
            const handle = await fs.open(target, flags, mode);
            if (String(target).includes('.v4.bak.') && String(target).endsWith('.tmp')) {
                return { writeFile: phase === 'backup-write' ? async () => { throw Object.assign(new Error('synthetic backup failure'), { code: 'EIO' }); } : handle.writeFile.bind(handle),
                    sync: phase === 'backup-sync' ? async () => { throw Object.assign(new Error('synthetic backup sync failure'), { code: 'EIO' }); } : handle.sync.bind(handle),
                    close: handle.close.bind(handle), stat: handle.stat.bind(handle) };
            }
            if (String(target).endsWith('.tmp')) {
                return { writeFile: handle.writeFile.bind(handle),
                    sync: async () => { throw Object.assign(new Error('synthetic temp sync failure'), { code: 'EIO' }); },
                    close: handle.close.bind(handle), stat: handle.stat.bind(handle) };
            }
            return handle;
        } };
        await assert.rejects(migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later, fileSystem }), error => {
            assert.equal(error.code, 'memory_schema_migration_failed', JSON.stringify({ cleanupCode: error.cleanupCause?.code,
                cleanupMessage: error.cleanupCause?.message, residuePath: error.residuePath, causeCode: error.cause?.code }));
            return true;
        });
        assert.deepEqual(await fs.readFile(f.storePath), before);
        assert.equal(await fs.stat(f.storePath + '.v4.bak').then(() => true, () => false), false);
        assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.includes('.v4.bak.')), []);
        const retry = await migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later });
        assert.equal(retry.outcome, 'migrated');
        assert.deepEqual(await fs.readFile(retry.backupPath), before);
    }
});

test('preexisting backup is never replaced or removed', async t => {
    const f = await setup(t); const before = await fs.readFile(f.storePath);
    const backup = Buffer.from('preexisting recovery material');
    await fs.writeFile(f.storePath + '.v4.bak', backup);
    await assert.rejects(migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later }),
        { code: 'memory_schema_migration_backup_exists' });
    assert.deepEqual(await fs.readFile(f.storePath), before);
    assert.deepEqual(await fs.readFile(f.storePath + '.v4.bak'), backup);
});

test('cleanup failure reports the original failure and owned residue for intervention', async t => {
    const f = await setup(t); const before = await fs.readFile(f.storePath);
    const fileSystem = {
        open: async (target, flags, mode) => {
            const handle = await fs.open(target, flags, mode);
            if (!String(target).includes('.v4.bak.') || !String(target).endsWith('.tmp')) return handle;
            return { writeFile: async () => { throw Object.assign(new Error('synthetic original write failure'), { code: 'EIO' }); },
                sync: handle.sync.bind(handle), close: handle.close.bind(handle), stat: handle.stat.bind(handle) };
        },
        unlink: async target => {
            if (String(target).includes('.v4.bak.') && String(target).endsWith('.tmp')) {
                throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
            }
            return fs.unlink(target);
        },
    };
    await assert.rejects(migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later, fileSystem }), error => {
        assert.equal(error.code, 'memory_schema_migration_backup_cleanup_failed');
        assert.equal(error.cause?.code, 'EIO');
        assert.match(error.message, /manual recovery/i);
        assert.ok(error.residuePath);
        return true;
    });
    assert.deepEqual(await fs.readFile(f.storePath), before);
    assert.equal(await fs.stat(f.storePath + '.v4.bak').then(() => true, () => false), false);
    assert.equal((await fs.readdir(f.directory)).some(name => name.includes('.v4.bak.') && name.endsWith('.tmp')), true);
});

test('a verified backup is retained when a later migration stage fails', async t => {
    const f = await setup(t); const before = await fs.readFile(f.storePath);
    await assert.rejects(migrateMemoryStoreV4ToV5({ storePath: f.storePath, now: () => later,
        fileSystem: { sync: async handle => {
            // The filesystem API is injected at the handle layer, so fail only
            // the candidate temporary after the backup has been published.
            return handle.sync();
        }, open: async (target, flags, mode) => {
            const handle = await fs.open(target, flags, mode);
            if (String(target).endsWith('.tmp') && !String(target).includes('.v4.bak.')) {
                return { writeFile: handle.writeFile.bind(handle), sync: async () => { throw Object.assign(new Error('synthetic candidate sync failure'), { code: 'EIO' }); },
                    close: handle.close.bind(handle), stat: handle.stat.bind(handle) };
            }
            return handle;
        } } }), { code: 'memory_schema_migration_failed' });
    assert.deepEqual(await fs.readFile(f.storePath), before);
    assert.deepEqual(await fs.readFile(f.storePath + '.v4.bak'), before);
});

test('v5 is never auto-created by opening an existing v4 store', async t => {
    const f = await setup(t); const before = await fs.readFile(f.storePath);
    const repo = f.create(); await repo.open(); await repo.close();
    assert.deepEqual(await fs.readFile(f.storePath), before);
});
