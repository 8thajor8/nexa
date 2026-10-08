import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { MemoryRepositoryError, contentDigest } from '../src/memory/repository.js';

const time = '2030-04-10T09:00:00.000Z';
const later = '2030-04-10T09:01:00.000Z';
const id = (prefix, n = 1) => `${prefix}_${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
function fixture() {
    return { schema_version: 4, self_person_id: 'person_00000000-0000-4000-8000-000000000000', entities: [{ id: 'person_00000000-0000-4000-8000-000000000000', type: 'person', created_at: '2000-01-01T00:00:00.000Z' }], store_id: id('store'), revision: 0, created_at: time, updated_at: time,
        assertions: [{ id: id('mem'), kind: 'fact', subject: { type: 'unspecified' }, predicate: 'legacy.fact',
            object: { type: 'text', value: 'Fictional Mira enjoys paper maps.' }, status: 'active', valid_from: null, valid_to: null,
            recorded_at: time, supersedes: [], compatibility: { category: 'fact', key: 'maps' } }],
        sources: [{ id: id('src'), kind: 'legacy_memory_1', origin_trust: 'unknown', authority: 'data_only', locator: null, occurred_at: null, recorded_at: time }],
        evidence: [{ id: id('ev'), assertion_id: id('mem'), source_id: id('src'), derivation: 'unknown', extraction_confidence: null,
            learned_at: null, last_confirmed_at: null, legacy_ref: { category: 'facts', key: 'maps', index: 0 } }], migrations: [] };
}
const code = expected => error => error instanceof MemoryRepositoryError && error.code === expected;
const ioError = () => Object.assign(new Error('PRIVATE filesystem path and SECRET value'), { code: 'EIO' });
function request(snapshot, value = 'Fictional Mira enjoys star maps.') {
    const record = structuredClone(snapshot.snapshot.assertions[0]); record.object.value = value;
    return { expectedRevision: snapshot.revision, expectedDigest: snapshot.digest, changes: [{ type: 'put', collection: 'assertions', record }] };
}
async function setup(t, { seed = true, fileSystem = {}, data = fixture() } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-memory-test-'));
    const storePath = path.join(directory, 'memory-v2.json');
    const repos = [];
    t.after(async () => {
        for (const repo of repos) await repo.close().catch(() => {});
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(directory, { recursive: true, force: true });
    });
    if (seed) await fs.writeFile(storePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    function create(overrides = {}) {
        const repo = createJsonMemoryRepository({ storePath, now: () => later, fileSystem, ...overrides });
        repos.push(repo); return repo;
    }
    return { directory, storePath, create, repo: create() };
}

test('explicit absolute path is required and construction creates nothing', async t => {
    for (const storePath of [undefined, '', 'data/memory-v2.json']) assert.throws(() => createJsonMemoryRepository({ storePath }), code('memory_repository_invalid'));
    const f = await setup(t, { seed: false });
    assert.deepEqual(await fs.readdir(f.directory), []);
    await assert.rejects(f.repo.open(), code('memory_uninitialized'));
    assert.deepEqual(await fs.readdir(f.directory), []);
    const nested = f.create({ storePath: path.join(f.directory, 'absent', 'memory-v2.json') });
    await assert.rejects(nested.open(), code('memory_uninitialized'));
    assert.deepEqual(await fs.readdir(f.directory), []);
});
test('corrupt, malformed and unsupported stores are distinct and never overwritten', async t => {
    const f = await setup(t);
    for (const [contents, expected] of [['{PRIVATE_SECRET', 'memory_store_corrupt'], [JSON.stringify({ ...fixture(), evidence: [] }), 'memory_store_corrupt'],
        [JSON.stringify({ ...fixture(), schema_version: 2 }), 'memory_schema_unsupported']]) {
        await fs.writeFile(f.storePath, contents);
        await assert.rejects(f.repo.open(), error => code(expected)(error) && !JSON.stringify(error).includes('PRIVATE_SECRET'));
        assert.equal(await fs.readFile(f.storePath, 'utf8'), contents);
        assert.deepEqual(await fs.readdir(f.directory), ['memory-v2.json']);
    }
});
test('unreadable store returns a safe error with a non-public cause', async t => {
    const f = await setup(t, { fileSystem: { readFile: async () => { throw Object.assign(ioError(), { code: 'EACCES' }); } } });
    await assert.rejects(f.repo.open(), error => {
        assert.equal(error.code, 'memory_store_unreadable');
        assert.ok(error.cause); assert.equal(Object.keys(error).includes('cause'), false);
        assert.equal(JSON.stringify(error).includes('SECRET'), false); assert.equal(error.message.includes('PRIVATE'), false); return true;
    });
    assert.deepEqual(await fs.readdir(f.directory), ['memory-v2.json']);
});
test('snapshots are recursively immutable and successful commit persists a new revision', async t => {
    const f = await setup(t); const original = await f.repo.open();
    assert.ok(Object.isFrozen(original)); assert.ok(Object.isFrozen(original.snapshot.assertions[0].object));
    assert.throws(() => { original.snapshot.assertions[0].object.value = 'mutation'; }, TypeError);
    assert.throws(() => { original.snapshot.sources.push({}); }, TypeError);
    const next = await f.repo.commit(request(original));
    assert.equal(next.revision, 1); assert.equal(next.snapshot.updated_at, later);
    assert.notEqual(next.digest, original.digest); assert.equal(original.snapshot.assertions[0].object.value, 'Fictional Mira enjoys paper maps.');
    assert.equal(next.snapshot.assertions[0].id, original.snapshot.assertions[0].id);
    assert.deepEqual(await f.repo.readSnapshot(), next);
    const bytes = await fs.readFile(f.storePath); assert.equal(contentDigest(bytes), next.digest);
    assert.equal(JSON.parse(bytes).revision, 1);
});
test('typed puts/deletes apply together across collections and migration receipts', async t => {
    const f = await setup(t); const snap = await f.repo.open();
    const receipt = { source_sha256: 'a'.repeat(64), conversion_version: 1, applied_at: time, source_entry_count: 1, created_assertion_count: 1 };
    const next = await f.repo.commit({ expectedRevision: snap.revision, expectedDigest: snap.digest, changes: [
        { type: 'delete', collection: 'assertions', id: id('mem') }, { type: 'delete', collection: 'evidence', id: id('ev') },
        { type: 'delete', collection: 'sources', id: id('src') }, { type: 'put', collection: 'migrations', record: receipt },
    ] });
    assert.equal(next.snapshot.assertions.length, 0); assert.equal(next.snapshot.migrations.length, 1);
    const final = await f.repo.commit({ expectedRevision: next.revision, expectedDigest: next.digest,
        changes: [{ type: 'delete', collection: 'migrations', source_sha256: receipt.source_sha256 }] });
    assert.equal(final.snapshot.migrations.length, 0);
});

test('generic repository commit cannot create, replace, or delete automatic operation receipts', async t => {
    const v5 = fixture(); v5.schema_version = 5; v5.automatic_operations = [];
    const f = await setup(t, { data: v5 }); const snapshot = await f.repo.open();
    const receipt = { operation_key: 'a'.repeat(64), operation_fingerprint_sha256: 'b'.repeat(64), operation_kind: 'ADD',
        status: 'applied', authorization_request_id: 'req_00000001-1111-4111-8111-111111111111', expected_revision: 0,
        expected_digest: snapshot.digest, result_revision: 1, result_assertion_id: snapshot.snapshot.assertions[0].id,
        target_assertion_id: null, result_code: null, recorded_at: later };
    const bytes = await fs.readFile(f.storePath, 'utf8');
    await assert.rejects(f.repo.commit({ expectedRevision: snapshot.revision, expectedDigest: snapshot.digest,
        changes: [{ type: 'put', collection: 'automatic_operations', record: receipt }] }), code('memory_invalid_changes'));
    await assert.rejects(f.repo.commit({ expectedRevision: snapshot.revision, expectedDigest: snapshot.digest,
        changes: [{ type: 'delete', collection: 'automatic_operations', operation_key: receipt.operation_key }] }), code('memory_invalid_changes'));
    const replacement = { ...receipt, operation_fingerprint_sha256: 'c'.repeat(64) };
    await assert.rejects(f.repo.commit({ expectedRevision: snapshot.revision, expectedDigest: snapshot.digest,
        changes: [{ type: 'put', collection: 'automatic_operations', record: replacement }] }), code('memory_invalid_changes'));
    assert.equal(await fs.readFile(f.storePath, 'utf8'), bytes);

    const legacy = await setup(t); const old = await legacy.repo.open();
    await assert.rejects(legacy.repo.commit({ expectedRevision: old.revision, expectedDigest: old.digest,
        changes: [{ type: 'put', collection: 'automatic_operations', record: receipt }] }), code('memory_invalid_changes'));
});
test('invalid, duplicate or dangling changes fail without altering bytes', async t => {
    const f = await setup(t); const snap = await f.repo.open(); const bytes = await fs.readFile(f.storePath, 'utf8');
    for (const changes of [[], [{ type: 'patch', collection: 'assertions', path: '/permissions', value: true }],
        [{ type: 'delete', collection: 'assertions', id: id('mem') }], [{ type: 'delete', collection: 'sources', id: id('src', 99) }],
        [request(snap).changes[0], request(snap).changes[0]]]) {
        await assert.rejects(f.repo.commit({ expectedRevision: snap.revision, expectedDigest: snap.digest, changes }), code('memory_invalid_changes'));
        assert.equal(await fs.readFile(f.storePath, 'utf8'), bytes);
    }
});
test('stale revisions and stale digests are rejected without retry', async t => {
    const f = await setup(t); const snap = await f.repo.open();
    await assert.rejects(f.repo.commit({ ...request(snap), expectedRevision: 99 }), code('memory_revision_conflict'));
    await assert.rejects(f.repo.commit({ ...request(snap), expectedDigest: '0'.repeat(64) }), code('memory_revision_conflict'));
    await f.repo.commit(request(snap));
    await assert.rejects(f.repo.commit(request(snap)), code('memory_revision_conflict'));
});
test('external edits to bytes, revision or store identity are detected by reads and writes', async t => {
    const f = await setup(t);
    for (const change of [s => { s.assertions[0].object.value = 'Other fictional data'; }, s => { s.revision++; }, s => { s.store_id = id('store', 2); }, null]) {
        await fs.writeFile(f.storePath, JSON.stringify(fixture()));
        const repo = f.create(); const snap = await repo.open(); const store = fixture();
        if (change) change(store);
        await fs.writeFile(f.storePath, JSON.stringify(store) + (change ? '' : '\n'));
        await assert.rejects(repo.readSnapshot(), code('memory_revision_conflict'));
        await assert.rejects(repo.commit(request(snap)), code('memory_revision_conflict'));
        assert.equal(snap.snapshot.assertions[0].object.value, fixture().assertions[0].object.value);
        await repo.close();
    }
});
test('serialized commits reject a second stale caller and snapshot queued input', async t => {
    let staged = 0; let unblock;
    const waiting = new Promise(resolve => { unblock = resolve; });
    const f = await setup(t, { fileSystem: { rename: async (...args) => { staged++; await waiting; return fs.rename(...args); } } });
    const snap = await f.repo.open(); const first = request(snap, 'First fictional value');
    const p1 = f.repo.commit(first); const p2 = f.repo.commit(request(snap, 'Second fictional value'));
    first.changes[0].record.object.value = 'Caller mutation after enqueue';
    unblock(); const results = await Promise.allSettled([p1, p2]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'memory_revision_conflict');
    assert.equal(staged, 1); assert.equal(results[0].value.snapshot.assertions[0].object.value, 'First fictional value');
    const next = await f.repo.commit(request(results[0].value, 'Third fictional value')); assert.equal(next.revision, 2);
});
test('same-process lock contention and reopen lifecycle are explicit', async t => {
    const f = await setup(t); await f.repo.open(); const contender = f.create();
    await assert.rejects(contender.open(), code('memory_store_locked'));
    const lock = JSON.parse(await fs.readFile(f.storePath + '.lock')); assert.equal(lock.pid, process.pid); assert.match(lock.token, /^[a-f0-9-]{36}$/u);
    await f.repo.close(); await f.repo.close();
    await assert.rejects(f.repo.readSnapshot(), code('memory_repository_closed'));
    await contender.open(); await contender.close(); await f.repo.open();
});
test('another process cannot acquire a held lock', async t => {
    const f = await setup(t); await f.repo.open();
    const moduleUrl = new URL('../src/memory/json-repository.js', import.meta.url).href;
    const script = `import { createJsonMemoryRepository } from ${JSON.stringify(moduleUrl)};
        const repo = createJsonMemoryRepository({storePath: process.argv[1]});
        try { await repo.open(); await repo.close(); process.exitCode = 2; }
        catch (error) { process.stdout.write(error.code); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.storePath], { windowsHide: true });
    assert.equal(stdout, 'memory_store_locked');
});
test('stale locks are never stolen and close preserves a replaced ownership token', async t => {
    const f = await setup(t); const lockPath = f.storePath + '.lock';
    await fs.writeFile(lockPath, JSON.stringify({ pid: 99999999, token: 'old-owner' }));
    await assert.rejects(f.repo.open(), code('memory_store_locked'));
    assert.equal(JSON.parse(await fs.readFile(lockPath)).token, 'old-owner');
    await fs.unlink(lockPath); await f.repo.open();
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
    await assert.rejects(f.repo.close(), code('memory_lock_lost'));
    assert.equal(JSON.parse(await fs.readFile(lockPath)).token, 'replacement-owner');
});
test('lock ownership is verified before mutation', async t => {
    const f = await setup(t); const snap = await f.repo.open();
    await fs.unlink(f.storePath + '.lock');
    await assert.rejects(f.repo.commit(request(snap)), code('memory_lock_lost'));
    assert.equal(JSON.parse(await fs.readFile(f.storePath)).revision, 0);
});
test('real replacement uses a unique same-directory temp, flush and close before rename', async t => {
    const steps = []; const temporaryPaths = [];
    const f = await setup(t, { fileSystem: {
        open: async (target, flags, mode) => {
            const handle = await fs.open(target, flags, mode);
            if (!target.endsWith('.tmp')) return handle;
            temporaryPaths.push(target); assert.equal(flags, 'wx');
            return { writeFile: async (...args) => { steps.push('write'); return handle.writeFile(...args); },
                sync: async () => { steps.push('sync'); return handle.sync(); }, close: async () => { steps.push('close'); return handle.close(); } };
        },
        rename: async (from, to) => {
            steps.push('rename'); assert.deepEqual(steps, ['write', 'sync', 'close', 'rename']);
            assert.equal(path.dirname(from), path.dirname(to));
            assert.equal(JSON.parse(await fs.readFile(to)).revision, 0);
            assert.equal(JSON.parse(await fs.readFile(from)).revision, 1);
            return fs.rename(from, to);
        },
        unlink: async target => { assert.notEqual(path.basename(target), 'memory-v2.json'); return fs.unlink(target); },
    } });
    const snap = await f.repo.open(); await f.repo.commit(request(snap));
    assert.equal(temporaryPaths.length, 1); assert.ok(path.basename(temporaryPaths[0]).startsWith('.memory-v2.json.'));
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['memory-v2.json', 'memory-v2.json.lock']);
});
test('rename failure preserves destination, old snapshot and cleans temporary files', async t => {
    const f = await setup(t, { fileSystem: { rename: async () => { throw ioError(); } } });
    const snap = await f.repo.open(); const before = await fs.readFile(f.storePath, 'utf8');
    await assert.rejects(f.repo.commit(request(snap)), code('memory_persist_failed'));
    assert.equal(await fs.readFile(f.storePath, 'utf8'), before); assert.equal(await f.repo.readSnapshot(), snap);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['memory-v2.json', 'memory-v2.json.lock']);
});
for (const stage of ['writeFile', 'sync', 'close']) {
    test(`temporary ${stage} failure preserves destination and unpublished state`, async t => {
        let failed = false;
        const f = await setup(t, { fileSystem: { open: async (target, ...args) => {
            const handle = await fs.open(target, ...args); if (!target.endsWith('.tmp')) return handle;
            return Object.fromEntries(['writeFile', 'sync', 'close'].map(method => [method, async (...params) => {
                if (method === stage && !failed) { failed = true; throw ioError(); }
                return handle[method](...params);
            }]));
        } } });
        const snap = await f.repo.open(); const before = await fs.readFile(f.storePath, 'utf8');
        await assert.rejects(f.repo.commit(request(snap)), code('memory_persist_failed'));
        assert.equal(await fs.readFile(f.storePath, 'utf8'), before); assert.equal(await f.repo.readSnapshot(), snap);
        assert.deepEqual((await fs.readdir(f.directory)).sort(), ['memory-v2.json', 'memory-v2.json.lock']);
    });
}
test('failed exclusive temp creation does not unlink a file not owned by the repository', async t => {
    let attemptedPath;
    const f = await setup(t, { fileSystem: { open: async (target, ...args) => {
        if (target.endsWith('.tmp')) { attemptedPath = target; await fs.writeFile(target, 'other owner'); throw Object.assign(ioError(), { code: 'EEXIST' }); }
        return fs.open(target, ...args);
    } } });
    const snap = await f.repo.open(); await assert.rejects(f.repo.commit(request(snap)), code('memory_persist_failed'));
    assert.equal(await fs.readFile(attemptedPath, 'utf8'), 'other owner');
});
test('external edit while staging is detected before replacement', async t => {
    let destination; let renamed = false;
    const f = await setup(t, { fileSystem: {
        open: async (target, ...args) => {
            const handle = await fs.open(target, ...args); if (!target.endsWith('.tmp')) return handle;
            return { writeFile: (...params) => handle.writeFile(...params), close: () => handle.close(), sync: async () => {
                await handle.sync(); const external = fixture(); external.revision = 12; await fs.writeFile(destination, JSON.stringify(external));
            } };
        }, rename: async (...args) => { renamed = true; return fs.rename(...args); },
    } }); destination = f.storePath;
    const snap = await f.repo.open(); await assert.rejects(f.repo.commit(request(snap)), code('memory_revision_conflict'));
    assert.equal(renamed, false); assert.equal(JSON.parse(await fs.readFile(f.storePath)).revision, 12);
});
test('rename succeeded but reported failure reconciles to the committed candidate', async t => {
    const f = await setup(t, { fileSystem: { rename: async (...args) => { await fs.rename(...args); throw ioError(); } } });
    const snap = await f.repo.open(); const result = await f.repo.commit(request(snap));
    assert.equal(result.revision, 1); assert.equal(result.digest, contentDigest(await fs.readFile(f.storePath)));
    assert.equal(await f.repo.readSnapshot(), result);
});
test('one post-rename read failure is reconciled without publishing prematurely', async t => {
    let replaced = false; let failed = false;
    const f = await setup(t, { fileSystem: {
        rename: async (...args) => { await fs.rename(...args); replaced = true; },
        readFile: async (target, ...args) => { if (replaced && !failed && target.endsWith('memory-v2.json')) { failed = true; throw ioError(); } return fs.readFile(target, ...args); },
    } });
    const snap = await f.repo.open(); const result = await f.repo.commit(request(snap)); assert.equal(result.revision, 1);
});
test('unreadable post-rename state poisons repository until close and explicit reopen', async t => {
    let replaced = false;
    const f = await setup(t, { fileSystem: {
        rename: async (...args) => { await fs.rename(...args); replaced = true; },
        readFile: async (target, ...args) => { if (replaced && target.endsWith('memory-v2.json')) throw ioError(); return fs.readFile(target, ...args); },
    } });
    const original = await f.repo.open(); await assert.rejects(f.repo.commit(request(original)), code('memory_commit_uncertain'));
    assert.equal(original.revision, 0);
    await assert.rejects(f.repo.readSnapshot(), code('memory_commit_uncertain'));
    await assert.rejects(f.repo.commit(request(original)), code('memory_commit_uncertain'));
    await f.repo.close(); const reopened = f.create({ fileSystem: {} }); assert.equal((await reopened.open()).revision, 1);
});
test('a third post-rename state is uncertain, never mistaken for old or committed data', async t => {
    const f = await setup(t, { fileSystem: { rename: async (from, to) => {
        await fs.rename(from, to); const external = fixture(); external.revision = 42; await fs.writeFile(to, JSON.stringify(external)); throw ioError();
    } } });
    const original = await f.repo.open(); await assert.rejects(f.repo.commit(request(original)), code('memory_commit_uncertain'));
    assert.equal(JSON.parse(await fs.readFile(f.storePath)).revision, 42);
    await assert.rejects(f.repo.readSnapshot(), code('memory_commit_uncertain'));
});
test('runtime corruption is explicit and never replaced by an empty store', async t => {
    const f = await setup(t); const snap = await f.repo.open(); await fs.writeFile(f.storePath, '{broken');
    await assert.rejects(f.repo.readSnapshot(), code('memory_store_corrupt'));
    await assert.rejects(f.repo.commit(request(snap)), code('memory_store_corrupt'));
    assert.equal(await fs.readFile(f.storePath, 'utf8'), '{broken');
});
test('Windows native filesystem: lock, flush/close, replacement, reopen and revision persistence', { skip: process.platform !== 'win32' }, async t => {
    const f = await setup(t); const snap = await f.repo.open(); const result = await f.repo.commit(request(snap)); await f.repo.close();
    assert.deepEqual(await fs.readdir(f.directory), ['memory-v2.json']);
    const reopened = f.create(); const after = await reopened.open();
    assert.equal(after.revision, 1); assert.equal(after.digest, result.digest); assert.deepEqual(after.snapshot, result.snapshot);
    await reopened.close(); assert.deepEqual(await fs.readdir(f.directory), ['memory-v2.json']);
});
