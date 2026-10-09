import nativeFs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openComparisonStore } from '../test/support/memory-persistence-comparison.js';

const [mode, backend, storePath, expectedJson] = process.argv.slice(2);
const expected = expectedJson ? JSON.parse(expectedJson) : null;

if (mode === 'lock') {
    const store = await openComparisonStore({ backend, storePath, clock: () => '2026-01-02T03:04:05.000Z' });
    try {
        await store.initialize({ installationId: 'test_install_m1e4' });
        const snapshot = await store.lockStore(expected);
        process.stdout.write(JSON.stringify({ status: 'applied', revision: snapshot.revision }));
    } catch (error) { process.stdout.write(JSON.stringify({ status: 'rejected', code: error.code })); }
    finally { await store.close(); }
} else if (mode === 'hold-json-write') {
    const lock = await nativeFs.open(`${storePath}.lock`, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: 'synthetic-held-writer' }) + '\n');
    await lock.sync();
    const staged = path.join(path.dirname(storePath), '.synthetic-staged.tmp');
    await nativeFs.writeFile(staged, '{ partial synthetic snapshot');
    process.stdout.write('READY');
    await new Promise(() => {});
} else if (mode === 'hold-sqlite-write') {
    const db = new DatabaseSync(storePath, { timeout: 5000 });
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE identity_snapshot SET body = 'corrupt-uncommitted' WHERE slot = 1").run();
    process.stdout.write('READY');
    await new Promise(() => {});
} else {
    process.stderr.write('unknown worker mode');
    process.exitCode = 2;
}
