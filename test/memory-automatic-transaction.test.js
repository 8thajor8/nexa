import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'person_00000000-0000-4000-8000-000000000001';
const TIME = '2036-02-03T10:00:00.000Z';
const ADD_TEXT = 'También tengo una Fender.';
const REPLACE_TEXT = 'Ya no uso mi laptop Acer; ahora uso una Lenovo.';
const hash = value => createHash('sha256').update(value).digest('hex');
const id = prefix => `${prefix}_${randomUUID()}`;

function store({ replace = false } = {}) {
    const assertions = [], sources = [], evidence = [];
    if (replace) {
        const assertionId = id('mem'), sourceId = id('src');
        assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: SELF },
            predicate: 'user.uses_tool', object: { type: 'text', value: 'Acer' }, status: 'active',
            valid_from: null, valid_to: null, recorded_at: TIME, supersedes: [], compatibility: null });
        sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: TIME });
        evidence.push({ id: id('ev'), assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: null, learned_at: TIME, last_confirmed_at: null, legacy_ref: null });
    }
    return { schema_version: 5, store_id: id('store'), self_person_id: SELF, revision: 0,
        created_at: TIME, updated_at: TIME, entities: [{ id: SELF, type: 'person', created_at: TIME }],
        assertions, sources, evidence, migrations: [], automatic_operations: [] };
}

function proposal(text, replace = false, value = replace ? 'Lenovo' : 'Fender') {
    return { candidates: [{ candidate_type: replace ? 'tool' : 'purchase', subject_text: 'user',
        predicate: replace ? 'user.uses_tool' : 'user.owns_item', value_text: value,
        mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.96,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' },
        update_intent: replace ? 'possible_correction' : 'addition', sensitivity: 'none',
        suggested_disposition: 'auto_save', evidence_quote: text }] };
}

async function setup(t, data) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-auto-tx-'));
    const storePath = path.join(directory, 'memory-v2.json');
    await fs.writeFile(storePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    const repository = createJsonMemoryRepository({ storePath, now: () => '2036-02-03T10:20:30.000Z' });
    t.after(async () => {
        await repository.close().catch(() => {});
        const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { repository, storePath, directory };
}

function workerScript({ text, replace = false, mode = 'apply' }) {
    const prop = proposal(text, replace);
    const operation = `text: turn.message, proposal: ${JSON.stringify(prop)}, snapshot, operationIndex: 0, recipient`;
    const special = ['failWrite', 'failSync', 'failRename', 'renameThenThrow', 'uncertainAfterRename'].includes(mode);
    let flow;
    if (mode === 'alterReceiptReplay') {
        flow = `const first = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
await repo.close();
const rawStore = JSON.parse(await nativeFs.readFile(process.argv[1], 'utf8'));
rawStore.automatic_operations[0].operation_fingerprint_sha256 = 'f'.repeat(64);
await nativeFs.writeFile(process.argv[1], JSON.stringify(rawStore, null, 2) + '\\n', 'utf8');
await repo.open();
const recipient2 = {};
const turn2 = await readDirectUserTurn(recipient2);
const prepared2 = prepareAutomaticMemoryAuthorization({ text: turn2.message, proposal: ${JSON.stringify(prop)}, snapshot,
  operationIndex: 0, recipient: recipient2, runtimeContextCapability: turn2.runtimeContextCapability });
const grant2 = await confirmAutomaticMemoryAuthorization(prepared2.request, recipient2);
const replay = await repo.commitAutomaticOperation({ text: turn2.message, proposal: ${JSON.stringify(prop)}, snapshot,
  operationIndex: 0, recipient: recipient2, capability: grant2.capability });
const current = await repo.readSnapshot();
console.log('__RESULT__' + JSON.stringify({ first, replay, revision: current.revision,
  assertions: current.snapshot.assertions.length, receipts: current.snapshot.automatic_operations.length }));`;
    } else if (mode === 'lockPreflight') {
        flow = `const lockPath = process.argv[1] + '.lock';
const lockBytes = await nativeFs.readFile(lockPath);
await nativeFs.unlink(lockPath);
let beforeLock;
try { await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability }); }
catch (error) { beforeLock = error.code; }
await nativeFs.writeFile(lockPath, lockBytes, { flag: 'wx' });
const retry = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
console.log('__RESULT__' + JSON.stringify({ beforeLock, retry }));`;
    } else if (mode === 'closedPreflight') {
        flow = `await repo.close();
let beforeOpen;
try { await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability }); }
catch (error) { beforeOpen = error.code; }
await repo.open();
const retry = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
console.log('__RESULT__' + JSON.stringify({ beforeOpen, retry }));`;
    } else if (mode === 'sameCapabilityRace') {
        flow = `const results = await Promise.allSettled([
  repo.commitAutomaticOperation({ ${operation}, capability: grant.capability }),
  repo.commitAutomaticOperation({ ${operation}, capability: grant.capability }),
]);
const current = await repo.readSnapshot();
console.log('__RESULT__' + JSON.stringify({ outcomes: results.map(item => item.status === 'fulfilled' ? item.value : { error: item.reason.code }),
  revision: current.revision, assertions: current.snapshot.assertions.length, receipts: current.snapshot.automatic_operations.length }));`;
    } else if (mode.startsWith('race')) {
        const secondText = mode === 'raceAdd' ? 'También tengo una Ibanez.'
            : mode === 'raceSameOperation' ? text
            : mode === 'raceAddReplace' ? 'Ya no uso mi laptop Acer; ahora uso una Lenovo.'
                : 'Ya no uso mi laptop Acer; ahora uso una ThinkPad.';
        const secondReplace = mode === 'raceAddReplace' || mode === 'raceReplace';
        const secondProp = proposal(secondText, secondReplace,
            mode === 'raceAdd' ? 'Ibanez' : mode === 'raceReplace' ? 'ThinkPad' : undefined);
        flow = `const recipient2 = {};
const turn2 = await readDirectUserTurn(recipient2);
const snapshot2 = await repo.readAutomaticMemorySnapshot();
const prepared2 = prepareAutomaticMemoryAuthorization({ text: turn2.message, proposal: ${JSON.stringify(secondProp)}, snapshot: snapshot2,
  operationIndex: 0, recipient: recipient2, runtimeContextCapability: turn2.runtimeContextCapability });
const grant2 = await confirmAutomaticMemoryAuthorization(prepared2.request, recipient2);
const results = await Promise.allSettled([
  repo.commitAutomaticOperation({ ${operation}, capability: grant.capability }),
  repo.commitAutomaticOperation({ text: turn2.message, proposal: ${JSON.stringify(secondProp)}, snapshot: snapshot2,
    operationIndex: 0, recipient: recipient2, capability: grant2.capability }),
]);
const current = await repo.readSnapshot();
console.log('__RESULT__' + JSON.stringify({ outcomes: results.map(item => item.status === 'fulfilled' ? item.value : { error: item.reason.code }),
  revision: current.revision, assertions: current.snapshot.assertions.map(item => ({ id: item.id, value: item.object.value, status: item.status, supersedes: item.supersedes })),
  receipts: current.snapshot.automatic_operations.length }));`;
    } else if (mode === 'withoutGrant') {
        flow = `const result = await repo.commitAutomaticOperation({ ${operation}, capability: {} });\nconsole.log('__RESULT__' + JSON.stringify(result));`;
    } else if (mode === 'stale') {
        flow = `const raw = await repo.readSnapshot();
await repo.commit({ expectedRevision: raw.revision, expectedDigest: raw.digest, changes: [{ type: 'put', collection: 'sources', record: { id: 'src_' + randomUUID(), kind: 'inference', origin_trust: 'derived_untrusted', authority: 'data_only', locator: null, occurred_at: null, recorded_at: '2036-02-03T10:20:30.000Z' } }] });
const result = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
const replay = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
console.log('__RESULT__' + JSON.stringify({ result, replay }));`;
    } else if (special) {
        flow = `let result;
try { result = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability }); }
catch (error) { result = { thrown: error.code ?? error.message }; }
const retry = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability }).catch(error => ({ thrown: error.code ?? error.message }));
const names = await nativeFs.readdir((await import('node:path')).dirname(process.argv[1]));
await repo.close();
const reopened = createJsonMemoryRepository({ storePath: process.argv[1] });
await reopened.open();
const recovered = await reopened.readSnapshot();
const replay = await reopened.commitAutomaticOperation({ ${operation}, capability: grant.capability });
console.log('__RESULT__' + JSON.stringify({ result, retry, replay, recoveredRevision: recovered.revision,
  recoveredAssertions: recovered.snapshot.assertions.length, recoveredReceipts: recovered.snapshot.automatic_operations.length,
  tempFiles: names.filter(name => name.endsWith('.tmp')) }));`;
    } else if (mode === 'applyAndReplay') {
        flow = `const result = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
const replay = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
await repo.close();
const reopened = createJsonMemoryRepository({ storePath: process.argv[1] });
await reopened.open();
const recovered = await reopened.readSnapshot();
const reopenReplay = await reopened.commitAutomaticOperation({ ${operation}, capability: grant.capability });
await reopened.close();
console.log('__RESULT__' + JSON.stringify({ result, replay, reopenReplay, recoveredRevision: recovered.revision }));`;
    } else {
        flow = `const result = await repo.commitAutomaticOperation({ ${operation}, capability: grant.capability });
console.log('__RESULT__' + JSON.stringify(result));`;
    }
    return `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { randomUUID } from 'node:crypto';
import { prepareAutomaticMemoryAuthorization, confirmAutomaticMemoryAuthorization } from './src/memory/automatic/authorization-coordinator.js';
import { createJsonMemoryRepository } from './src/memory/json-repository.js';
import * as nativeFs from 'node:fs/promises';
const recipient = {};
let storeReads = 0;
let injectedRenamePublished = false;
const fileSystem = ${JSON.stringify(special)} ? {
  open: async (...args) => {
    const handle = await nativeFs.open(...args);
    if (!String(args[0]).endsWith('.tmp')) return handle;
    return {
      writeFile: async (...writeArgs) => ${mode === 'failWrite' ? "(async () => { await handle.writeFile(Buffer.from(writeArgs[0]).subarray(0, 8)); throw Object.assign(new Error('injected_write_failure'), { code: 'EIO' }); })()" : 'handle.writeFile(...writeArgs)'},
      sync: async () => ${mode === 'failSync' ? "Promise.reject(Object.assign(new Error('injected_sync_failure'), { code: 'EIO' }))" : 'handle.sync()'},
      close: () => handle.close(),
    };
  },
  rename: async (...args) => {
    ${mode === 'failRename' ? "throw Object.assign(new Error('injected_rename_failure'), { code: 'EIO' });" : ''}
    await nativeFs.rename(...args);
    ${mode === 'uncertainAfterRename' ? 'injectedRenamePublished = true;' : ''}
    ${mode === 'renameThenThrow' || mode === 'uncertainAfterRename' ? "throw Object.assign(new Error('injected_post_rename_failure'), { code: 'EIO' });" : ''}
  },
  readFile: async (...args) => {
    if (String(args[0]) === process.argv[1]) {
      storeReads += 1;
      ${mode === 'uncertainAfterRename' ? "if (injectedRenamePublished) throw Object.assign(new Error('injected_reconcile_read_failure'), { code: 'EIO' });" : ''}
    }
    return nativeFs.readFile(...args);
  },
} : {};
const repo = createJsonMemoryRepository({ storePath: process.argv[1], fileSystem, now: () => '2036-02-03T10:20:30.000Z' });
await repo.open();
const turn = await readDirectUserTurn(recipient);
const snapshot = await repo.readAutomaticMemorySnapshot();
const prepared = prepareAutomaticMemoryAuthorization({ text: turn.message,
  proposal: ${JSON.stringify(prop)}, snapshot, operationIndex: 0, recipient,
  runtimeContextCapability: turn.runtimeContextCapability });
${mode === 'withoutGrant' ? '' : `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
`}
${flow}
await repo.close(); closeDirectUserInput();
`;
}

async function runWorker({ storePath, text, replace = false, mode = 'apply' }) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript({ text, replace, mode }), storePath], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', sentConfirmations = 0;
    child.stdin.write(text + '\n');
    child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        const prompts = [...stdout.matchAll(/Para confirmar, escribí exactamente: (CONFIRM (?:ADD [A-F0-9]{12}|REPLACE mem_[0-9a-f-]{36} [A-F0-9]{12}))/gu)];
        while (sentConfirmations < prompts.length) {
            child.stdin.write(prompts[sentConfirmations][1] + '\n');
            sentConfirmations += 1;
            if ((mode.startsWith('race') || mode === 'alterReceiptReplay') && sentConfirmations === 1) {
                child.stdin.write((mode === 'raceAdd' ? 'También tengo una Ibanez.'
                    : mode === 'raceSameOperation' ? text
                    : mode === 'alterReceiptReplay' ? text
                    : mode === 'raceAddReplace' ? 'Ya no uso mi laptop Acer; ahora uso una Lenovo.'
                        : 'Ya no uso mi laptop Acer; ahora uso una ThinkPad.') + '\n');
            }
        }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
        setTimeout(() => { if (child.exitCode === null) child.kill(); }, 10000).unref();
    });
    assert.equal(exitCode, 0, stderr + stdout);
    return JSON.parse(stdout.split('__RESULT__')[1]);
}

test('authorized ADD publishes assertion, evidence, provenance, and receipt in one revision; exact retry is read-only', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'applyAndReplay' });
    assert.equal(result.result.success, true, JSON.stringify(result)); assert.equal(result.result.outcome, 'applied');
    assert.equal(result.result.revision, 1);
    assert.deepEqual(result.replay, { success: true, outcome: 'already_applied', revision: 1 });
    assert.deepEqual(result.reopenReplay, { success: true, outcome: 'already_applied', revision: 1 });
    assert.equal(result.recoveredRevision, 1);
    await f.repository.open();
    const current = await f.repository.readSnapshot();
    assert.equal(current.revision, 1);
    assert.equal(current.snapshot.assertions.length, 1);
    assert.equal(current.snapshot.assertions[0].object.value, 'Fender');
    assert.equal(current.snapshot.sources[0].kind, 'inference');
    assert.equal(current.snapshot.evidence[0].derivation, 'inferred');
    assert.equal(current.snapshot.automatic_operations.length, 1);
    const receipt = current.snapshot.automatic_operations[0];
    assert.equal(receipt.expected_revision, 0); assert.equal(receipt.result_revision, 1);
    assert.match(receipt.authorization_request_id, /^req_[0-9a-f-]{36}$/u);
    const originalBytes = await fs.readFile(f.storePath, 'utf8');
    assert.equal(hash(originalBytes), current.digest);
    await assert.rejects(f.repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
        changes: [{ type: 'put', collection: 'automatic_operations', record: { ...receipt,
            operation_fingerprint_sha256: 'f'.repeat(64) } }] }), { code: 'memory_invalid_changes' });
    await assert.rejects(f.repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
        changes: [{ type: 'delete', collection: 'automatic_operations', operation_key: receipt.operation_key }] }),
    { code: 'memory_invalid_changes' });
    assert.equal(await fs.readFile(f.storePath, 'utf8'), originalBytes);
});

test('authorized REPLACE mutates only the confirmed target and preserves superseded history', async t => {
    const initial = store({ replace: true });
    const target = initial.assertions[0].id;
    const f = await setup(t, initial);
    const result = await runWorker({ storePath: f.storePath, text: REPLACE_TEXT, replace: true, mode: 'applyAndReplay' });
    assert.equal(result.result.outcome, 'applied', JSON.stringify(result));
    assert.equal(result.replay.outcome, 'already_applied');
    assert.equal(result.reopenReplay.outcome, 'already_applied');
    assert.equal(result.recoveredRevision, 1);
    await f.repository.open();
    const current = await f.repository.readSnapshot();
    assert.equal(current.revision, 1);
    assert.equal(current.snapshot.assertions.length, 2);
    assert.equal(current.snapshot.assertions.find(item => item.id === target).status, 'superseded');
    const replacement = current.snapshot.assertions.find(item => item.status === 'active');
    assert.equal(replacement.object.value, 'Lenovo'); assert.deepEqual(replacement.supersedes, [target]);
    assert.equal(current.snapshot.evidence.length, 2);
    assert.equal(current.snapshot.automatic_operations[0].target_assertion_id, target);
});

test('no capability and generic commit cannot publish automatic receipts', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'withoutGrant' });
    assert.equal(result.success, false);
    await f.repository.open();
    const current = await f.repository.readSnapshot();
    assert.equal(current.revision, 0); assert.equal(current.snapshot.automatic_operations.length, 0);
    const receipt = { operation_key: 'a'.repeat(64), operation_fingerprint_sha256: 'b'.repeat(64),
        operation_kind: 'ADD', status: 'applied', authorization_request_id: 'req_00000001-1111-4111-8111-111111111111',
        expected_revision: 0, expected_digest: current.digest, result_revision: 1,
        result_assertion_id: id('mem'), target_assertion_id: null, result_code: null, recorded_at: TIME };
    await assert.rejects(f.repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
        changes: [{ type: 'put', collection: 'automatic_operations', record: receipt }] }), { code: 'memory_invalid_changes' });
    assert.equal((await f.repository.readSnapshot()).revision, 0);
});

test('stale authorized snapshot burns capability and never writes', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'stale' });
    assert.deepEqual(result, { result: { success: false, outcome: 'rejected', error: { code: 'memory_revision_conflict' } },
        replay: { success: false, outcome: 'rejected', error: { code: 'authorization_capability_invalid_or_consumed' } } });
    await f.repository.open();
    const current = await f.repository.readSnapshot();
    assert.equal(current.revision, 1); assert.equal(current.snapshot.assertions.length, 0);
    assert.equal(current.snapshot.automatic_operations.length, 0);
});

for (const mode of ['failWrite', 'failSync', 'failRename']) {
    test(`real repository ${mode}: pre-publication failure keeps v5 store unchanged and burns the capability`, async t => {
        const f = await setup(t, store());
        const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode });
        assert.equal(result.result.thrown, 'memory_persist_failed', JSON.stringify(result));
        assert.deepEqual(result.retry, { success: false, outcome: 'rejected',
            error: { code: 'authorization_capability_invalid_or_consumed' } });
        assert.equal(result.recoveredRevision, 0);
        assert.equal(result.recoveredAssertions, 0);
        assert.equal(result.recoveredReceipts, 0);
        assert.equal(result.replay.success, false);
        assert.deepEqual(result.tempFiles, []);
    });
}

test('real repository reconciles a rename that published then raised an error; replay is read-only', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'renameThenThrow' });
    assert.equal(result.result.success, true, JSON.stringify(result));
    assert.equal(result.result.outcome, 'applied');
    assert.deepEqual(result.retry, { success: true, outcome: 'already_applied', revision: 1 });
    assert.deepEqual(result.replay, { success: true, outcome: 'already_applied', revision: 1 });
    assert.equal(result.recoveredRevision, 1);
    assert.equal(result.recoveredAssertions, 1);
    assert.equal(result.recoveredReceipts, 1);
    assert.deepEqual(result.tempFiles, []);
});

test('real repository fails closed when publication succeeds but reconciliation cannot read; reopen finds the receipt', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'uncertainAfterRename' });
    assert.equal(result.result.thrown, 'memory_commit_uncertain', JSON.stringify(result));
    assert.equal(result.retry.thrown, 'memory_commit_uncertain');
    assert.equal(result.recoveredRevision, 1);
    assert.equal(result.recoveredAssertions, 1);
    assert.equal(result.recoveredReceipts, 1);
    assert.deepEqual(result.replay, { success: true, outcome: 'already_applied', revision: 1 });
    assert.deepEqual(result.tempFiles, []);
});

test('concurrent authorized ADDs on one snapshot commit one winner and reject the stale plan', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'raceAdd' });
    assert.equal(result.revision, 1);
    assert.equal(result.assertions.length, 1);
    assert.equal(result.receipts, 1);
    assert.equal(result.outcomes.filter(item => item.outcome === 'applied').length, 1);
    assert.equal(result.outcomes.filter(item => item.error?.code === 'memory_revision_conflict').length, 1, JSON.stringify(result.outcomes));
});

test('concurrent ADD and REPLACE on one snapshot cannot lose or silently replace data', async t => {
    const f = await setup(t, store({ replace: true }));
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'raceAddReplace' });
    assert.equal(result.revision, 1);
    assert.equal(result.receipts, 1);
    assert.ok([1, 2].includes(result.assertions.filter(item => item.status === 'active').length));
    if (result.assertions.filter(item => item.status === 'active').length === 1)
        assert.equal(result.assertions.find(item => item.status === 'superseded').value, 'Acer');
    else assert.equal(result.assertions.find(item => item.value === 'Acer').status, 'active');
    assert.equal(result.outcomes.filter(item => item.outcome === 'applied').length, 1);
    assert.equal(result.outcomes.filter(item => item.error?.code === 'memory_revision_conflict').length, 1);
});

test('two concurrent REPLACE approvals for the same target cannot both supersede it', async t => {
    const f = await setup(t, store({ replace: true }));
    const result = await runWorker({ storePath: f.storePath, text: REPLACE_TEXT, replace: true, mode: 'raceReplace' });
    assert.equal(result.revision, 1);
    assert.equal(result.receipts, 1);
    assert.equal(result.assertions.filter(item => item.status === 'active').length, 1);
    assert.equal(result.assertions.filter(item => item.status === 'superseded').length, 1);
    assert.equal(result.outcomes.filter(item => item.outcome === 'applied').length, 1);
    assert.equal(result.outcomes.filter(item => item.error?.code === 'memory_revision_conflict').length, 1);
});

test('two capabilities for the identical operation racing on one snapshot converge to one receipt', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'raceSameOperation' });
    assert.equal(result.revision, 1);
    assert.equal(result.assertions.length, 1);
    assert.equal(result.receipts, 1);
    assert.equal(result.outcomes.filter(item => item.outcome === 'applied').length, 1);
    assert.equal(result.outcomes.filter(item => item.outcome === 'already_applied').length, 1);
});

test('racing attempts with one capability publish once; the retry is a receipt-only replay', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'sameCapabilityRace' });
    assert.equal(result.revision, 1);
    assert.equal(result.assertions, 1);
    assert.equal(result.receipts, 1);
    assert.equal(result.outcomes.filter(item => item.outcome === 'applied').length, 1);
    assert.equal(result.outcomes.filter(item => item.outcome === 'already_applied').length, 1);
});

test('a repository-closed preflight failure occurs before capability consumption and exact retry can proceed after reopening', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'closedPreflight' });
    assert.equal(result.beforeOpen, 'memory_repository_closed');
    assert.equal(result.retry.success, true, JSON.stringify(result));
    assert.equal(result.retry.outcome, 'applied');
    await f.repository.open();
    const current = await f.repository.readSnapshot();
    assert.equal(current.revision, 1);
    assert.equal(current.snapshot.automatic_operations.length, 1);
});

test('lock verification failure occurs before capability consumption; restoring ownership permits exact retry', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'lockPreflight' });
    assert.equal(result.beforeLock, 'memory_lock_lost');
    assert.equal(result.retry.success, true, JSON.stringify(result));
    assert.equal(result.retry.outcome, 'applied');
});

test('a persisted key paired with a different fingerprint fails closed without a new revision', async t => {
    const f = await setup(t, store());
    const result = await runWorker({ storePath: f.storePath, text: ADD_TEXT, mode: 'alterReceiptReplay' });
    assert.equal(result.first.outcome, 'applied');
    assert.deepEqual(result.replay, { success: false, outcome: 'rejected', error: { code: 'automatic_idempotency_conflict' } });
    assert.equal(result.revision, 1);
    assert.equal(result.assertions, 1);
    assert.equal(result.receipts, 1);
});

test('a corrupt real store is rejected on open and left byte-for-byte untouched', async t => {
    const f = await setup(t, store());
    await f.repository.close();
    const corrupt = '{not-json';
    await fs.writeFile(f.storePath, corrupt, 'utf8');
    const reopened = createJsonMemoryRepository({ storePath: f.storePath });
    await assert.rejects(reopened.open(), { code: 'memory_store_corrupt' });
    assert.equal(await fs.readFile(f.storePath, 'utf8'), corrupt);
    await reopened.close();
});
