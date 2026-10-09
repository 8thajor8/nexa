import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createIdentityBrokerLabClient, spawnIdentityBrokerLabProcess, startIdentityBrokerLab } from './support/identity-broker-ipc-lab-client.js';

const message = (type, requestId, payload = {}) => ({ protocolVersion: 1, requestId, type, payload });
const auth = requestId => message('authentication.start', requestId, { requestedTtlMs: 1000 });
const denied = result => {
    assert.equal(result.synthetic, true);
    assert.equal(result.authorization, 'DENY');
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
};

function eventFrame(child, predicate = () => true, timeoutMs = 500) {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => { cleanup(); reject(new Error('frame_timeout')); }, timeoutMs);
        const onData = chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            const newline = buffer.indexOf(10);
            if (newline < 0) return;
            const line = buffer.subarray(0, newline).toString('utf8');
            let frame;
            try { frame = JSON.parse(line); } catch { return; }
            if (!predicate(frame)) return;
            cleanup(); resolve(frame);
        };
        const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); };
        child.stdout.on('data', onData);
    });
}

async function waitFor(predicate, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    return predicate();
}

test('child-process stdio transport accepts a valid request and keeps the result synthetic and denied', async t => {
    const client = startIdentityBrokerLab();
    t.after(() => client.close());
    const result = await client.request(auth('test_pipe_ok'));
    assert.equal(result.transport, 'received');
    assert.equal(result.responseStatus, 'accepted_synthetic');
    assert.equal(result.responseCode, 'request_pending');
    assert.equal(result.brokerAuthenticity, 'unverified');
    denied(result);
});

test('broker rejects malformed schemas with a typed error over the pipe', async t => {
    const client = startIdentityBrokerLab();
    t.after(() => client.close());
    const result = await client.request({ ...auth('test_bad'), payload: { requestedTtlMs: 1000, extra: true } });
    assert.equal(result.responseStatus, 'rejected');
    assert.equal(result.responseCode, 'request_invalid');
    denied(result);
});

test('concurrent requests are correlated independently and duplicate IDs cannot replay', async t => {
    const client = startIdentityBrokerLab();
    t.after(() => client.close());
    const results = await Promise.all([client.request(auth('test_con_a')), client.request(auth('test_con_b'))]);
    assert.deepEqual(results.map(result => result.responseCode), ['request_pending', 'request_pending']);
    const replay = await client.request(auth('test_con_a'));
    assert.equal(replay.responseCode, 'request_replayed');
    results.forEach(denied); denied(replay);
});

test('client timeout returns a typed fail-closed result and does not retry', async t => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'], { shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    const client = createIdentityBrokerLabClient(child, { timeoutMs: 30 });
    t.after(() => client.close());
    const result = await client.request(auth('test_timeout'));
    assert.equal(result.transport, 'timed_out');
    assert.equal(result.code, 'transport_failed');
    denied(result);
});

test('explicit cancellation changes only the matching pending synthetic request', async t => {
    const client = startIdentityBrokerLab();
    t.after(() => client.terminate());
    assert.equal((await client.request(auth('test_cancel_target'))).responseCode, 'request_pending');
    const cancelled = await client.request(message('request.cancel', 'test_cancel_cmd', { targetRequestId: 'test_cancel_target' }));
    assert.equal(cancelled.responseCode, 'cancelled');
    const later = await client.request(message('request.status', 'test_cancel_status', { targetRequestId: 'test_cancel_target' }));
    assert.equal(later.responseCode, 'cancelled');
    denied(cancelled); denied(later);
});

test('incomplete frame receives a transport error only when the input pipe closes', async t => {
    const child = spawnIdentityBrokerLabProcess();
    const client = createIdentityBrokerLabClient(child, { timeoutMs: 1000 });
    t.after(() => client.close());
    const responsePromise = eventFrame(child, frame => frame.requestId === 'test_transport');
    client.sendRawForTest('{"protocolVersion":1', { endInput: true }).catch(() => {});
    const frame = await responsePromise;
    assert.equal(frame.response.code, 'transport_failed');
    denied(frame.response);
});

test('broker times out an incomplete frame even while the client keeps the pipe open', async t => {
    const client = startIdentityBrokerLab({ timeoutMs: 1500 });
    t.after(() => client.close());
    const response = await client.sendRawForTest('{"protocolVersion":1', { timeoutMs: 1200 });
    assert.equal(response.transport, 'received_unmatched');
    assert.equal(response.responseCode, 'transport_failed');
    denied(response);
});

test('oversized frame is rejected before JSON parsing', async t => {
    const client = startIdentityBrokerLab();
    t.after(() => client.close());
    const response = await client.sendRawForTest(`${'x'.repeat(8193)}\n`, { timeoutMs: 1000 });
    assert.equal(response.responseCode, 'payload_too_large');
    assert.equal(response.transport, 'received_unmatched');
    denied(response);
});

test('broker closure fails pending work and a fresh process starts with empty state', async t => {
    const client = startIdentityBrokerLab();
    const start = await client.request(auth('test_restart_state'));
    assert.equal(start.responseCode, 'request_pending');
    await client.close();
    const afterClose = await client.request(auth('test_after_close'));
    assert.equal(afterClose.code, 'transport_failed');
    denied(afterClose);

    const restarted = startIdentityBrokerLab();
    t.after(() => restarted.close());
    const status = await restarted.request(message('request.status', 'test_after_restart', { targetRequestId: 'test_restart_state' }));
    assert.equal(status.responseCode, 'request_unknown');
    denied(status);
});

test('a substituted child can spoof a well-formed synthetic reply but client output remains DENY', async t => {
    const script = `process.stdin.on('data', chunk => { const req = JSON.parse(chunk.toString()); process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: req.requestId, response: { synthetic: true, status: 'accepted_synthetic', code: 'request_pending', authorization: 'DENY', executable: false, persistencePerformed: false } }) + '\\n'); });`;
    const child = spawn(process.execPath, ['-e', script], { shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    const client = createIdentityBrokerLabClient(child, { timeoutMs: 500 });
    t.after(() => client.close());
    const result = await client.request(auth('test_spoofed_broker'));
    assert.equal(result.transport, 'received');
    assert.equal(result.brokerAuthenticity, 'unverified');
    assert.equal(result.responseCode, 'request_pending');
    denied(result);
});

test('broker reply attempting to claim executable authority is rejected', async t => {
    const script = `process.stdin.on('data', chunk => { const req = JSON.parse(chunk.toString()); process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: req.requestId, response: { synthetic: true, status: 'accepted_synthetic', code: 'request_pending', authorization: 'ALLOW', executable: true, persistencePerformed: true } }) + '\\n'); });`;
    const child = spawn(process.execPath, ['-e', script], { shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    const client = createIdentityBrokerLabClient(child, { timeoutMs: 1500 });
    t.after(() => client.close());
    const result = await client.request(auth('test_bad_broker_claim'));
    assert.equal(result.transport, 'timed_out');
    assert.equal(client.protocolErrors, 1);
    denied(result);
});

test('client rejects an oversized broker frame without buffering or accepting it', async t => {
    const script = `process.stdin.on('data', () => { process.stdout.write(Buffer.alloc(8193, 65)); process.stdout.write('\\n'); });`;
    const child = spawn(process.execPath, ['-e', script], { shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    const client = createIdentityBrokerLabClient(child, { timeoutMs: 500 });
    t.after(() => client.close());
    const result = await client.request(auth('test_oversized_reply'));
    assert.equal(result.code, 'payload_too_large');
    assert.equal(result.authorization, 'DENY');
    denied(result);
});

test('duplicate and cross-correlated frames cannot settle a different request', async t => {
    const script = `let seen = false; process.stdin.on('data', chunk => { const req = JSON.parse(chunk.toString()); const response = { synthetic: true, status: 'accepted_synthetic', code: 'request_pending', authorization: 'DENY', executable: false, persistencePerformed: false }; const frame = id => JSON.stringify({ protocolVersion: 1, requestId: id, response }) + '\\n'; if (!seen) { seen = true; process.stdout.write(frame('test_wrong')); process.stdout.write(frame(req.requestId)); process.stdout.write(frame(req.requestId)); } });`;
    const child = spawn(process.execPath, ['-e', script], { shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    const client = createIdentityBrokerLabClient(child, { timeoutMs: 500 });
    t.after(() => client.close());
    const a = await client.request(auth('test_corr_a'));
    assert.equal(a.transport, 'received');
    assert.equal(await waitFor(() => client.protocolErrors === 2), true);
    assert.equal(client.protocolErrors, 2);
    denied(a);
});

test('raw malformed JSON fails closed and no process remains after teardown', async t => {
    const child = spawnIdentityBrokerLabProcess();
    const client = createIdentityBrokerLabClient(child, { timeoutMs: 1000 });
    t.after(() => client.close());
    const responsePromise = eventFrame(child, frame => frame.requestId === 'test_transport');
    client.sendRawForTest('{invalid json}\n', { endInput: true }).catch(() => {});
    const frame = await responsePromise;
    assert.equal(frame.response.code, 'request_invalid');
    denied(frame.response);
    await client.close();
    assert.equal(child.exitCode === null && child.signalCode === null, false);
});
