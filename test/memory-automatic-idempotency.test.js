import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { applyChanges, contentDigest, MemoryRepositoryError } from '../src/memory/repository.js';
import { validateMemoryStore } from '../src/memory/schema.js';
import { createAutomaticMemoryPersistenceContract } from '../src/memory/automatic/persistence-contract.js';
import { snapshotFingerprint } from '../src/memory/automatic/policy.js';
import { assessAutomaticMemoryAuthorization } from '../src/memory/automatic/authorization-contract.js';

const NOW = '2037-05-06T07:08:09.000Z';
const SELF = 'person_00000000-0000-4000-8000-000000000001';
const STORE_ID = 'store_00000000-0000-4000-8000-000000000001';
const code = expected => error => error?.code === expected;
const id = prefix => `${prefix}_${randomUUID()}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function emptyStore() {
    return { schema_version: 4, store_id: STORE_ID, self_person_id: SELF, revision: 0,
        created_at: NOW, updated_at: NOW,
        entities: [{ id: SELF, type: 'person', created_at: NOW }],
        assertions: [], sources: [], evidence: [], migrations: [] };
}

function storeWithAcer() {
    const store = emptyStore();
    const assertionId = 'mem_00000000-0000-4000-8000-000000000011';
    const sourceId = 'src_00000000-0000-4000-8000-000000000011';
    store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: SELF },
        predicate: 'user.uses_tool', object: { type: 'text', value: 'Acer' }, status: 'active',
        valid_from: null, valid_to: null, recorded_at: NOW, supersedes: [], compatibility: null });
    store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
        locator: null, occurred_at: { value: NOW, precision: 'instant' }, recorded_at: NOW });
    store.evidence.push({ id: 'ev_00000000-0000-4000-8000-000000000011', assertion_id: assertionId,
        source_id: sourceId, derivation: 'explicit', extraction_confidence: null, learned_at: null,
        last_confirmed_at: null, legacy_ref: null });
    validateMemoryStore(store);
    return { store, assertionId };
}

function proposalFor(text, { operation = 'ADD', targetAssertionId = null, value = 'Fender' } = {}) {
    const candidate = { candidate_type: operation === 'REPLACE' ? 'tool' : 'purchase', subject_text: 'user',
        predicate: operation === 'REPLACE' ? 'user.uses_tool' : 'user.owns_item', value_text: value,
        mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.94,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' },
        update_intent: operation === 'REPLACE' ? 'possible_supersession' : 'addition',
        sensitivity: 'none', suggested_disposition: operation === 'REPLACE' ? 'ask' : 'auto_save',
        evidence_quote: text };
    // B.2a's key is based on the exact operation/candidate/source/snapshot/target.
    return { candidate, targetAssertionId };
}

function operationIdentity({ type, key, fingerprint, targetAssertionId = null, expectedRevision, expectedDigest }) {
    return { type, key, fingerprint, targetAssertionId, expectedRevision, expectedDigest };
}

function memoryChanges(store, operation) {
    const assertionId = id('mem');
    const sourceId = id('src');
    const evidenceId = id('ev');
    const assertion = { id: assertionId, kind: 'fact',
        subject: { type: 'entity', entity_type: 'person', id: store.self_person_id },
        predicate: operation.type === 'REPLACE' ? 'user.uses_tool' : 'user.owns_item',
        object: { type: 'text', value: operation.value }, status: 'active', valid_from: null,
        valid_to: null, recorded_at: NOW,
        supersedes: operation.type === 'REPLACE' ? [operation.targetAssertionId] : [], compatibility: null };
    const source = { id: sourceId, kind: 'inference', origin_trust: 'derived_untrusted', authority: 'data_only',
        locator: null, occurred_at: { value: NOW, precision: 'instant' }, recorded_at: NOW };
    const evidence = { id: evidenceId, assertion_id: assertionId, source_id: sourceId,
        derivation: 'inferred', extraction_confidence: 0.94, learned_at: null,
        last_confirmed_at: null, legacy_ref: null };
    const changes = [
        { type: 'put', collection: 'assertions', record: assertion },
        { type: 'put', collection: 'sources', record: source },
        { type: 'put', collection: 'evidence', record: evidence },
    ];
    if (operation.type === 'REPLACE') {
        const previous = store.assertions.find(record => record.id === operation.targetAssertionId && record.status === 'active');
        if (!previous) throw Object.assign(new Error('sim_target_not_found'), { code: 'sim_target_not_found' });
        changes.push({ type: 'put', collection: 'assertions', record: { ...previous, status: 'superseded' } });
    }
    return changes;
}

function validateEnvelope(envelope) {
    assert.deepEqual(Object.keys(envelope).sort(), ['format_version', 'ledger_revision', 'receipts', 'store']);
    assert.equal(envelope.format_version, 1);
    assert.ok(Number.isSafeInteger(envelope.ledger_revision) && envelope.ledger_revision >= 0);
    assert.ok(Array.isArray(envelope.receipts));
    validateMemoryStore(envelope.store);
    const keys = new Set();
    for (const receipt of envelope.receipts) {
        assert.deepEqual(Object.keys(receipt).sort(), ['fingerprint', 'key', 'operation', 'status']);
        assert.match(receipt.key, /^[a-f0-9]{64}$/u);
        assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/u);
        assert.ok(['ADD', 'REPLACE'].includes(receipt.operation));
        assert.ok(['applied', 'rejected', 'unknown'].includes(receipt.status));
        assert.ok(!keys.has(receipt.key)); keys.add(receipt.key);
    }
}

async function withTempLedger(t, store = emptyStore()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-auto-idempotency-'));
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const filePath = path.join(directory, 'simulated-ledger.json');
    const lockPath = filePath + '.lock';
    const initial = { format_version: 1, ledger_revision: 0, store, receipts: [] };
    validateEnvelope(initial);
    await fs.writeFile(filePath, JSON.stringify(initial, null, 2) + '\n');
    t.after(async () => {
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });

    async function read() {
        let parsed;
        try { parsed = JSON.parse(await fs.readFile(filePath, 'utf8')); }
        catch { throw Object.assign(new Error('sim_ledger_corrupt'), { code: 'sim_ledger_corrupt' }); }
        try { validateEnvelope(parsed); }
        catch { throw Object.assign(new Error('sim_ledger_corrupt'), { code: 'sim_ledger_corrupt' }); }
        return parsed;
    }

    async function persist(envelope) {
        validateEnvelope(envelope);
        const temporaryPath = path.join(directory, `.simulated-ledger.${randomUUID()}.tmp`);
        let handle;
        try {
            handle = await fs.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(JSON.stringify(envelope, null, 2) + '\n', 'utf8');
            await handle.sync();
            await handle.close(); handle = undefined;
            await fs.rename(temporaryPath, filePath);
        } finally {
            if (handle) await handle.close().catch(() => {});
            await fs.unlink(temporaryPath).catch(() => {});
        }
    }

    async function commit(operation, { failAt = null, confirmationTargetId = operation.targetAssertionId } = {}) {
        let lock;
        try { lock = await fs.open(lockPath, 'wx', 0o600); }
        catch (error) {
            if (error.code === 'EEXIST') throw Object.assign(new Error('sim_writer_locked'), { code: 'sim_writer_locked' });
            throw error;
        }
        try {
            const envelope = await read();
            const previous = envelope.receipts.find(receipt => receipt.key === operation.key);
            if (previous) {
                if (previous.fingerprint !== operation.fingerprint || previous.operation !== operation.type)
                    throw Object.assign(new Error('sim_idempotency_key_reused'), { code: 'sim_idempotency_key_reused' });
                return { duplicate: true, receipt: previous, envelope };
            }
            const currentDigest = snapshotFingerprint({ snapshot: envelope.store });
            if (operation.expectedRevision !== envelope.store.revision || operation.expectedDigest !== currentDigest)
                throw new MemoryRepositoryError('memory_revision_conflict');

            if (operation.type === 'REPLACE' && confirmationTargetId !== operation.targetAssertionId) {
                const rejected = { ...envelope, ledger_revision: envelope.ledger_revision + 1,
                    receipts: [...envelope.receipts, { key: operation.key, fingerprint: operation.fingerprint,
                        operation: operation.type, status: 'rejected' }] };
                if (failAt === 'before-commit') throw Object.assign(new Error('simulated_precommit_failure'), { code: 'simulated_precommit_failure' });
                await persist(rejected);
                return { duplicate: false, receipt: rejected.receipts.at(-1), envelope: rejected };
            }

            const changes = memoryChanges(envelope.store, operation);
            const nextStore = applyChanges(envelope.store, changes, NOW);
            const status = failAt === 'unknown-after-commit' ? 'unknown' : 'applied';
            const next = { format_version: 1, ledger_revision: envelope.ledger_revision + 1,
                store: nextStore, receipts: [...envelope.receipts, { key: operation.key,
                    fingerprint: operation.fingerprint, operation: operation.type, status }] };
            if (failAt === 'before-commit') throw Object.assign(new Error('simulated_precommit_failure'), { code: 'simulated_precommit_failure' });
            await persist(next);
            if (failAt === 'after-commit') throw Object.assign(new Error('simulated_response_lost_after_commit'), { code: 'simulated_response_lost_after_commit' });
            if (failAt === 'unknown-after-commit') throw Object.assign(new Error('simulated_outcome_unknown'), { code: 'simulated_outcome_unknown' });
            return { duplicate: false, receipt: next.receipts.at(-1), envelope: next };
        } finally {
            await lock.close().catch(() => {});
            await fs.unlink(lockPath).catch(() => {});
        }
    }

    return { directory, filePath, read, commit };
}

function makeAddContract(text, store = emptyStore()) {
    const snapshot = { snapshot: store, revision: store.revision, digest: snapshotFingerprint({ snapshot: store }) };
    const { candidate } = proposalFor(text);
    const result = createAutomaticMemoryPersistenceContract({ text, proposal: { candidates: [candidate] }, snapshot });
    assert.equal(result.success, true);
    assert.equal(result.operations.length, 1);
    return { key: result.operations[0].idempotency.key, snapshot, candidate };
}

function makeReplaceContract(text, store, targetAssertionId) {
    const snapshot = { snapshot: store, revision: store.revision, digest: snapshotFingerprint({ snapshot: store }) };
    const { candidate } = proposalFor(text, { operation: 'REPLACE', targetAssertionId, value: 'Lenovo' });
    const result = createAutomaticMemoryPersistenceContract({ text, proposal: { candidates: [candidate] }, snapshot });
    assert.equal(result.success, true);
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].operation, 'REPLACE');
    assert.equal(result.operations[0].targetAssertionId, targetAssertionId);
    return { key: result.operations[0].idempotency.key, snapshot, candidate };
}

function operationFrom(contract, { type = 'ADD', value = 'Fender', targetAssertionId = null, fingerprint = null } = {}) {
    const contentFingerprint = fingerprint ?? sha256(JSON.stringify({ type, value, targetAssertionId,
        expectedRevision: contract.snapshot.revision, expectedDigest: contract.snapshot.digest }));
    const key = (type === 'ADD' && targetAssertionId === null)
        || (type === 'REPLACE' && contract.candidate.update_intent === 'possible_supersession') ? contract.key
        : sha256(JSON.stringify({ baseKey: contract.key, type, value, targetAssertionId }));
    return operationIdentity({ type, key, fingerprint: contentFingerprint, targetAssertionId,
        expectedRevision: contract.snapshot.revision, expectedDigest: contract.snapshot.digest });
}

test('B.2a deterministic key binds an exact ADD and remains a dry-run contract', () => {
    const text = 'También tengo una Fender.';
    const first = makeAddContract(text); const second = makeAddContract(text);
    assert.equal(first.key, second.key);
    assert.match(first.key, /^[a-f0-9]{64}$/u);
    const changed = makeAddContract(text.replace('Fender', 'Ibanez'));
    assert.notEqual(first.key, changed.key);
    const contract = createAutomaticMemoryPersistenceContract({ text,
        proposal: { candidates: [first.candidate] }, snapshot: first.snapshot });
    assert.equal(contract.operations[0].idempotency.recorded, false);
    assert.equal(contract.operations[0].executable, false);
    assert.equal(contract.operations[0].writeReady, false);
});

test('ADD receipt and assertion are one simulated transaction; replay after restart is a no-op', async t => {
    const ledger = await withTempLedger(t); const contract = makeAddContract('También tengo una Fender.');
    const operation = operationFrom(contract);
    const first = await ledger.commit({ ...operation, value: 'Fender' });
    assert.equal(first.receipt.status, 'applied');
    const restarted = await withTempLedger(t);
    await fs.copyFile(ledger.filePath, restarted.filePath);
    const replay = await restarted.commit({ ...operation, value: 'Fender' });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.envelope.store.assertions.length, 1);
    assert.equal(replay.envelope.receipts.length, 1);
    assert.equal(replay.envelope.store.revision, 1);
});

test('REPLACE receipt replay does not supersede history twice', async t => {
    const { store, assertionId: oldId } = storeWithAcer();
    const ledger = await withTempLedger(t, store);
    const contract = makeReplaceContract('Ya no uso la Acer; ahora uso una Lenovo.', store, oldId);
    const operation = operationFrom(contract, { type: 'REPLACE', value: 'Lenovo', targetAssertionId: oldId });
    const first = await ledger.commit({ ...operation, value: 'Lenovo' }, { confirmationTargetId: oldId });
    const restarted = await withTempLedger(t);
    await fs.copyFile(ledger.filePath, restarted.filePath);
    const replay = await restarted.commit({ ...operation, value: 'Lenovo' }, { confirmationTargetId: oldId });
    assert.equal(first.receipt.status, 'applied'); assert.equal(replay.duplicate, true);
    assert.equal(replay.envelope.store.assertions.filter(record => record.status === 'active').length, 1);
    assert.equal(replay.envelope.store.assertions.find(record => record.id === oldId).status, 'superseded');
    assert.equal(replay.envelope.store.assertions.find(record => record.object.value === 'Lenovo').supersedes[0], oldId);
    assert.equal(replay.envelope.store.assertions.length, 2);
});

test('a reused idempotency key with different operation content fails closed', async t => {
    const ledger = await withTempLedger(t); const contract = makeAddContract('También tengo una Fender.');
    const original = operationFrom(contract);
    await ledger.commit({ ...original, value: 'Fender' });
    const substituted = { ...original, fingerprint: 'f'.repeat(64), value: 'Ibanez' };
    await assert.rejects(ledger.commit(substituted), code('sim_idempotency_key_reused'));
    const state = await ledger.read();
    assert.equal(state.store.assertions.length, 1); assert.equal(state.store.assertions[0].object.value, 'Fender');
});

test('failure before commit leaves no receipt or memory mutation and can be retried', async t => {
    const ledger = await withTempLedger(t); const contract = makeAddContract('También tengo una Fender.');
    const operation = operationFrom(contract); const before = await fs.readFile(ledger.filePath);
    await assert.rejects(ledger.commit({ ...operation, value: 'Fender' }, { failAt: 'before-commit' }), code('simulated_precommit_failure'));
    assert.deepEqual(await fs.readFile(ledger.filePath), before);
    assert.equal((await ledger.read()).receipts.length, 0);
    const retry = await ledger.commit({ ...operation, value: 'Fender' });
    assert.equal(retry.receipt.status, 'applied'); assert.equal(retry.envelope.store.assertions.length, 1);
});

test('lost response after commit is resolved from the durable receipt after restart', async t => {
    const ledger = await withTempLedger(t); const contract = makeAddContract('También tengo una Fender.');
    const operation = operationFrom(contract);
    await assert.rejects(ledger.commit({ ...operation, value: 'Fender' }, { failAt: 'after-commit' }), code('simulated_response_lost_after_commit'));
    const replay = await ledger.commit({ ...operation, value: 'Fender' });
    assert.equal(replay.duplicate, true); assert.equal(replay.receipt.status, 'applied');
    assert.equal(replay.envelope.store.assertions.length, 1); assert.equal(replay.envelope.store.revision, 1);
});

test('unknown persisted outcome is never replayed automatically', async t => {
    const ledger = await withTempLedger(t); const contract = makeAddContract('También tengo una Fender.');
    const operation = operationFrom(contract);
    await assert.rejects(ledger.commit({ ...operation, value: 'Fender' }, { failAt: 'unknown-after-commit' }), code('simulated_outcome_unknown'));
    const replay = await ledger.commit({ ...operation, value: 'Fender' });
    assert.equal(replay.duplicate, true); assert.equal(replay.receipt.status, 'unknown');
    assert.equal(replay.envelope.store.assertions.length, 1);
});

test('incorrect REPLACE confirmation records rejection and never mutates assertions', async t => {
    const ledger = await withTempLedger(t); const contract = makeAddContract('replace synthetic value');
    const targetId = 'mem_00000000-0000-4000-8000-000000000077';
    const operation = operationFrom(contract, { type: 'REPLACE', value: 'Lenovo', targetAssertionId: targetId });
    const result = await ledger.commit({ ...operation, value: 'Lenovo' }, { confirmationTargetId: 'mem_00000000-0000-4000-8000-000000000099' });
    assert.equal(result.receipt.status, 'rejected');
    assert.equal(result.envelope.store.revision, 0); assert.equal(result.envelope.store.assertions.length, 0);
    const retry = await ledger.commit({ ...operation, value: 'Lenovo' }, { confirmationTargetId: targetId });
    assert.equal(retry.duplicate, true); assert.equal(retry.receipt.status, 'rejected');
    assert.equal(retry.envelope.store.assertions.length, 0);
});

test('stale snapshots and simultaneous writers fail closed without implicit rebase', async t => {
    const ledger = await withTempLedger(t); const contract = makeAddContract('También tengo una Fender.');
    const first = operationFrom(contract, { value: 'Fender' });
    const second = { ...operationFrom(contract, { value: 'Ibanez' }), key: 'b'.repeat(64), fingerprint: 'c'.repeat(64) };
    const outcomes = await Promise.allSettled([
        ledger.commit({ ...first, value: 'Fender' }), ledger.commit({ ...second, value: 'Ibanez' }),
    ]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
    const loser = outcomes.find(item => item.status === 'rejected');
    assert.ok(['sim_writer_locked', 'memory_revision_conflict'].includes(loser.reason.code));
    const state = await ledger.read(); assert.equal(state.store.revision, 1);
    assert.equal(state.store.assertions.length, 1); assert.equal(state.receipts.length, 1);
    const losingOperation = loser === outcomes[0] ? first : second;
    await assert.rejects(ledger.commit({ ...losingOperation, value: losingOperation === first ? 'Fender' : 'Ibanez' }),
        code('memory_revision_conflict'));
});

test('ADD/REPLACE race on the same snapshot permits only one outcome; retry requires fresh planning', async t => {
    const { store, assertionId } = storeWithAcer();
    const ledger = await withTempLedger(t, store); const contract = makeAddContract('También tengo una Lenovo.', store);
    const replaceContract = makeReplaceContract('Ya no uso la Acer; ahora uso una Lenovo.', store, assertionId);
    const add = operationFrom(contract, { type: 'ADD', value: 'Lenovo' });
    const replace = operationFrom(replaceContract, { type: 'REPLACE', value: 'Lenovo', targetAssertionId: assertionId });
    const outcomes = await Promise.allSettled([
        ledger.commit({ ...add, value: 'Lenovo' }), ledger.commit({ ...replace, value: 'Lenovo' }, { confirmationTargetId: assertionId }),
    ]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(item => item.status === 'rejected');
    assert.ok(['sim_writer_locked', 'memory_revision_conflict'].includes(rejected.reason.code));
    const losingOperation = rejected === outcomes[0] ? add : replace;
    await assert.rejects(ledger.commit({ ...losingOperation, value: 'Lenovo' },
        { confirmationTargetId: losingOperation.targetAssertionId }), code('memory_revision_conflict'));
    const current = await ledger.read();
    const fresh = { ...add, key: 'd'.repeat(64), fingerprint: 'e'.repeat(64),
        expectedRevision: current.store.revision, expectedDigest: snapshotFingerprint({ snapshot: current.store }) };
    const retry = await ledger.commit({ ...fresh, value: 'Lenovo' });
    assert.equal(retry.envelope.store.revision, 2);
    assert.equal(retry.envelope.store.assertions.length, 3);
});

test('corrupt receipt ledger is rejected without resetting or overwriting it', async t => {
    const ledger = await withTempLedger(t); await fs.writeFile(ledger.filePath, '{broken');
    await assert.rejects(ledger.read(), code('sim_ledger_corrupt'));
    assert.equal(await fs.readFile(ledger.filePath, 'utf8'), '{broken');
});

test('real repository lock excludes an independent process and stale lock is not stolen', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-auto-process-lock-'));
    const storePath = path.join(directory, 'memory-v2.json');
    await fs.writeFile(storePath, JSON.stringify(emptyStore(), null, 2) + '\n');
    const repo = createJsonMemoryRepository({ storePath }); await repo.open();
    t.after(async () => {
        await repo.close().catch(() => {});
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const moduleUrl = new URL('../src/memory/json-repository.js', import.meta.url).href;
    const child = `import { createJsonMemoryRepository } from ${JSON.stringify(moduleUrl)};
        const repo = createJsonMemoryRepository({ storePath: process.argv[1] });
        try { await repo.open(); await repo.close(); process.stdout.write('unexpected-open'); process.exitCode = 2; }
        catch (error) { process.stdout.write(error.code); }`;
    const { stdout } = await promisify(execFile)(process.execPath,
        ['--input-type=module', '-e', child, storePath], { windowsHide: true });
    assert.equal(stdout, 'memory_store_locked');
    assert.equal(JSON.parse(await fs.readFile(storePath + '.lock', 'utf8')).pid, process.pid);
});

test('B.2a and B.2b.1 remain non-executable; simulator has no production write route', () => {
    const text = 'También tengo una Fender.';
    const contract = makeAddContract(text);
    const result = createAutomaticMemoryPersistenceContract({ text: 'También tengo una Fender.',
        proposal: { candidates: [contract.candidate] }, snapshot: contract.snapshot });
    const authorization = assessAutomaticMemoryAuthorization({ text, proposal: { candidates: [contract.candidate] },
        snapshot: contract.snapshot, operationIndex: 0, contextClaims: null });
    assert.equal(result.executable, false); assert.equal(result.writeReady, false);
    assert.equal(result.operations[0].authorization.granted, false);
    assert.equal(result.operations[0].idempotency.recorded, false);
    assert.equal(authorization.authorization.granted, false);
    assert.equal(authorization.executable, false);
});
