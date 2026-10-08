import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsHelloProvider } from '../src/core/windows-hello-provider.js';
import { createWindowsPrincipalProvider } from '../src/core/windows-principal-provider.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfId = 'person_00000000-0000-4000-8000-000000000001';
const source = 'Prefiero respuestas breves. Coti trabaja en el proyecto.';

function runWithStdin(script, input = source) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root, input: `${input}\n`, encoding: 'utf8', timeout: 5000,
        windowsHide: true, env: { ...process.env, NEXA_MEMORY_BACKEND: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
}

const linkedResolutionScript = `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { createTrustedSpeakerIdentityBoundary } from './src/core/trusted-speaker-identity.js';
import { validateAutomaticMemoryCandidates } from './src/memory/automatic/schema.js';
import { evaluateAutomaticMemoryPolicy } from './src/memory/automatic/policy.js';
const selfId = ${JSON.stringify(selfId)};
const text = ${JSON.stringify(source)};
const recipient = {};
let turn = await readDirectUserTurn(recipient);
const now = '2026-10-08T12:00:00.000Z';
const snapshot = { schema_version: 4, store_id: 'store_00000000-0000-4000-8000-000000000002',
  self_person_id: selfId, revision: 0, created_at: now, updated_at: now,
  entities: [{ id: selfId, type: 'person', created_at: now }], assertions: [], sources: [], evidence: [], migrations: [] };
let binding = { principalId: 'windows-sid:S-1-5-21-1-2-3-1001', selfPersonId: selfId,
  verificationMethod: 'windows_hello_user_consent', verifiedAt: now, status: 'active' };
const boundary = createTrustedSpeakerIdentityBoundary({
  principalProvider: { getCurrentPrincipal: async () => ({ id: binding.principalId,
    kind: 'windows_account_sid', authenticationState: 'os_account_session_unverified', method: 'windows_process_token' }) },
  windowsHelloProvider: { verifyUser: async () => ({ status: 'unavailable', method: null }) },
  bindingStore: { get: async () => binding, set: async () => true, revoke: async () => true },
  ownerSelfProvider: { getSelfPersonId: async () => selfId },
});
const proposal = { candidates: [{ candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference',
  value_text: 'respuestas breves', mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95,
  assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact',
  sensitivity: 'none', suggested_disposition: 'ignore', evidence_quote: 'Prefiero respuestas breves.' },
  { candidate_type: 'professional', subject_text: 'Coti', predicate: 'user.professional_context',
    value_text: 'trabaja en el proyecto', mentioned_person_text: 'Coti', durability: 'durable', linguistic_confidence: 0.95,
    assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact',
    sensitivity: 'none', suggested_disposition: 'ignore', evidence_quote: 'Coti trabaja en el proyecto' }] };
function evaluate(capability) {
  const validated = validateAutomaticMemoryCandidates(proposal, text);
  return evaluateAutomaticMemoryPolicy(validated.candidates, { snapshot: { snapshot, revision: 0, digest: '0'.repeat(64) },
    speakerIdentityCapability: capability }).candidates;
}
const identity = await boundary.resolveTurn({ capability: turn.speakerIdentityCapability, recipient, text });
const first = evaluate(identity.capability);
const replay = evaluate(identity.capability);
binding = { ...binding, status: 'revoked' };
turn = await readDirectUserTurn(recipient);
const revokedIdentity = await boundary.resolveTurn({ capability: turn.speakerIdentityCapability, recipient, text });
const revoked = evaluate(revokedIdentity.capability);
binding = [{ ...binding, status: 'active' }];
turn = await readDirectUserTurn(recipient);
const ambiguousIdentity = await boundary.resolveTurn({ capability: turn.speakerIdentityCapability, recipient, text });
const ambiguous = evaluate(ambiguousIdentity.capability);
console.log(JSON.stringify({ identity: identity.success, first, replay, revoked: revoked[0].disposition,
  revokedStatus: revoked[0].entityResolution.status, ambiguous: ambiguous[0].disposition,
  ambiguousStatus: ambiguous[0].entityResolution.status }));
closeDirectUserInput();
`;

test('actual stdin proof plus a verified synthetic binding resolves Self; identity proof is one-use', () => {
    const result = runWithStdin(linkedResolutionScript, [source, source, source].join('\n'));
    assert.equal(result.identity, true);
    assert.equal(result.first[0].disposition, 'auto_save');
    assert.equal(result.first[0].entityResolution.status, 'self');
    assert.equal(result.first[0].entityResolution.entityId, selfId);
    assert.equal(result.first[1].disposition, 'ask');
    assert.notEqual(result.first[1].entityResolution.entityId, selfId);
    assert.equal(result.replay[0].disposition, 'ask');
    assert.ok(result.replay[0].reasonCodes.includes('subject_not_canonically_resolved'));
    assert.equal(result.revoked, 'ask');
    assert.equal(result.revokedStatus, 'unresolved');
    assert.equal(result.ambiguous, 'ask');
    assert.equal(result.ambiguousStatus, 'unresolved');
});

test('plain objects, model IDs, wrong text and absent binding cannot resolve Self', () => {
    const script = `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { trustedSpeakerIdentityBoundary } from './src/core/trusted-speaker-identity.js';
const recipient = {}; const turn = await readDirectUserTurn(recipient);
const fake = await trustedSpeakerIdentityBoundary.resolveTurn({ capability: {}, recipient, text: turn.message });
const altered = await trustedSpeakerIdentityBoundary.resolveTurn({ capability: turn.speakerIdentityCapability,
  recipient, text: turn.message + ' changed' });
console.log(JSON.stringify({ fake: fake.success, altered: altered.success }));
closeDirectUserInput();`;
    const result = runWithStdin(script, 'Soy Jorge y prefiero respuestas breves.');
    assert.deepEqual(result, { fake: false, altered: false });
});

test('synthetic provider injection is unavailable outside the node:test process', () => {
    const script = `
import { createTrustedSpeakerIdentityBoundary } from './src/core/trusted-speaker-identity.js';
delete process.env.NODE_TEST_CONTEXT;
let rejected = false;
try { createTrustedSpeakerIdentityBoundary({ principalProvider: { getCurrentPrincipal: async () => null } }); }
catch (error) { rejected = error.message === 'speaker_identity_test_injection_unavailable'; }
console.log(JSON.stringify({ rejected }));`;
    const result = runWithStdin(script, source);
    assert.deepEqual(result, { rejected: true });
});

test('speaker proof is bound to its recipient and expires when the next stdin turn begins', () => {
    const script = `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { trustedSpeakerIdentityBoundary } from './src/core/trusted-speaker-identity.js';
const recipient = {}; const otherRecipient = {};
const first = await readDirectUserTurn(recipient);
const wrongRecipient = await trustedSpeakerIdentityBoundary.resolveTurn({ capability: first.speakerIdentityCapability,
  recipient: otherRecipient, text: first.message });
const second = await readDirectUserTurn(recipient);
await readDirectUserTurn(recipient);
const expiredTurn = await trustedSpeakerIdentityBoundary.resolveTurn({ capability: second.speakerIdentityCapability,
  recipient, text: ${JSON.stringify(source)} });
console.log(JSON.stringify({ wrongRecipient: wrongRecipient.success, expiredTurn: expiredTurn.success }));
closeDirectUserInput();`;
    const result = runWithStdin(script, `${source}\n${source}\n${source}`);
    assert.deepEqual(result, { wrongRecipient: false, expiredTurn: false });
});

test('identity-to-authorization handoff is one-use, tied to the exact source turn/text/recipient, and rechecks revoked Self', () => {
    const script = `
import { createHash } from 'node:crypto';
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { createTrustedSpeakerIdentityBoundary, consumeTrustedSpeakerIdentity,
  consumeTrustedSpeakerAuthorizationContext } from './src/core/trusted-speaker-identity.js';
const selfId = ${JSON.stringify(selfId)}; const text = ${JSON.stringify(source)}; const recipient = {};
const principalId = 'windows-sid:S-1-5-21-1-2-3-1001';
let record = { principalId, selfPersonId: selfId, verificationMethod: 'windows_hello_user_consent',
  verifiedAt: '2026-10-08T12:00:00.000Z', status: 'active' };
const boundary = createTrustedSpeakerIdentityBoundary({
  principalProvider: { getCurrentPrincipal: async () => ({ id: principalId, kind: 'windows_account_sid',
    authenticationState: 'os_account_session_unverified', method: 'windows_process_token' }) },
  windowsHelloProvider: { verifyUser: async () => ({ status: 'unavailable' }) },
  bindingStore: { get: async () => record, set: async () => true, revoke: async () => true },
  ownerSelfProvider: { getSelfPersonId: async () => selfId },
});
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
async function context(turn) {
  const resolution = await boundary.resolveTurn({ capability: turn.speakerIdentityCapability, recipient, text });
  return resolution.success ? consumeTrustedSpeakerIdentity(resolution.capability, hash(text)) : null;
}
let turn = await readDirectUserTurn(recipient); const wrongRecipientContext = await context(turn);
const wrongRecipient = await consumeTrustedSpeakerAuthorizationContext(wrongRecipientContext, { recipient: {}, text });
turn = await readDirectUserTurn(recipient); const changedTextContext = await context(turn);
const changedText = await consumeTrustedSpeakerAuthorizationContext(changedTextContext, { recipient, text: text + 'x' });
turn = await readDirectUserTurn(recipient); const staleContext = await context(turn);
await readDirectUserTurn(recipient);
const staleTurn = await consumeTrustedSpeakerAuthorizationContext(staleContext, { recipient, text });
turn = await readDirectUserTurn(recipient); const revokedContext = await context(turn); record = { ...record, status: 'revoked' };
const revoked = await consumeTrustedSpeakerAuthorizationContext(revokedContext, { recipient, text });
record = { ...record, status: 'active' };
turn = await readDirectUserTurn(recipient); const validContext = await context(turn);
const first = await consumeTrustedSpeakerAuthorizationContext(validContext, { recipient, text });
const replay = await consumeTrustedSpeakerAuthorizationContext(validContext, { recipient, text });
console.log(JSON.stringify({ wrongRecipient: Boolean(wrongRecipient), changedText: Boolean(changedText),
  staleTurn: Boolean(staleTurn), revoked: Boolean(revoked), valid: Boolean(first), replay: Boolean(replay) }));
closeDirectUserInput();`;
    const result = runWithStdin(script, [source, source, source, source, source, source].join('\n'));
    assert.deepEqual(result, { wrongRecipient: false, changedText: false, staleTurn: false,
        revoked: false, valid: true, replay: false });
});

test('Windows Hello default is fail-closed and Windows principal is only an unverified account label', async () => {
    const hello = await createWindowsHelloProvider().verifyUser({ purpose: 'bind_self' });
    assert.deepEqual(hello, { status: 'unavailable', method: null });
    const provider = createWindowsPrincipalProvider({ platform: 'win32', systemRoot: 'C:\\Windows',
        execute: async (exe, args, options) => {
            assert.equal(exe, 'C:\\Windows\\System32\\whoami.exe');
            assert.deepEqual(args, ['/user', '/fo', 'csv', '/nh']);
            assert.equal(options.shell, false);
            return { stdout: '"USER", "SID"\r\n"S-1-5-21-1-2-3-1001"' };
        } });
    assert.deepEqual(await provider.getCurrentPrincipal(), { id: 'windows-sid:S-1-5-21-1-2-3-1001',
        kind: 'windows_account_sid', authenticationState: 'os_account_session_unverified', method: 'windows_process_token' });
    const unavailable = await createWindowsPrincipalProvider({ platform: 'linux' }).getCurrentPrincipal();
    assert.equal(unavailable, null);
});

test('Self link and revoke require Windows Hello and leave the volatile store untouched when unavailable', () => {
    const script = `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { createTrustedSpeakerIdentityBoundary } from './src/core/trusted-speaker-identity.js';
import { createWindowsHelloProvider } from './src/core/windows-hello-provider.js';
const recipient = {}; const selfPersonId = ${JSON.stringify(selfId)};
const principalId = 'windows-sid:S-1-5-21-1-2-3-1001'; let binding = null; let writes = 0;
const boundary = createTrustedSpeakerIdentityBoundary({
  principalProvider: { getCurrentPrincipal: async () => ({ id: principalId, kind: 'windows_account_sid',
    authenticationState: 'os_account_session_unverified', method: 'windows_process_token' }) },
  windowsHelloProvider: createWindowsHelloProvider(),
  bindingStore: { get: async () => binding, set: async () => { writes++; return true; },
    revoke: async () => { writes++; return true; } },
  ownerSelfProvider: { getSelfPersonId: async () => selfPersonId },
});
let turn = await readDirectUserTurn(recipient);
const link = await boundary.prepareSelfBinding({ capability: turn.speakerIdentityCapability, recipient, text: turn.message });
binding = { principalId, selfPersonId, verificationMethod: 'windows_hello_user_consent',
  verifiedAt: '2026-10-08T12:00:00.000Z', status: 'active' };
turn = await readDirectUserTurn(recipient);
const revoke = await boundary.prepareSelfBindingRevocation({ capability: turn.speakerIdentityCapability,
  recipient, text: turn.message });
console.log(JSON.stringify({ link: link.error.code, revoke: revoke.error.code, writes }));
closeDirectUserInput();`;
    const result = runWithStdin(script, `${source}\n${source}`);
    assert.deepEqual(result, { link: 'windows_hello_unavailable', revoke: 'windows_hello_unavailable', writes: 0 });
});

test('invalid or revoked bindings do not establish Self, and identity never grants memory writes', () => {
    const script = `
import { readDirectUserTurn, closeDirectUserInput } from './src/core/direct-user-input.js';
import { trustedSpeakerIdentityBoundary } from './src/core/trusted-speaker-identity.js';
const recipient = {}; const turn = await readDirectUserTurn(recipient);
const linked = await trustedSpeakerIdentityBoundary.resolveTurn({ capability: turn.speakerIdentityCapability,
  recipient, text: turn.message });
console.log(JSON.stringify({ success: linked.success, ...(linked.success ? { capabilityShape: Reflect.ownKeys(linked.capability).length } : {}),
  auth: linked.authorizationGranted ?? false, writes: linked.writeReady ?? false }));
closeDirectUserInput();`;
    const result = runWithStdin(script);
    assert.equal(result.success, true);
    assert.equal(result.capabilityShape, 0);
    assert.equal(result.auth, false);
    assert.equal(result.writes, false);
});
