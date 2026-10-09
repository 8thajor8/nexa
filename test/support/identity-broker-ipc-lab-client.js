// Test-only client for the isolated child-process transport experiment.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { IPC_MAX_MESSAGE_BYTES, IPC_PROTOCOL_VERSION } from './identity-broker-ipc-contract.js';

const BROKER_SCRIPT = fileURLToPath(new URL('./identity-broker-ipc-lab-broker.js', import.meta.url));
const ID = /^test_[a-z0-9_-]{1,64}$/u;
const RESPONSE_STATUSES = new Set(['accepted_synthetic', 'accepted_shape_only', 'rejected']);
const RESPONSE_CODES = new Set(['capabilities_only', 'request_pending', 'request_replayed', 'request_invalid',
    'protocol_unsupported', 'payload_too_large', 'request_unknown', 'request_expired', 'request_cancelled',
    'request_not_pending', 'operation_invalid', 'session_unavailable', 'state_ambiguous', 'transport_failed',
    'pending', 'cancelled', 'timed_out']);
const RESULT_KEYS = new Set(['synthetic', 'status', 'code', 'authorization', 'executable', 'persistencePerformed',
    'protocolVersion', 'capabilities', 'session', 'targetRequestId', 'requestId', 'expiresAt', 'operationFingerprint']);

function safeResult(code, transport = 'failed') {
    return Object.freeze({ transport, synthetic: true, code, authorization: 'DENY', executable: false,
        persistencePerformed: false, brokerAuthenticity: 'unverified' });
}

function isSafeBrokerResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).some(key => !RESULT_KEYS.has(key))) return false;
    if (value.synthetic !== true || !RESPONSE_STATUSES.has(value.status) || !RESPONSE_CODES.has(value.code)
        || value.authorization !== 'DENY' || value.executable !== false || value.persistencePerformed !== false) return false;
    if (value.protocolVersion !== undefined && value.protocolVersion !== IPC_PROTOCOL_VERSION) return false;
    if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !ID.test(value.requestId))) return false;
    if (value.targetRequestId !== undefined && (typeof value.targetRequestId !== 'string' || !ID.test(value.targetRequestId))) return false;
    if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0)) return false;
    if (value.capabilities !== undefined && (!Array.isArray(value.capabilities)
        || value.capabilities.some(item => !['authentication.start', 'step_up.start', 'request.status',
            'request.cancel', 'session.status'].includes(item)))) return false;
    if (value.session !== undefined && (!value.session || typeof value.session !== 'object'
        || Array.isArray(value.session) || Object.keys(value.session).length !== 1
        || value.session.state !== 'unavailable')) return false;
    if (value.operationFingerprint !== null && value.operationFingerprint !== undefined
        && !/^[a-f0-9]{64}$/u.test(value.operationFingerprint)) return false;
    return true;
}

function parseWireFrame(frame) {
    if (frame.length > IPC_MAX_MESSAGE_BYTES) return null;
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).length !== 3 || value.protocolVersion !== IPC_PROTOCOL_VERSION
        || !(ID.test(value.requestId ?? '') || value.requestId === 'test_transport') || !isSafeBrokerResult(value.response)) return null;
    return value;
}

/**
 * Wraps a child process's stdio as an untrusted test transport. The caller owns
 * how the child was created; this helper never upgrades a response to authority.
 */
export function createIdentityBrokerLabClient(child, { timeoutMs = 1000, maxPending = 16 } = {}) {
    if (!child?.stdin || !child?.stdout || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
        || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64)
        throw new TypeError('lab_client_options_invalid');

    const pending = new Map();
    const rawWaiters = [];
    let buffered = Buffer.alloc(0);
    let closed = false;
    let protocolErrors = 0;

    function failPending(code) {
        closed = true;
        for (const [requestId, item] of pending) {
            clearTimeout(item.timer);
            pending.delete(requestId);
            item.resolve(safeResult(code));
        }
        for (const waiter of rawWaiters.splice(0)) waiter.resolve(safeResult(code));
    }

    function receive(frame) {
        const parsed = parseWireFrame(frame);
        if (!parsed) {
            protocolErrors += 1;
            return;
        }
        const item = pending.get(parsed.requestId);
        if (item) {
            pending.delete(parsed.requestId);
            clearTimeout(item.timer);
            item.resolve(Object.freeze({ transport: 'received', brokerAuthenticity: 'unverified',
                synthetic: true, responseStatus: parsed.response.status, responseCode: parsed.response.code,
                authorization: 'DENY', executable: false, persistencePerformed: false }));
            return;
        }
        if (rawWaiters.length > 0) rawWaiters.shift().resolve(Object.freeze({ transport: 'received_unmatched',
            brokerAuthenticity: 'unverified', synthetic: true, requestId: parsed.requestId,
            responseCode: parsed.response.code, authorization: 'DENY', executable: false, persistencePerformed: false }));
        else protocolErrors += 1;
    }

    child.stdout.on('data', chunk => {
        // Process a chunk incrementally so concatenated frames stay supported
        // without copying an unbounded child output into the pending buffer.
        let offset = 0;
        while (offset < chunk.length && !closed) {
            const newline = chunk.indexOf(10, offset);
            const end = newline < 0 ? chunk.length : newline;
            const segment = chunk.subarray(offset, end);
            if (buffered.length + segment.length > IPC_MAX_MESSAGE_BYTES) {
                failPending('payload_too_large');
                return;
            }
            const frame = buffered.length === 0 ? segment : Buffer.concat([buffered, segment]);
            if (newline < 0) {
                buffered = frame;
                return;
            }
            buffered = Buffer.alloc(0);
            receive(frame);
            offset = newline + 1;
        }
    });
    child.stdout.on('error', () => failPending('transport_failed'));
    child.on('error', () => failPending('transport_failed'));
    child.on('close', () => failPending('transport_failed'));

    function writeFrame(bytes) {
        if (closed || child.stdin.destroyed) return false;
        return child.stdin.write(bytes);
    }

    function request(message, { timeoutMs: perRequestTimeout = timeoutMs } = {}) {
        if (closed || pending.size >= maxPending || !Number.isSafeInteger(perRequestTimeout) || perRequestTimeout < 1)
            return Promise.resolve(safeResult(closed ? 'transport_failed' : 'state_ambiguous'));
        let line;
        try { line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'); } catch { return Promise.resolve(safeResult('request_invalid')); }
        if (line.length - 1 > IPC_MAX_MESSAGE_BYTES) return Promise.resolve(safeResult('payload_too_large'));
        const requestId = message?.requestId;
        if (typeof requestId !== 'string' || !ID.test(requestId) || pending.has(requestId))
            return Promise.resolve(safeResult('request_invalid'));
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                pending.delete(requestId);
                resolve(safeResult('transport_failed', 'timed_out'));
            }, perRequestTimeout);
            pending.set(requestId, { resolve, timer });
            if (!writeFrame(line)) {
                clearTimeout(timer);
                pending.delete(requestId);
                resolve(safeResult('transport_failed'));
            }
        });
    }

    async function close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await once(child, 'close');
    }

    function sendRawForTest(value, { timeoutMs: perRequestTimeout = timeoutMs, endInput = false } = {}) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
        if (closed || !Number.isSafeInteger(perRequestTimeout) || perRequestTimeout < 1)
            return Promise.resolve(safeResult('transport_failed'));
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                const index = rawWaiters.indexOf(waiter);
                if (index >= 0) rawWaiters.splice(index, 1);
                resolve(safeResult('transport_failed', 'timed_out'));
            }, perRequestTimeout);
            const waiter = { resolve: result => { clearTimeout(timer); resolve(result); } };
            rawWaiters.push(waiter);
            if (!writeFrame(bytes)) {
                clearTimeout(timer);
                rawWaiters.splice(rawWaiters.indexOf(waiter), 1);
                resolve(safeResult('transport_failed'));
            } else if (endInput) child.stdin.end();
        });
    }

    return Object.freeze({ request, sendRawForTest, closeInput: () => child.stdin.end(), close,
        terminate: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); },
        get protocolErrors() { return protocolErrors; }, child });
}

export function startIdentityBrokerLab({ timeoutMs = 1000, maxPending = 16 } = {}) {
    const child = spawnIdentityBrokerLabProcess();
    return createIdentityBrokerLabClient(child, { timeoutMs, maxPending });
}

export function spawnIdentityBrokerLabProcess() {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawn(process.execPath, [BROKER_SCRIPT], { shell: false, windowsHide: true, env,
        stdio: ['pipe', 'pipe', 'pipe'] });
}
