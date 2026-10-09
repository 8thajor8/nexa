// Synthetic, test-only IPC contract. Never import from src/ or use as a broker.
import { createHash } from 'node:crypto';

export const IPC_PROTOCOL_VERSION = 1;
export const IPC_MAX_MESSAGE_BYTES = 8192;
export const IPC_MAX_TTL_MS = 120_000;

const ID = /^test_[a-z0-9_-]{1,64}$/u;
const ACTIONS = new Set(['memory.add', 'memory.replace', 'identity.bootstrap_owner',
    'identity.bind_device', 'identity.revoke_device', 'session.revoke']);
const REQUEST_TYPES = new Set(['capabilities.query', 'authentication.start', 'step_up.start',
    'request.status', 'request.cancel', 'session.status']);
const OUTCOMES = new Set(['pending', 'verified', 'cancelled', 'timed_out', 'denied', 'error']);
const ERROR_CODES = new Set(['request_invalid', 'protocol_unsupported', 'request_replayed',
    'payload_too_large',
    'request_unknown', 'request_expired', 'request_cancelled', 'request_not_pending',
    'operation_invalid', 'broker_unavailable', 'transport_failed', 'state_ambiguous']);

function snapshotRecord(value, required, allowed) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
        const own = Reflect.ownKeys(value);
        if (!required.every(key => own.includes(key)) || own.some(key => typeof key !== 'string' || !allowed.includes(key))) return null;
        const copy = Object.create(null);
        for (const key of own) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
            copy[key] = descriptor.value;
        }
        return copy;
    } catch { return false; }
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function safeResult(status, code, fields = {}) {
    return deepFreeze({ synthetic: true, status, code, ...fields, authorization: 'DENY',
        executable: false, persistencePerformed: false });
}

function encodedSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Infinity; }
}

function validOperation(operation) {
    if (!operation || !ACTIONS.has(operation.action)
        || !(operation.targetId === null || (typeof operation.targetId === 'string' && ID.test(operation.targetId)))
        || !(operation.expectedRevision === null || (Number.isSafeInteger(operation.expectedRevision)
            && operation.expectedRevision >= 0))) return false;
    switch (operation.action) {
        case 'memory.add':
        case 'identity.bootstrap_owner':
            return operation.targetId === null && operation.expectedRevision !== null;
        case 'memory.replace':
        case 'identity.bind_device':
        case 'identity.revoke_device':
        case 'session.revoke':
            return operation.targetId !== null && operation.expectedRevision !== null;
        default: return false;
    }
}

function parseRequest(input) {
    const message = snapshotRecord(input, ['protocolVersion', 'requestId', 'type', 'payload'],
        ['protocolVersion', 'requestId', 'type', 'payload']);
    if (!message) return { code: 'request_invalid' };
    if (message.protocolVersion !== IPC_PROTOCOL_VERSION) return { code: 'protocol_unsupported' };
    if (!ID.test(message.requestId ?? '') || !REQUEST_TYPES.has(message.type)) return { code: 'request_invalid' };
    const payloadKeys = message.type === 'authentication.start' ? ['requestedTtlMs']
        : message.type === 'step_up.start' ? ['requestedTtlMs', 'operation']
        : message.type === 'request.status' || message.type === 'request.cancel' ? ['targetRequestId'] : [];
    const payload = snapshotRecord(message.payload, payloadKeys, payloadKeys);
    if (!payload || Reflect.ownKeys(payload).length !== payloadKeys.length) return { code: 'request_invalid' };
    message.payload = payload;
    const finish = valid => valid
        ? (encodedSize(message) <= IPC_MAX_MESSAGE_BYTES ? { code: null, message } : { code: 'payload_too_large' })
        : { code: 'request_invalid' };
    switch (message.type) {
        case 'capabilities.query':
        case 'session.status':
            return finish(true);
        case 'authentication.start':
            return finish(Number.isSafeInteger(message.payload.requestedTtlMs)
                && message.payload.requestedTtlMs >= 1 && message.payload.requestedTtlMs <= IPC_MAX_TTL_MS
            );
        case 'step_up.start':
            const operation = snapshotRecord(message.payload.operation, ['action', 'targetId', 'expectedRevision'],
                ['action', 'targetId', 'expectedRevision']);
            if (!operation || Reflect.ownKeys(operation).length !== 3) return { code: 'operation_invalid' };
            message.payload.operation = operation;
            if (encodedSize(message) > IPC_MAX_MESSAGE_BYTES) return { code: 'payload_too_large' };
            return finish(Number.isSafeInteger(message.payload.requestedTtlMs)
                && message.payload.requestedTtlMs >= 1 && message.payload.requestedTtlMs <= IPC_MAX_TTL_MS
                && validOperation(operation));
        case 'request.status':
        case 'request.cancel':
            return finish(ID.test(message.payload.targetRequestId ?? ''));
        default: return { code: 'request_invalid' };
    }
}

/** Shape-only validator: a well-shaped response is not authenticated or trusted. */
export function validateSyntheticBrokerResponse(message) {
    const response = snapshotRecord(message, ['protocolVersion', 'requestId', 'status', 'errorCode', 'synthetic'],
        ['protocolVersion', 'requestId', 'status', 'errorCode', 'synthetic']);
    if (!response || Reflect.ownKeys(response).length !== 5 || response.protocolVersion !== IPC_PROTOCOL_VERSION
        || !ID.test(response.requestId ?? '') || !OUTCOMES.has(response.status) || response.synthetic !== true
        || !(response.errorCode === null || ERROR_CODES.has(response.errorCode)))
        return safeResult('rejected', 'response_invalid');
    if ((response.status === 'error') !== (response.errorCode !== null))
        return safeResult('rejected', 'response_inconsistent');
    return safeResult('accepted_shape_only', 'response_not_authenticated');
}

/** Canonical operation digest for fixtures; it is a binding, not authorization. */
export function fingerprintSyntheticOperation(operation) {
    const copy = snapshotRecord(operation, ['action', 'targetId', 'expectedRevision'], ['action', 'targetId', 'expectedRevision']);
    if (!copy || Reflect.ownKeys(copy).length !== 3 || !validOperation(copy))
        return null;
    const canonical = JSON.stringify({ action: copy.action, targetId: copy.targetId,
        expectedRevision: copy.expectedRevision });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** In-memory contract simulator; it creates no sockets, credentials, sessions or durable state. */
export function createIdentityBrokerIpcTestHarness({ clock = () => Date.now() } = {}) {
    if (typeof clock !== 'function') throw new TypeError('harness_options_invalid');
    const seenIds = new Set();
    const requests = new Map();

    function handle(message) {
        const parsed = parseRequest(message);
        if (parsed.code) return safeResult('rejected', parsed.code);
        message = parsed.message;
        if (seenIds.has(message.requestId)) return safeResult('rejected', 'request_replayed');
        seenIds.add(message.requestId);
        let now;
        try { now = clock(); } catch { return safeResult('rejected', 'state_ambiguous'); }
        if (!Number.isSafeInteger(now) || now < 0) return safeResult('rejected', 'state_ambiguous');

        if (message.type === 'capabilities.query') return safeResult('accepted_synthetic', 'capabilities_only', {
            protocolVersion: IPC_PROTOCOL_VERSION, capabilities: ['authentication.start', 'step_up.start',
                'request.status', 'request.cancel', 'session.status'],
        });
        if (message.type === 'session.status') return safeResult('accepted_synthetic', 'session_unavailable', {
            session: { state: 'unavailable' },
        });
        if (message.type === 'request.status' || message.type === 'request.cancel') {
            const state = requests.get(message.payload.targetRequestId);
            if (!state) return safeResult('rejected', 'request_unknown');
            if (now >= state.expiresAt && state.status === 'pending') state.status = 'timed_out';
            if (message.type === 'request.cancel') {
                if (state.status !== 'pending') return safeResult('rejected', 'request_not_pending');
                state.status = 'cancelled';
            }
            return safeResult('accepted_synthetic', state.status, { targetRequestId: message.payload.targetRequestId });
        }

        const ttlMs = message.payload.requestedTtlMs;
        if (!Number.isSafeInteger(now + ttlMs)) return safeResult('rejected', 'request_invalid');
        const state = { requestId: message.requestId, type: message.type, status: 'pending',
            expiresAt: now + ttlMs, operationFingerprint: message.type === 'step_up.start'
                ? fingerprintSyntheticOperation(message.payload.operation) : null };
        requests.set(message.requestId, state);
        return safeResult('accepted_synthetic', 'request_pending', { requestId: message.requestId,
            expiresAt: state.expiresAt, operationFingerprint: state.operationFingerprint });
    }

    return Object.freeze({ handle });
}

export function validateSyntheticIpcRequest(message) {
    const parsed = parseRequest(message);
    return parsed.code ? safeResult('rejected', parsed.code)
        : safeResult('accepted_shape_only', 'request_not_authenticated');
}
