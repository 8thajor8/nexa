import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createIdentityBrokerIpcTestHarness,
    fingerprintSyntheticOperation,
    IPC_MAX_MESSAGE_BYTES,
    IPC_PROTOCOL_VERSION,
    validateSyntheticBrokerResponse,
    validateSyntheticIpcRequest,
} from './support/identity-broker-ipc-contract.js';

const operation = (overrides = {}) => ({ action: 'memory.replace', targetId: 'test_assertion_01',
    expectedRevision: 7, ...overrides });
const message = (type, requestId, payload = {}) => ({ protocolVersion: IPC_PROTOCOL_VERSION, requestId, type, payload });
const auth = (id, ttl = 10_000) => message('authentication.start', id, { requestedTtlMs: ttl });
const stepUp = (id, op = operation()) => message('step_up.start', id, { requestedTtlMs: 10_000, operation: op });
const target = (type, id, targetRequestId) => message(type, id, { targetRequestId });
function assertDenied(result) {
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
    assert.equal(result.authorization, 'DENY');
    assert.equal(result.synthetic, true);
}

test('closed, versioned request set accepts only the declared shapes', () => {
    for (const request of [message('capabilities.query', 'test_caps'), auth('test_auth'),
        stepUp('test_step'), target('request.status', 'test_status', 'test_auth'),
        target('request.cancel', 'test_cancel', 'test_auth'), message('session.status', 'test_session')]) {
        const result = validateSyntheticIpcRequest(request);
        assert.equal(result.status, 'accepted_shape_only');
        assert.equal(result.code, 'request_not_authenticated');
        assertDenied(result);
    }
});

test('unknown identity, approval, credential, file, command and generic-sign fields are rejected', () => {
    const claims = ['principalId', 'ownerId', 'installationId', 'verified', 'approved', 'credential',
        'path', 'command', 'signature', 'sign', 'token'];
    for (const claim of claims) {
        const request = auth(`test_${claim}`);
        request[claim] = claim === 'verified' || claim === 'approved' ? true : 'test_forged';
        assert.equal(validateSyntheticIpcRequest(request).status, 'rejected', claim);
    }
    assertDenied(validateSyntheticIpcRequest(message('sign', 'test_sign', { data: 'test_payload' })));
});

test('wrong protocol versions, message kinds and malformed field types fail closed', () => {
    assert.equal(validateSyntheticIpcRequest({ ...auth('test_v2'), protocolVersion: 2 }).code, 'protocol_unsupported');
    assert.equal(validateSyntheticIpcRequest(message('future.action', 'test_future')).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(auth('bad id')).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(auth('test_badttl', '1000')).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(stepUp('test_badop', operation({ action: 'shell.exec' }))).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(stepUp('test_badtarget', operation({ targetId: '../secret' }))).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(stepUp('test_badrev', operation({ expectedRevision: -1 }))).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(stepUp('test_badreplace', operation({ targetId: null }))).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(stepUp('test_badadd', operation({ action: 'memory.add' }))).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(stepUp('test_badaddnull', operation({ action: 'memory.add', targetId: null,
        expectedRevision: null }))).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(stepUp('test_badbind', operation({ action: 'identity.bind_device', targetId: null }))).status, 'rejected');
});

test('step-up is fingerprint-bound to the exact allowed operation and expected revision', () => {
    const original = operation();
    const input = stepUp('test_bound', original);
    const before = structuredClone(input);
    const fingerprint = fingerprintSyntheticOperation(original);
    assert.match(fingerprint, /^[a-f0-9]{64}$/u);
    assert.notEqual(fingerprint, fingerprintSyntheticOperation(operation({ targetId: 'test_other' })));
    assert.notEqual(fingerprint, fingerprintSyntheticOperation(operation({ expectedRevision: 8 })));
    assert.notEqual(fingerprint, fingerprintSyntheticOperation(operation({ action: 'memory.add', targetId: null })));
    assert.equal(fingerprintSyntheticOperation({ expectedRevision: 7, targetId: 'test_assertion_01',
        action: 'memory.replace' }), fingerprint);
    assert.equal(fingerprintSyntheticOperation(operation({ expectedRevision: Number.MAX_SAFE_INTEGER })) !== null, true);
    assert.equal(fingerprintSyntheticOperation(operation({ expectedRevision: Number.MAX_SAFE_INTEGER + 1 })), null);
    assert.equal(fingerprintSyntheticOperation(operation({ targetId: 'test_é' })), null);
    assert.equal(fingerprintSyntheticOperation(operation({ targetId: 'test_e\u0301' })), null);
    const result = createIdentityBrokerIpcTestHarness({ clock: () => 100 }).handle(input);
    assert.deepEqual(input, before);
    assert.equal(result.status, 'accepted_synthetic');
    assert.equal(result.operationFingerprint, fingerprint);
    assertDenied(result);
});

test('payloads reject nulls, arrays, inherited data, strange prototypes and prototype keys', () => {
    for (const payload of [null, [], Object.create({ inherited: true })])
        assert.equal(validateSyntheticIpcRequest(message('session.status', 'test_payload', payload)).status, 'rejected');
    const inheritedTop = Object.assign(Object.create({ verified: true }), auth('test_inherited'));
    assert.equal(validateSyntheticIpcRequest(inheritedTop).status, 'rejected');
    const unusualTop = Object.assign(Object.create(null), auth('test_nullproto'));
    assert.equal(validateSyntheticIpcRequest(unusualTop).status, 'accepted_shape_only');
    const protoKey = JSON.parse('{"protocolVersion":1,"requestId":"test_proto","type":"session.status","payload":{},"__proto__":{"verified":true}}');
    const constructorKey = { ...message('session.status', 'test_constructor'), constructor: { verified: true } };
    assert.equal(validateSyntheticIpcRequest(protoKey).status, 'rejected');
    assert.equal(validateSyntheticIpcRequest(constructorKey).status, 'rejected');
    const nestedExtra = stepUp('test_nested', { ...operation(), payload: { verified: true } });
    assert.equal(validateSyntheticIpcRequest(nestedExtra).status, 'rejected');
});

test('request identifiers are correlation labels, duplicates and replays are rejected', () => {
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => 100 });
    assert.equal(harness.handle(auth('test_once')).code, 'request_pending');
    assert.equal(harness.handle(auth('test_once')).code, 'request_replayed');
    assert.equal(harness.handle(target('request.status', 'test_status1', 'test_once')).status, 'accepted_synthetic');
    assert.equal(harness.handle(target('request.status', 'test_status1', 'test_once')).code, 'request_replayed');
    assertDenied(harness.handle(auth('test_once')));
});

test('caller mutation after handling cannot change the snapshotted operation or result', () => {
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => 100 });
    const input = stepUp('test_snapshot');
    const expected = fingerprintSyntheticOperation(input.payload.operation);
    const result = harness.handle(input);
    input.payload.operation.action = 'identity.bootstrap_owner';
    input.payload.operation.targetId = null;
    input.payload.operation.expectedRevision = 99;
    assert.equal(result.operationFingerprint, expected);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(harness.handle(input).code, 'request_replayed');
});

test('requests remain independent; session state exposes no identity or secret', () => {
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => 100 });
    const a = harness.handle(stepUp('test_a'));
    const b = harness.handle(stepUp('test_b', operation({ targetId: 'test_other' })));
    assert.notEqual(a.operationFingerprint, b.operationFingerprint);
    assert.equal(harness.handle(target('request.status', 'test_sa', 'test_a')).status, 'accepted_synthetic');
    assert.equal(harness.handle(target('request.status', 'test_sb', 'test_b')).status, 'accepted_synthetic');
    const status = harness.handle(message('session.status', 'test_sess'));
    assert.deepEqual(status.session, { state: 'unavailable' });
    assert.equal(JSON.stringify(status).includes('principalId'), false);
    assert.equal(JSON.stringify(status).includes('sessionId'), false);
    for (const value of [a, b, status]) assertDenied(value);
});

test('expiry is enforced on status and cannot become success after a late response', () => {
    let now = 100;
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => now });
    const started = harness.handle(auth('test_expire', 10));
    assert.equal(started.expiresAt, 110);
    now = 110;
    const status = harness.handle(target('request.status', 'test_afterexpiry', 'test_expire'));
    assert.equal(status.code, 'timed_out');
    assert.equal(harness.handle(target('request.cancel', 'test_cancel_late', 'test_expire')).code, 'request_not_pending');
    assertDenied(status);
});

test('cancellation consumes pending state and later status cannot revive it', () => {
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => 100 });
    harness.handle(auth('test_cancelled'));
    const cancelled = harness.handle(target('request.cancel', 'test_cancel_msg', 'test_cancelled'));
    assert.equal(cancelled.code, 'cancelled');
    assert.equal(harness.handle(target('request.status', 'test_cancel_status', 'test_cancelled')).code, 'cancelled');
    assert.equal(harness.handle(target('request.cancel', 'test_cancel_again', 'test_cancelled')).code, 'request_not_pending');
    assertDenied(cancelled);
});

test('invalid messages do not create pending state or reserve a request identifier', () => {
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => 100 });
    const invalid = auth('test_reusable'); invalid.unexpected = 'x';
    assert.equal(harness.handle(invalid).status, 'rejected');
    assert.equal(harness.handle(auth('test_reusable')).status, 'accepted_synthetic');
});

test('oversized payloads and accessors are rejected without getters; throwing proxy traps fail closed', () => {
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => 100 });
    const oversized = { ...auth('test_big'), padding: 'x'.repeat(IPC_MAX_MESSAGE_BYTES + 1) };
    assert.equal(harness.handle(oversized).status, 'rejected');
    const largeOperation = stepUp('test_largeop', operation({ targetId: `test_${'x'.repeat(IPC_MAX_MESSAGE_BYTES)}` }));
    assert.equal(validateSyntheticIpcRequest(largeOperation).code, 'payload_too_large');
    let getterCalled = false;
    const accessor = auth('test_getter');
    Object.defineProperty(accessor, 'verified', { enumerable: true, get() { getterCalled = true; return true; } });
    assert.equal(harness.handle(accessor).status, 'rejected');
    assert.equal(getterCalled, false);
    const hostile = new Proxy(auth('test_proxy'), { ownKeys() { throw new Error('synthetic proxy'); } });
    assert.equal(harness.handle(hostile).status, 'rejected');
    assertDenied(harness.handle(hostile));
});

test('synthetic broker response shape never authenticates a broker or accepts verified claims', () => {
    const response = { protocolVersion: 1, requestId: 'test_resp', status: 'verified', errorCode: null, synthetic: true };
    assert.equal(validateSyntheticBrokerResponse(response).code, 'response_not_authenticated');
    assertDenied(validateSyntheticBrokerResponse(response));
    assert.equal(validateSyntheticBrokerResponse({ ...response, verified: true }).status, 'rejected');
    assert.equal(validateSyntheticBrokerResponse({ ...response, principalId: 'test_forged' }).status, 'rejected');
    assert.equal(validateSyntheticBrokerResponse({ ...response, installationId: 'test_forged' }).status, 'rejected');
    assert.equal(validateSyntheticBrokerResponse({ ...response, synthetic: false }).status, 'rejected');
    assert.equal(validateSyntheticBrokerResponse({ ...response, status: 'error' }).code, 'response_inconsistent');
});

test('out-of-order or forged verified response shapes cannot change any synthetic request state', () => {
    const harness = createIdentityBrokerIpcTestHarness({ clock: () => 100 });
    harness.handle(auth('test_pending_order'));
    const late = validateSyntheticBrokerResponse({ protocolVersion: 1, requestId: 'test_pending_order',
        status: 'verified', errorCode: null, synthetic: true });
    assert.equal(late.code, 'response_not_authenticated');
    assertDenied(late);
    assert.equal(harness.handle(target('request.status', 'test_order_status', 'test_pending_order')).code, 'pending');
    assert.equal(harness.handle(message('session.status', 'test_order_session')).code, 'session_unavailable');
});

test('clock errors and unsafe timestamp arithmetic fail closed and consume the correlation ID', () => {
    const throwing = createIdentityBrokerIpcTestHarness({ clock() { throw new Error('synthetic clock failure'); } });
    assert.equal(throwing.handle(auth('test_clock')).code, 'state_ambiguous');
    assert.equal(throwing.handle(auth('test_clock')).code, 'request_replayed');
    const overflow = createIdentityBrokerIpcTestHarness({ clock: () => Number.MAX_SAFE_INTEGER });
    assert.equal(overflow.handle(auth('test_overflow', 1)).code, 'request_invalid');
});

test('typed errors never return capabilities or executable grants', () => {
    for (const code of ['broker_unavailable', 'transport_failed', 'state_ambiguous']) {
        const error = validateSyntheticBrokerResponse({ protocolVersion: 1, requestId: 'test_error', status: 'error', errorCode: code, synthetic: true });
        assert.equal(error.status, 'accepted_shape_only');
        assertDenied(error);
        assert.equal('capability' in error, false);
        assert.equal('grant' in error, false);
    }
});

test('test-only contract is unreachable from production modules and has no transport or persistence APIs', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    async function jsFiles(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        const nested = await Promise.all(entries.map(entry => entry.isDirectory()
            ? jsFiles(path.join(directory, entry.name))
            : entry.isFile() && entry.name.endsWith('.js') ? [path.join(directory, entry.name)] : []));
        return nested.flat();
    }
    for (const filename of await jsFiles(root)) {
        const source = await readFile(filename, 'utf8');
        assert.doesNotMatch(source, /identity-broker-ipc-contract/u, path.relative(root, filename));
    }
    const source = await readFile(new URL('./support/identity-broker-ipc-contract.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:net|node:tls|node:child_process|node:fs|fetch\s*\(|https?\.request|createServer/u);
    assert.doesNotMatch(source, /capability\s*[:=]|issueCapability|authorizeOperation/u);
});
