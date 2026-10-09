import { createHash } from 'node:crypto';

export const MEMORY_AUTHORIZATION_VERSION = 'nexa.memory.authorization/0.1';
export const MEMORY_AUTHORIZATION_OPERATIONS = Object.freeze([
    'read', 'query', 'add', 'replace', 'correct', 'forget', 'delete', 'share', 'administer',
]);
export const MEMORY_AUTHORIZATION_LIFECYCLE = Object.freeze([
    'pending', 'presented', 'approved', 'denied', 'cancelled', 'expired', 'revoked', 'consumed',
]);

const CHANNELS = new Set(['desktop', 'voice', 'mobile', 'wearable']);
const INTENT_SOURCES = new Set(['direct_user', 'model', 'tool', 'retrieved_memory', 'system']);
const RESOURCE_KINDS = new Set(['assertion', 'query', 'partition', 'user', 'device', 'installation']);
const SCOPES = new Set(['private', 'project', 'shared', 'installation']);
const ADMIN_ACTIONS = new Set(['invite_user', 'grant_permission', 'revoke_permission', 'bind_device', 'suspend_user', 'revoke_user', 'revoke_device', 'recover_owner']);
const CONFIRMATION_STATES = new Set(['pending', 'presented', 'answered', 'cancelled']);
const RESPONSE_KINDS = new Set(['none', 'approve', 'deny', 'clarify', 'cancel']);
const AUTH_EVIDENCE_KINDS = new Set(['none', 'synthetic_webauthn']);
const POLICY_OUTCOMES = new Set(['ALLOW', 'DENY', 'ASK']);
const REASON_CODES = new Set(['policy_allow_hypothetical', 'policy_denied', 'confirmation_required', 'authentication_missing', 'permission_missing', 'snapshot_stale', 'principal_mismatch', 'session_invalid', 'device_invalid', 'expired', 'revoked', 'replay', 'operation_mismatch', 'resource_mismatch', 'malformed_request']);
const HEX_256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_REF = /^oref_[A-Za-z0-9_-]{32,128}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
function copyRecord(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of own) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
        copy[key] = descriptor.value;
    }
    return copy;
}
function copyArray(value, maxLength = 64) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== length + 1 || own.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) return null;
    const copy = [];
    for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
        copy.push(descriptor.value);
    }
    return copy;
}
function text(value, max = 128) { return typeof value === 'string' && value.length > 0 && value.length <= max && ID.test(value); }
function digest(value) { return typeof value === 'string' && HEX_256.test(value); }
function timestamp(value) {
    return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function uint(value) { return Number.isSafeInteger(value) && value >= 0; }
function immutableResult(fields) { return deepFreeze({ ...fields, syntheticOnly: true, authorization: 'DENY', permission: null, executable: false }); }
function invalid(code) { return immutableResult({ valid: false, code }); }
function valid(fields) { return immutableResult({ valid: true, ...fields }); }
function caught(fn) { try { return fn(); } catch { return invalid('contract_input_invalid'); } }

function normalizeIntent(input) {
    const keys = ['intentId', 'source', 'candidateFingerprintSha256', 'operationKind'];
    input = copyRecord(input, keys);
    if (!input || !text(input.intentId) || !INTENT_SOURCES.has(input.source)
        || !digest(input.candidateFingerprintSha256) || !MEMORY_AUTHORIZATION_OPERATIONS.includes(input.operationKind)) return null;
    return { intentId: input.intentId, source: input.source,
        candidateFingerprintSha256: input.candidateFingerprintSha256, operationKind: input.operationKind };
}
function normalizeOperation(input) {
    const keys = ['kind', 'resourceKind', 'resourceId', 'scope', 'targetFingerprintSha256', 'payloadFingerprintSha256', 'recipientIds', 'administrativeAction'];
    input = copyRecord(input, keys);
    if (!input || !MEMORY_AUTHORIZATION_OPERATIONS.includes(input.kind)
        || !RESOURCE_KINDS.has(input.resourceKind) || !SCOPES.has(input.scope)
        || !(input.resourceId === null || text(input.resourceId))
        || !(input.targetFingerprintSha256 === null || digest(input.targetFingerprintSha256))
        || !(input.payloadFingerprintSha256 === null || digest(input.payloadFingerprintSha256))
        || !Array.isArray(input.recipientIds)) return null;
    const recipientIds = copyArray(input.recipientIds, 32);
    if (!recipientIds || !recipientIds.every(value => text(value)) || new Set(recipientIds).size !== recipientIds.length
        || !(input.administrativeAction === null || ADMIN_ACTIONS.has(input.administrativeAction))) return null;
    const share = input.kind === 'share';
    const admin = input.kind === 'administer';
    const query = input.kind === 'query';
    const add = input.kind === 'add';
    const targetedMutation = ['replace', 'correct', 'forget', 'delete'].includes(input.kind);
    if (share) {
        if (input.resourceKind !== 'assertion' || !text(input.resourceId) || !digest(input.targetFingerprintSha256)
            || input.payloadFingerprintSha256 !== null || input.scope !== 'shared' || recipientIds.length === 0
            || input.administrativeAction !== null) return null;
    } else if (admin) {
        if (!['user', 'device', 'installation'].includes(input.resourceKind) || !text(input.resourceId)
            || !digest(input.targetFingerprintSha256) || input.payloadFingerprintSha256 === null
            || input.scope !== 'installation' || recipientIds.length !== 0 || !input.administrativeAction) return null;
    } else if (query) {
        if (input.resourceKind !== 'query' || input.resourceId !== null || input.targetFingerprintSha256 !== null
            || !digest(input.payloadFingerprintSha256) || recipientIds.length !== 0 || input.administrativeAction !== null) return null;
    } else if (add) {
        if (input.resourceKind !== 'assertion' || input.resourceId !== null || input.targetFingerprintSha256 !== null
            || !digest(input.payloadFingerprintSha256) || recipientIds.length !== 0 || input.administrativeAction !== null) return null;
    } else if (targetedMutation) {
        if (input.resourceKind !== 'assertion' || !text(input.resourceId) || !digest(input.targetFingerprintSha256)
            || (['replace', 'correct'].includes(input.kind) !== digest(input.payloadFingerprintSha256))
            || recipientIds.length !== 0 || input.administrativeAction !== null) return null;
    } else if (input.kind === 'read') {
        if (!['assertion', 'partition'].includes(input.resourceKind) || !text(input.resourceId)
            || !digest(input.targetFingerprintSha256) || input.payloadFingerprintSha256 !== null
            || recipientIds.length !== 0 || input.administrativeAction !== null) return null;
    }
    if (share && recipientIds.some((recipient, i) => i > 0 && recipientIds[i - 1] >= recipient)) return null;
    return { kind: input.kind, resourceKind: input.resourceKind, resourceId: input.resourceId,
        scope: input.scope, targetFingerprintSha256: input.targetFingerprintSha256,
        payloadFingerprintSha256: input.payloadFingerprintSha256, recipientIds,
        administrativeAction: input.administrativeAction };
}
function normalizeSnapshot(input) {
    input = copyRecord(input, ['revision', 'digestSha256']);
    if (!input || !uint(input.revision) || !digest(input.digestSha256)) return null;
    return { revision: input.revision, digestSha256: input.digestSha256 };
}
function normalizeRequest(input) {
    const keys = ['contractVersion', 'requestId', 'intentBinding', 'principalId', 'installationId', 'sessionId', 'channel',
        'operation', 'snapshot', 'requestedAt', 'expiresAt', 'revocationEpoch', 'sessionEpoch'];
    input = copyRecord(input, keys);
    if (!input || input.contractVersion !== MEMORY_AUTHORIZATION_VERSION
        || !text(input.requestId) || !text(input.principalId) || !text(input.installationId) || !text(input.sessionId)
        || !CHANNELS.has(input.channel) || !timestamp(input.requestedAt) || !timestamp(input.expiresAt)
        || Date.parse(input.expiresAt) <= Date.parse(input.requestedAt) || !uint(input.revocationEpoch) || !uint(input.sessionEpoch)) return null;
    const intentBinding = copyRecord(input.intentBinding, ['intentId', 'intentFingerprintSha256', 'operationKind']);
    if (!intentBinding || !text(intentBinding.intentId) || !digest(intentBinding.intentFingerprintSha256)
        || !MEMORY_AUTHORIZATION_OPERATIONS.includes(intentBinding.operationKind)) return null;
    const operation = normalizeOperation(input.operation), snapshot = normalizeSnapshot(input.snapshot);
    if (!operation || !snapshot || operation.kind !== intentBinding.operationKind) return null;
    return { contractVersion: MEMORY_AUTHORIZATION_VERSION, requestId: input.requestId,
        intentBinding,
        principalId: input.principalId, installationId: input.installationId, sessionId: input.sessionId,
        channel: input.channel, operation, snapshot, requestedAt: input.requestedAt, expiresAt: input.expiresAt,
        revocationEpoch: input.revocationEpoch, sessionEpoch: input.sessionEpoch };
}

export function validateMemoryIntent(input) {
    return caught(() => {
        const intent = normalizeIntent(input);
        if (!intent) return invalid('intent_shape_invalid');
        return valid({ intent: deepFreeze(intent), intentFingerprintSha256: sha256(intent), trust: 'untrusted_content' });
    });
}

export function validateMemoryAuthorizationRequest(input) {
    return caught(() => {
        const request = normalizeRequest(input);
        if (!request) return invalid('authorization_request_invalid');
        return valid({ request: deepFreeze(request), requestFingerprintSha256: sha256(request),
            operationFingerprintSha256: sha256(request.operation), status: 'pending' });
    });
}

export function validateConfirmationInteraction(input, requestInput) {
    return caught(() => {
        const requestResult = validateMemoryAuthorizationRequest(requestInput);
        const keys = ['interactionId', 'requestId', 'channel', 'state', 'responseKind', 'createdAt', 'expiresAt', 'presentationRevision'];
        input = copyRecord(input, keys);
        if (!requestResult.valid || !input || !text(input.interactionId)
            || input.requestId !== requestResult.request.requestId || input.channel !== requestResult.request.channel
            || !CONFIRMATION_STATES.has(input.state) || !RESPONSE_KINDS.has(input.responseKind)
            || !timestamp(input.createdAt) || !timestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)
            || !uint(input.presentationRevision)) return invalid('confirmation_interaction_invalid');
        const consistent = (input.state === 'pending' || input.state === 'presented')
            ? input.responseKind === 'none'
            : input.state === 'cancelled' ? input.responseKind === 'cancel'
                : ['approve', 'deny', 'clarify'].includes(input.responseKind);
        if (!consistent || Date.parse(input.createdAt) < Date.parse(requestResult.request.requestedAt)
            || Date.parse(input.createdAt) >= Date.parse(requestResult.request.expiresAt)
            || Date.parse(input.expiresAt) > Date.parse(requestResult.request.expiresAt)) return invalid('confirmation_interaction_invalid');
        return valid({ interaction: deepFreeze({ ...input }), interpretationOnly: true });
    });
}

export function validateAuthenticationEvidence(input, requestInput) {
    return caught(() => {
        const requestResult = validateMemoryAuthorizationRequest(requestInput);
        const keys = ['evidenceId', 'requestId', 'kind', 'proofFingerprintSha256', 'verified', 'source'];
        input = copyRecord(input, keys);
        if (!requestResult.valid || !input || !text(input.evidenceId)
            || input.requestId !== requestResult.request.requestId || !AUTH_EVIDENCE_KINDS.has(input.kind)
            || input.verified !== false || input.source !== 'synthetic_fixture'
            || !(input.proofFingerprintSha256 === null || digest(input.proofFingerprintSha256))
            || ((input.kind === 'none') !== (input.proofFingerprintSha256 === null))) return invalid('authentication_evidence_invalid');
        return valid({ evidence: deepFreeze({ ...input }), evidenceTrust: 'unverified_synthetic' });
    });
}

export function validateMemoryPolicyDecision(input, requestInput) {
    return caught(() => {
        const requestResult = validateMemoryAuthorizationRequest(requestInput);
        const keys = ['decisionId', 'requestId', 'outcome', 'reasonCodes', 'policyRevision', 'synthetic'];
        input = copyRecord(input, keys);
        if (!requestResult.valid || !input || !text(input.decisionId)
            || input.requestId !== requestResult.request.requestId || !POLICY_OUTCOMES.has(input.outcome)
            || !Array.isArray(input.reasonCodes)) return invalid('policy_decision_invalid');
        const reasonCodes = copyArray(input.reasonCodes, 16);
        if (!reasonCodes || reasonCodes.length < 1 || !reasonCodes.every(code => REASON_CODES.has(code))
            || new Set(reasonCodes).size !== reasonCodes.length
            || !text(input.policyRevision) || input.synthetic !== true) return invalid('policy_decision_invalid');
        return valid({ decision: deepFreeze({ ...input, reasonCodes }), decisionTrust: 'hypothetical_only',
            hypotheticalAllow: input.outcome === 'ALLOW' });
    });
}

function normalizeReference(input) {
    const keys = ['contractVersion', 'authorizationId', 'requestId', 'principalId', 'installationId', 'sessionId',
        'requestFingerprintSha256', 'operationFingerprintSha256', 'resourceKind', 'resourceId', 'snapshot',
        'expiresAt', 'revocationEpoch', 'sessionEpoch', 'opaqueReference'];
    input = copyRecord(input, keys);
    if (!input || input.contractVersion !== MEMORY_AUTHORIZATION_VERSION
        || !text(input.authorizationId) || !text(input.requestId) || !text(input.principalId)
        || !text(input.installationId) || !text(input.sessionId) || !digest(input.requestFingerprintSha256)
        || !digest(input.operationFingerprintSha256) || !RESOURCE_KINDS.has(input.resourceKind)
        || !(input.resourceId === null || text(input.resourceId)) || !normalizeSnapshot(input.snapshot)
        || !timestamp(input.expiresAt) || !uint(input.revocationEpoch) || !uint(input.sessionEpoch)
        || typeof input.opaqueReference !== 'string' || !OPAQUE_REF.test(input.opaqueReference)) return null;
    return { contractVersion: input.contractVersion, authorizationId: input.authorizationId, requestId: input.requestId,
        principalId: input.principalId, installationId: input.installationId, sessionId: input.sessionId,
        requestFingerprintSha256: input.requestFingerprintSha256, operationFingerprintSha256: input.operationFingerprintSha256,
        resourceKind: input.resourceKind, resourceId: input.resourceId, snapshot: normalizeSnapshot(input.snapshot),
        expiresAt: input.expiresAt, revocationEpoch: input.revocationEpoch, sessionEpoch: input.sessionEpoch,
        opaqueReference: input.opaqueReference };
}

export function matchSyntheticAuthorizationReference(referenceInput, requestInput, contextInput) {
    return caught(() => {
        const requestResult = validateMemoryAuthorizationRequest(requestInput);
        const reference = normalizeReference(referenceInput);
        const contextKeys = ['principalId', 'installationId', 'sessionId', 'principalState', 'sessionState', 'deviceState',
            'revision', 'digestSha256', 'revocationEpoch', 'sessionEpoch', 'now', 'revokedAuthorizationIds'];
        contextInput = copyRecord(contextInput, contextKeys);
        if (!requestResult.valid || !reference || !contextInput
            || !text(contextInput.principalId) || !text(contextInput.installationId) || !text(contextInput.sessionId)
            || !['active', 'suspended', 'revoked'].includes(contextInput.principalState)
            || !['active', 'suspended', 'revoked', 'expired'].includes(contextInput.sessionState)
            || !['none', 'active', 'suspended', 'revoked'].includes(contextInput.deviceState)
            || !uint(contextInput.revision) || !digest(contextInput.digestSha256)
            || !uint(contextInput.revocationEpoch) || !uint(contextInput.sessionEpoch) || !timestamp(contextInput.now)
            || !Array.isArray(contextInput.revokedAuthorizationIds)) return invalid('authorization_reference_invalid');
        const revokedAuthorizationIds = copyArray(contextInput.revokedAuthorizationIds, 4096);
        if (!revokedAuthorizationIds || !revokedAuthorizationIds.every(value => text(value))
            || new Set(revokedAuthorizationIds).size !== revokedAuthorizationIds.length) return invalid('authorization_reference_invalid');
        const request = requestResult.request;
        let code = 'reference_matches_synthetic_context';
        if (reference.requestId !== request.requestId || reference.requestFingerprintSha256 !== requestResult.requestFingerprintSha256
            || reference.operationFingerprintSha256 !== requestResult.operationFingerprintSha256
            || reference.principalId !== request.principalId || reference.installationId !== request.installationId
            || reference.sessionId !== request.sessionId || reference.resourceKind !== request.operation.resourceKind
            || reference.resourceId !== request.operation.resourceId
            || stable(reference.snapshot) !== stable(request.snapshot)) code = 'authorization_reference_binding_mismatch';
        else if (request.principalId !== contextInput.principalId || request.installationId !== contextInput.installationId
            || request.sessionId !== contextInput.sessionId) code = 'identity_context_mismatch';
        else if (contextInput.principalState !== 'active' || contextInput.sessionState !== 'active'
            || ['suspended', 'revoked'].includes(contextInput.deviceState)) code = 'identity_state_invalid';
        else if (reference.revocationEpoch !== request.revocationEpoch || reference.revocationEpoch !== contextInput.revocationEpoch
            || reference.sessionEpoch !== request.sessionEpoch || reference.sessionEpoch !== contextInput.sessionEpoch) code = 'revocation_epoch_mismatch';
        else if (contextInput.revision !== request.snapshot.revision || contextInput.digestSha256 !== request.snapshot.digestSha256) code = 'snapshot_stale';
        else if (Date.parse(contextInput.now) < Date.parse(request.requestedAt)) code = 'authorization_not_yet_valid';
        else if (Date.parse(contextInput.now) >= Date.parse(request.expiresAt) || Date.parse(contextInput.now) >= Date.parse(reference.expiresAt)
            || Date.parse(reference.expiresAt) <= Date.parse(request.requestedAt)
            || Date.parse(reference.expiresAt) > Date.parse(request.expiresAt)) code = 'authorization_expired';
        else if (revokedAuthorizationIds.includes(reference.authorizationId)) code = 'authorization_revoked';
        return code === 'reference_matches_synthetic_context'
            ? valid({ outcome: code, authorizationId: reference.authorizationId, referenceFingerprintSha256: sha256(reference) })
            : invalid(code);
    });
}

export function verifyExecutableMemoryPermission(_permission) {
    return invalid('real_permission_verifier_unavailable');
}

const TRANSITIONS = Object.freeze({
    pending: new Set(['presented', 'denied', 'cancelled', 'expired', 'revoked']),
    presented: new Set(['approved', 'denied', 'cancelled', 'expired', 'revoked']),
    approved: new Set(['consumed', 'expired', 'revoked']),
    denied: new Set(), cancelled: new Set(), expired: new Set(), revoked: new Set(), consumed: new Set(),
});

export function createSyntheticAuthorizationLifecycle(requestInput) {
    return caught(() => {
        const result = validateMemoryAuthorizationRequest(requestInput);
        if (!result.valid) return invalid('authorization_request_invalid');
        return valid({ lifecycle: deepFreeze({ contractVersion: MEMORY_AUTHORIZATION_VERSION,
            requestId: result.request.requestId, requestFingerprintSha256: result.requestFingerprintSha256,
            status: 'pending', revision: 0, eventIds: [], authorizationId: null, lastEventAt: null }) });
    });
}

export function applySyntheticAuthorizationEvent(stateInput, eventInput, requestInput) {
    return caught(() => {
        const stateKeys = ['contractVersion', 'requestId', 'requestFingerprintSha256', 'status', 'revision', 'eventIds', 'authorizationId', 'lastEventAt'];
        const eventKeys = ['eventId', 'requestId', 'expectedRevision', 'status', 'occurredAt', 'channel', 'source', 'reasonCode', 'authorizationId'];
        const requestResult = validateMemoryAuthorizationRequest(requestInput);
        stateInput = copyRecord(stateInput, stateKeys);
        eventInput = copyRecord(eventInput, eventKeys);
        if (!requestResult.valid || !stateInput || !eventInput
            || stateInput.contractVersion !== MEMORY_AUTHORIZATION_VERSION || stateInput.requestId !== requestResult.request.requestId
            || stateInput.requestFingerprintSha256 !== requestResult.requestFingerprintSha256
            || !MEMORY_AUTHORIZATION_LIFECYCLE.includes(stateInput.status) || !uint(stateInput.revision)
            || !Array.isArray(stateInput.eventIds)) return invalid('lifecycle_event_invalid');
        const eventIds = copyArray(stateInput.eventIds, 4096);
        if (!eventIds || !eventIds.every(value => text(value)) || new Set(eventIds).size !== eventIds.length
            || (stateInput.lastEventAt !== null && !timestamp(stateInput.lastEventAt))
            || !(stateInput.authorizationId === null || text(stateInput.authorizationId))
            || !text(eventInput.eventId) || eventInput.requestId !== stateInput.requestId
            || !uint(eventInput.expectedRevision) || !MEMORY_AUTHORIZATION_LIFECYCLE.includes(eventInput.status)
            || !timestamp(eventInput.occurredAt) || eventInput.channel !== requestResult.request.channel
            || eventInput.source !== 'synthetic_fixture' || !(eventInput.reasonCode === null || REASON_CODES.has(eventInput.reasonCode))
            || !(eventInput.authorizationId === null || text(eventInput.authorizationId))) return invalid('lifecycle_event_invalid');
        const pristine = stateInput.revision === 0 && stateInput.status === 'pending'
            && eventIds.length === 0 && stateInput.lastEventAt === null && stateInput.authorizationId === null;
        const progressed = stateInput.revision > 0 && stateInput.status !== 'pending'
            && eventIds.length === stateInput.revision && timestamp(stateInput.lastEventAt);
        const authorizationStateConsistent = !['approved', 'consumed'].includes(stateInput.status)
            || stateInput.authorizationId !== null;
        if ((!pristine && !progressed) || !authorizationStateConsistent
            || (['denied', 'cancelled'].includes(stateInput.status) && stateInput.authorizationId !== null))
            return invalid('lifecycle_state_inconsistent');
        if (eventInput.expectedRevision !== stateInput.revision || stateInput.revision === Number.MAX_SAFE_INTEGER
            || eventIds.includes(eventInput.eventId)) return invalid('lifecycle_replay_or_stale_revision');
        if (!TRANSITIONS[stateInput.status].has(eventInput.status)) return invalid('lifecycle_transition_invalid');
        if (Date.parse(eventInput.occurredAt) < Date.parse(requestResult.request.requestedAt)
            || (stateInput.lastEventAt && Date.parse(eventInput.occurredAt) < Date.parse(stateInput.lastEventAt))) return invalid('lifecycle_time_invalid');
        if (eventInput.status === 'expired' && Date.parse(eventInput.occurredAt) < Date.parse(requestResult.request.expiresAt)) return invalid('lifecycle_time_invalid');
        if (Date.parse(eventInput.occurredAt) >= Date.parse(requestResult.request.expiresAt) && !['expired', 'revoked', 'cancelled'].includes(eventInput.status))
            return invalid('authorization_expired');
        if (['approved', 'consumed'].includes(eventInput.status) && !eventInput.authorizationId) return invalid('authorization_reference_required');
        if (stateInput.authorizationId === null && eventInput.status !== 'approved' && eventInput.authorizationId !== null)
            return invalid('authorization_reference_mismatch');
        if (stateInput.authorizationId && eventInput.authorizationId !== stateInput.authorizationId) return invalid('authorization_reference_mismatch');
        const lifecycle = deepFreeze({ ...stateInput, status: eventInput.status, revision: stateInput.revision + 1,
            eventIds: [...eventIds, eventInput.eventId],
            authorizationId: eventInput.authorizationId ?? stateInput.authorizationId, lastEventAt: eventInput.occurredAt });
        return valid({ lifecycle });
    });
}
