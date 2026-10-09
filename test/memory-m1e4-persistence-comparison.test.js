import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { link, symlink, rmdir } from 'node:fs/promises';
import { openComparisonStore, sqliteIntegrityCheck } from './support/memory-persistence-comparison.js';

const worker = path.resolve('test-support/memory-persistence-comparison-worker.js');
const fixedTime = '2026-01-02T03:04:05.000Z';

async function fixture(t) {
    const root = await nativeFs.mkdtemp(path.join(os.tmpdir(), 'nexa-m1e4-'));
    t.after(async () => nativeFs.rm(root, { recursive: true, force: true }));
    return root;
}

function storePath(root, backend) { return path.join(root, backend === 'json' ? 'identity.json' : 'identity.sqlite'); }
async function openInitialized(backend, root, options = {}) {
    const store = await openComparisonStore({ backend, storePath: storePath(root, backend), clock: () => fixedTime, ...options });
    const snapshot = await store.initialize({ installationId: 'test_install_m1e4' });
    return { store, snapshot };
}

async function runWorker(mode, backend, file, expected) {
    const child = spawn(process.execPath, [worker, mode, backend, file, expected ? JSON.stringify(expected) : ''], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { SystemRoot: process.env.SystemRoot, windir: process.env.windir,
            PATH: process.env.PATH ?? process.env.Path ?? '', TEMP: process.env.TEMP ?? os.tmpdir(), TMP: process.env.TMP ?? os.tmpdir() },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let timer;
    const closed = new Promise((resolve, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error('worker_timeout')); }, 8_000);
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    return { child, closed, readOutput: () => ({ stdout, stderr }) };
}

async function waitReady(workerProcess) {
    const started = Date.now();
    while (!workerProcess.readOutput().stdout.includes('READY')) {
        if (Date.now() - started > 8_000) { workerProcess.child.kill(); throw new Error('worker_not_ready'); }
        if (workerProcess.child.exitCode !== null) throw new Error(`worker_exited_early:${workerProcess.readOutput().stderr}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

for (const backend of ['json', 'sqlite']) {
    test(`${backend} initializes the same synthetic identity snapshot and denies execution`, async t => {
        const root = await fixture(t);
        const { store, snapshot } = await openInitialized(backend, root);
        assert.equal(snapshot.snapshot.trustDomain, 'test.synthetic');
        assert.equal(snapshot.snapshot.revision, 0);
        assert.equal(snapshot.revision, 0);
        assert.equal(snapshot.executable, false);
        assert.equal(snapshot.authorization, 'DENY');
        const execution = store.evaluateExecutionRequest();
        assert.equal(execution.decision, 'DENY');
        assert.equal(execution.authorization, 'DENY');
        assert.equal(execution.executable, false);
        assert.equal(execution.persistencePerformed, false);
        await store.close();
    });

    test(`${backend} rejects a stale revision and persists a single idempotent lock transition across reopen`, async t => {
        const root = await fixture(t);
        const { store, snapshot } = await openInitialized(backend, root);
        const start = process.hrtime.bigint();
        const committed = await store.lockStore({ revision: snapshot.revision, digest: snapshot.digest });
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        assert.equal(committed.snapshot.bootstrapState, 'locked');
        assert.equal(committed.snapshot.revocationEpoch, 1);
        await assert.rejects(store.lockStore({ revision: snapshot.revision, digest: snapshot.digest }),
            error => ['revision_conflict', 'identity_store_revision_conflict'].includes(error.code));
        await store.close();
        const reopened = await openComparisonStore({ backend, storePath: storePath(root, backend), clock: () => fixedTime });
        await reopened.initialize({ installationId: 'test_install_m1e4' });
        const restored = await reopened.readSnapshot();
        assert.equal(restored.digest, committed.digest);
        assert.equal(restored.revision, 1);
        t.diagnostic(`${backend}: 1 successful mutation, 1 stale conflict, reopen ${elapsedMs.toFixed(2)} ms`);
        await reopened.close();
    });
}

test('JSON and SQLite snapshots share a canonical revision digest for equivalent state', async t => {
    const root = await fixture(t);
    const json = await openInitialized('json', root);
    const sqlite = await openInitialized('sqlite', root);
    assert.equal(json.snapshot.digest, sqlite.snapshot.digest);
    assert.deepEqual(json.snapshot.snapshot, sqlite.snapshot.snapshot);
    await json.store.close(); await sqlite.store.close();
});

test('JSON has no persistent sidecars; SQLite WAL sidecars and integrity are observed while open', async t => {
    const root = await fixture(t);
    const json = await openInitialized('json', root);
    const jsonFiles = await nativeFs.readdir(root);
    assert.deepEqual(jsonFiles, ['identity.json']);
    await json.store.close();
    const sqlite = await openInitialized('sqlite', root);
    const sqliteFiles = await nativeFs.readdir(root);
    assert.ok(sqliteFiles.includes('identity.sqlite'));
    assert.ok(sqliteFiles.includes('identity.sqlite-wal') || sqliteFiles.includes('identity.sqlite-shm'));
    assert.equal(await sqliteIntegrityCheck(storePath(root, 'sqlite')), 'ok');
    t.diagnostic(`auxiliary files while open: JSON=${jsonFiles.join(',')}; SQLite=${sqliteFiles.filter(name => name.startsWith('identity.sqlite')).join(',')}`);
    await sqlite.store.close();
});

test('pre-publication faults preserve the old snapshot; post-publication response loss is reconciled by reopening', async t => {
    const root = await fixture(t);
    let failRename = false;
    const jsonFs = { ...nativeFs, rename: async (from, to) => {
        if (failRename === 'before') {
            failRename = false;
            throw Object.assign(new Error('synthetic pre-publication failure'), { code: 'EIO' });
        }
        if (failRename === 'after') {
            failRename = false;
            await nativeFs.rename(from, to);
            throw Object.assign(new Error('synthetic lost rename response'), { code: 'EIO' });
        }
        return nativeFs.rename(from, to);
    } };
    const json = await openInitialized('json', root, { fileSystem: jsonFs });
    failRename = 'before';
    await assert.rejects(json.store.lockStore({ revision: json.snapshot.revision, digest: json.snapshot.digest }),
        { code: 'identity_store_persist_failed' });
    assert.equal((await json.store.readSnapshot()).revision, 0);
    failRename = 'after';
    const jsonPublished = await json.store.lockStore({ revision: json.snapshot.revision, digest: json.snapshot.digest });
    assert.equal(jsonPublished.revision, 1);
    assert.equal(jsonPublished.snapshot.bootstrapState, 'locked');
    await json.store.close();

    let fault = null;
    const sqlite = await openInitialized('sqlite', root, { faultInjector(stage) {
        if (fault === stage) throw Object.assign(new Error(`synthetic ${stage}`), { code: 'EIO' });
    } });
    fault = 'before_commit';
    await assert.rejects(sqlite.store.lockStore({ revision: sqlite.snapshot.revision, digest: sqlite.snapshot.digest }),
        { code: 'transaction_failed' });
    fault = null;
    assert.equal((await sqlite.store.readSnapshot()).revision, 0);
    fault = 'after_commit';
    await assert.rejects(sqlite.store.lockStore({ revision: sqlite.snapshot.revision, digest: sqlite.snapshot.digest }),
        { code: 'response_lost_after_commit' });
    fault = null;
    await sqlite.store.close();
    const reopened = await openComparisonStore({ backend: 'sqlite', storePath: storePath(root, 'sqlite'), clock: () => fixedTime });
    await reopened.initialize({ installationId: 'test_install_m1e4' });
    assert.equal((await reopened.readSnapshot()).snapshot.bootstrapState, 'locked');
    await reopened.close();
});

test('permission failures are injected without changing global Windows ACLs and preserve prior state', async t => {
    const root = await fixture(t);
    let denyRename = false;
    const jsonFs = { ...nativeFs, rename: async (from, to) => {
        if (denyRename) throw Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' });
        return nativeFs.rename(from, to);
    } };
    const json = await openInitialized('json', root, { fileSystem: jsonFs });
    denyRename = true;
    await assert.rejects(json.store.lockStore({ revision: json.snapshot.revision, digest: json.snapshot.digest }),
        { code: 'identity_store_persist_failed' });
    denyRename = false;
    assert.equal((await json.store.readSnapshot()).revision, 0);
    await json.store.close();

    let denyCommit = false;
    const sqlite = await openInitialized('sqlite', root, { faultInjector(stage) {
        if (denyCommit && stage === 'before_commit') throw Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' });
    } });
    denyCommit = true;
    await assert.rejects(sqlite.store.lockStore({ revision: sqlite.snapshot.revision, digest: sqlite.snapshot.digest }),
        { code: 'transaction_failed' });
    denyCommit = false;
    assert.equal((await sqlite.store.readSnapshot()).revision, 0);
    await sqlite.store.close();
});

for (const backend of ['json', 'sqlite']) {
    test(`${backend} concurrent independent processes allow at most one writer for the same snapshot`, async t => {
        const root = await fixture(t);
        const { store, snapshot } = await openInitialized(backend, root);
        await store.close();
        const workers = await Promise.all([1, 2].map(() => runWorker('lock', backend, storePath(root, backend),
            { revision: snapshot.revision, digest: snapshot.digest })));
        const results = await Promise.all(workers.map(async item => {
            const exit = await item.closed;
            assert.equal(exit.code, 0, item.readOutput().stderr);
            return JSON.parse(item.readOutput().stdout);
        }));
        assert.equal(results.filter(item => item.status === 'applied').length, 1, JSON.stringify(results));
        assert.equal(results.filter(item => item.status === 'rejected').length, 1);
        assert.ok(results.some(item => item.code === 'identity_store_locked' || item.code === 'identity_store_revision_conflict'
            || item.code === 'revision_conflict'));
    });
}

for (const backend of ['json', 'sqlite']) {
    test(`${backend} fails closed for a missing parent but cannot distinguish first creation from later store deletion`, async t => {
        const root = await fixture(t);
        const missingParentPath = path.join(os.tmpdir(), `nexa-m1e4-${Date.now()}-${backend}`, 'identity.store');
        await assert.rejects(openComparisonStore({ backend, storePath: missingParentPath, clock: () => fixedTime }),
            { code: 'fixture_root_unavailable' });

        const file = storePath(root, backend);
        const initialized = await openInitialized(backend, root);
        await initialized.store.close();
        await nativeFs.unlink(file);
        if (backend === 'sqlite') {
            await nativeFs.rm(`${file}-wal`, { force: true });
            await nativeFs.rm(`${file}-shm`, { force: true });
        }
        const recreated = await openComparisonStore({ backend, storePath: file, clock: () => fixedTime });
        const snapshot = await recreated.initialize({ installationId: 'test_install_m1e4' });
        assert.equal(snapshot.snapshot.revision, 0);
        await recreated.close();
    });
}

test('an interrupted JSON writer leaves a non-stealable lock while SQLite rolls back an uncommitted writer on process death', async t => {
    const root = await fixture(t);
    const json = await openInitialized('json', root);
    await json.store.close();
    const jsonWriter = await runWorker('hold-json-write', 'json', storePath(root, 'json'));
    await waitReady(jsonWriter);
    const visibleJson = JSON.parse(await nativeFs.readFile(storePath(root, 'json'), 'utf8'));
    assert.equal(visibleJson.revision, 0);
    const blockedJsonWriter = await openComparisonStore({ backend: 'json', storePath: storePath(root, 'json') });
    await assert.rejects(blockedJsonWriter.initialize({ installationId: 'test_install_m1e4' }),
        { code: 'identity_store_locked' });
    await blockedJsonWriter.close();
    jsonWriter.child.kill(); await jsonWriter.closed;
    assert.equal(await nativeFs.readFile(`${storePath(root, 'json')}.lock`, 'utf8').then(() => true), true);
    await nativeFs.unlink(`${storePath(root, 'json')}.lock`);
    await nativeFs.unlink(path.join(root, '.synthetic-staged.tmp'));

    const sqlite = await openInitialized('sqlite', root);
    await sqlite.store.close();
    const sqliteWriter = await runWorker('hold-sqlite-write', 'sqlite', storePath(root, 'sqlite'));
    await waitReady(sqliteWriter);
    const reader = new DatabaseSync(storePath(root, 'sqlite'), { readOnly: true });
    const visibleRow = reader.prepare('SELECT revision, body FROM identity_snapshot WHERE slot = 1').get();
    assert.equal(visibleRow.revision, 0);
    assert.equal(JSON.parse(visibleRow.body).bootstrapState, 'uninitialized');
    reader.close();
    sqliteWriter.child.kill(); await sqliteWriter.closed;
    assert.equal(await sqliteIntegrityCheck(storePath(root, 'sqlite')), 'ok');
    const reopened = await openComparisonStore({ backend: 'sqlite', storePath: storePath(root, 'sqlite') });
    await reopened.initialize({ installationId: 'test_install_m1e4' });
    assert.equal((await reopened.readSnapshot()).revision, 0);
    await reopened.close();
});

test('both backends reject malformed or integrity-inconsistent persisted state', async t => {
    const root = await fixture(t);
    const json = await openInitialized('json', root);
    await json.store.close();
    await nativeFs.writeFile(storePath(root, 'json'), '{ broken synthetic JSON');
    const corruptJson = await openComparisonStore({ backend: 'json', storePath: storePath(root, 'json') });
    await assert.rejects(corruptJson.initialize({ installationId: 'test_install_m1e4' }), { code: 'identity_store_corrupt' });
    await corruptJson.close();

    const sqlite = await openInitialized('sqlite', root);
    await sqlite.store.close();
    const db = new DatabaseSync(storePath(root, 'sqlite'));
    db.prepare("UPDATE identity_snapshot SET body = '{ broken synthetic JSON' WHERE slot = 1").run();
    db.close();
    const corruptSqlite = await openComparisonStore({ backend: 'sqlite', storePath: storePath(root, 'sqlite') });
    await assert.rejects(corruptSqlite.initialize({ installationId: 'test_install_m1e4' }), { code: 'corrupt' });
    await corruptSqlite.close();
});

test('fixture path redirection and multiply-linked store files are rejected before opening either backend', async t => {
    const root = await fixture(t);
    const target = path.join(root, 'synthetic-target.sqlite');
    const alias = storePath(root, 'sqlite');
    await nativeFs.writeFile(target, 'synthetic-target-must-remain-unchanged');
    await link(target, alias);
    for (const backend of ['json', 'sqlite']) {
        await assert.rejects(openComparisonStore({ backend, storePath: alias }), { code: 'store_file_redirected' });
    }
    assert.equal(await nativeFs.readFile(target, 'utf8'), 'synthetic-target-must-remain-unchanged');
    await nativeFs.unlink(alias);

    if (process.platform !== 'win32') return t.skip('Windows junction path check requires a Windows runner');
    const junction = path.join(os.tmpdir(), `nexa-m1e4-junction-${Date.now()}`);
    try { await symlink(root, junction, 'junction'); }
    catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code))
            return t.skip(`Windows did not permit creating a synthetic junction: ${error.code}`);
        throw error;
    }
    try {
        await assert.rejects(openComparisonStore({ backend: 'sqlite', storePath: path.join(junction, 'redirected.sqlite') }),
            { code: 'fixture_root_redirected' });
        assert.equal(await nativeFs.readFile(target, 'utf8'), 'synthetic-target-must-remain-unchanged');
    } finally { await rmdir(junction); }
});

for (const backend of ['json', 'sqlite']) {
    test(`${backend} accepts an old restored snapshot without an independent anti-rollback anchor`, async t => {
        const root = await fixture(t);
        const file = storePath(root, backend);
        const initial = await openInitialized(backend, root);
        await initial.store.close();
        const backup = `${file}.synthetic-backup`;
        await nativeFs.copyFile(file, backup);
        const current = await openComparisonStore({ backend, storePath: file, clock: () => fixedTime });
        await current.initialize({ installationId: 'test_install_m1e4' });
        const before = await current.readSnapshot();
        const changed = await current.lockStore({ revision: before.revision, digest: before.digest });
        assert.equal(changed.revision, 1);
        await current.close();
        await nativeFs.copyFile(backup, file);
        const restored = await openComparisonStore({ backend, storePath: file, clock: () => fixedTime });
        await restored.initialize({ installationId: 'test_install_m1e4' });
        assert.equal((await restored.readSnapshot()).revision, 0);
        await restored.close();
    });
}
