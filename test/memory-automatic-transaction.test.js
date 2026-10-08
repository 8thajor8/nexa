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

function proposal(text, replace = false) {
    return { candidates: [{ candidate_type: replace ? 'tool' : 'purchase', subject_text: 'user',
        predicate: replace ? 'user.uses_tool' : 'user.owns_item', value_text: replace ? 'Lenovo' : 'Fender',
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
    return `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { randomUUID } from 'node:crypto';
import { prepareAutomaticMemoryAuthorization, confirmAutomaticMemoryAuthorization } from './src/memory/automatic/authorization-coordinator.js';
import { createJsonMemoryRepository } from './src/memory/json-repository.js';
const recipient = {};
const repo = createJsonMemoryRepository({ storePath: process.argv[1], now: () => '2036-02-03T10:20:30.000Z' });
await repo.open();
const turn = await readDirectUserTurn(recipient);
const snapshot = await repo.readAutomaticMemorySnapshot();
const prepared = prepareAutomaticMemoryAuthorization({ text: turn.message,
  proposal: ${JSON.stringify(prop)}, snapshot, operationIndex: 0, recipient,
  runtimeContextCapability: turn.runtimeContextCapability });
${mode === 'withoutGrant' ? `
const result = await repo.commitAutomaticOperation({ text: turn.message, proposal: ${JSON.stringify(prop)}, snapshot,
  operationIndex: 0, recipient, capability: {} });
console.log('__RESULT__' + JSON.stringify(result));` : `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
${mode === 'stale' ? `
const raw = await repo.readSnapshot();
await repo.commit({ expectedRevision: raw.revision, expectedDigest: raw.digest, changes: [{ type: 'put', collection: 'sources',
  record: { id: 'src_' + randomUUID(), kind: 'inference', origin_trust: 'derived_untrusted', authority: 'data_only',
    locator: null, occurred_at: null, recorded_at: '2036-02-03T10:20:30.000Z' } }] });
const result = await repo.commitAutomaticOperation({ text: turn.message, proposal: ${JSON.stringify(prop)}, snapshot,
  operationIndex: 0, recipient, capability: grant.capability });
const replay = await repo.commitAutomaticOperation({ text: turn.message, proposal: ${JSON.stringify(prop)}, snapshot,
  operationIndex: 0, recipient, capability: grant.capability });
console.log('__RESULT__' + JSON.stringify({ result, replay }));` : `
const result = await repo.commitAutomaticOperation({ text: turn.message, proposal: ${JSON.stringify(prop)}, snapshot,
  operationIndex: 0, recipient, capability: grant.capability });
${mode === 'applyAndReplay' ? `
const replay = await repo.commitAutomaticOperation({ text: turn.message, proposal: ${JSON.stringify(prop)}, snapshot,
  operationIndex: 0, recipient, capability: grant.capability });
console.log('__RESULT__' + JSON.stringify({ result, replay }));` : `
console.log('__RESULT__' + JSON.stringify(result));`}`}`}
await repo.close(); closeDirectUserInput();
`;
}

async function runWorker({ storePath, text, replace = false, mode = 'apply' }) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript({ text, replace, mode }), storePath], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', sentConfirmation = false;
    child.stdin.write(text + '\n');
    child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        if (sentConfirmation) return;
        const match = stdout.match(/Para confirmar, escribí exactamente: (CONFIRM (?:ADD [A-F0-9]{12}|REPLACE mem_[0-9a-f-]{36} [A-F0-9]{12}))/u);
        if (match) { sentConfirmation = true; child.stdin.write(match[1] + '\n'); }
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
    const result = await runWorker({ storePath: f.storePath, text: REPLACE_TEXT, replace: true });
    assert.equal(result.outcome, 'applied', JSON.stringify(result));
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
