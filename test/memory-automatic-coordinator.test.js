import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addText = 'También tengo una Fender.';
const replaceText = 'Ya no uso mi laptop Acer; ahora uso una Lenovo.';
const selfId = 'person_00000000-0000-4000-8000-000000000001';
const time = '2026-04-03T12:00:00.000Z';

function snapshot(values = [], revision = 0) {
    const assertions = [], sources = [], evidence = [];
    values.forEach(([predicate, value], index) => {
        const suffix = String(index + 10).padStart(12, '0');
        const assertionId = `mem_00000000-0000-4000-8000-${suffix}`;
        const sourceId = `src_00000000-0000-4000-8000-${suffix}`;
        const evidenceId = `ev_00000000-0000-4000-8000-${suffix}`;
        assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'owner' }, predicate,
            object: { type: 'text', value }, status: 'active', valid_from: null, valid_to: null,
            recorded_at: time, supersedes: [], compatibility: null });
        sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: { value: time, precision: 'instant' }, recorded_at: time });
        evidence.push({ id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: null, learned_at: time, last_confirmed_at: null, legacy_ref: null });
    });
    const value = { schema_version: 4, store_id: 'store_00000000-0000-4000-8000-000000000002',
        self_person_id: selfId, revision, created_at: time, updated_at: time,
        entities: [{ id: selfId, type: 'person', created_at: time }], assertions, sources, evidence, migrations: [] };
    return { snapshot: value, revision, digest: createHashHex(JSON.stringify(value)) };
}

function createHashHex(value) {
    return createHash('sha256').update(value).digest('hex');
}

const candidate = (text, replace = false, overrides = {}) => ({ candidate_type: replace ? 'tool' : 'purchase', subject_text: 'user',
    predicate: replace ? 'user.uses_tool' : 'user.owns_item', value_text: replace ? 'Lenovo' : 'Fender',
    mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95,
    assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' },
    update_intent: replace ? 'possible_correction' : 'addition', sensitivity: 'none',
    suggested_disposition: 'auto_save', evidence_quote: text, ...overrides });

function inlineScenario({ text, replace = false, values = [], candidateOverrides = {}, action }) {
    const snap = snapshot(values);
    const proposal = { candidates: [candidate(text, replace, candidateOverrides)] };
    return `
import { readDirectUserTurn, readDirectUserConfirmation, consumeDirectUserConfirmation,
  closeDirectUserInput, closeDirectUserSession } from './src/core/direct-user-input.js';
import { prepareAutomaticMemoryAuthorization, confirmAutomaticMemoryAuthorization,
  consumeAutomaticMemoryAuthorization } from './src/memory/automatic/authorization-coordinator.js';
const recipient = {};
const turn = await readDirectUserTurn(recipient);
const prepared = prepareAutomaticMemoryAuthorization({ text: turn.message, proposal: ${JSON.stringify(proposal)},
  snapshot: ${JSON.stringify(snap)}, operationIndex: 0, recipient,
  runtimeContextCapability: turn.runtimeContextCapability });
${action}
closeDirectUserInput();
`;
}

async function runInteractive({ text, replace = false, values = [], candidateOverrides = {}, action, reply = 'valid' }) {
    const script = inlineScenario({ text, replace, values, candidateOverrides, action });
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', confirmationSent = false, nextTurnSent = false;
    child.stdin.write(text + '\n');
    child.stdout.on('data', data => {
        stdout += data.toString();
        if (!nextTurnSent && stdout.includes('__READ_NEXT__')) {
            nextTurnSent = true;
            child.stdin.write('next harmless turn\n');
        }
        if (confirmationSent) return;
        const match = stdout.match(/Para confirmar, escribí exactamente: (CONFIRM (?:ADD [A-F0-9]{12}|REPLACE mem_[0-9a-f-]{36} [A-F0-9]{12}))/u);
        if (match) {
            confirmationSent = true;
            child.stdin.write((reply === 'valid' ? match[1] : reply) + '\n');
        }
    });
    child.stderr.on('data', data => { stderr += data.toString(); });
    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
        setTimeout(() => { if (child.exitCode === null) child.kill(); }, 10000).unref();
    });
    assert.equal(exitCode, 0, stderr + stdout);
    return { stdout, stderr, confirmationSent };
}

test('coordinator prepares ADD from real stdin, shows exact preview, and yields one-use scoped capability', async () => {
    const result = await runInteractive({ text: addText, action: `
const forged = await confirmAutomaticMemoryAuthorization({ request: prepared.request,
  authorization: { granted: true }, confirmation: 'yes' }, recipient);
const [first, competing] = await Promise.all([
  confirmAutomaticMemoryAuthorization(prepared.request, recipient),
  confirmAutomaticMemoryAuthorization(prepared.request, recipient),
]);
const expected = { recipient, operation: 'ADD', operationFingerprint: prepared.operationFingerprint,
  snapshotRevision: prepared.snapshotBinding.revision, snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null };
const consumed = consumeAutomaticMemoryAuthorization(first.capability, expected);
const replay = consumeAutomaticMemoryAuthorization(first.capability, expected);
console.log('__RESULT__' + JSON.stringify({ prepared: prepared.success, operation: prepared.operation,
  granted: first.authorizationGranted, consumed: consumed.authorized, replay: replay.success,
  competing: competing.error.code, forged: forged.error.code,
  executable: first.executable, writeReady: first.writeReady }));` });
    assert.equal(result.confirmationSent, true);
    assert.match(result.stdout, /Operación: ADD/u);
    assert.match(result.stdout, /Valor que se agregaría: Fender/u);
    assert.match(result.stdout, /Provenance: inferencia no confiable/u);
    const report = JSON.parse(result.stdout.split('__RESULT__')[1]);
    assert.deepEqual(report, { prepared: true, operation: 'ADD', granted: true,
        consumed: true, replay: false, competing: 'authorization_request_invalid',
        forged: 'authorization_request_invalid', executable: false, writeReady: false });
});

test('REPLACE preview and confirmation require the exact prior assertion target', async () => {
    const result = await runInteractive({ text: replaceText, replace: true,
        values: [['user.uses_tool', 'Acer']], action: `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
const expected = { recipient, operation: 'REPLACE', operationFingerprint: prepared.operationFingerprint,
  snapshotRevision: prepared.snapshotBinding.revision, snapshotDigest: prepared.snapshotBinding.digest,
  targetAssertionId: 'mem_00000000-0000-4000-8000-000000000010' };
const consumed = consumeAutomaticMemoryAuthorization(grant.capability, expected);
console.log('__RESULT__' + JSON.stringify({ prepared: prepared.operation, grant: grant.authorizationGranted,
  target: consumed.targetAssertionId, authorized: consumed.authorized }));` });
    assert.equal(result.confirmationSent, true);
    assert.match(result.stdout, /Operación: REPLACE/u);
    assert.match(result.stdout, /Target exacto: mem_00000000-0000-4000-8000-000000000010/u);
    assert.match(result.stdout, /Valor anterior: Acer/u);
    assert.match(result.stdout, /Valor nuevo: Lenovo/u);
    assert.match(result.stdout, /CONFIRM REPLACE mem_00000000-0000-4000-8000-000000000010/u);
    const report = JSON.parse(result.stdout.split('__RESULT__')[1]);
    assert.deepEqual(report, { prepared: 'REPLACE', grant: true,
        target: 'mem_00000000-0000-4000-8000-000000000010', authorized: true });
});

test('wrong confirmation is consumed as a rejection and never yields a capability', async () => {
    const result = await runInteractive({ text: addText, reply: 'yes', action: `
const first = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
const second = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
console.log('__RESULT__' + JSON.stringify({ first: first.error.code, second: second.error.code,
  capability: Object.hasOwn(first, 'capability') }));` });
    assert.equal(result.confirmationSent, true);
    const report = JSON.parse(result.stdout.split('__RESULT__')[1]);
    assert.deepEqual(report, { first: 'trusted_confirmation_rejected', second: 'authorization_request_invalid', capability: false });
});

test('altered operation, fingerprint, snapshot, recipient, or forged model data fail closed and burn the grant', async () => {
    const result = await runInteractive({ text: addText, action: `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
const altered = consumeAutomaticMemoryAuthorization(grant.capability, { recipient, operation: 'REPLACE',
  operationFingerprint: prepared.operationFingerprint, snapshotRevision: prepared.snapshotBinding.revision,
  snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null });
const replay = consumeAutomaticMemoryAuthorization(grant.capability, { recipient, operation: 'ADD',
  operationFingerprint: prepared.operationFingerprint, snapshotRevision: prepared.snapshotBinding.revision,
  snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null });
const forged = prepareAutomaticMemoryAuthorization({ text: turn.message, proposal: {}, snapshot: {}, operationIndex: 0,
  recipient, runtimeContextCapability: { origin: 'local_cli', sessionId: 'fake', turnId: 'fake' } });
console.log('__RESULT__' + JSON.stringify({ altered: altered.success, alteredCode: altered.error.code,
  replay: replay.success, forged: forged.success, scopes: grant.scopes ?? null }));` });
    const report = JSON.parse(result.stdout.split('__RESULT__')[1]);
    assert.deepEqual(report, { altered: false, alteredCode: 'authorization_binding_mismatch_or_stale',
        replay: false, forged: false, scopes: null });
});

test('fingerprint, snapshot revision/digest, target, and recipient mismatches consume grants', async () => {
    const mismatches = [
        { operationFingerprint: '0'.repeat(64) },
        { snapshotRevision: 99 },
        { snapshotDigest: '0'.repeat(64) },
        { targetAssertionId: 'mem_00000000-0000-4000-8000-000000000010' },
    ];
    for (const mismatch of mismatches) {
        const action = `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
const expected = { recipient, operation: 'ADD', operationFingerprint: prepared.operationFingerprint,
  snapshotRevision: prepared.snapshotBinding.revision, snapshotDigest: prepared.snapshotBinding.digest,
  targetAssertionId: null, ...${JSON.stringify(mismatch)} };
const denied = consumeAutomaticMemoryAuthorization(grant.capability, expected);
const replay = consumeAutomaticMemoryAuthorization(grant.capability, { recipient, operation: 'ADD',
  operationFingerprint: prepared.operationFingerprint, snapshotRevision: prepared.snapshotBinding.revision,
  snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null });
console.log('__RESULT__' + JSON.stringify({ denied: denied.success, replay: replay.success }));`;
        const result = await runInteractive({ text: addText, action });
        assert.deepEqual(JSON.parse(result.stdout.split('__RESULT__')[1]), { denied: false, replay: false });
    }
    const wrongGrantRecipient = await runInteractive({ text: addText, action: `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
const denied = consumeAutomaticMemoryAuthorization(grant.capability, { recipient: {}, operation: 'ADD',
  operationFingerprint: prepared.operationFingerprint, snapshotRevision: prepared.snapshotBinding.revision,
  snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null });
const replay = consumeAutomaticMemoryAuthorization(grant.capability, { recipient, operation: 'ADD',
  operationFingerprint: prepared.operationFingerprint, snapshotRevision: prepared.snapshotBinding.revision,
  snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null });
console.log('__RESULT__' + JSON.stringify({ denied: denied.success, replay: replay.success }));` });
    assert.deepEqual(JSON.parse(wrongGrantRecipient.stdout.split('__RESULT__')[1]), { denied: false, replay: false });
    const wrongRecipient = await runInteractive({ text: addText, action: `
const wrong = await confirmAutomaticMemoryAuthorization(prepared.request, {});
const correct = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
console.log('__RESULT__' + JSON.stringify({ wrong: wrong.error.code, correct: correct.error.code }));` });
    assert.equal(wrongRecipient.confirmationSent, false);
    assert.deepEqual(JSON.parse(wrongRecipient.stdout.split('__RESULT__')[1]), {
        wrong: 'authorization_request_stale_or_wrong_recipient', correct: 'authorization_request_invalid' });
});

test('a later user turn invalidates a previously issued grant', async () => {
    const result = await runInteractive({ text: addText, action: `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
console.log('__READ_NEXT__');
const next = await readDirectUserTurn(recipient);
const consumed = consumeAutomaticMemoryAuthorization(grant.capability, { recipient, operation: 'ADD',
  operationFingerprint: prepared.operationFingerprint, snapshotRevision: prepared.snapshotBinding.revision,
  snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null });
console.log('__RESULT__' + JSON.stringify({ nextTurn: next.message, consumed: consumed.success,
  code: consumed.error.code }));` });
    assert.deepEqual(JSON.parse(result.stdout.split('__RESULT__')[1]), { nextTurn: 'next harmless turn',
        consumed: false, code: 'authorization_binding_mismatch_or_stale' });
});

test('closing a local session invalidates an issued capability', async () => {
    const result = await runInteractive({ text: addText, action: `
const grant = await confirmAutomaticMemoryAuthorization(prepared.request, recipient);
closeDirectUserSession(recipient);
const consumed = consumeAutomaticMemoryAuthorization(grant.capability, { recipient, operation: 'ADD',
  operationFingerprint: prepared.operationFingerprint, snapshotRevision: prepared.snapshotBinding.revision,
  snapshotDigest: prepared.snapshotBinding.digest, targetAssertionId: null });
console.log('__RESULT__' + JSON.stringify({ consumed: consumed.success, code: consumed.error.code }));` });
    assert.deepEqual(JSON.parse(result.stdout.split('__RESULT__')[1]), { consumed: false,
        code: 'authorization_binding_mismatch_or_stale' });
});

test('trusted confirmation proof cannot be substituted across request IDs and failed verification burns it', async () => {
    const result = await runInteractive({ text: addText, action: `
const requestId = '00000000-0000-4000-8000-000000000099';
const operationFingerprint = 'a'.repeat(64);
const phrase = 'CONFIRM ADD ABCDEF123456';
const confirmation = await readDirectUserConfirmation({ recipient, requestId, operationFingerprint,
  preview: 'Synthetic preview only.', phrase });
const wrong = (() => { try { consumeDirectUserConfirmation(confirmation.capability,
  { recipient, requestId: '00000000-0000-4000-8000-000000000098', operationFingerprint, phrase }); return false; }
  catch { return true; } })();
const replay = (() => { try { consumeDirectUserConfirmation(confirmation.capability,
  { recipient, requestId, operationFingerprint, phrase }); return false; } catch { return true; } })();
console.log('__RESULT__' + JSON.stringify({ confirmed: confirmation.confirmed, wrong, replay }));` });
    assert.equal(result.confirmationSent, true);
    assert.deepEqual(JSON.parse(result.stdout.split('__RESULT__')[1]), { confirmed: true, wrong: true, replay: true });
});

test('ASK, IGNORE, and DUPLICATE dispositions never produce pending authorization requests', async () => {
    const duplicate = await runInteractive({ text: addText,
        values: [['user.owns_item', 'Fender']], action: `
console.log('__RESULT__' + JSON.stringify({ prepared: prepared.prepared,
  disposition: prepared.disposition, executable: prepared.executable, hasRequest: Object.hasOwn(prepared, 'request') }));` });
    const ask = await runInteractive({ text: 'Coti cambió de trabajo.', candidateOverrides: {
        candidate_type: 'professional', subject_text: 'Coti', predicate: 'user.professional_context',
        value_text: 'cambió de trabajo', mentioned_person_text: 'Coti',
    }, action: `console.log('__RESULT__' + JSON.stringify({ prepared: prepared.prepared,
      disposition: prepared.disposition, executable: prepared.executable, hasRequest: Object.hasOwn(prepared, 'request') }));` });
    const secretText = 'My token is sk-1234567890abcdefghij';
    const ignore = await runInteractive({ text: secretText, candidateOverrides: {
        value_text: secretText, suggested_disposition: 'ignore',
    }, action: `console.log('__RESULT__' + JSON.stringify({ prepared: prepared.prepared,
      disposition: prepared.disposition, executable: prepared.executable, hasRequest: Object.hasOwn(prepared, 'request') }));` });
    for (const [result, expected] of [[duplicate, 'DUPLICATE'], [ask, 'ASK'], [ignore, 'IGNORE']]) {
        const report = JSON.parse(result.stdout.split('__RESULT__')[1]);
        assert.deepEqual(report, { prepared: false, disposition: expected, executable: false, hasRequest: false });
    }
});

test('coordinator has no writer/service/agent dependency and existing authorization remains deny-only', async () => {
    const source = await readFile(path.join(repoRoot, 'src/memory/automatic/authorization-coordinator.js'), 'utf8');
    assert.doesNotMatch(source, /createMemoryService|MemoryRepository|\.commit\(|writeFile|agent\.run|executeTool|authorizeMemoryRemember/u);
    const auth = await readFile(path.join(repoRoot, 'src/memory/automatic/authorization-contract.js'), 'utf8');
    assert.match(auth, /authorizationRequestEligible:\s*false/u);
    assert.match(auth, /granted:\s*false/u);
    assert.match(auth, /executable:\s*false/u);
});
