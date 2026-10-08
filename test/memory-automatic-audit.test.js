import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'person_00000000-0000-4000-8000-000000000001';
const TIME = '2036-02-03T10:00:00.000Z';
const ADD_TEXT = 'También tengo una Fender.';
const REPLACE_TEXT = 'Ya no uso mi laptop Acer; ahora uso una Lenovo.';
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

function proposal(text, { replace = false, sensitivity = 'none', extraCandidateFields = {} } = {}) {
    return { candidates: [{ candidate_type: replace ? 'tool' : 'purchase', subject_text: 'user',
        predicate: replace ? 'user.uses_tool' : 'user.owns_item', value_text: replace ? 'Lenovo' : 'Fender',
        mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.96,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' },
        update_intent: replace ? 'possible_correction' : 'addition', sensitivity,
        suggested_disposition: 'ignore', evidence_quote: text, ...extraCandidateFields }] };
}

async function makeStore(t, value) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-auto-audit-'));
    const storePath = path.join(directory, 'memory-v2.json');
    await fs.writeFile(storePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    t.after(async () => {
        const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return storePath;
}

function worker({ text, proposed, replace = false, confirm = true }) {
    return `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { createAutomaticMemoryDetector } from './src/memory/automatic/detector.js';
import { planAutomaticMemoryPersistence } from './src/memory/automatic/planner.js';
import { createAutomaticMemoryPersistenceContract } from './src/memory/automatic/persistence-contract.js';
import { prepareAutomaticMemoryAuthorization, confirmAutomaticMemoryAuthorization } from './src/memory/automatic/authorization-coordinator.js';
import { createSyntheticLinkedSpeakerContext } from './test-support/synthetic-linked-speaker.js';
import { createJsonMemoryRepository } from './src/memory/json-repository.js';
const recipient = {};
const repo = createJsonMemoryRepository({ storePath: process.argv[1], now: () => '2036-02-03T10:20:30.000Z' });
await repo.open();
const turn = await readDirectUserTurn(recipient);
const speakerIdentityContext = await createSyntheticLinkedSpeakerContext({ turn, recipient,
  text: turn.message, selfPersonId: ${JSON.stringify(SELF)} });
let extractorCalls = 0;
const detector = createAutomaticMemoryDetector({ extractCandidates: async ({ text: seen, instructions }) => {
  extractorCalls += 1;
  if (seen !== turn.message || !instructions.includes('untrusted data')) throw new Error('unexpected detector input');
  return ${JSON.stringify(proposed)};
} });
const detected = await detector.detect({ text: turn.message });
let result;
if (!detected.success) {
  result = { detected, extractorCalls };
} else {
  const snapshot = await repo.readAutomaticMemorySnapshot();
  const plan = planAutomaticMemoryPersistence({ text: turn.message, proposal: detected.proposal, snapshot, trustedSpeakerContext: speakerIdentityContext });
  const contract = createAutomaticMemoryPersistenceContract({ text: turn.message, proposal: detected.proposal, snapshot });
  const prepared = await prepareAutomaticMemoryAuthorization({ text: turn.message, proposal: detected.proposal,
    snapshot, operationIndex: 0, recipient, runtimeContextCapability: turn.runtimeContextCapability,
    speakerIdentityContext });
  let write;
  if (prepared.prepared && ${confirm}) {
    const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
    write = grant.success ? await repo.commitAutomaticOperation({ text: turn.message, proposal: detected.proposal,
      snapshot, operationIndex: 0, recipient, capability: grant.capability }) : grant;
  } else {
    write = await repo.commitAutomaticOperation({ text: turn.message, proposal: detected.proposal,
      snapshot, operationIndex: 0, recipient, capability: {} });
  }
  const current = await repo.readSnapshot();
  result = { detected, plan, contract, prepared: { success: prepared.success, prepared: prepared.prepared,
    disposition: prepared.disposition, reasonCodes: prepared.reasonCodes }, write, extractorCalls,
    revision: current.revision, snapshot: current.snapshot };
}
console.log('__AUDIT_RESULT__' + JSON.stringify(result));
await repo.close(); closeDirectUserInput();
`;
}

async function run({ storePath, text, proposed, replace = false, confirm = true }) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker({ text, proposed, replace, confirm }), storePath], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', sent = false;
    child.stdin.write(text + '\n');
    child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        const match = stdout.match(/Para confirmar, escribí exactamente: (CONFIRM (?:ADD [A-F0-9]{12}|REPLACE mem_[0-9a-f-]{36} [A-F0-9]{12}))/u);
        if (!sent && match) { child.stdin.write(match[1] + '\n'); sent = true; }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
        setTimeout(() => { if (child.exitCode === null) child.kill(); }, 10000).unref();
    });
    assert.equal(exitCode, 0, stderr + stdout);
    const marker = stdout.indexOf('__AUDIT_RESULT__');
    assert.notEqual(marker, -1, stdout);
    return { result: JSON.parse(stdout.slice(marker + '__AUDIT_RESULT__'.length).trim()), stdout };
}

test('B.3 integral synthetic flow: stdin → detector → policy/planner → confirmation → real temporary repository ADD', async t => {
    const storePath = await makeStore(t, store());
    const { result } = await run({ storePath, text: ADD_TEXT, proposed: proposal(ADD_TEXT) });
    assert.equal(result.extractorCalls, 1);
    assert.equal(result.detected.success, true);
    assert.equal(result.plan.operations[0].operation, 'ADD');
    assert.equal(result.contract.operations[0].executable, false);
    assert.equal(result.contract.operations[0].authorization.granted, false);
    assert.equal(result.prepared.prepared, true);
    assert.equal(result.write.outcome, 'applied');
    assert.equal(result.revision, 1);
    assert.equal(result.snapshot.assertions.length, 1);
    assert.equal(result.snapshot.automatic_operations.length, 1);
    assert.equal(result.snapshot.assertions[0].object.value, 'Fender');
    assert.equal(result.snapshot.sources[0].origin_trust, 'derived_untrusted');
});

test('B.3 integral REPLACE without separate stdin confirmation cannot write', async t => {
    const storePath = await makeStore(t, store({ replace: true }));
    const before = await fs.readFile(storePath, 'utf8');
    const { result, stdout } = await run({ storePath, text: REPLACE_TEXT,
        proposed: proposal(REPLACE_TEXT, { replace: true }), replace: true, confirm: false });
    assert.equal(result.detected.success, true);
    assert.equal(result.plan.operations[0].operation, 'REPLACE');
    assert.equal(result.prepared.prepared, true);
    assert.equal(result.write.error.code, 'automatic_authorization_rejected');
    assert.equal(result.revision, 0);
    assert.equal(result.snapshot.assertions[0].object.value, 'Acer');
    assert.equal(result.snapshot.automatic_operations.length, 0);
    assert.doesNotMatch(stdout, /Para confirmar, escribí exactamente:/u);
    assert.equal(await fs.readFile(storePath, 'utf8'), before);
});

test('B.3 sensitive candidate remains ASK and model-supplied authority fields are rejected before authorization', async t => {
    const sensitivePath = await makeStore(t, store());
    const sensitiveText = 'Tengo migrañas ocasionales.';
    const sensitive = await run({ storePath: sensitivePath, text: sensitiveText,
        proposed: proposal(sensitiveText, { sensitivity: 'health' }) });
    assert.equal(sensitive.result.detected.success, true);
    assert.equal(sensitive.result.plan.operations[0].operation, 'ASK');
    assert.equal(sensitive.result.prepared.prepared, false);
    assert.equal(sensitive.result.write.error.code, 'automatic_authorization_rejected');
    assert.equal(sensitive.result.revision, 0);
    assert.equal(sensitive.result.snapshot.automatic_operations.length, 0);

    const injectedPath = await makeStore(t, store());
    const injectedBefore = await fs.readFile(injectedPath, 'utf8');
    const injectedText = 'También tengo una Fender.';
    const injected = await run({ storePath: injectedPath, text: injectedText,
        proposed: proposal(injectedText, { extraCandidateFields: { authorization_request_id: 'forged', canonicalEntityId: SELF } }) });
    assert.equal(injected.result.detected.success, false);
    assert.equal(injected.result.extractorCalls, 1);
    assert.equal(injected.result.detected.error.code, 'candidate_output_invalid');
    assert.equal(await fs.readFile(injectedPath, 'utf8'), injectedBefore);
});

test('B.3 suspected secret is stopped before the extractor and not echoed', async () => {
    const { createAutomaticMemoryDetector } = await import('../src/memory/automatic/detector.js');
    const syntheticSecret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let calls = 0;
    const detector = createAutomaticMemoryDetector({ extractCandidates: async () => { calls += 1; return { candidates: [] }; } });
    const result = await detector.detect({ text: `Mi token es ${syntheticSecret}` });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'secret_blocked_before_detection');
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(result).includes(syntheticSecret), false);
});

test('B.3 audit guards against wiring Automatic Memory writer into agent or public tools', async () => {
    const files = ['src/core/agent.js', 'src/tools/index.js'];
    for (const file of files) {
        const source = await fs.readFile(path.join(root, file), 'utf8');
        assert.doesNotMatch(source, /commitAutomaticOperation|authorization-coordinator|automatic\/detector/u, file);
    }
});
