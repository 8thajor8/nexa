import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { planMemory1Migration, applyMemory1Migration } from '../src/memory/migration.js';
import { validateMemoryStore } from '../src/memory/schema.js';

const now = '2032-06-12T10:30:00.000Z';
function emptyStore() { return { schema_version: 2, store_id: 'store_00000000-0000-4000-8000-000000000000', revision: 0,
    created_at: now, updated_at: now, assertions: [], sources: [], evidence: [], migrations: [] }; }
function legacy() { return { user: { nickname: 'Fictional Ada' }, preferences: { tea: 'Fictional Ada prefers mint tea.' },
    facts: [{ key: 'project', value: 'Fictional Ada studies paper maps.' }, { key: 'project', value: 'Fictional Ada collects atlases.' }],
    person: { companion: 'Fictional Bo is a colleague.' }, project: { codename: 'Fictional North Star' }, routine: { morning: 'Fictional Ada reads.' } }; }
async function setup(t, store = emptyStore()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-memory-migrate-'));
    const storePath = path.join(directory, 'memory-v2.json'); await fs.writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');
    const repository = createJsonMemoryRepository({ storePath, now: () => now }); await repository.open();
    t.after(async () => {
        await repository.close().catch(() => {});
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { directory, storePath, repository };
}

test('synthetic migration maps user, preference and facts with honest provenance and temporal unknowns', () => {
    const plan = planMemory1Migration({ legacy: legacy(), now: () => now });
    assert.equal(plan.assertions.length, 7); assert.equal(plan.sources.length, 1); assert.equal(plan.evidence.length, 7);
    assert.equal(plan.receipt.source_entry_count, 7); assert.equal(plan.receipt.created_assertion_count, 7);
    assert.equal(plan.sources[0].kind, 'legacy_memory_1'); assert.equal(plan.sources[0].origin_trust, 'unknown');
    assert.equal(plan.sources[0].authority, 'data_only'); assert.equal(plan.sources[0].occurred_at, null);
    assert.equal(plan.evidence.every(item => item.derivation === 'unknown' && item.learned_at === null && item.extraction_confidence === null), true);
    assert.equal(plan.assertions.find(item => item.compatibility.category === 'user').subject.type, 'owner');
    assert.equal(plan.assertions.find(item => item.compatibility.category === 'preference').subject.type, 'owner');
    assert.equal(plan.assertions.find(item => item.compatibility.category === 'fact').subject.type, 'unspecified');
    assert.deepEqual(plan.evidence.filter(item => item.legacy_ref.category === 'facts').map(item => item.legacy_ref.index), [0, 1]);
    assert.equal(plan.assertions.every(item => item.valid_from === null && item.valid_to === null), true);
    assert.equal(plan.trust.authority, 'data_only');
    const candidate = { ...emptyStore(), assertions: plan.assertions, sources: plan.sources, evidence: plan.evidence, migrations: [plan.receipt] };
    validateMemoryStore(candidate);
});
test('migration is deterministic across calls and canonical object key order', () => {
    const source = legacy(); const reordered = Object.fromEntries(Object.entries(source).reverse());
    const first = planMemory1Migration({ legacy: source, now: () => now });
    const second = planMemory1Migration({ legacy: source, now: () => now });
    const third = planMemory1Migration({ legacy: reordered, now: () => now });
    assert.equal(first.source_sha256, second.source_sha256); assert.equal(first.source_sha256, third.source_sha256);
    assert.deepEqual(first.assertions.map(item => item.id), second.assertions.map(item => item.id));
    assert.deepEqual(first.evidence.map(item => item.id), third.evidence.map(item => item.id));
});
test('preferences and preference aliases preserve each original source category', () => {
    const plan = planMemory1Migration({ legacy: { facts: [], preferences: { color: 'Fictional green' }, preference: { color: 'Fictional blue' } }, now: () => now });
    assert.equal(plan.assertions.length, 2);
    assert.deepEqual(plan.assertions.map(item => item.compatibility), [
        { category: 'preference', key: 'color' }, { category: 'preference', key: 'color' },
    ]);
    assert.deepEqual(plan.evidence.map(item => item.legacy_ref.category), ['preference', 'preferences']);
});
test('apply creates one atomic migration and a repeat is safely detected from its receipt', async t => {
    const f = await setup(t); const source = legacy();
    const migrated = await applyMemory1Migration({ legacy: source, repository: f.repository, now: () => now });
    assert.equal(migrated.success, true); assert.equal(migrated.outcome, 'migrated'); assert.equal(migrated.revision, 1);
    const snapshot = await f.repository.readSnapshot(); assert.equal(snapshot.snapshot.assertions.length, 7);
    assert.equal(snapshot.snapshot.migrations.length, 1); assert.deepEqual(snapshot.snapshot.migrations[0], migrated.receipt);
    const repeated = await applyMemory1Migration({ legacy: source, repository: f.repository, now: () => now });
    assert.equal(repeated.success, true); assert.equal(repeated.outcome, 'already_applied'); assert.equal(repeated.revision, 1);
    assert.equal((await f.repository.readSnapshot()).snapshot.assertions.length, 7);
});
test('migration refuses to overwrite any nonempty or previously revised destination', async t => {
    const populated = emptyStore(); populated.revision = 1; populated.assertions = [{
        id: 'mem_00000001-1111-4111-8111-111111111111', kind: 'fact', subject: { type: 'unspecified' }, predicate: 'fixture.fact',
        object: { type: 'text', value: 'Synthetic preexisting record.' }, status: 'active', valid_from: null, valid_to: null,
        recorded_at: now, supersedes: [], compatibility: { category: 'fact', key: 'fixture' },
    }]; populated.sources = [{ id: 'src_00000001-1111-4111-8111-111111111111', kind: 'inference', origin_trust: 'derived_untrusted',
        authority: 'data_only', locator: null, occurred_at: null, recorded_at: now }];
    populated.evidence = [{ id: 'ev_00000001-1111-4111-8111-111111111111', assertion_id: populated.assertions[0].id,
        source_id: populated.sources[0].id, derivation: 'inferred', extraction_confidence: 0.5, learned_at: now, last_confirmed_at: null, legacy_ref: null }];
    const f = await setup(t, populated); const before = await fs.readFile(f.storePath, 'utf8');
    const result = await applyMemory1Migration({ legacy: legacy(), repository: f.repository, now: () => now });
    assert.equal(result.success, false); assert.equal(result.error.code, 'memory_migration_destination_not_empty');
    assert.equal(await fs.readFile(f.storePath, 'utf8'), before); assert.equal((await f.repository.readSnapshot()).revision, 1);
});
test('malformed records, unsupported categories, executable data and accessors fail closed', () => {
    for (const input of [null, [], { user: {}, preferences: {} }, { facts: [{ key: 'a', value: 'b', extra: 'ignore me' }] },
        { facts: [{ key: '', value: 'fictional' }] }, { facts: [{ key: 'a', value: '' }] }, { facts: [], unsupported: { x: 'y' } },
        { facts: [], user: ['unexpected'] }, { facts: [{ key: 'a', value: () => 'run' }] }]) {
        assert.throws(() => planMemory1Migration({ legacy: input, now: () => now }), error => error.code === 'memory_migration_invalid_legacy');
    }
    let accessed = false; const user = {};
    Object.defineProperty(user, 'unsafe', { enumerable: true, get() { accessed = true; return 'fictional'; } });
    assert.throws(() => planMemory1Migration({ legacy: { facts: [], user }, now: () => now }), { code: 'memory_migration_invalid_legacy' });
    assert.equal(accessed, false);
});
test('migration applies secret screening and redacted errors without partial writes', async t => {
    const f = await setup(t); const value = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    const result = await applyMemory1Migration({ legacy: { facts: [{ key: 'key', value }] }, repository: f.repository, now: () => now });
    assert.equal(result.success, false); assert.equal(result.error.code, 'memory_secret_suspected');
    assert.equal(JSON.stringify(result).includes(value), false); assert.equal((await f.repository.readSnapshot()).revision, 0);
});
test('unsupported values are never coerced or promoted into canonical people', () => {
    const plan = planMemory1Migration({ legacy: { facts: [], person: { pal: 'Fictional Jo lives in a fictional town.' } }, now: () => now });
    assert.equal(plan.assertions[0].kind, 'legacy'); assert.equal(plan.assertions[0].subject.type, 'unspecified');
    assert.equal(plan.assertions[0].compatibility.category, 'person');
    assert.throws(() => planMemory1Migration({ legacy: { facts: [{ key: 'person', value: { name: 'Fictional' } }] }, now: () => now }), { code: 'memory_migration_invalid_legacy' });
});
test('receipt permits safe retry after a committed response was lost', async t => {
    const f = await setup(t); let once = true;
    const flaky = { readSnapshot: f.repository.readSnapshot.bind(f.repository),
        commit: async request => { const committed = await f.repository.commit(request); if (once) { once = false; throw new Error('simulated lost response'); } return committed; } };
    const first = await applyMemory1Migration({ legacy: legacy(), repository: flaky, now: () => now });
    assert.equal(first.success, false); const second = await applyMemory1Migration({ legacy: legacy(), repository: flaky, now: () => now });
    assert.equal(second.success, true); assert.equal(second.outcome, 'already_applied');
    assert.equal((await f.repository.readSnapshot()).snapshot.assertions.length, 7);
});
